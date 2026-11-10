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
  assert.ok(scored.priority_reasons.fit.some(f => f.factor === 'Scope evidence' && /Source documents core drilling/.test(f.text)));
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

for (const s of [m, a, b, x, anon, svc, admin]) await s.end();
const failed = results.filter(r => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
