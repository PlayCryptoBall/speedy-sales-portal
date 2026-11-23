import { readFileSync } from 'node:fs';
// End-to-end database workflow tests. Each "user" is a separate Postgres connection running
// as the `authenticated` role with that user's JWT claims, exactly how Supabase's API calls the database.
// usage: node tests/workflows.test.mjs <database>
import pg from 'pg';
import assert from 'node:assert/strict';

const DB = process.argv[2] || 't1';
const conn = { host: 'localhost', port: 54329, user: 'postgres', password: 'pw', database: DB };
const admin = new pg.Client(conn); await admin.connect();
const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); console.log('PASS', name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('FAIL', name, '\n   ', e.message); }
};

async function session(uid, role = 'authenticated') {
  const c = new pg.Client(conn); await c.connect();
  await c.query(`set role ${role}`);
  if (uid) await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role })]);
  c.rpc = async (fn, args = {}) => {
    const keys = Object.keys(args);
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    const vals = keys.map(k => args[k] !== null && typeof args[k] === 'object' && !['p_keys', 'p_ids'].includes(k) ? JSON.stringify(args[k]) : args[k]);
    const res = await c.query(sql, vals);
    return res.rows[0].r;
  };
  c.fails = async (fn, args, re) => {
    try { await c.rpc(fn, args); } catch (e) { if (re && !re.test(e.message)) throw new Error(`${fn} failed with "${e.message}", expected ${re}`); return e.message; }
    throw new Error(`${fn} should have failed`);
  };
  return c;
}

// ---------------------------------------------------------------- set up people
const mk = async (email, name, role, active) => {
  const { rows } = await admin.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { full_name: name }]);
  await admin.query(`update public.profiles set full_name = $2, role = $3, active = $4 where id = $1`, [rows[0].id, name, role, active]);
  return rows[0].id;
};
await admin.query(`delete from auth.users where email like '%@test.local'`);
const M = await mk('manager@test.local', 'Test Manager', 'manager', true);
const A = await mk('flip@test.local', 'Test Flip', 'sales', true);
const B = await mk('rep2@test.local', 'Test Rep Two', 'sales', true);
const X = await mk('stranger@test.local', '', 'sales', false);    // signed up but never activated
const m = await session(M), a = await session(A), b = await session(B), x = await session(X), anon = await session(null, 'anon');
const svc = await session(null, 'service_role');
// Scheduler tests simulate fixed days; runs other tests created at the real current time must not land inside those simulated mornings.
const pushRunsBack = () => admin.query(`update refresh_runs set started_at = started_at - interval '10 years', finished_at = finished_at - interval '10 years' where started_at > '2026-01-01'`);
const opp = async (where) => (await admin.query(`select z.* from (select o.*, p.external_key from opportunities o left join projects p on p.id = o.project_id) z where ${where} limit 1`)).rows[0];

// ---------------------------------------------------------------- access control
await test('Inactive or anonymous callers get nothing', async () => {
  await x.fails('get_board', {}, /not_authorized/);
  await anon.fails('get_board', {}, /permission denied/);
  for (const t of ['opportunities', 'activities', 'contacts', 'profiles', 'projects']) {
    await assert.rejects(a.query(`select * from public.${t} limit 1`), /permission denied/, `direct read of ${t} must be blocked`);
    await assert.rejects(anon.query(`select * from public.${t} limit 1`), /permission denied/);
  }
  await assert.rejects(a.query(`update public.opportunities set owner_id = '${A}'`), /permission denied/);
  await assert.rejects(a.query(`select * from private.app_config`), /permission denied/);
});

await test('Salesperson cannot use manager actions', async () => {
  const o = await opp(`stage = 'available' and not needs_review`);
  await a.fails('assign_opportunity', { p_id: o.id, p_user: A }, /manager_only/);
  await a.fails('team_overview', {}, /manager_only/);
  await a.fails('sources_status', {}, /manager_only/);
  await a.fails('export_rows', { p_scope: 'team' }, /manager_only/);
  await a.fails('resolve_review', { p_id: o.id, p_action: 'publish' }, /manager_only/);
  await a.fails('update_setting', { p_key: 'stale_days', p_value: '3' }, /manager_only/);
  await a.fails('add_lead', { p: { project_title: 'x', source_url: 'https://x' } }, /manager_only/);
  await a.fails('list_users', {}, /manager_only/);
  await a.fails('daily_maintenance', {}, /manager_only/);
  await a.fails('refresh_upsert_project', { p_run: 1, p: { external_key: 'x' } }, /permission denied/);
  await a.fails('refresh_finish_run', { p_run: 1, p_status: 'success', p_counts: {}, p_log: [] }, /permission denied/);
});

await test('Board hides unreviewed leads from salespeople; managers see them', async () => {
  const sb = await a.rpc('get_board'), mb = await m.rpc('get_board');
  const hidden = (await admin.query(`select count(*)::int n from opportunities where stage='available' and needs_review`)).rows[0].n;
  assert.equal(mb.length, (await admin.query('select count(*)::int n from opportunities')).rows[0].n);
  assert.equal(sb.length, mb.length - hidden);
  assert.ok(hidden >= 2, 'legacy 2025 awards should be in review');
});

// ---------------------------------------------------------------- claim race
await test('Two salespeople claiming the same lead at the same moment: exactly one wins', async () => {
  const o = await opp(`stage = 'available' and not needs_review and company_id is not null`);
  const a2 = await session(A), b2 = await session(B);
  await a2.query('begin'); await b2.query('begin');
  const ra = await a2.rpc('claim_opportunity', { p_id: o.id, p_ack_company: true });       // holds the row lock
  const pb = b2.rpc('claim_opportunity', { p_id: o.id, p_ack_company: true });              // blocks on the lock
  await new Promise(r => setTimeout(r, 300));
  await a2.query('commit');
  const rb = await pb; await b2.query('commit');
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, false); assert.equal(rb.reason, 'already_claimed'); assert.equal(rb.owner_name, 'Test Flip');
  const after = await opp(`id = '${o.id}'`);
  assert.equal(after.owner_id, A);
  const hist = (await admin.query(`select count(*)::int n from ownership_history where opportunity_id = $1`, [o.id])).rows[0].n;
  assert.equal(hist, 1, 'one ownership record');
  await a2.end(); await b2.end();
});

await test('Burst: 2 reps x 12 parallel claims on 6 leads leaves one owner per lead', async () => {
  const { rows } = await admin.query(`select id from opportunities where stage='available' and not needs_review order by ref desc limit 6`);
  const sess = await Promise.all([...Array(12)].map((_, i) => session(i < 6 ? A : B)));   // 6 connections for each rep
  const out = await Promise.all(rows.flatMap((r, j) => [sess[j], sess[6 + j]].map(s => s.rpc('claim_opportunity', { p_id: r.id, p_ack_company: true }))));
  const wins = out.filter(r => r.ok && !r.already_yours).length;
  assert.equal(wins, 6, `expected 6 wins, got ${wins}: ${JSON.stringify(out.filter(r=>!r.ok).map(r=>r.reason))}`);
  for (const r of rows) {
    const n = (await admin.query(`select count(*)::int n from ownership_history where opportunity_id=$1 and action='claim'`, [r.id])).rows[0].n;
    assert.equal(n, 1);
  }
  await Promise.all(sess.map(s => s.end()));
  // put them back so later tests have a clean pool
  for (const r of rows) await m.rpc('release_opportunity', { p_id: r.id, p_reason: 'test reset' });
});

await test('Company coordination: second rep is warned before claiming a company a teammate works', async () => {
  const pair = (await admin.query(`select company_id from opportunities where stage='available' and not needs_review and company_id is not null group by 1 having count(*) >= 2 limit 1`)).rows[0];
  const [o1, o2] = (await admin.query(`select id from opportunities where company_id = $1 and stage='available' and not needs_review order by ref limit 2`, [pair.company_id])).rows;
  assert.equal((await a.rpc('claim_opportunity', { p_id: o1.id })).ok, true);
  const warn = await b.rpc('claim_opportunity', { p_id: o2.id });
  assert.equal(warn.ok, false); assert.equal(warn.reason, 'company_conflict'); assert.equal(warn.owners[0].name, 'Test Flip');
  const board = await b.rpc('get_board');
  assert.equal(board.find(r => r.id === o2.id).company_owners[0].name, 'Test Flip', 'board shows the teammate before any call');
  assert.equal((await b.rpc('claim_opportunity', { p_id: o2.id, p_ack_company: true })).ok, true);
  await m.rpc('release_opportunity', { p_id: o2.id });
});

// ---------------------------------------------------------------- working a lead
let mine;
await test('Owner logs a call, sets a follow-up and requests a quote; history is kept', async () => {
  mine = (await admin.query(`select id from opportunities where owner_id = $1 limit 1`, [A])).rows[0].id;
  const r1 = await a.rpc('log_activity', { p_id: mine, p: { kind: 'call', outcome: 'reached', body: 'Spoke to estimator Dana. Wants pricing on 40 cores.', next_action: 'Send core pricing', next_action_due: '2026-11-10' } });
  assert.equal(r1.ok, true); assert.equal(r1.stage, 'contacted'); assert.equal(r1.auto_stage, true);
  const r2 = await a.rpc('log_activity', { p_id: mine, p: { kind: 'note', stage: 'quote_needed', body: '40 x 6in cores, 12in slab', services_confirmed: ['Core drilling', 'GPR scanning'], expected_work_date: '2026-12-01' } });
  assert.equal(r2.stage, 'quote_needed');
  const d = await a.rpc('get_opportunity', { p_id: mine });
  assert.equal(d.timeline.filter(t => t.kind !== 'import').length >= 3, true);
  assert.ok(d.timeline.some(t => t.body === 'Spoke to estimator Dana. Wants pricing on 40 cores.'), 'first note kept');
  assert.equal(d.next_action_due, '2026-11-10');
  assert.deepEqual(d.services_confirmed, ['Core drilling', 'GPR scanning']);
  const n = (await admin.query(`select count(*)::int n from notifications where user_id=$1 and kind='quote_requested'`, [M])).rows[0].n;
  assert.equal(n, 1, 'manager notified of quote request');
  assert.match(d.priority_reasons.fit.find(f => f.factor === 'Speedy work evidence').text, /Contact confirmed the need/);
});

await test('Rules: reason required for Lost; follow-up needs a date; others cannot log on my lead', async () => {
  await a.fails('log_activity', { p_id: mine, p: { stage: 'lost' } }, /reason_required/);
  await b.fails('log_activity', { p_id: mine, p: { kind: 'note', body: 'hi' } }, /not_owner/);
  await b.fails('release_opportunity', { p_id: mine }, /not_owner/);
  const avail = await opp(`stage='available' and not needs_review`);
  await b.fails('log_activity', { p_id: avail.id, p: { kind: 'call' } }, /claim_first/);
});

await test('Other reps see who owns it and when it was last worked, but not the notes or quote', async () => {
  const d = await b.rpc('get_opportunity', { p_id: mine });
  assert.equal(d.owner_name, 'Test Flip'); assert.ok(d.last_activity_at);
  assert.equal(d.quote_amount, undefined); assert.equal(d.next_action_due, undefined);
  const call = d.timeline.find(t => t.kind === 'call');
  assert.equal(call.hidden, true); assert.equal(call.body, undefined);
  const md = await m.rpc('get_opportunity', { p_id: mine });
  assert.ok(md.timeline.find(t => t.kind === 'call').body, 'manager sees notes');
});

await test('Saved work shows up on a second device (new session, same user)', async () => {
  const phone = await session(A);
  await phone.rpc('log_activity', { p_id: mine, p: { kind: 'text', body: 'Texted Dana the GPR sheet', next_action_due: '2026-11-12' } });
  const laptop = await session(A);
  const d = await laptop.rpc('get_opportunity', { p_id: mine });
  assert.equal(d.next_action_due, '2026-11-12');
  assert.ok(d.timeline.some(t => t.body === 'Texted Dana the GPR sheet'));
  await phone.end(); await laptop.end();
});

await test('Contacts: add a verified contact; old values kept when corrected', async () => {
  const r = await a.rpc('save_contact', { p: { opportunity_id: mine, name: 'Dana Ruiz', title: 'Estimator', phone: '407-555-0100', verified: true } });
  assert.equal(r.ok, true);
  await a.rpc('save_contact', { p: { opportunity_id: mine, id: r.id, phone: '407-555-0199' } });
  const d = await a.rpc('get_opportunity', { p_id: mine });
  const c = d.contacts.find(c => c.id === r.id);
  assert.equal(c.phone, '407-555-0199'); assert.equal(c.verified, true);
  const upd = d.timeline.find(t => t.kind === 'contact' && t.data?.old);
  assert.equal(upd.data.old.phone, '407-555-0100');
  await b.fails('save_contact', { p: { opportunity_id: mine, name: 'Nope', phone: '1' } }, /not_owner/);
});

// ---------------------------------------------------------------- refreshes
const run = async (src = 'sam_gov') => svc.rpc('refresh_start_run', { p_source: src, p_trigger: 'test' });
await test('Refresh changes a deadline without touching ownership, notes, quote or follow-up', async () => {
  const o = (await admin.query(`select o.id, p.external_key, p.deadline from opportunities o join projects p on p.id=o.project_id where o.id=$1`, [mine])).rows[0];
  // give the owned lead a quote first
  await a.rpc('log_activity', { p_id: mine, p: { kind: 'quote', stage: 'quote_sent', quote_amount: 18500, body: 'Sent $18,500 for coring + GPR' } });
  const before = (await admin.query(`select owner_id, stage, quote_amount, next_action_due, next_action, (select count(*) from activities where opportunity_id=$1 and kind<>'refresh') acts from opportunities where id=$1`, [mine])).rows[0];
  const id = await run();
  const r = await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: o.external_key, source_id: 'sam_gov', deadline: '2026-12-15T14:00:00-05:00', status_text: 'Amendment 2 posted', title: 'SHOUTY SOURCE TITLE' } });
  assert.equal(r.action, 'updated'); assert.ok(r.material.some(t => /Deadline changed/.test(t)));
  const after = (await admin.query(`select owner_id, stage, quote_amount, next_action_due, next_action, (select count(*) from activities where opportunity_id=$1 and kind<>'refresh') acts from opportunities where id=$1`, [mine])).rows[0];
  assert.deepEqual(after, before, 'sales fields unchanged');
  const p = (await admin.query(`select deadline, title, last_verified_at, verify_status from projects where external_key=$1`, [o.external_key])).rows[0];
  assert.equal(new Date(p.deadline).toISOString(), '2026-12-15T19:00:00.000Z');
  assert.notEqual(p.title, 'SHOUTY SOURCE TITLE', 'curated legacy title kept');
  assert.ok(p.last_verified_at); assert.equal(p.verify_status, 'ok');
  const note = (await admin.query(`select * from notifications where user_id=$1 and kind='source_change' and opportunity_id=$2`, [A, mine])).rows;
  assert.equal(note.length, 1, 'owner notified');
  await svc.rpc('refresh_finish_run', { p_run: id, p_status: 'success', p_counts: { fetched: 1, updated: 1 }, p_log: ['ok'] });
  // same data again: nothing changes, no duplicate notification
  const id2 = await run();
  const r2 = await svc.rpc('refresh_upsert_project', { p_run: id2, p: { external_key: o.external_key, source_id: 'sam_gov', deadline: '2026-12-15T14:00:00-05:00' } });
  assert.equal(r2.action, 'unchanged');
});

await test('Cancelled project: owner told, lead flagged for review, stage left alone', async () => {
  const o = (await admin.query(`select o.id, o.stage, p.external_key from opportunities o join projects p on p.id=o.project_id where o.id=$1`, [mine])).rows[0];
  const id = await run();
  const r = await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: o.external_key, source_id: 'sam_gov', stage: 'cancelled' } });
  assert.ok(r.material.includes('The agency cancelled this project'));
  const after = await opp(`id='${mine}'`);
  assert.equal(after.stage, o.stage); assert.equal(after.needs_review, true); assert.equal(after.review_kind, 'cancelled');
  assert.equal(after.urgency_score, 0);
});

await test('Uncertain awards: low bidder is not a winner; upgrades only forward; one outreach lead per winner', async () => {
  const t = await opp(`kind='gov_bid' and stage='available' and approach='track_award' and not needs_review`);
  const id = await run('fdot_lettings');
  const r1 = await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: t.external_key, source_id: 'fdot_lettings',
    winner: { name: 'ACME PAVING OF FLORIDA, LLC', amount: 1234567, status: 'low_bidder', as_of: '2026-11-05' } } });
  assert.equal(r1.opportunities_created, 1);
  let p = (await admin.query(`select stage, winner_status, winner_name from projects where external_key=$1`, [t.external_key])).rows[0];
  assert.equal(p.winner_status, 'low_bidder'); assert.equal(p.stage, 'low_bidder');
  const tracker = await opp(`id='${t.id}'`);
  assert.equal(tracker.stage, 'archived', 'unowned tracker replaced, not duplicated'); assert.ok(tracker.superseded_by);
  const outreach = await opp(`id='${tracker.superseded_by}'`);
  assert.equal(outreach.approach, 'approach_prime'); assert.equal(outreach.stage, 'available');
  assert.match(outreach.next_action, /not final/);
  // intended award: upgrade, same company, no new lead
  const r2 = await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: t.external_key, source_id: 'fdot_lettings',
    winner: { name: 'Acme Paving of Florida LLC', status: 'intended', as_of: '2026-11-12' } } });
  assert.equal(r2.opportunities_created, 0);
  p = (await admin.query(`select winner_status from projects where external_key=$1`, [t.external_key])).rows[0];
  assert.equal(p.winner_status, 'intended');
  // a stale "low bidder" read never downgrades
  await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: t.external_key, source_id: 'fdot_lettings',
    winner: { name: 'Acme Paving of Florida LLC', status: 'low_bidder' } } });
  p = (await admin.query(`select winner_status from projects where external_key=$1`, [t.external_key])).rows[0];
  assert.equal(p.winner_status, 'intended');
  const outs = (await admin.query(`select count(*)::int n from opportunities o join companies c on c.id=o.company_id where c.name_key = 'acme paving' `)).rows[0].n;
  assert.equal(outs, 1);
});

await test('Owned bid tracker: new outreach lead goes to the same salesperson', async () => {
  const t = await opp(`kind='gov_bid' and stage='available' and approach='track_award' and not needs_review`);
  await b.rpc('claim_opportunity', { p_id: t.id, p_ack_company: true });
  const id = await run('fdot_lettings');
  await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: t.external_key, source_id: 'fdot_lettings',
    winner: { name: 'Beta Civil Inc', amount: 999, status: 'awarded', as_of: '2026-11-04' } } });
  const out = (await admin.query(`select o.* from opportunities o join companies c on c.id=o.company_id where c.name_key='beta civil'`)).rows[0];
  assert.equal(out.owner_id, B); assert.equal(out.stage, 'claimed');
  const tracker = await opp(`id='${t.id}'`);
  assert.equal(tracker.owner_id, B); assert.notEqual(tracker.stage, 'archived', 'owned work is never archived by a refresh');
  const n = (await admin.query(`select count(*)::int n from notifications where user_id=$1 and kind='award'`, [B])).rows[0].n;
  assert.equal(n, 1);
});

await test('Failed refresh is visible and does not mark data as freshly verified', async () => {
  const p = (await admin.query(`select external_key, last_verified_at from projects where verify_status='not_checked' limit 1`)).rows[0];
  const id = await run('fdot_lettings');
  await svc.rpc('refresh_mark_failed', { p_keys: [p.external_key] });
  await svc.rpc('refresh_finish_run', { p_run: id, p_status: 'failed', p_counts: { errors: 1 }, p_log: ['GET ... 503 after 3 tries'], p_error: 'FDOT site returned 503' });
  const after = (await admin.query(`select last_verified_at, verify_status, last_checked_at from projects where external_key=$1`, [p.external_key])).rows[0];
  assert.equal(after.last_verified_at, null); assert.equal(after.verify_status, 'failed'); assert.ok(after.last_checked_at);
  const s = (await admin.query(`select last_status, consecutive_failures, last_error from sources where id='fdot_lettings'`)).rows[0];
  assert.equal(s.last_status, 'failed'); assert.equal(s.consecutive_failures, 1); assert.match(s.last_error, /503/);
  const st = await m.rpc('sources_status');
  assert.equal(st.runs[0].status, 'failed'); assert.ok(st.freshness.failed >= 1);
  const note = (await admin.query(`select count(*)::int n from notifications where user_id=$1 and kind='refresh_failed'`, [M])).rows[0].n;
  assert.equal(note, 1);
  // recovery
  const id2 = await run('fdot_lettings');
  await svc.rpc('refresh_upsert_project', { p_run: id2, p: { external_key: p.external_key, source_id: 'fdot_lettings', status_text: 'Results posted' } });
  await svc.rpc('refresh_finish_run', { p_run: id2, p_status: 'success', p_counts: { fetched: 1, updated: 1 }, p_log: [] });
  const s2 = (await admin.query(`select last_status, consecutive_failures from sources where id='fdot_lettings'`)).rows[0];
  assert.equal(s2.consecutive_failures, 0); assert.equal(s2.last_status, 'success');
  const ok = (await admin.query(`select last_verified_at, verify_status from projects where external_key=$1`, [p.external_key])).rows[0];
  assert.ok(ok.last_verified_at); assert.equal(ok.verify_status, 'ok');
});

await test('Refresh discovers a new project once; re-running merges instead of duplicating', async () => {
  const id = await run();
  const body = { external_key: 'sam:test-new-1', source_id: 'sam_gov', title: 'Demolition of Building 12, Orlando VA', solicitation_no: '36C24827B9999',
    region: 'Central FL', city: 'Orlando', stage: 'bidding', deadline: '2026-12-01T14:00:00-05:00', source_url: 'https://sam.gov/opp/x/view',
    source_summary: 'Selective demolition and concrete removal.', relevance: 'high',
    opportunity: { kind: 'gov_bid', approach: 'quote_bidders', title: 'Orlando VA Bldg 12 demolition', next_action: 'Call bidders' } };
  const r1 = await svc.rpc('refresh_upsert_project', { p_run: id, p: body });
  const r2 = await svc.rpc('refresh_upsert_project', { p_run: id, p: { ...body, external_key: 'sam:test-new-1-amended' } });  // same solicitation, new notice id
  assert.equal(r1.action, 'discovered'); assert.equal(r2.merged, true);
  const n = (await admin.query(`select count(*)::int n from projects where sol_key = '36C24827B9999'`)).rows[0].n;
  assert.equal(n, 1);
  const o = (await admin.query(`select count(*)::int n from opportunities o join projects p on p.id=o.project_id where p.sol_key='36C24827B9999'`)).rows[0].n;
  assert.equal(o, 1);
  const low = await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'sam:test-low', source_id: 'sam_gov', title: 'Janitorial services', relevance: 'low', opportunity: { kind: 'gov_bid', approach: 'quote_bidders' } } });
  assert.equal(low.flagged, 1, 'low-relevance discovery goes to review, not the pool');
});

await test('Legacy record found again by solicitation number is merged, not duplicated', async () => {
  const p = (await admin.query(`select external_key, solicitation_no from projects where source_id='legacy_import' and solicitation_no like 'W9127826RA%' limit 1`)).rows[0];
  const id = await run();
  const r = await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'sam:abc123', source_id: 'sam_gov', solicitation_no: p.solicitation_no, title: 'X' } });
  assert.equal(r.merged, true);
  const n = (await admin.query(`select count(*)::int n, max(array_length(alt_keys,1)) k from projects where sol_key = private.norm_sol($1)`, [p.solicitation_no])).rows[0];
  assert.equal(n.n, 1); assert.ok(n.k >= 1);
});

// ---------------------------------------------------------------- stale claims, upkeep
await test('Stale claims are suggested for review, never auto-released', async () => {
  const o = (await admin.query(`select id from opportunities where owner_id=$1 and stage='claimed' limit 1`, [A])).rows[0]
    || (await admin.query(`select id from opportunities where owner_id=$1 limit 1`, [A])).rows[0];
  await admin.query(`update opportunities set stage='claimed', claimed_at = now() - interval '20 days', last_activity_at = null where id=$1`, [o.id]);
  const r = await svc.rpc('daily_maintenance');
  assert.ok(r.stale >= 1);
  const after = await opp(`id='${o.id}'`);
  assert.equal(after.owner_id, A);
  const team = await m.rpc('team_overview');
  assert.ok(team.stale_list.some(s => s.id === o.id));
  assert.ok((await a.rpc('get_board')).find(r => r.id === o.id).stale);
  const before = (await admin.query('select count(*)::int n from notifications')).rows[0].n;
  await svc.rpc('daily_maintenance');
  assert.equal((await admin.query('select count(*)::int n from notifications')).rows[0].n, before, 'no repeat notifications');
});

await test('Daily upkeep closes past-deadline bids and points them at the award', async () => {
  const { rows } = await admin.query(`select count(*)::int n from projects where stage='bidding' and deadline < now()`);
  await svc.rpc('daily_maintenance');
  const left = (await admin.query(`select count(*)::int n from projects where stage='bidding' and deadline < now()`)).rows[0].n;
  assert.equal(left, 0);
  if (rows[0].n) {
    const t = (await admin.query(`select o.approach from opportunities o join projects p on p.id=o.project_id where p.stage='bid_closed' and o.owner_id is null and o.kind='gov_bid' and o.legacy_id = 'opps/mdc-srts-northwestern'`)).rows[0];
    if (t) assert.equal(t.approach, 'track_award');
  }
});

// ---------------------------------------------------------------- exports and import
await test('Exports: rep gets only their own pipeline; manager gets the team', async () => {
  const mineX = await a.rpc('export_rows', { p_scope: 'mine' });
  const own = (await admin.query(`select count(*)::int n from opportunities where owner_id=$1`, [A])).rows[0].n;
  assert.equal(mineX.rows.length, own); assert.ok(mineX.rows.every(r => r.owner_name === 'Test Flip'));
  assert.ok(mineX.generated_at);
  const team = await m.rpc('export_rows', { p_scope: 'team' });
  const all = (await admin.query(`select count(*)::int n from opportunities where stage <> 'archived' and not (stage='available' and needs_review)`)).rows[0].n;
  assert.equal(team.rows.length, all);
  const r = mineX.rows.find(r => r.id === mine);
  assert.ok(r.recent_notes.includes('Sent $18,500'));
});

await test('Workbook import: preview first, never overwrites newer portal work, no duplicates on re-import', async () => {
  const ref = (await admin.query(`select ref from opportunities where id=$1`, [mine])).rows[0].ref;
  const rows = [
    { row: 2, sheet: 'Sales Leads', ref, status: 'Won', last_contact: '2026-10-01', next_follow_up: '2026-10-05', notes: 'Old sheet note from Oct 1' },
    { row: 3, sheet: 'Sales Leads', ref: 'OPP-99999', status: 'Called', notes: 'no match' },
  ];
  const pv = await a.rpc('import_preview', { p_rows: rows });
  const c = pv[0].changes;
  assert.equal(c.find(x => x.field === 'note').apply, true);
  assert.equal(c.find(x => x.field === 'stage').apply, false, 'portal activity is newer than the sheet');
  assert.match(pv[1].skip, /No matching/);
  const before = await opp(`id='${mine}'`);
  const ap = await a.rpc('import_apply', { p_rows: rows, p_file: 'test.xlsx' });
  assert.equal(ap.notes_added, 1); assert.equal(ap.stages_changed, 0);
  const after = await opp(`id='${mine}'`);
  assert.equal(after.stage, before.stage); assert.equal(after.next_action_due?.toISOString(), before.next_action_due?.toISOString());
  const again = await a.rpc('import_apply', { p_rows: rows, p_file: 'test.xlsx' });
  assert.equal(again.notes_added, 0);
  const n = (await admin.query(`select count(*)::int n from activities where opportunity_id=$1 and kind='import' and body like '%Old sheet note%'`, [mine])).rows[0].n;
  assert.equal(n, 1);
  const pvB = await b.rpc('import_preview', { p_rows: rows });
  assert.match(pvB[0].skip, /Not in your pipeline/);
});

// ---------------------------------------------------------------- manager tools
await test('Manager assigns, reassigns and releases with history; deactivated rep is locked out at once', async () => {
  const o = await opp(`stage='available' and not needs_review and not exists (select 1 from ownership_history h where h.opportunity_id = z.id)`);
  await m.rpc('assign_opportunity', { p_id: o.id, p_user: A, p_reason: 'Knows the GC' });
  await m.rpc('assign_opportunity', { p_id: o.id, p_user: B, p_reason: 'Flip on vacation' });
  await m.rpc('release_opportunity', { p_id: o.id, p_reason: 'Back to pool' });
  const d = await m.rpc('get_opportunity', { p_id: o.id });
  assert.deepEqual(d.ownership.map(h => h.action), ['release', 'reassign', 'assign']);
  assert.equal(d.stage, 'available');
  await admin.query(`update profiles set active=false where id=$1`, [B]);
  await b.fails('get_board', {}, /not_authorized/);
  await admin.query(`update profiles set active=true where id=$1`, [B]);
});

await test('Manager adds a lead by hand; same link twice is caught as a duplicate', async () => {
  const lead = { project_title: 'Orlando Health South Lake tower', source_url: 'https://example.com/news/1', company_name: 'Test Builders Inc', region: 'Central FL', services: ['Core drilling'] };
  const r1 = await m.rpc('add_lead', { p: lead });
  assert.equal(r1.ok, true);
  const r2 = await m.rpc('add_lead', { p: lead });
  assert.equal(r2.ok, false); assert.equal(r2.reason, 'possible_duplicate');
});

await test('Team overview and settings work for managers', async () => {
  const t = await m.rpc('team_overview');
  assert.ok(t.people.find(p => p.name === 'Test Flip').open >= 1);
  assert.ok(Array.isArray(t.source_productivity));
  // each pipeline number means one thing: the Team page's "available" is the pool salespeople can claim
  const pool = (await a.rpc('get_board')).filter(r => r.stage === 'available').length;
  assert.equal(t.pipeline.available || 0, pool, 'team pipeline "available" = the Available list');
  const inReview = (await admin.query(`select count(*)::int n from opportunities where stage='available' and needs_review`)).rows[0].n;
  assert.equal(t.pipeline.in_review || 0, inReview, 'unreviewed finds are counted separately');
  const total = (await admin.query('select count(*)::int n from opportunities')).rows[0].n;
  assert.equal(Object.values(t.pipeline).reduce((s, n) => s + n, 0), total, 'every opportunity counted exactly once');
  assert.ok('last_activity_at' in t.people.find(p => p.name === 'Test Flip'));
  // one person's history is for managers only
  const hist = await m.rpc('person_activity', { p_user: A });
  assert.ok(Array.isArray(hist) && hist.length >= 1 && hist.every(h => h.at && h.kind));
  await a.fails('person_activity', { p_user: A }, /manager_only/);
  await anon.fails('person_activity', { p_user: A }, /permission denied/);
  await m.rpc('update_setting', { p_key: 'stale_days', p_value: '10' });
  await m.fails('update_setting', { p_key: 'stale_days', p_value: '1' }, /bad_value/);
  await m.rpc('update_setting', { p_key: 'stale_days', p_value: '14' });
});


// ---------------------------------------------------------------- statewide discovery
const proj = async (key) => (await admin.query(`select * from projects where external_key = $1 or $1 = any(alt_keys)`, [key])).rows[0];
const oppsOf = async (pid) => (await admin.query(`select * from opportunities where project_id = $1 order by created_at`, [pid])).rows;

await test('Discovery routing: documented scope goes to the pool and alerts managers, inferred goes to the pool, weak signals go to review', async () => {
  const id = await run();
  const base = { source_id: 'sam_gov', level: 'Federal', region: 'Central FL', county: 'Orange', city: 'Orlando', stage: 'bidding', deadline: '2099-02-01T14:00:00-05:00' };
  const hi = await svc.rpc('refresh_upsert_project', { p_run: id, p: { ...base, external_key: 'sam:disc-high', title: 'Concrete coring and wall sawing, Building 7', relevance: 'high', relevance_score: 6,
    evidence: [{ term: 'core drilling', confidence: 'documented', field: 'title', snippet: 'Concrete coring' }], category: 'Institutional & government', review_reason: 'Source names Speedy work: core drilling',
    opportunity: { kind: 'gov_bid', approach: 'bid_direct', title: 'Concrete coring and wall sawing, Building 7', next_action: 'Bid it' } } });
  const pot = await svc.rpc('refresh_upsert_project', { p_run: id, p: { ...base, external_key: 'sam:disc-pot', title: 'Lift station 12 rehabilitation, Apopka', relevance: 'potential',
    evidence: [{ term: 'lift / pump station', confidence: 'inferred', field: 'title', snippet: 'Lift station 12' }], opportunity: { kind: 'gov_bid', approach: 'quote_bidders', title: 'Lift station 12' } } });
  const rev = await svc.rpc('refresh_upsert_project', { p_run: id, p: { ...base, external_key: 'sam:disc-rev', title: 'Sidewalk gap program', relevance: 'review', review_reason: 'Weak signal: sidewalks / ADA',
    opportunity: { kind: 'gov_bid', approach: 'quote_bidders', title: 'Sidewalk gap program' } } });
  const [o1] = await oppsOf(hi.project_id), [o2] = await oppsOf(pot.project_id), [o3] = await oppsOf(rev.project_id);
  assert.equal(o1.needs_review, false); assert.equal(o2.needs_review, false); assert.equal(o3.needs_review, true); assert.equal(o3.review_kind, 'discovery');
  assert.match(o3.review_reason, /Weak signal/);
  const alerts = (await admin.query(`select * from notifications where user_id = $1 and kind = 'discovery' and opportunity_id = any($2)`, [M, [o1.id, o2.id, o3.id]])).rows;
  assert.equal(alerts.length, 1, 'one alert for the documented-scope find only'); assert.match(alerts[0].title, /Confirmed Speedy scope: Concrete coring/);
  await svc.rpc('refresh_upsert_project', { p_run: id, p: { ...base, external_key: 'sam:disc-high', title: 'Concrete coring and wall sawing, Building 7', relevance: 'high' } });
  assert.equal((await admin.query(`select count(*)::int n from notifications where kind = 'discovery' and opportunity_id = $1`, [o1.id])).rows[0].n, 1, 'no repeat alert for an unchanged project');
  const p1 = await proj('sam:disc-high');
  assert.equal(p1.relevance, 'high'); assert.equal(p1.evidence[0].confidence, 'documented');
  const detail = await a.rpc('get_opportunity', { p_id: o1.id });
  assert.equal(detail.project.evidence[0].term, 'core drilling'); assert.equal(detail.project.category, 'Institutional & government');
  const scored = await opp(`id = '${o1.id}'`);
  assert.ok(scored.priority_reasons.fit.some(f => f.factor === 'Speedy work evidence' && /Source documents core drilling/.test(f.text)));
  const board = await b.rpc('get_board', {});
  assert.ok(!board.some(r => r.id === o3.id), 'salespeople do not see review items');
});

await test('Same project on two sources: a federal award with the same solicitation number merges into the SAM.gov project', async () => {
  const id = await run('usaspending_awards');
  const samP = await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'sam:merge-1', source_id: 'sam_gov', solicitation_no: '36C24826R0039', title: 'Renovate interventional radiology suites, Gainesville VAMC',
    level: 'Federal', county: 'Alachua', region: 'Northeast FL', stage: 'bid_closed', relevance: 'potential', opportunity: { kind: 'gov_bid', approach: 'quote_bidders', title: 'Renovate IR suites' } } });
  const r = await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'usaspending:CONT_AWD_X1', alt_keys: ['piid:36C24827C0011'], source_id: 'usaspending_awards',
    solicitation_no: '36C24826R0039', title: 'Bb - renovate IR suites (different wording)', county: 'Alachua', region: 'Northeast FL', stage: 'awarded', relevance: 'potential',
    winner: { name: 'Blue Cord Design And Construction, LLC', amount: 12974316, status: 'awarded', as_of: '2026-10-15' } } });
  assert.equal(r.project_id, samP.project_id); assert.equal(r.merged, true);
  const p = await proj('sam:merge-1');
  assert.ok(p.alt_keys.includes('usaspending:CONT_AWD_X1') && p.alt_keys.includes('piid:36C24827C0011'));
  assert.match(p.title, /Gainesville VAMC/, 'the original source keeps its title');
  assert.equal(p.stage, 'awarded'); assert.equal(p.winner_status, 'awarded');
  const opps = await oppsOf(p.id);
  assert.equal(opps.filter(o => o.kind === 'contractor_outreach' && o.stage === 'available').length, 1, 'one outreach lead for the awardee');
  assert.equal(opps.find(o => o.kind === 'gov_bid').stage, 'archived', 'the bid tracker is replaced, not duplicated');
  const again = await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'usaspending:CONT_AWD_X1', source_id: 'usaspending_awards', stage: 'awarded',
    winner: { name: 'Blue Cord Design And Construction, LLC', amount: 12974316, status: 'awarded', as_of: '2026-10-15' } } });
  assert.equal(again.project_id, p.id); assert.equal((await oppsOf(p.id)).length, opps.length, 'second run adds nothing');
  const award = (await admin.query(`select count(*)::int n from notifications where kind = 'award' and user_id = $1`, [M])).rows[0].n;
  assert.equal(award, 1, 'managers get one alert for a relevant new award');
});

await test('Similar titles in the same county: clear matches merge, unclear ones are saved separately and sent to review as possible duplicates', async () => {
  const id = await run('orlando_permits');
  const first = await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'news:dup-1', source_id: 'private_news', title: 'Orlando Health Lakeland Highlands tower expansion',
    owner_name: 'Orlando Health', county: 'Orange', city: 'Orlando', region: 'Central FL', stage: 'planning', relevance: 'potential',
    opportunity: { kind: 'private_project', approach: 'approach_developer', title: 'Orlando Health tower' } } });
  const same = await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'orlando:BLD-DUP-1', source_id: 'orlando_permits', title: 'Orlando Health Lakeland Highlands Tower Expansion',
    owner_name: 'ORLANDO HEALTH INC', county: 'Orange', city: 'Orlando', region: 'Central FL', stage: 'permitting', relevance: 'potential',
    opportunity: { kind: 'private_project', approach: 'approach_prime', title: 'Brasfield & Gorrie — tower', company_name: 'Brasfield & Gorrie' } } });
  assert.equal(same.project_id, first.project_id); assert.equal(same.merged, true); assert.match(same.match_note, /another source/);
  const unclear = await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'orlando:BLD-DUP-2', source_id: 'orlando_permits', title: 'Orlando Health Lakeland parking tower',
    owner_name: 'Some Other Owner LLC', county: 'Orange', city: 'Orlando', region: 'Central FL', stage: 'permitting', relevance: 'potential',
    opportunity: { kind: 'private_project', approach: 'approach_prime', title: 'Parking tower', company_name: 'Finfrock Construction', company_phone: '(407) 293-4000' } } });
  assert.notEqual(unclear.project_id, first.project_id);
  assert.equal(unclear.duplicate_of, first.project_id);
  const [o] = await oppsOf(unclear.project_id);
  assert.equal(o.needs_review, true); assert.equal(o.review_kind, 'duplicate'); assert.match(o.review_reason, /Possible duplicate/);
  const c = (await admin.query(`select c.phone, c.source from contacts c join companies k on k.id = c.company_id where k.name_key = 'finfrock construction'`)).rows;
  assert.equal(c.length, 1); assert.equal(c[0].source, 'source_document');
  const d = await m.rpc('get_opportunity', { p_id: o.id });
  assert.equal(d.project.possible_duplicate.id, first.project_id);
  await m.rpc('resolve_review', { p_id: o.id, p_action: 'archive', p_note: 'Same job as the news lead' });
  assert.equal((await opp(`id = '${o.id}'`)).stage, 'archived');
});

await test('A cancellation from a different source does not cancel the project; one from its own source does', async () => {
  const id = await run('usaspending_awards');
  const p0 = await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'sam:cx-1', source_id: 'sam_gov', solicitation_no: 'W912EP26B0099', title: 'Seawall repair, Patrick SFB',
    county: 'Brevard', region: 'Central FL', stage: 'bidding', relevance: 'potential', deadline: '2099-03-01T14:00:00-05:00', opportunity: { kind: 'gov_bid', approach: 'quote_bidders', title: 'Seawall repair' } } });
  await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'usaspending:cx', source_id: 'usaspending_awards', solicitation_no: 'W912EP26B0099', stage: 'cancelled', title: 'x' } });
  assert.equal((await proj('sam:cx-1')).stage, 'bidding');
  const r = await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'sam:cx-1', source_id: 'sam_gov', stage: 'cancelled' } });
  assert.ok(r.material.includes('The agency cancelled this project')); assert.equal((await proj('sam:cx-1')).stage, 'cancelled');
});

await test('Discovery monitoring and search terms are manager-only; the refresh job reads the live vocabulary', async () => {
  const ov = await m.rpc('discovery_overview', {});
  assert.equal(ov.counties.length, 67); assert.equal(new Set(ov.counties.map(c => c.region)).size, 6);
  assert.ok(ov.sources.some(s => s.id === 'usaspending_awards' && s.kind === 'automated'));
  assert.ok(ov.sources.some(s => s.id === 'paid_platforms' && s.kind === 'paid'));
  assert.ok(ov.counties.find(c => c.county === 'Orange').local_sources.includes('City of Orlando commercial building permits'));
  assert.ok(ov.summary.awaiting_review >= 1); assert.ok(ov.summary.duplicates_open >= 0);
  await a.fails('discovery_overview', {}, /manager_only/);
  await a.fails('service_terms_list', {}, /manager_only/);
  await a.fails('save_service_term', { p: { label: 'x', pattern: 'x' } }, /manager_only/);
  await a.fails('discovery_terms', {}, /permission denied/);
  const terms = await svc.rpc('discovery_terms', {});
  assert.ok(terms.length > 40 && terms.some(t => t.label === 'core drilling' && t.kind === 'direct'));
  await m.fails('save_service_term', { p: { label: 'broken', pattern: '(abc', kind: 'direct' } }, /bad_pattern/);
  const saved = await m.rpc('save_service_term', { p: { label: 'helipad', pattern: 'helipads?', kind: 'direct', services: ['Slab sawing'] } });
  assert.ok((await svc.rpc('discovery_terms', {})).some(t => t.label === 'helipad'));
  await m.rpc('save_service_term', { p: { id: saved.id, enabled: false } });
  assert.ok(!(await svc.rpc('discovery_terms', {})).some(t => t.label === 'helipad'), 'turned-off terms are not used');
  assert.equal((await admin.query(`select count(*)::int n from projects where region in ('North FL','South FL')`)).rows[0].n, 0, 'old region names are gone');
});

await test('Run counts include what each refresh examined and how much of it was relevant', async () => {
  const id = await run('orlando_permits');
  await svc.rpc('refresh_finish_run', { p_run: id, p_status: 'success', p_counts: { examined: 120, relevant: 18, low: 102, fetched: 18, discovered: 5 }, p_log: ['ok'] });
  const r = (await admin.query(`select examined, relevant, low, discovered from refresh_runs where id = $1`, [id])).rows[0];
  assert.deepEqual(r, { examined: 120, relevant: 18, low: 102, discovered: 5 });
  const ov = await m.rpc('discovery_overview', {});
  assert.equal(ov.sources.find(s => s.id === 'orlando_permits').last_run.examined, 120);
});


// ---------------------------------------------------------------- daily operations
const freshClaim = async (sess, who) => {
  const o = await opp(`stage = 'available' and not needs_review and company_id is not null and project_id is not null`);
  await sess.rpc('claim_opportunity', { p_id: o.id, p_ack_company: true });
  return o.id;
};

await test('Call outcomes: no answer and voicemail do not mark a lead Contacted; reaching someone does; a quote request starts quote tracking', async () => {
  const id = await freshClaim(b);
  await b.rpc('log_activity', { p_id: id, p: { kind: 'call', outcome: 'no_answer' } });
  await b.rpc('log_activity', { p_id: id, p: { kind: 'call', outcome: 'voicemail', body: 'Left a message for the estimator' } });
  assert.equal((await opp(`id = '${id}'`)).stage, 'claimed');
  await b.fails('log_activity', { p_id: id, p: { kind: 'call', outcome: 'made_up' } }, /bad_outcome/);
  await b.rpc('log_activity', { p_id: id, p: { kind: 'call', outcome: 'spoke', body: 'Talked to Maria, PM' } });
  assert.equal((await opp(`id = '${id}'`)).stage, 'contacted');
  await b.rpc('log_activity', { p_id: id, p: { kind: 'call', outcome: 'quote_requested', quote_service: 'Wall sawing', quote_decision_date: '2099-01-15' } });
  let o = await opp(`id = '${id}'`);
  assert.equal(o.stage, 'quote_needed'); assert.equal(o.quote_status, 'requested'); assert.ok(o.quote_requested_at); assert.equal(o.quote_service, 'Wall sawing');
  await b.rpc('log_activity', { p_id: id, p: { kind: 'quote', stage: 'quote_sent', quote_amount: 18500, next_action_due: '2099-01-10' } });
  o = await opp(`id = '${id}'`);
  assert.equal(o.quote_status, 'sent'); assert.ok(o.quote_sent_at); assert.equal(Number(o.quote_amount), 18500);
  await b.rpc('log_activity', { p_id: id, p: { kind: 'note', stage: 'won', outcome_reason: 'Best price and schedule' } });
  assert.equal((await opp(`id = '${id}'`)).quote_status, 'accepted');
  const acts = (await admin.query(`select user_id, outcome, created_at from activities where opportunity_id = $1 and kind = 'call' order by created_at`, [id])).rows;
  assert.equal(acts.length, 4); assert.ok(acts.every(x => x.user_id === B && x.created_at));
});

await test('Company profile: one contractor across several projects, contact history shared without exposing other people\'s notes', async () => {
  const comp = (await admin.query(`select company_id from opportunities where company_id is not null group by 1 order by count(*) desc limit 1`)).rows[0].company_id;
  const o1 = (await admin.query(`select id from opportunities where company_id = $1 and stage = 'available' and not needs_review limit 1`, [comp])).rows[0];
  if (o1) { await a.rpc('claim_opportunity', { p_id: o1.id, p_ack_company: true }); await a.rpc('log_activity', { p_id: o1.id, p: { kind: 'call', outcome: 'spoke', body: 'PRIVATE NOTE from Flip' } }); }
  const forB = await b.rpc('get_company', { p_id: comp });
  const forM = await m.rpc('get_company', { p_id: comp });
  assert.ok(forB.opportunities.length >= 1 && forB.company.id === comp);
  if (o1) {
    const hb = forB.history.find(h => h.opportunity_id === o1.id), hm = forM.history.find(h => h.opportunity_id === o1.id);
    assert.equal(hb.user_name, 'Test Flip'); assert.equal(hb.body, null, 'another salesperson sees who called and when, not the note');
    assert.equal(hm.body, 'PRIVATE NOTE from Flip');
    assert.ok(forB.summary.owners.includes('Test Flip')); assert.ok(forB.summary.last_contact_at);
  }
  await anon.fails('get_company', { p_id: comp }, /permission denied/);
  await x.fails('get_company', { p_id: comp }, /not_authorized/);
});

await test('Watchlists: a watched project change and a contractor\'s new award notify the right people once', async () => {
  const id = await run('sam_gov');
  const p0 = await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'sam:watch-1', source_id: 'sam_gov', solicitation_no: 'W9-WATCH-1', title: 'Pier 3 repair, Mayport',
    county: 'Duval', region: 'Northeast FL', stage: 'bidding', relevance: 'potential', deadline: '2099-02-01T14:00:00-05:00', opportunity: { kind: 'gov_bid', approach: 'quote_bidders', title: 'Pier 3 repair' } } });
  assert.equal((await b.rpc('toggle_watch', { p_project: p0.project_id })).watching, true);
  // Rep Two also works another lead with the contractor that will win
  const comp = (await admin.query(`select private.upsert_company('Watchco Marine Builders', 'contractor') c`)).rows[0].c;
  const other = await freshClaim(b);
  await admin.query(`update opportunities set company_id = $1 where id = $2`, [comp, other]);
  await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'sam:watch-1', source_id: 'sam_gov', stage: 'awarded',
    winner: { name: 'Watchco Marine Builders', amount: 3100000, status: 'awarded', as_of: '2026-11-01' } } });
  const n = (await admin.query(`select title from notifications where user_id = $1 and kind = 'watch' order by id`, [B])).rows.map(r => r.title);
  assert.ok(n.some(t => /Watched project: Pier 3 repair/.test(t)), 'watcher told about the award');
  assert.ok(n.some(t => /contractor you work with has a new award/.test(t)), 'owner of another lead with that contractor told');
  await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'sam:watch-1', source_id: 'sam_gov', stage: 'awarded',
    winner: { name: 'Watchco Marine Builders', amount: 3100000, status: 'awarded', as_of: '2026-11-01' } } });
  assert.equal((await admin.query(`select count(*)::int n from notifications where user_id = $1 and kind = 'watch'`, [B])).rows[0].n, n.length, 'unchanged data, no repeat');
  assert.equal((await b.rpc('toggle_watch', { p_project: p0.project_id })).watching, false);
});

await test('Saved searches and preferences are personal; notification preferences are respected', async () => {
  await b.rpc('save_search', { p_list: 'pool', p_name: 'Central bridges', p_params: { region: 'Central FL', q: 'bridge' } });
  assert.equal((await b.rpc('my_saved_searches', {})).length, 1); assert.equal((await a.rpc('my_saved_searches', {})).length, 0);
  await b.fails('save_search', { p_list: 'all', p_name: 'x', p_params: {} }, /manager_only/);
  const sid = (await b.rpc('my_saved_searches', {}))[0].id;
  assert.equal((await a.rpc('delete_search', { p_id: sid })).ok, false, 'cannot delete someone else\'s');
  await b.fails('update_my_prefs', { p: { territory: ['Narnia'] } }, /bad_region/);
  await b.rpc('update_my_prefs', { p: { territory: ['Central FL', 'Tampa Bay'], services: ['Wall sawing'], notify: { deadlines: false, hack: true } } });
  const me = await b.rpc('me', {});
  assert.deepEqual(me.prefs.territory, ['Central FL', 'Tampa Bay']); assert.equal(me.prefs.notify.hack, undefined);
  await admin.query(`select private.notify($1, null, 'deadline_soon', 'Test deadline', 'x', 'pref-test-1')`, [B]);
  await admin.query(`select private.notify($1, null, 'manager_update', 'Test update', 'x', 'pref-test-2')`, [B]);
  const got = (await admin.query(`select dedupe_key from notifications where dedupe_key like 'pref-test-%'`)).rows.map(r => r.dedupe_key);
  assert.deepEqual(got, ['pref-test-2']);
});

await test('Morning schedule (Eastern time): collect once, retry failures, snapshot, alert only when incomplete, midday check', async () => {
  await admin.query(`delete from private.test_refresh_calls; delete from private.scheduler_steps; delete from morning_snapshots`);
  await pushRunsBack();
  const auto = (await admin.query(`select id from sources where kind = 'automated' and enabled order by id`)).rows.map(r => r.id);
  const tick = async (iso) => (await admin.query(`select private.scheduler_tick($1::timestamptz) r`, [iso])).rows[0].r;
  const calls = async () => (await admin.query(`select source from private.test_refresh_calls order by id`)).rows.map(r => r.source);
  assert.deepEqual((await tick('2026-11-12 04:05-05')).ran, [], 'nothing before 4:15');
  assert.deepEqual((await tick('2026-11-12 04:17-05')).ran, ['morning']);
  assert.deepEqual((await tick('2026-11-12 04:22-05')).ran, [], 'a second tick does not start the cycle again');
  assert.deepEqual((await calls()).sort(), auto);
  // the runs finish: all succeed except permits
  const snap = (await admin.query(`select started_at from morning_snapshots where day = '2026-11-12'`)).rows[0];
  for (const src of auto) {
    const r = (await admin.query(`insert into refresh_runs (source_id, trigger, started_at, status, finished_at, error) values ($1, 'schedule', $2::timestamptz + interval '1 minute', $3, $2::timestamptz + interval '3 minutes', $4) returning id`,
      [src, snap.started_at, src === 'orlando_permits' ? 'failed' : 'success', src === 'orlando_permits' ? 'HTTP 503' : null])).rows[0];
  }
  assert.deepEqual((await tick('2026-11-12 05:16-05')).ran, ['verify']);
  assert.deepEqual((await calls()).filter(x => x === 'orlando_permits').length, 2, 'the failed source is retried once');
  assert.deepEqual((await tick('2026-11-12 05:31-05')).ran, ['snapshot']);
  let s = (await admin.query(`select * from morning_snapshots where day = '2026-11-12'`)).rows[0];
  assert.equal(s.status, 'partial'); assert.equal(s.summary.sources_ok, auto.length - 1);
  const fr = await b.rpc('data_freshness', {});
  assert.equal(fr.status, 'partial'); assert.equal(fr.sources_total, auto.length); assert.equal(fr.sources[0].error, undefined, 'salespeople get no error text');
  assert.deepEqual((await tick('2026-11-12 06:02-05')).ran, ['alert']);
  const al = (await admin.query(`select title, body from notifications where user_id = $1 and kind = 'morning_refresh'`, [M])).rows;
  assert.equal(al.length, 1); assert.match(al[0].title, /incomplete/); assert.match(al[0].body, /City of Orlando commercial building permits \(failed: HTTP 503\)/);
  assert.deepEqual((await tick('2026-11-12 06:07-05')).ran, [], 'one alert per day');
  assert.deepEqual((await tick('2026-11-12 12:20-05')).ran, ['midday']);
  // next day everything succeeds by 6 AM: no alert
  for (const src of auto) await admin.query(`insert into refresh_runs (source_id, trigger, started_at, status, finished_at) values ($1, 'schedule', '2026-11-13 04:20-05', 'success', '2026-11-13 04:25-05')`, [src]);
  await tick('2026-11-13 04:16-05');
  await admin.query(`update morning_snapshots set started_at = '2026-11-13 04:16-05' where day = '2026-11-13'`);
  await tick('2026-11-13 05:20-05'); await tick('2026-11-13 05:35-05'); await tick('2026-11-13 06:05-05');
  s = (await admin.query(`select * from morning_snapshots where day = '2026-11-13'`)).rows[0];
  assert.equal(s.status, 'ready'); assert.equal(s.alerted_at, null);
  // daylight saving time: 4:17 AM EDT in July is 08:17 UTC
  await admin.query(`delete from private.test_refresh_calls`);
  assert.deepEqual((await tick('2027-07-14 08:17+00')).ran, ['morning']);
  assert.ok(!(await tick('2027-07-14 09:17+00')).ran.includes('morning'), '5:17 AM EDT is not the start time');
});

await test('Missed morning step: the 5:15 check starts the collection itself; no false "not run" alarm', async () => {
  await admin.query(`delete from private.test_refresh_calls; delete from private.scheduler_steps where day = '2026-11-20'; delete from morning_snapshots where day = '2026-11-20'`);
  await pushRunsBack();
  const auto = (await admin.query(`select id from sources where kind = 'automated' and enabled order by id`)).rows.map(r => r.id);
  const tick = async (iso) => (await admin.query(`select private.scheduler_tick($1::timestamptz) r`, [iso])).rows[0].r;
  assert.deepEqual((await tick('2026-11-20 05:40-05')).ran, ['verify'], 'collection starts; the snapshot waits for it');
  assert.deepEqual((await admin.query(`select source from private.test_refresh_calls order by source`)).rows.map(r => r.source), auto, 'late start ran every source');
  for (const src of auto) await admin.query(`insert into refresh_runs (source_id, trigger, started_at, status, finished_at) values ($1, 'schedule', '2026-11-20 05:41-05', 'success', '2026-11-20 05:44-05')`, [src]);
  await tick('2026-11-20 05:50-05'); await tick('2026-11-20 06:05-05');
  const s = (await admin.query(`select * from morning_snapshots where day = '2026-11-20'`)).rows[0];
  assert.equal(s.status, 'ready'); assert.equal(s.alerted_at, null);
  // nothing ran at all before the snapshot (e.g. the scheduler was switched on mid-morning): runs since midnight count
  await admin.query(`delete from private.scheduler_steps where day = '2026-11-21'; delete from morning_snapshots where day = '2026-11-21'`);
  for (const src of auto) await admin.query(`insert into refresh_runs (source_id, trigger, started_at, status, finished_at) values ($1, 'schedule', '2026-11-21 04:00-05', 'success', '2026-11-21 04:03-05')`, [src]);
  await tick('2026-11-21 07:05-05');
  assert.equal((await admin.query(`select status from morning_snapshots where day = '2026-11-21'`)).rows[0].status, 'ready');
});

await test('Early signals: a property sale and a later rezoning on the same parcel show as one story; tracking one makes a claimed lead', async () => {
  const run = await svc.rpc('refresh_start_run', { p_source: 'orange_land_sales', p_trigger: 'test' });
  const sale = { external_key: 'ocsale:TEST01:2026-10-01', source_id: 'orange_land_sales', title: 'Test Holdings LLC bought 8 acres of vacant land at 1 Test Rd',
    level: 'Private', county: 'Orange', region: 'Central FL', stage: 'land', relevance: 'review', published_at: '2026-10-01', source_summary: 'Qualified sale' };
  await svc.rpc('refresh_upsert_project', { p_run: run, p: sale });
  await svc.rpc('refresh_project_extras', { p_key: sale.external_key, p: { signal_type: 'land_sale', parcel_id: 'TEST-PARCEL-1', acreage: 8,
    stakeholders: [{ role: 'buyer', name: 'Test Holdings LLC', address: '1 Main St', source: 'sale' }] } });
  const rz = { ...sale, external_key: 'occase:TEST02', source_id: 'orange_dev_cases', title: 'Test Commons PD (Land Use Plan)', stage: 'planning', published_at: '2026-11-01' };
  await svc.rpc('refresh_upsert_project', { p_run: run, p: rz });
  const r = await svc.rpc('refresh_project_extras', { p_key: rz.external_key, p: { signal_type: 'rezoning', parcel_id: 'TEST-PARCEL-1',
    stakeholders: [{ role: 'engineer', name: 'Test Civil Inc', source: 'case' }, { role: 'buyer', name: 'TEST HOLDINGS, LLC', source: 'case' }] } });
  assert.equal(r.same_parcel, 1);
  // signed-out and inactive callers get nothing; the service-only function is closed to users
  await anon.fails('early_signals', {}, /./); await x.fails('early_signals', {}, /not_authorized/);
  await b.fails('refresh_project_extras', { p_key: rz.external_key, p: {} }, /permission denied/);
  const list = await b.rpc('early_signals', { p: { days: 3650 } });
  const mine = list.items.filter(i => /^Test /.test(i.title));
  assert.equal(mine.length, 2); assert.equal(mine[0].signal_type, 'rezoning', 'newest first'); assert.equal(mine[0].same_parcel, 1);
  assert.equal((await b.rpc('early_signals', { p: { days: 3650, type: 'land_sale', q: 'Test Holdings' } })).items.length, 1);
  const pid = mine[1].id;
  assert.equal((await opp(`project_id = '${pid}'`)), undefined, 'a sale is not a lead until someone tracks it');
  const t1 = await b.rpc('track_signal', { p_project: pid });
  assert.equal(t1.claimed, true);
  const o = await opp(`id = '${t1.id}'`);
  assert.equal(o.owner_id, B); assert.equal(o.approach, 'approach_developer'); assert.match(o.next_action, /Test Holdings LLC plans to build/);
  const t2 = await a.rpc('track_signal', { p_project: pid });
  assert.equal(t2.existing, true, 'a second person opens the same lead instead of creating another');
  const people = await a.rpc('project_people', { p_project: mine[0].id });
  assert.equal(people.related.length, 1); assert.equal(people.related[0].opp, t1.id);
  assert.equal(people.stakeholders.length, 2, 'buyer named twice with different punctuation is kept once per record');
  assert.equal((await b.rpc('early_signals', { p: { days: 3650, tracked: 'untracked', q: 'Test' } })).items.length, 1);
  // a source record the filters now reject leaves the list; a lead made from it is archived only if nobody worked it
  const run2 = await svc.rpc('refresh_start_run', { p_source: 'orlando_planning', p_trigger: 'test' });
  for (const [k, t] of [['orlplan:TEST-HOME', 'Test house porch'], ['orlplan:TEST-WORKED', 'Test worked office']]) {
    await svc.rpc('refresh_upsert_project', { p_run: run2, p: { external_key: k, source_id: 'orlando_planning', title: t, level: 'Private', city: 'Orlando', county: 'Orange',
      region: 'Central FL', stage: 'design', relevance: 'potential', source_summary: t, opportunity: { kind: 'private_project', approach: 'approach_developer', title: t } } });
    await svc.rpc('refresh_project_extras', { p_key: k, p: { signal_type: 'site_plan' } });
  }
  const worked = await opp(`external_key = 'orlplan:TEST-WORKED'`);
  await a.rpc('claim_opportunity', { p_id: worked.id });
  await a.rpc('log_activity', { p_id: worked.id, p: { kind: 'note', body: 'called' } });
  const ret = await svc.rpc('refresh_retire_signals', { p_keys: ['orlplan:TEST-HOME', 'orlplan:TEST-WORKED', 'orlplan:NOT-THERE'] });
  assert.deepEqual(ret, { retired: 2, archived_leads: 1 });
  assert.equal((await opp(`external_key = 'orlplan:TEST-HOME'`)).stage, 'archived');
  assert.notEqual((await opp(`external_key = 'orlplan:TEST-WORKED'`)).stage, 'archived', 'work someone started is never archived automatically');
  assert.equal((await b.rpc('early_signals', { p: { days: 3650, q: 'Test house' } })).items.length, 0);
  // keep the signal but take an unworked lead out of Available
  await svc.rpc('refresh_upsert_project', { p_run: run2, p: { external_key: 'orlplan:TEST-KEEP', source_id: 'orlando_planning', title: 'Test keep office signage', level: 'Private',
    city: 'Orlando', county: 'Orange', region: 'Central FL', stage: 'design', relevance: 'potential', source_summary: 'x', opportunity: { kind: 'private_project', approach: 'approach_developer', title: 'Test keep' } } });
  await svc.rpc('refresh_project_extras', { p_key: 'orlplan:TEST-KEEP', p: { signal_type: 'site_plan' } });
  assert.deepEqual(await svc.rpc('refresh_retire_signals', { p_keys: ['orlplan:TEST-KEEP'], p_keep_signal: true }), { retired: 0, archived_leads: 1 });
  const kept = (await b.rpc('early_signals', { p: { days: 3650, q: 'Test keep' } })).items;
  assert.equal(kept.length, 1); assert.equal(kept[0].opportunity, null, 'listed again as untracked, so anyone can still track it');
  await b.fails('refresh_retire_signals', { p_keys: ['x'], p_keep_signal: false }, /permission denied/);
});

await test('Lead score: gates keep big speculative projects out of Hot; documented scope + fresh award + verified contact is Hot; expired bids say so', async () => {
  const run = await svc.rpc('refresh_start_run', { p_source: 'fdot_lettings', p_trigger: 'test' });
  const mk = async (key, p) => { await svc.rpc('refresh_upsert_project', { p_run: run, p: { external_key: key, source_id: 'fdot_lettings', level: 'State', county: 'Orange', region: 'Central FL', ...p } });
    return (await admin.query(`select o.* from opportunities o join projects p on p.id = o.project_id where p.external_key = $1`, [key])).rows[0]; };
  // a huge planning-stage development with no stated cutting scope
  const big = await mk('score:big', { title: 'Score test mega development', stage: 'planning', project_value: 900000000, relevance: 'potential',
    evidence: [{ term: 'redevelopment', confidence: 'inferred' }], opportunity: { kind: 'private_project', approach: 'approach_developer', title: 'Score test mega' } });
  await admin.query(`select private.rescore($1)`, [big.id]);
  let r = (await admin.query(`select lead_score, lead_class, priority_reasons from opportunities where id = $1`, [big.id])).rows[0];
  assert.equal(r.lead_class, 'Early Signal'); assert.notEqual(r.lead_class, 'Hot');
  assert.match(r.priority_reasons.summary, /^\d+\/100\. Inferred from the project type/);
  // documented removal scope, low bidder this week, verified estimator
  const hot = await mk('score:hot', { title: 'Score test bridge deck replacement', stage: 'bid_closed', winner: { name: 'Score Test Bridge Co', status: 'low_bidder', as_of: new Date().toISOString().slice(0, 10) }, relevance: 'high', project_value: 12000000,
    evidence: [{ term: 'concrete removal', confidence: 'documented', doc: 'Bid items', page: 3 }], opportunity: { kind: 'contractor_outreach', approach: 'approach_prime', title: 'Score test bridge' } });
  await admin.query(`update projects set last_verified_at = now() where external_key = 'score:hot'`);
  if (!hot.company_id) await admin.query(`update opportunities set company_id = private.upsert_company('Score Test Bridge Co') where id = $1`, [hot.id]);
  const co = (await admin.query(`select company_id from opportunities where id = $1`, [hot.id])).rows[0].company_id;
  await admin.query(`insert into contacts (company_id, name, title, phone, verified, verified_at, source) values ($1, 'Pat Estimator', 'Estimator', '407-555-0101', true, now(), 'research')`, [co]);
  await admin.query(`select private.rescore($1)`, [hot.id]);
  r = (await admin.query(`select lead_score, lead_class, priority_reasons from opportunities where id = $1`, [hot.id])).rows[0];
  assert.equal(r.lead_class, 'Hot', r.priority_reasons.summary); assert.ok(r.lead_score >= 75);
  assert.match(r.priority_reasons.summary, /Source documents concrete removal.*Apparent low bidder today.*Verified contact Pat Estimator.*Call today\./);
  // the same lead without a contact is not Hot, and the explanation carries a research task
  await admin.query(`update contacts set archived = true where company_id = $1`, [co]); await admin.query(`select private.rescore($1)`, [hot.id]);
  r = (await admin.query(`select lead_class, priority_reasons from opportunities where id = $1`, [hot.id])).rows[0];
  assert.equal(r.lead_class, 'Warm'); assert.match(r.priority_reasons.research, /Find the estimator or project manager/);
  // a direct bid whose response date passed (stage still "upcoming") is closed by daily upkeep and shows as Expired
  const exp = await mk('score:exp', { title: 'Score test expired notice', stage: 'upcoming', deadline: '2026-01-05T17:00:00Z', relevance: 'high',
    evidence: [{ term: 'core drilling', confidence: 'documented' }], opportunity: { kind: 'gov_bid', approach: 'bid_direct', title: 'Score test expired' } });
  await admin.query(`select public.daily_maintenance()`);
  assert.equal((await admin.query(`select stage from projects where external_key = 'score:exp'`)).rows[0].stage, 'bid_closed');
  r = (await admin.query(`select lead_class, priority_reasons from opportunities where id = $1`, [exp.id])).rows[0];
  assert.equal(r.lead_class, 'Expired'); assert.equal(r.priority_reasons.expired, 'Bid deadline passed');
  const board = await b.rpc('get_board');
  const row = board.find(x => x.id === hot.id);
  assert.ok(row.lead_score > 0 && row.lead_class && row.office === 'Orlando');
});

await test('Duplicates: same awardee across sources is suggested, a manager merges (the worked lead survives) or keeps them separate', async () => {
  const run = await svc.rpc('refresh_start_run', { p_source: 'usaspending_awards', p_trigger: 'test' });
  const today = new Date().toISOString().slice(0, 10);
  const base = { level: 'Federal', county: 'Sumter', region: 'Central FL', stage: 'bid_closed', winner: { name: 'Dup Test Septic LLC', status: 'awarded', as_of: today }, relevance: 'potential' };
  await svc.rpc('refresh_upsert_project', { p_run: run, p: { ...base, external_key: 'dup:a', source_id: 'sam_gov', title: 'Emergency lift station repair at Dup Test complex', solicitation_no: 'DUPA1',
    opportunity: { kind: 'contractor_outreach', approach: 'approach_prime', title: 'Dup A' } } });
  // the federal award record has no county (like the live FCC Coleman records), so the upsert cannot match it on its own
  await svc.rpc('refresh_upsert_project', { p_run: run, p: { ...base, county: null, region: null, external_key: 'dup:b', source_id: 'usaspending_awards', title: 'Dup test complex emergency lift station repair project 2', solicitation_no: 'DUPB2',
    opportunity: { kind: 'contractor_outreach', approach: 'approach_prime', title: 'Dup B' } } });
  await b.fails('duplicate_candidates', {}, /manager_only/);
  const c = (await m.rpc('duplicate_candidates')).find(x => [x.a.title, x.b.title].every(t => /Dup test/i.test(t)));
  assert.ok(c, 'suggested'); assert.match(c.reason, /Same contractor/);
  const oa = await opp(`external_key = 'dup:a'`), ob = await opp(`external_key = 'dup:b'`);
  await b.rpc('claim_opportunity', { p_id: ob.id });
  const res = await m.rpc('merge_projects', { p_keep: oa.project_id, p_drop: ob.project_id });
  assert.equal(res.lead, ob.id, 'the lead someone is working is the one kept');
  assert.equal((await opp(`id = '${oa.id}'`)).stage, 'archived');
  const kept = (await admin.query(`select alt_keys, solicitation_no from projects where id = $1`, [oa.project_id])).rows[0];
  assert.ok(kept.alt_keys.includes('dup:b'), 'the other source will update this project from now on');
  const tl = await b.rpc('project_timeline', { p_project: oa.project_id });
  assert.ok(tl.some(e => e.kind === 'merged') && tl.some(e => e.kind === 'award'));
  assert.equal((await m.rpc('duplicate_candidates')).filter(x => /Dup test/i.test(x.a.title + x.b.title)).length, 0);
  // two different jobs for the same contractor can be marked separate and are not suggested again
  await svc.rpc('refresh_upsert_project', { p_run: run, p: { ...base, county: null, region: null, external_key: 'dup:c', source_id: 'usaspending_awards', title: 'Dup test complex lift station repair phase 2', solicitation_no: 'DUPC3',
    opportunity: { kind: 'contractor_outreach', approach: 'approach_prime', title: 'Dup C' } } });
  const c2 = (await m.rpc('duplicate_candidates')).find(x => /phase 2/.test(x.a.title + x.b.title));
  assert.ok(c2);
  await m.rpc('separate_projects', { p_a: c2.a.id, p_b: c2.b.id, p_note: 'different phase' });
  // one source never lists the same job twice under different numbers: two FDOT contracts for one contractor are not suggested
  for (const [k, t] of [['dup:f1', 'FDOT contract DUPF1, Dup County'], ['dup:f2', 'FDOT contract DUPF2, Dup County']])
    await svc.rpc('refresh_upsert_project', { p_run: run, p: { ...base, external_key: k, source_id: 'fdot_lettings', title: t, solicitation_no: k.slice(4).toUpperCase(),
      winner: { name: 'Dup Paving Co', status: 'low_bidder', as_of: today }, opportunity: { kind: 'contractor_outreach', approach: 'approach_prime', title: t } } });
  assert.equal((await m.rpc('duplicate_candidates')).filter(x => /DUPF/.test(x.a.title + x.b.title)).length, 0);
  // records with no contractor are never paired as "same contractor"
  assert.ok((await m.rpc('duplicate_candidates')).every(x => x.reason && !/Same contractor \(\)/.test(x.reason)));
  assert.equal((await m.rpc('duplicate_candidates')).filter(x => /phase 2/.test(x.a.title + x.b.title)).length, 0);
});

await test('Claims expire: an unworked New lead goes back to Available after the configured days, with history and a notice; worked ones stay', async () => {
  const o1 = await opp(`stage='available' and not needs_review and not exists (select 1 from ownership_history h where h.opportunity_id = z.id)`);
  await a.rpc('claim_opportunity', { p_id: o1.id });
  await admin.query(`update opportunities set claimed_at = now() - interval '30 days', last_activity_at = null where id = $1`, [o1.id]);
  const r = (await admin.query(`select private.expire_claims() r`)).rows[0].r;
  assert.ok(r.released >= 1);
  const after = await opp(`id = '${o1.id}'`);
  assert.equal(after.owner_id, null); assert.equal(after.stage, 'available');
  assert.match((await admin.query(`select reason from ownership_history where opportunity_id = $1 order by id desc limit 1`, [o1.id])).rows[0].reason, /Automatic: no activity logged in 21 days/);
  await admin.query(`update settings set value = '0' where key = 'claim_release_days'`);
  assert.equal((await admin.query(`select private.expire_claims() r`)).rows[0].r.off, true);
  await admin.query(`update settings set value = '21' where key = 'claim_release_days'`);
});

await test('Company directory for everyone; outcomes report for managers only, with observed numbers', async () => {
  const dir = await b.rpc('company_directory', { p: { q: 'Dup Test' } });
  assert.ok(dir.length >= 1 && dir[0].awards >= 1);
  await b.fails('outcome_report', {}, /manager_only/);
  const rep = await m.rpc('outcome_report', { p: {} });
  assert.ok(Array.isArray(rep.by_source) && 'median_hours_to_first_contact' in rep && /not project budgets/.test(rep.note));
});

await test('Source health: a quiet source is judged against its normal pace; zero records read is flagged; coverage is manager-only and honest', async () => {
  await b.fails('coverage_status', {}, /manager_only/);
  await admin.query(`update sources set last_run_at = now(), last_success_at = now(), last_status = 'success', enabled = true where id in ('orlando_permits','fdot_lettings')`);
  await admin.query(`insert into refresh_runs (source_id, trigger, status, started_at, finished_at, examined, discovered) values
    ('orlando_permits', 'test', 'success', now() - interval '20 days', now() - interval '20 days', 40, 5),
    ('orlando_permits', 'test', 'success', now(), now(), 38, 0),
    ('fdot_lettings', 'test', 'success', now() - interval '20 days', now() - interval '20 days', 43, 4),
    ('fdot_lettings', 'test', 'success', now(), now(), 0, 0)`);
  const cov = await m.rpc('coverage_status');
  const h = Object.fromEntries(cov.sources.map(x => [x.id, x]));
  assert.equal(h.orlando_permits.status, 'Stale', 'permits normally arrive within days: ' + h.orlando_permits.why);
  assert.equal(h.fdot_lettings.status, 'Degraded', 'a successful run that read nothing is suspicious: ' + h.fdot_lettings.why);
  assert.ok(h.orlando_permits.last_new && h.orlando_permits.last_attempt && h.orlando_permits.last_success);
  assert.equal(cov.counties.length, 67);
  const orange = cov.counties.find(c => c.county === 'Orange'), lake = cov.counties.find(c => c.county === 'Lake');
  assert.ok(orange.local.length >= 4); assert.equal(lake.local.length, 0, 'no local source is claimed where there is none');
  assert.ok(cov.registry.some(r => r.jurisdiction === 'City of Fort Lauderdale' && r.status === 'Stale'));
  assert.ok(cov.next[0].value >= cov.next[cov.next.length - 1].value);
});

await test('Refresh schedule settings are validated on the server and keep the source lists', async () => {
  const cur = (await admin.query(`select value from settings where key = 'refresh_schedule'`)).rows[0].value;
  await m.fails('update_setting', { p_key: 'refresh_schedule', p_value: { ...cur, morning: '4:15am' } }, /bad_value/);
  await m.fails('update_setting', { p_key: 'refresh_schedule', p_value: { ...cur, verify: '04:00' } }, /bad_value/);
  await b.fails('update_setting', { p_key: 'refresh_schedule', p_value: cur }, /manager_only/);
  const { midday_sources, afternoon_sources, ...rest } = cur;
  await m.rpc('update_setting', { p_key: 'refresh_schedule', p_value: { ...rest, morning: '04:10' } });
  const now = (await admin.query(`select value from settings where key = 'refresh_schedule'`)).rows[0].value;
  assert.equal(now.morning, '04:10'); assert.deepEqual(now.midday_sources, midday_sources);
  await m.rpc('update_setting', { p_key: 'refresh_schedule', p_value: cur });
});

await test('Overlapping runs of the same source are refused; a stuck run is closed as failed', async () => {
  await admin.query(`update refresh_runs set status = 'failed', finished_at = now() where status = 'running'`);
  const r1 = await svc.rpc('refresh_start_run', { p_source: 'usaspending_awards', p_trigger: 'schedule' });
  await svc.fails('refresh_start_run', { p_source: 'usaspending_awards', p_trigger: 'manual' }, /already_running/);
  await admin.query(`update refresh_runs set started_at = now() - interval '20 minutes' where id = $1`, [r1]);
  const r2 = await svc.rpc('refresh_start_run', { p_source: 'usaspending_awards', p_trigger: 'schedule' });
  assert.ok(r2 > r1);
  assert.equal((await admin.query(`select status from refresh_runs where id = $1`, [r1])).rows[0].status, 'failed');
  await svc.rpc('refresh_finish_run', { p_run: r2, p_status: 'success', p_counts: {}, p_log: [] });
});

await test('Morning briefing and team report: personal for salespeople, team-wide for managers only', async () => {
  const bb = await b.rpc('my_briefing', {});
  assert.deepEqual(bb.territory, ['Central FL', 'Tampa Bay']); assert.equal(bb.team, undefined);
  assert.ok(Array.isArray(bb.new_hot) && typeof bb.my_overdue === 'number');
  const mb = await m.rpc('my_briefing', {});
  assert.ok(mb.team && typeof mb.team.awaiting_review === 'number');
  const rep = await m.rpc('team_report', { p: { from: '2026-01-01' } });
  const rb = rep.people.find(x => x.id === B);
  assert.ok(rb.attempts >= 4 && rb.conversations >= 2 && rb.quotes_requested >= 1 && rb.quotes_sent >= 1 && rb.won >= 1);
  assert.ok(rb.attempts > rb.conversations, 'attempts and conversations are counted separately');
  const only = await m.rpc('team_report', { p: { from: '2026-01-01', user_id: B } });
  assert.equal(only.people.length, 1);
  await b.fails('team_report', { p: {} }, /manager_only/);
});

await test('Missed-opportunity check explains whether a project is in the pipeline and, if not, why', async () => {
  const known = (await admin.query(`select source_url, external_key from projects where external_key like 'sam:%' and source_url is not null limit 1`)).rows[0];
  let r = await m.rpc('check_missed', { p_input: known.source_url });
  assert.equal(r.cause, 'already_in_pipeline'); assert.ok(r.matches.length >= 1);
  r = await m.rpc('check_missed', { p_input: 'https://www.examplecountybids.gov/bid/12345' });
  assert.equal(r.cause, 'source_not_monitored');
  r = await m.rpc('check_missed', { p_input: 'https://orangecountyfl.bonfirehub.com/opportunities/123456' });
  assert.equal(r.cause, 'access_restricted', JSON.stringify(r.matches).slice(0, 300));
  r = await m.rpc('check_missed', { p_input: 'https://app.buildingconnected.com/projects/zq77k1x' });
  assert.equal(r.cause, 'access_restricted');
  r = await m.rpc('check_missed', { p_input: 'https://sam.gov/opp/0123456789abcdef0123456789abcdef/view' });
  assert.ok(['filtered_or_not_reached', 'source_not_refreshed', 'collector_failed'].includes(r.cause)); assert.equal(r.probe_supported, true);
  await m.rpc('resolve_missed_check', { p_id: r.id, p: { resolution: 'not_relevant' } });
  assert.ok((await m.rpc('missed_checks_list', {})).length >= 5);
  await b.fails('check_missed', { p_input: 'https://sam.gov/opp/x' }, /manager_only/);
});

await test('Documented scope clears a discovery review; duplicate reviews stay; agents cannot call it', async () => {
  const id = await run('fdot_lettings');
  const mkp = (k, extra = {}) => svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: k, source_id: 'fdot_lettings', title: 'Example contract ' + k, county: 'Orange', region: 'Central FL',
    stage: 'low_bidder', relevance: 'review', opportunity: { kind: 'gov_bid', approach: 'track_award', title: 'Example ' + k }, ...extra } });
  await mkp('fdot:ZZ001'); await mkp('fdot:ZZ002');
  const p1 = await proj('fdot:ZZ001'), p2 = await proj('fdot:ZZ002');
  assert.equal((await oppsOf(p1.id))[0].needs_review, true);
  let r = await svc.rpc('refresh_clear_review', { p_key: 'fdot:ZZ001', p_note: 'test' });
  assert.equal(r.reason, 'no_documented_scope', 'inferred scope is not enough');
  await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'fdot:ZZ001', source_id: 'fdot_lettings', relevance: 'high', evidence: [{ term: 'bid item: concrete removal', kind: 'direct',
    confidence: 'documented', field: 'bid item', doc: 'FDOT bid tabulation, contract ZZ001', snippet: '0110 4 10 REMOVAL OF EXISTING CONCRETE (1,000 SY)', services: ['Breaking & removal'] }] } });
  await admin.query(`update opportunities set review_kind = 'duplicate' where project_id = $1`, [p2.id]);
  r = await svc.rpc('refresh_clear_review', { p_key: 'fdot:ZZ001', p_note: 'the tabulation lists concrete removal' });
  assert.equal(r.cleared, 1);
  const o1 = (await oppsOf(p1.id))[0];
  assert.equal(o1.needs_review, false);
  assert.match((await admin.query(`select body from activities where opportunity_id = $1 and kind = 'review' order by created_at desc limit 1`, [o1.id])).rows[0].body, /cleared automatically: the tabulation/);
  await admin.query(`update projects set evidence = (select evidence from projects where id = $1) where id = $2`, [p1.id, p2.id]);
  r = await svc.rpc('refresh_clear_review', { p_key: 'fdot:ZZ002', p_note: 'x' });
  assert.equal(r.cleared, 0, 'a duplicate review is a manager decision');
  await a.fails('refresh_clear_review', { p_key: 'fdot:ZZ001', p_note: 'x' }, /permission denied/);
});

await test('Workspaces: a private workspace lead is invisible to another user, even by id; switching changes what you see', async () => {
  const ws = await m.rpc('ensure_personal_workspace');
  const mine = ws.items.find(w => w.kind === 'personal');
  assert.ok(mine, 'personal workspace created'); assert.equal(mine.role, 'owner');
  assert.equal((await m.rpc('ensure_personal_workspace')).items.filter(w => w.kind === 'personal').length, 1, 'idempotent');
  const shared = ws.items.find(w => w.is_default);
  await m.rpc('set_workspace', { p_id: mine.id });
  const r = await m.rpc('add_lead', { p: { project_title: 'Private prospect: example warehouse slab', source_url: 'https://example.com/private/1', company_name: 'Example Private GC', region: 'Central FL', services: ['Slab sawing'] } });
  assert.equal(r.ok, true);
  const id = r.id || r.opportunity_id || (await opp(`title like '%example warehouse slab%'`)).id;
  const row = (await admin.query(`select workspace_id from opportunities where id = $1`, [id])).rows[0];
  assert.equal(row.workspace_id, mine.id, 'created in the current (private) workspace');
  assert.ok((await m.rpc('get_board')).some(x => x.id === id), 'owner sees it');
  // another user, guessing the id
  await a.fails('get_opportunity', { p_id: id }, /not_found/);
  await a.fails('log_activity', { p_id: id, p: { kind: 'note', body: 'x' } }, /not_found/);
  const cl = await a.rpc('claim_opportunity', { p_id: id }).catch(e => ({ error: e.message }));
  assert.notEqual(cl.ok, true, 'cannot claim it: ' + JSON.stringify(cl));
  assert.equal((await admin.query('select owner_id from opportunities where id = $1', [id])).rows[0].owner_id, null);
  assert.ok(!(await a.rpc('get_board')).some(x => x.id === id), 'not on the other user board');
  await a.fails('set_workspace', { p_id: mine.id }, /not_a_member/);
  await a.fails('set_workspace_member', { p_ws: mine.id, p_user: A, p_role: 'member' }, /personal_workspace_is_private/);
  // activity written in the private workspace stays there
  await m.rpc('log_activity', { p_id: id, p: { kind: 'note', body: 'private note' } });
  assert.equal((await admin.query(`select count(*)::int n from activities where opportunity_id = $1 and workspace_id = $2`, [id, mine.id])).rows[0].n >= 1, true);
  // back to the shared workspace: the private lead is out of view for the owner too
  await m.rpc('set_workspace', { p_id: shared.id });
  assert.ok(!(await m.rpc('get_board')).some(x => x.id === id));
  await m.fails('get_opportunity', { p_id: id }, /not_found/);
  // branding is per workspace and only its managers can change it
  await a.fails('update_workspace', { p_id: shared.id, p: { branding: { display_name: 'X' } } }, /workspace_manager_only/);
  const u = await m.rpc('update_workspace', { p_id: mine.id, p: { branding: { display_name: 'Valor Cutting Test' } } });
  assert.equal(u.items.find(w => w.id === mine.id).branding.display_name, 'Valor Cutting Test');
});
await test('Participants: several bidders on one project stay separate; project value is not repeated per bidder', async () => {
  const id = await run('fdot_lettings');
  await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'fdot:ZZB01', source_id: 'fdot_lettings', title: 'Example bridge contract ZZB01',
    county: 'Orange', region: 'Central FL', stage: 'low_bidder', project_value: 2000000,
    bidders: [{ name: 'Example Paving Inc', rank: 1, amount: 2000000 }, { name: 'Sample Bridge Co', rank: 2, amount: 2300000 }, { name: 'Test Civil LLC', rank: 3, amount: 2500000 }],
    winner: { name: 'Example Paving Inc', status: 'low_bidder', as_of: '2026-11-10', amount: 2000000 } } });
  const p = await proj('fdot:ZZB01');
  const parts = await a.rpc('project_participants', { p_project: p.id });
  const bidders = parts.filter(x => x.role === 'bidder');
  assert.deepEqual(bidders.map(x => x.rank), [1, 2, 3]);
  assert.equal(parts.filter(x => x.role === 'low_bidder').length, 1, 'the low bidder is its own row next to its bid');
  assert.equal(parts[0].role, 'low_bidder', 'outcome roles sort first');
  // the source drops a bidder: kept for history, marked not current; a re-run does not duplicate
  await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'fdot:ZZB01', source_id: 'fdot_lettings',
    bidders: [{ name: 'Example Paving Inc', rank: 1, amount: 2000000 }, { name: 'Sample Bridge Co', rank: 2, amount: 2300000 }] } });
  const again = await a.rpc('project_participants', { p_project: p.id });
  assert.equal(again.filter(x => x.role === 'bidder').length, 3);
  assert.equal(again.find(x => x.name === 'Test Civil LLC').current, false);
  // value lives on the project once, whatever the number of bidder leads
  assert.equal((await admin.query(`select count(*)::int n from projects where external_key = 'fdot:ZZB01'`)).rows[0].n, 1);
});

await test('Tasks: a lead next step becomes one task due 9 AM Eastern; completing it needs the next step or a reason', async () => {
  const o = await opp(`stage = 'available' and not needs_review and workspace_id = (select id from workspaces where is_default)`);
  await a.rpc('claim_opportunity', { p_id: o.id });
  await a.rpc('log_activity', { p_id: o.id, p: { kind: 'call', outcome: 'spoke', body: 'Talked to the estimator', next_action: 'Send the core drilling question list', next_action_due: '2026-03-09' } });
  const tasks = await a.rpc('task_list', { p: { opportunity_id: o.id } });
  assert.equal(tasks.length, 1, 'one mirrored task');
  // 2026-03-09 is the day after the DST change: 9 AM EDT is 13:00 UTC (it would be 14:00 in EST)
  assert.equal(new Date(tasks[0].due_at).toISOString(), '2026-03-09T13:00:00.000Z');
  await a.rpc('log_activity', { p_id: o.id, p: { kind: 'note', body: 'moved date', next_action_due: '2026-12-01' } });
  const t2 = await a.rpc('task_list', { p: { opportunity_id: o.id } });
  assert.equal(t2.length, 1, 'still one task after the date changes');
  assert.equal(new Date(t2[0].due_at).toISOString(), '2026-12-01T14:00:00.000Z', 'EST in December');
  await a.fails('complete_task', { p_id: t2[0].id, p: { outcome: 'sent' } }, /next_step_required/);
  await b.fails('complete_task', { p_id: t2[0].id, p: { outcome: 'x', no_action_reason: 'x' } }, /not_found|not_owner/);
  await a.rpc('complete_task', { p_id: t2[0].id, p: { outcome: 'Sent the list', next_action: 'Call back about drawings', next_action_due: '2026-12-03' } });
  const t3 = await a.rpc('task_list', { p: { opportunity_id: o.id } });
  assert.equal(t3.length, 1); assert.equal(t3[0].title, 'Call back about drawings');
  const done = await a.rpc('task_list', { p: { opportunity_id: o.id, status: 'done' } });
  assert.ok(done.some(x => x.title === 'Send the core drilling question list'));
  assert.ok((await admin.query(`select 1 from activities where opportunity_id = $1 and body like 'Done: Send the core drilling%'`, [o.id])).rowCount);
  // explicit "nothing scheduled" is allowed and recorded
  await a.rpc('complete_task', { p_id: t3[0].id, p: { outcome: 'Left message', no_action_reason: 'Waiting for drawings from the GC' } });
  const row = (await admin.query(`select next_action, no_action_reason from opportunities where id = $1`, [o.id])).rows[0];
  assert.equal(row.next_action, null); assert.equal(row.no_action_reason, 'Waiting for drawings from the GC');
  // a standalone task
  const st = await a.rpc('save_task', { p: { opportunity_id: o.id, kind: 'drawings', title: 'Get the MEP sheets', due_date: '2026-12-02' } });
  await a.rpc('complete_task', { p_id: st.id, p: { outcome: 'Received' } });
  // moving to Research is allowed for an owned lead (was blocked by the old ownership rule)
  await a.rpc('log_activity', { p_id: o.id, p: { kind: 'note', body: 'more research', stage: 'researching' } });
  assert.equal((await admin.query(`select stage from opportunities where id = $1`, [o.id])).rows[0].stage, 'researching');
});

await test('Contacts: do-not-contact hides phone and email from task lists; guessed email never shows as verified', async () => {
  const o = await opp(`owner_id = '${A}' and company_id is not null and stage <> 'archived'`);
  const c = await a.rpc('save_contact', { p: { opportunity_id: o.id, name: 'Pat Example', phone: '(407) 555-0142', email: 'pat@example.com' } }).catch(e => ({ error: e.message }));
  const k = (await admin.query(`select * from contacts where name = 'Pat Example' order by created_at desc limit 1`)).rows[0];
  assert.ok(k, 'contact saved: ' + JSON.stringify(c));
  await a.rpc('save_contact_details', { p_id: k.id, p: { email_is_guess: true, buying_role: 'estimator' } });
  await a.fails('save_contact_details', { p_id: k.id, p: { verification: 'published' } }, /bad_verification/);
  const t = await a.rpc('save_task', { p: { opportunity_id: o.id, contact_id: k.id, kind: 'call', title: 'Call Pat', due_date: '2026-12-04' } });
  let row = (await a.rpc('task_list', { p: { opportunity_id: o.id } })).find(x => x.id === t.id);
  assert.equal(row.contact.email, null, 'a guessed email is not offered as a way to reach them');
  assert.equal(row.contact.phone, '(407) 555-0142');
  await a.rpc('save_contact_details', { p_id: k.id, p: { do_not_contact: true, do_not_contact_reason: 'Asked not to be called' } });
  row = (await a.rpc('task_list', { p: { opportunity_id: o.id } })).find(x => x.id === t.id);
  assert.equal(row.contact.phone, null); assert.equal(row.contact.do_not_contact, true);
  assert.ok((await admin.query(`select 1 from activities where contact_id = $1 and body = 'Marked do not contact'`, [k.id])).rowCount);
  await a.rpc('complete_task', { p_id: t.id, p: { status: 'cancelled', outcome: 'Do not contact' } });
});
await test('Estimate request: units are explicit, missing details listed, company and contact matched, estimating task created, duplicates caught', async () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/estimate_request_core.json', import.meta.url)));
  await m.rpc('set_workspace', { p_id: (await m.rpc('my_workspaces')).items.find(w => w.is_default).id });
  // a number without a unit, or in a unit the field does not allow, is refused (no silent inches-as-feet)
  const noUnit = structuredClone(fx); noUnit.idempotency_key = 'x1'; noUnit.items[0].answers.core_diameter = 4;
  await m.fails('submit_estimate_request', { p: noUnit }, /unit_required/);
  const wrongUnit = structuredClone(fx); wrongUnit.idempotency_key = 'x2'; wrongUnit.items[0].answers.core_diameter = { value: 4, unit: 'ft' };
  await m.fails('submit_estimate_request', { p: wrongUnit }, /bad_unit/);
  const unknown = structuredClone(fx); unknown.idempotency_key = 'x3'; unknown.items[0].service = 'teleportation';
  await m.fails('submit_estimate_request', { p: unknown }, /unknown_service/);
  const r = await m.rpc('submit_estimate_request', { p: fx });
  assert.equal(r.ok, true); assert.equal(r.duplicate, false); assert.match(r.ref, /^ER-\d+/);
  assert.equal(r.status, 'missing_info');
  assert.deepEqual(r.missing.map(x => x.field), ['attachments'], 'only the photos are missing');
  const again = await m.rpc('submit_estimate_request', { p: fx });
  assert.equal(again.duplicate, true); assert.equal(again.id, r.id, 'same idempotency key returns the first request');
  const req = await m.rpc('get_estimate_request', { p_id: r.id });
  assert.equal(req.is_fixture, true);
  assert.match(req.disclaimer, /not an approved estimate/);
  const core = req.items.find(x => x.service_key === 'core_drilling');
  assert.deepEqual(core.normalized.core_diameter, { value: 4, unit: 'in', base_value: 4, base_unit: 'in' });
  const saw = req.items.find(x => x.service_key === 'slab_sawing');
  assert.equal(saw.normalized.cut_length.base_value, 720, '60 linear feet = 720 inches, kept beside the original 60 lf');
  assert.equal(saw.normalized.cut_length.value, 60); assert.equal(saw.normalized.cut_length.unit, 'lf');
  const co = (await admin.query(`select * from companies where id = $1`, [req.company_id])).rows[0];
  assert.equal(co.name, 'Example Mechanical Contractors LLC');
  const k = (await admin.query(`select * from contacts where id = $1`, [req.contact_id])).rows[0];
  assert.equal(k.verification, 'unverified'); assert.equal(k.source, 'estimate_request');
  const o = (await admin.query(`select * from opportunities where id = $1`, [req.opportunity_id])).rows[0];
  assert.equal(o.kind, 'inbound_request'); assert.equal(o.owner_id, M, 'goes to the workspace manager'); assert.equal(o.stage, 'qualified');
  const t = (await admin.query(`select * from tasks where id = $1`, [req.task_id])).rows[0];
  assert.equal(t.kind, 'estimate'); assert.equal(t.status, 'open'); assert.match(t.notes, /Photos or drawings/);
  // fixtures stay out of the normal list
  assert.ok(!(await m.rpc('estimate_requests')).some(x => x.id === r.id));
  assert.ok((await m.rpc('estimate_requests', { p: { include_fixtures: true } })).some(x => x.id === r.id));
  // a second request from the same company and email reuses both
  const fx2 = structuredClone(fx); fx2.idempotency_key = 'fixture-core-0002'; fx2.items = [fx.items[1]];
  const r2 = await m.rpc('submit_estimate_request', { p: fx2 });
  const req2 = await m.rpc('get_estimate_request', { p_id: r2.id });
  assert.equal(req2.company_id, req.company_id); assert.equal(req2.contact_id, req.contact_id);
  // another user cannot read it by id from a workspace they are not in
  const priv = (await m.rpc('my_workspaces')).items.find(w => w.kind === 'personal');
  await m.rpc('set_workspace', { p_id: priv.id });
  const pr = structuredClone(fx); pr.idempotency_key = 'fixture-private-1';
  const r3 = await m.rpc('submit_estimate_request', { p: pr });
  await a.fails('get_estimate_request', { p_id: r3.id }, /not_found/);
  await m.rpc('set_workspace', { p_id: (await m.rpc('my_workspaces')).items.find(w => w.is_default).id });
  globalThis.__er = { id: r.id, opp: req.opportunity_id };
});

await test('Integration key: only the edge function can submit; bad keys, missing idempotency and floods are refused and logged', async () => {
  const k = await m.rpc('create_integration', { p_name: 'Estimate app (test)' });
  assert.match(k.key, /^erk_[0-9a-f]{48}$/);
  const stored = (await admin.query(`select key_hash, key_hint from integrations where id = $1`, [k.id])).rows[0];
  assert.notEqual(stored.key_hash, k.key, 'only a hash is stored');
  await a.fails('intake_estimate_request', { p_key: k.key, p: {} }, /permission denied/);
  const fx = JSON.parse(readFileSync(new URL('./fixtures/estimate_request_core.json', import.meta.url)));
  fx.idempotency_key = 'app-1';
  assert.equal((await svc.rpc('intake_estimate_request', { p_key: 'erk_wrong', p: fx })).error, 'unauthorized');
  const noIdem = structuredClone(fx); delete noIdem.idempotency_key;
  assert.equal((await svc.rpc('intake_estimate_request', { p_key: k.key, p: noIdem })).error, 'idempotency_key_required');
  const ok = await svc.rpc('intake_estimate_request', { p_key: k.key, p: fx });
  assert.equal(ok.ok, true); assert.equal(ok.duplicate, false);
  assert.deepEqual(Object.keys(ok).sort(), ['duplicate', 'missing', 'ok', 'ref', 'status'], 'the app learns nothing about other records');
  assert.equal((await svc.rpc('intake_estimate_request', { p_key: k.key, p: fx })).duplicate, true);
  const bad = structuredClone(fx); bad.idempotency_key = 'app-2'; bad.items[0].answers.core_depth = { value: 8, unit: 'yards' };
  const rej = await svc.rpc('intake_estimate_request', { p_key: k.key, p: bad });
  assert.equal(rej.error, 'invalid');
  await admin.query(`update integrations set max_per_hour = 2 where id = $1`, [k.id]);
  const flood = structuredClone(fx); flood.idempotency_key = 'app-3';
  assert.equal((await svc.rpc('intake_estimate_request', { p_key: k.key, p: flood })).error, 'rate_limited');
  const log = await m.rpc('list_integrations');
  assert.deepEqual(log[0].recent.map(e => e.outcome).sort(), ['accepted', 'duplicate', 'rate_limited', 'rejected', 'rejected'].sort());
  await m.rpc('set_integration_active', { p_id: k.id, p_active: false });
  assert.equal((await svc.rpc('intake_estimate_request', { p_key: k.key, p: flood })).error, 'unauthorized');
});

await test('Quotes: lines keep the customer quantities flagged, unpriced lines block approval, sent versions are frozen, new versions keep history', async () => {
  const { id: erId, opp } = globalThis.__er;
  const q = await m.rpc('create_quote', { p_opportunity: opp, p: { estimate_request_id: erId } });
  const v1 = q.versions[0];
  assert.equal(v1.status, 'draft');
  assert.deepEqual(v1.lines.map(l => [l.qty, l.unit, l.qty_source, l.rate_source]), [[12, 'ea', 'contractor', 'manual'], [60, 'lf', 'contractor', 'manual']]);
  assert.ok(v1.flags.some(f => /customer's quantities/.test(f.text)));
  await m.fails('approve_quote_version', { p_version: v1.id }, /unpriced_lines/);
  // a pricing rule needs approval before it can price a line; salespeople can propose but not approve
  let rules = await a.rpc('save_pricing_rule', { p: { service_key: 'core_drilling', description: 'Core 2-6 in dia up to 12 in deep (EXAMPLE RATE)', unit: 'ea', rate: 85 } });
  const rule = rules.find(r => r.service_key === 'core_drilling');
  await a.fails('save_pricing_rule', { p: { id: rule.id, status: 'approved' } }, /workspace_manager_only/);
  await m.fails('save_quote_line', { p_version: v1.id, p: { id: v1.lines[0].id, pricing_rule_id: rule.id, unit: 'ea' } }, /rule_not_approved/);
  rules = await m.rpc('save_pricing_rule', { p: { id: rule.id, status: 'approved' } });
  await m.fails('save_quote_line', { p_version: v1.id, p: { id: v1.lines[0].id, pricing_rule_id: rule.id, unit: 'lf' } }, /unit_mismatch/);
  await m.rpc('save_quote_line', { p_version: v1.id, p: { id: v1.lines[0].id, pricing_rule_id: rule.id, unit: 'ea' } });
  await m.rpc('save_quote_line', { p_version: v1.id, p: { id: v1.lines[1].id, rate: 9.5, unit: 'lf' } });
  await m.rpc('save_quote_line', { p_version: v1.id, p: { kind: 'mobilization', description: 'Mobilization', qty: 1, unit: 'ls', rate: 350, qty_source: 'verified' } });
  let cur = await m.rpc('update_quote_version', { p_version: v1.id, p: { assumptions: ['Customer marks core locations', 'Water available on floor'], exclusions: ['Patching', 'Firestopping'] } });
  let v = cur.versions[0];
  assert.equal(v.total, 12 * 85 + 60 * 9.5 + 350, 'total reconciles with the lines');
  await m.fails('mark_quote_sent', { p_version: v.id, p: { sent_to: 'sam@example.com' } }, /approve_first/);
  await m.rpc('approve_quote_version', { p_version: v.id });
  await m.fails('save_quote_line', { p_version: v.id, p: { id: v.lines[0].id, rate: 1, unit: 'ea' } }, /version_frozen/);
  await m.fails('mark_quote_sent', { p_version: v.id, p: {} }, /sent_to_required/);
  cur = await m.rpc('mark_quote_sent', { p_version: v.id, p: { sent_to: 'Sam Example <sam@example.com>', sent_method: 'email' } });
  const o = (await admin.query(`select stage, quote_amount, quote_status from opportunities where id = $1`, [opp])).rows[0];
  assert.equal(o.stage, 'quote_sent'); assert.equal(Number(o.quote_amount), 1940); assert.equal(o.quote_status, 'sent');
  assert.equal((await admin.query(`select status from estimate_requests where id = $1`, [erId])).rows[0].status, 'quoted');
  // a revision is a new version; version 1 stays exactly as sent
  cur = await m.rpc('new_quote_version', { p_from: v.id });
  const v2 = cur.versions[0];
  assert.equal(v2.version_no, 2); assert.equal(v2.status, 'draft'); assert.equal(v2.lines.length, 3);
  await m.rpc('save_quote_line', { p_version: v2.id, p: { id: v2.lines[1].id, qty: 75, unit: 'lf', qty_source: 'measured', rate: 9.5 } });
  cur = await m.rpc('get_quote', { p_id: cur.id });
  assert.equal(cur.versions.find(x => x.version_no === 1).total, 1940, 'version 1 unchanged');
  assert.equal(cur.versions.find(x => x.version_no === 2).total, 12 * 85 + 75 * 9.5 + 350);
  // extra scope after sending is a change request, not a silent edit
  cur = await m.rpc('record_change_request', { p_quote: cur.id, p: { description: 'Add 4 cores on level 3', requested_by: 'Sam Example' } });
  assert.equal(cur.change_requests.length, 1);
  await a.fails('get_quote', { p_id: cur.id }, /not_owner/);   // teammate in the same workspace: quote details stay with the owner and managers
  globalThis.__q = { quote: cur.id, v1: v.id, opp };
});

await test('Quote sent needs a quote: the quick amount path records a version; no amount, no move', async () => {
  const o = await opp(`stage = 'available' and not needs_review and workspace_id = (select id from workspaces where is_default)`);
  await b.rpc('claim_opportunity', { p_id: o.id });
  await b.fails('log_activity', { p_id: o.id, p: { kind: 'note', body: 'sent', stage: 'quote_sent' } }, /quote_version_required/);
  await b.rpc('log_activity', { p_id: o.id, p: { kind: 'quote', body: 'Sent by email', stage: 'quote_sent', quote_amount: 4200 } });
  const v = (await admin.query(`select v.* from quote_versions v join quotes q on q.id = v.quote_id where q.opportunity_id = $1`, [o.id])).rows;
  assert.equal(v.length, 1); assert.equal(v[0].status, 'sent'); assert.equal(Number(v[0].quick_amount), 4200);
});
await test('Award: needs how it was confirmed; awarding is not payment; job is scheduled only with confirmation; handoff carries the accepted scope', async () => {
  const { quote, v1, opp: oppId } = globalThis.__q;
  const q = await m.rpc('get_quote', { p_id: quote });
  const draft = q.versions.find(v => v.status === 'draft');
  await m.fails('record_award', { p_opportunity: oppId, p: { quote_version_id: v1 } }, /confirmation_required/);
  await m.fails('record_award', { p_opportunity: oppId, p: { method: 'purchase_order', quote_version_id: draft.id } }, /version_not_sent/);
  const r = await m.rpc('record_award', { p_opportunity: oppId, p: { method: 'purchase_order', reference: 'PO-EXAMPLE-77', quote_version_id: v1, confirmed_on: '2026-11-20' } });
  const o = (await admin.query(`select stage, quote_status from opportunities where id = $1`, [oppId])).rows[0];
  assert.equal(o.stage, 'won'); assert.equal(o.quote_status, 'accepted');
  const vs = (await m.rpc('get_quote', { p_id: quote })).versions;
  assert.equal(vs.find(v => v.id === v1).status, 'accepted'); assert.equal(vs.find(v => v.id === draft.id).status, 'superseded');
  let money = await m.rpc('money_summary', { p_opportunity: oppId });
  assert.equal(money.awarded, 1940); assert.equal(money.collected, null, 'an award is not money collected'); assert.equal(money.invoiced, null);
  let job = await m.rpc('get_job', { p_id: r.job_id });
  assert.equal(job.status, 'ready_for_scheduling');
  const h = job.handoff;
  assert.equal(h.accepted_scope.version_no, 1); assert.equal(h.accepted_scope.total, 1940);
  assert.equal(h.site.working_hours, 'nights'); assert.equal(h.site.site_contact.name, 'Lee Super');
  assert.ok(h.unresolved.some(x => /Photos or drawings/.test(x)), 'open questions travel with the handoff');
  assert.match(h.scheduling.note, /nothing here books a crew/);
  await m.fails('update_job', { p_id: r.job_id, p: { status: 'scheduled', scheduled_start: '2026-12-14' } }, /schedule_confirmation_required/);
  job = await m.rpc('update_job', { p_id: r.job_id, p: { handoff_reviewed: true } });
  assert.ok(job.handoff_reviewed_at);
  job = await m.rpc('update_job', { p_id: r.job_id, p: { status: 'scheduled', scheduled_start: '2026-12-14', schedule_source: 'Dispatch (example)' } });
  assert.equal(job.scheduled_start, '2026-12-14');
  await a.fails('get_job', { p_id: r.job_id }, /not_owner|not_found/);
  job = await m.rpc('update_job', { p_id: r.job_id, p: { status: 'completed', completed_on: '2026-12-15' } });
  assert.equal(job.follow_up_on, '2027-02-13', 'repeat-business check-in 60 days later');
  assert.ok((await admin.query(`select 1 from tasks where dedupe_key = $1 and status = 'open'`, ['repeat:' + r.job_id])).rowCount);
  // invoice and a partial payment, then a credit: each total from its own records
  job = await m.rpc('save_invoice', { p_job: r.job_id, p: { number: 'INV-EX-1', amount: 1940, issued_on: '2026-12-16', due_on: '2027-01-15' } });
  const inv = job.invoices[0];
  await m.rpc('record_payment', { p_invoice: inv.id, p: { amount: 1000, received_on: '2027-01-05', method: 'check', reference: '1042' } });
  job = await m.rpc('record_payment', { p_invoice: inv.id, p: { amount: -40, received_on: '2027-01-06', method: 'credit', reference: 'short pay' } });
  assert.equal(job.invoices[0].paid, 960); assert.equal(job.invoices[0].balance, 980);
  money = await m.rpc('money_summary', { p_opportunity: oppId });
  assert.deepEqual([money.quoted, money.awarded, money.completed, money.invoiced, money.collected], [1940, 1940, 1940, 1940, 960]);
  assert.deepEqual(money.warnings, []);
  // attribution was filled in from who did what
  assert.deepEqual(money.attribution.map(x => x.role).sort(), ['closed', 'developed', 'quoted', 'sourced']);
  globalThis.__award = { opp: oppId, job: r.job_id, invoice: inv.id };
});

await test('Awarded from the board still records an award; no reason, no move', async () => {
  const o = await opp(`owner_id = '${B}' and stage = 'quote_sent'`);
  await b.fails('log_activity', { p_id: o.id, p: { kind: 'note', body: 'won', stage: 'won' } }, /reason_required/);
  await b.rpc('log_activity', { p_id: o.id, p: { kind: 'note', body: 'won', stage: 'won', outcome_reason: 'GC emailed the award' } });
  const aw = (await admin.query(`select * from awards where opportunity_id = $1`, [o.id])).rows;
  assert.equal(aw.length, 1); assert.equal(aw[0].method, 'recorded'); assert.equal(aw[0].note, 'GC emailed the award');
  assert.equal(Number(aw[0].amount), 4200, 'amount from the sent version, not invented');
  assert.equal((await admin.query(`select count(*)::int n from jobs where opportunity_id = $1`, [o.id])).rows[0].n, 1);
});

await test('Commission: scenarios without an agreement; traceable owed amounts under an approved one; first job vs repeat; profit needs cost', async () => {
  const { opp: oppId, invoice } = globalThis.__award;
  // no agreement recorded: nothing is owed; a what-if rate gives labelled scenario lines
  let r = await m.rpc('commission_report', { p: { from: '2026-01-01', to: '2027-12-31' } });
  assert.equal(r.owed, 0); assert.equal(r.lines.length, 0); assert.match(r.note, /scenarios, not money owed/);
  r = await m.rpc('commission_report', { p: { from: '2026-01-01', to: '2027-12-31', scenario_rate: 0.05, scenario_trigger: 'collected' } });
  assert.ok(r.lines.length >= 2 && r.lines.every(l => l.status === 'scenario'));
  assert.equal(r.scenario, Math.round((1000 * 0.05 - 40 * 0.05) * 100) / 100);
  // an active agreement must name who approved it and when
  await assert.rejects(m.rpc('save_commission_agreement', { p: { title: 'Example plan', status: 'active', effective_from: '2026-01-01', basis: 'revenue', trigger_event: 'collected', first_job_rate: 0.05, repeat_rate: 0.02 } }), /active_needs_approval/);
  const ag = await m.rpc('save_commission_agreement', { p: { title: 'Example plan (test)', status: 'active', effective_from: '2026-01-01', basis: 'revenue', trigger_event: 'collected',
    first_job_rate: 0.05, repeat_rate: 0.02, credited_roles: ['closed'], approved_by_name: 'Example Owner', approved_on: '2026-01-02' } });
  r = await m.rpc('commission_report', { p: { from: '2026-01-01', to: '2027-12-31' } });
  const lines = r.lines.filter(l => l.opportunity_id === oppId);
  assert.equal(lines.length, 2);
  assert.ok(lines.every(l => l.status === 'owed' && l.agreement_id === ag.id && l.record_type === 'payment' && l.repeat === false && l.rate === 0.05));
  assert.equal(r.owed, 48, '5% of 960 collected (1000 received, 40 credited back)');
  assert.equal(r.note, null);
  // a salesperson cannot read someone else's commission
  await a.fails('commission_report', { p: { user_id: M } }, /workspace_manager_only/);
  // profit basis without a recorded job cost is flagged, not guessed
  await m.rpc('save_commission_agreement', { p: { id: ag.id, title: 'Example plan (test)', status: 'ended', effective_from: '2026-01-01', effective_to: '2026-12-31', basis: 'revenue',
    trigger_event: 'collected', first_job_rate: 0.05, repeat_rate: 0.02, credited_roles: ['closed'], approved_by_name: 'Example Owner', approved_on: '2026-01-02' } });
  await m.rpc('save_commission_agreement', { p: { title: 'Example profit plan (test)', status: 'active', effective_from: '2027-01-01', basis: 'gross_profit',
    profit_definition: 'Invoice minus recorded direct job cost (labor, equipment, disposal)', trigger_event: 'collected', first_job_rate: 0.1, repeat_rate: 0.05,
    credited_roles: ['closed'], approved_by_name: 'Example Owner', approved_on: '2026-12-20' } });
  r = await m.rpc('commission_report', { p: { from: '2027-01-01', to: '2027-12-31' } });
  assert.ok(r.lines.filter(l => l.opportunity_id === oppId).every(l => l.status === 'needs_cost' && l.amount === null));
  await m.rpc('update_job', { p_id: globalThis.__award.job, p: { direct_cost: 970 } });
  r = await m.rpc('commission_report', { p: { from: '2027-01-01', to: '2027-12-31' } });
  assert.equal(r.owed, Math.round((500 - 20) * 0.1 * 100) / 100, '10% of half the collected amount (cost is half the job)');
});
await test('Documents: only allowed file types and sizes; files stay with the lead owner and the workspace; uploads need a registered path', async () => {
  const { id: erId, opp } = globalThis.__er;
  await m.fails('add_document_revision', { p: { estimate_request_id: erId, filename: 'run.exe', mime: 'application/x-msdownload', bytes: 100 } }, /file_type_not_allowed/);
  await m.fails('add_document_revision', { p: { estimate_request_id: erId, filename: 'big.pdf', mime: 'application/pdf', bytes: 30 * 1024 * 1024 } }, /file_too_large/);
  const up = await m.rpc('add_document_revision', { p: { estimate_request_id: erId, kind: 'photo', title: 'Level 2 slab', filename: 'slab photo (1).jpg', mime: 'image/jpeg', bytes: 52000,
    sha256: 'a'.repeat(64) } });
  assert.match(up.path, new RegExp(`^[0-9a-f-]{36}/${up.document_id}/1-slab_photo_1_.jpg$`), 'path starts with the workspace and has a safe name');
  assert.equal((await admin.query(`select public.registered_upload($1) ok`, [up.path])).rows[0].ok, false, 'only the uploader may use the path');
  // the uploader's own check (as the storage rule runs it)
  assert.equal((await m.query(`select public.registered_upload($1) ok`, [up.path])).rows[0].ok, true);
  assert.equal((await m.query(`select public.registered_upload($1) ok`, [up.path.replace('/1-', '/9-')])).rows[0].ok, false);
  assert.equal((await a.query(`select public.can_access_workspace($1) ok`, [up.path.split('/')[0]])).rows[0].ok, true, 'a teammate in the shared workspace');
  const priv = (await m.rpc('my_workspaces')).items.find(w => w.kind === 'personal');
  assert.equal((await a.query(`select public.can_access_workspace($1) ok`, [priv.id])).rows[0].ok, false, 'not someone else\'s private workspace');
  await m.rpc('confirm_document_revision', { p_revision: up.revision_id });   // no storage locally: confirmation records the revision
  const docs = await m.rpc('list_documents', { p: { estimate_request_id: erId } });
  assert.equal(docs.length, 1); assert.equal(docs[0].revisions[0].rev_no, 1);
  const again = await m.rpc('add_document_revision', { p: { document_id: up.document_id, filename: 'slab photo (1).jpg', mime: 'image/jpeg', bytes: 52000, sha256: 'a'.repeat(64) } });
  assert.equal(again.duplicate, true, 'the same file twice is one revision');
  const r2 = await m.rpc('add_document_revision', { p: { document_id: up.document_id, filename: 'slab-marked.jpg', mime: 'image/jpeg', bytes: 61000, sha256: 'b'.repeat(64), note: 'Cuts marked' } });
  assert.equal(r2.rev_no, 2);
  // a lead document is private to the lead owner and managers
  const ld = await m.rpc('add_document_revision', { p: { opportunity_id: opp, kind: 'purchase_order', title: 'PO', filename: 'po.pdf', mime: 'application/pdf', bytes: 9000 } });
  await a.fails('add_document_revision', { p: { document_id: ld.document_id, filename: 'x.pdf', mime: 'application/pdf', bytes: 10 } }, /not_owner/);
  await a.fails('list_documents', { p: { opportunity_id: opp } }, /not_found/);
});

await test('Outreach brief: built from the record, inferred scope asked as a question, documented scope cited, do-not-contact refused, never sent', async () => {
  // a discovery lead with a bidder role and inferred scope
  const id = await run('fdot_lettings');
  await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'fdot:ZZO01', source_id: 'fdot_lettings', title: 'Example interchange contract ZZO01', short_title: 'Example interchange',
    county: 'Orange', city: 'Orlando', region: 'Central FL', stage: 'low_bidder', relevance: 'potential', services_likely: ['Slab sawing', 'Core drilling'],
    winner: { name: 'Example Roadbuilders Inc', status: 'low_bidder', as_of: '2026-11-10', amount: 3100000 },
    evidence: [{ term: 'bridge replacement', kind: 'indicator', confidence: 'inferred', field: 'title', doc: 'FDOT letting results', snippet: 'bridge replacement', services: ['Slab sawing'] }],
    opportunity: { kind: 'contractor_outreach', approach: 'approach_prime', title: 'Example Roadbuilders Inc — Example interchange', company_name: 'Example Roadbuilders Inc' } } });
  const pr = await proj('fdot:ZZO01');
  const o = (await oppsOf(pr.id)).find(x => x.kind === 'contractor_outreach');
  await admin.query(`update opportunities set needs_review = false, review_kind = null where id = $1`, [o.id]);
  await a.rpc('claim_opportunity', { p_id: o.id });
  await a.rpc('save_contact', { p: { opportunity_id: o.id, name: 'Robin Example', title: 'Chief estimator', phone: '(407) 555-0177' } });
  const k = (await admin.query(`select id from contacts where name = 'Robin Example'`)).rows[0];
  await a.rpc('save_contact_details', { p_id: k.id, p: { buying_role: 'estimator' } });
  let b1 = await a.rpc('generate_outreach_brief', { p_opportunity: o.id });
  assert.equal(b1.contact.name, 'Robin Example'); assert.match(b1.why_this_contact, /Estimators collect sub prices/);
  assert.equal(b1.scope_confidence, 'inferred');
  assert.equal(b1.questions[0], 'Is there any slab sawing or core drilling on this job?', 'inferred scope is a question');
  assert.ok(!b1.questions.some(q => /trench/.test(q)), 'only the services the record points to');
  assert.match(b1.opener, /came in low on Example interchange/);
  assert.match(b1.facts.join(' '), /listed as low bidder at \$3\.1M/);
  assert.match(b1.facts.join(' '), /Orlando, Orange County/);
  assert.ok(!/insur|certif|crew|years|our past|we have worked/i.test(b1.email), 'no invented claims');
  assert.match(b1.email, /Speedy Concrete Cutting/, 'company name from the workspace branding');
  assert.match(b1.note, /Nothing is sent/);
  assert.equal(b1.follow_up, null, 'no follow-up draft before any contact');
  // after a call, the follow-up draft refers to it
  await a.rpc('log_activity', { p_id: o.id, p: { kind: 'call', outcome: 'voicemail', contact_id: k.id, body: 'Left voicemail' } });
  const b2 = await a.rpc('generate_outreach_brief', { p_opportunity: o.id });
  assert.match(b2.follow_up, /from my call on/); assert.match(b2.next_step, /Try again in two business days/);
  // documented scope (a bid item) is cited with its document
  await svc.rpc('refresh_upsert_project', { p_run: id, p: { external_key: 'fdot:ZZO01', source_id: 'fdot_lettings', relevance: 'high',
    evidence: [{ term: 'bid item: concrete removal', kind: 'direct', confidence: 'documented', field: 'bid item', doc: 'FDOT bid tabulation, contract ZZO01', page: 3,
      snippet: '0110 4 10 REMOVAL OF EXISTING CONCRETE (1,200 SY)', services: ['Breaking & removal'] }] } });
  const b3 = await a.rpc('generate_outreach_brief', { p_opportunity: o.id });
  assert.equal(b3.scope_confidence, 'documented');
  assert.match(b3.scope, /FDOT bid tabulation, contract ZZO01 \(page 3\) lists concrete removal/);
  // copying is recorded; nothing sends
  await a.rpc('mark_outreach_draft', { p_id: b3.id, p_status: 'copied' });
  assert.ok((await admin.query(`select 1 from activities where opportunity_id = $1 and body like 'Copied an outreach draft%'`, [o.id])).rowCount);
  await b.fails('mark_outreach_draft', { p_id: b3.id, p_status: 'copied' }, /not_found/);
  // do not contact stops drafting
  await a.rpc('save_contact_details', { p_id: k.id, p: { do_not_contact: true, do_not_contact_reason: 'Asked to stop' } });
  await a.fails('generate_outreach_brief', { p_opportunity: o.id, p: { contact_id: k.id } }, /do_not_contact/);
  const b4 = await a.rpc('generate_outreach_brief', { p_opportunity: o.id });
  assert.equal(b4.contact, null, 'with the only contact suppressed, the brief says to find one');
  await a.rpc('save_company_account', { p_company: o.company_id, p: { do_not_contact: true, do_not_contact_reason: 'Company policy' } });
  await a.fails('generate_outreach_brief', { p_opportunity: o.id }, /do_not_contact/);
  await b.fails('generate_outreach_brief', { p_opportunity: o.id }, /not_owner/);
});
for (const s of [m, a, b, x, anon, svc, admin]) await s.end();
const failed = results.filter(r => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
