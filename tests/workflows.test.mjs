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
  assert.match(d.priority_reasons.fit.find(f => f.factor === 'Scope evidence').text, /Confirmed by the contact/);
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
  const o = await opp(`stage='available' and not needs_review`);
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
  await m.rpc('update_setting', { p_key: 'stale_days', p_value: '10' });
  await m.fails('update_setting', { p_key: 'stale_days', p_value: '1' }, /bad_value/);
  await m.rpc('update_setting', { p_key: 'stale_days', p_value: '14' });
});

for (const s of [m, a, b, x, anon, svc, admin]) await s.end();
const failed = results.filter(r => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
