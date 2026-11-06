// Parser tests against saved real responses, then the parsed records are pushed through the
// database refresh function to check they merge with the imported pipeline instead of duplicating it.
// usage: node --experimental-strip-types tests/parsers.test.mjs <database>
import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import * as L from '../supabase/functions/refresh/lib.ts';

const fx = (f) => fs.readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '\n   ', e.message); } };

await t('FDOT list page: letting ids and dates', () => {
  const l = L.parseFdotList(fx('fdot_list_08.html'));
  assert.equal(l.length, 2);
  assert.deepEqual(l[0], { id: '08261103', date: '11/3/2026', iso: '2026-11-03', url: 'https://bidletting.fdot.gov/LettingResults/DisplayPreliminaryReport?id=08261103&lettingDate=11/3/2026' });
});

await t('FDOT report: contracts, counties, bidders ranked by amount', () => {
  const r = L.parseFdotReport(fx('fdot_report_08261103.html'));
  assert.equal(r.complete, true); assert.equal(r.lettingDate, '11/3/2026');
  assert.equal(r.contracts.length, 2);
  const [a, b] = r.contracts;
  assert.equal(a.contract, 'E8V46'); assert.equal(a.county, 'BROWARD'); assert.equal(a.finProject, '437155-1-52-01');
  assert.equal(a.bidders[0].name, 'HALLEY CONTRACTORS JV'); assert.equal(a.bidders[0].amount, 209825300.77);
  assert.equal(b.bidders[0].name, 'SOUTHLAND CONSTRUCTION, INC.', 'sorted: listing order is not trusted');
  assert.equal(b.bidders[0].rank, 1); assert.equal(b.bidders.length, 3);
});

await t('FDOT report still in progress is not treated as results', () => {
  const r = L.parseFdotReport(fx('fdot_report_in_progress.html'));
  assert.equal(r.complete, false); assert.match(r.status, /In Progress/i);
});

await t('FDOT payload: low bidder is marked low_bidder, never awarded; untracked goes to review', () => {
  const r = L.parseFdotReport(fx('fdot_report_08261103.html'));
  const letting = L.parseFdotList(fx('fdot_list_08.html'))[0];
  const p = L.fdotPayload(r.contracts[1], letting, '08', false);
  assert.equal(p.winner.status, 'low_bidder'); assert.equal(p.region, 'Central FL'); assert.equal(p.relevance, 'low');
  assert.match(p.status_text, /Not an award/);
  const tracked = L.fdotPayload(r.contracts[0], letting, '08', true);
  assert.equal(tracked.title, undefined, 'tracked records keep their curated title');
});

await t('Regions from counties and ZIP codes', () => {
  assert.equal(L.regionForCounty('ORANGE'), 'Central FL'); assert.equal(L.regionForCounty('MIAMI DADE'), 'South FL');
  assert.equal(L.regionForCounty('ST JOHNS'), 'North FL'); assert.equal(L.regionForZip('32827'), 'Central FL');
  assert.equal(L.regionForZip('33039-1299'), 'South FL'); assert.equal(L.regionForZip(null), 'Unknown');
});

await t('SAM.gov search: award notices map to the original solicitation; janitorial is skipped', () => {
  const list = JSON.parse(fx('sam_sgs_search.json'))._embedded.results.map(L.normalizeSgs);
  assert.equal(list[0].originalSol, 'W911WN26QA049'); assert.equal(list[0].awardee, 'WSP USA SOLUTIONS INC');
  assert.equal(list[1].deadline, '2026-11-23T12:00:00-05:00');
  assert.equal(L.relevance(list[1].title + ' ' + list[1].snippet), 'high');
  assert.equal(L.relevance(list[2].title + ' ' + list[2].snippet), 'skip');
  const g = L.groupNotices(list);
  assert.ok(g.has('W911WN26QA049')); assert.ok(g.has('FA664827R0001'));
});

await t('SAM.gov tracked solicitation with closed bids and no award stays "bid closed"', () => {
  const list = JSON.parse(fx('sam_sgs_tracked_closed.json'))._embedded.results.map(L.normalizeSgs);
  const notices = [...L.groupNotices(list).values()][0];
  const f = L.samFacts(notices, null);
  assert.equal(f.stage, 'bid_closed'); assert.equal(f.deadline, '2026-06-03T14:00:00-05:00'); assert.equal(f.award, undefined);
  const p = L.samPayload('W9127826RA025', notices, f, true);
  assert.equal(p.alt_keys.length, 4); assert.equal(p.solicitation_no, 'W9127826RA025');
});

// ---------------------------------------------------------------- through the database
const DB = process.argv[2];
if (DB) {
  const c = new pg.Client({ host: 'localhost', port: 54329, user: 'postgres', password: 'pw', database: DB });
  await c.connect();
  await c.query('set role service_role');
  const rpc = async (fn, args) => (await c.query(`select public.${fn}(${Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(',')}) r`, Object.values(args).map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : v))).rows[0].r;
  const counts = async () => (await c.query(`select (select count(*) from projects)::int p, (select count(*) from opportunities)::int o`)).rows[0];

  await t('Real FDOT results merge into the imported Sawgrass and Taft-Vineland records (no new projects)', async () => {
    const before = await counts();
    const run = await rpc('refresh_start_run', { p_source: 'fdot_lettings', p_trigger: 'test' });
    const r = L.parseFdotReport(fx('fdot_report_08261103.html'));
    const letting = L.parseFdotList(fx('fdot_list_08.html'))[0];
    const out = [];
    for (const k of r.contracts) out.push(await rpc('refresh_upsert_project', { p_run: run, p: L.fdotPayload(k, letting, '08', true) }));
    assert.deepEqual(out.map(o => o.action), ['updated', 'updated']);
    assert.ok(out.every(o => o.opportunities_created === 0), 'winners already have their outreach lead');
    assert.deepEqual(await counts(), before);
    const p = (await c.query(`select winner_name, winner_status, jsonb_array_length(bidders) n, last_verified_at from projects where 'fdot:E8V46' = any(alt_keys)`)).rows[0];
    assert.equal(p.winner_status, 'low_bidder'); assert.equal(p.n, 3); assert.ok(p.last_verified_at);
    await rpc('refresh_finish_run', { p_run: run, p_status: 'success', p_counts: { fetched: 2, updated: 2 }, p_log: ['fixture'] });
  });

  await t('Real SAM.gov notices: tracked Homestead solicitation merges; new award creates one outreach lead', async () => {
    const before = await counts();
    const run = await rpc('refresh_start_run', { p_source: 'sam_gov', p_trigger: 'test' });
    const list = JSON.parse(fx('sam_sgs_search.json'))._embedded.results.map(L.normalizeSgs);
    const g = L.groupNotices(list);
    const home = g.get('FA664827R0001');
    const r1 = await rpc('refresh_upsert_project', { p_run: run, p: L.samPayload('FA664827R0001', home, L.samFacts(home, null), false) });
    assert.equal(r1.merged, true, 'matched the imported Homestead B164 record by solicitation number');
    const award = g.get('W911WN26QA049');
    const r2 = await rpc('refresh_upsert_project', { p_run: run, p: L.samPayload('W911WN26QA049', award, L.samFacts(award, null), false) });
    assert.equal(r2.action, 'discovered'); assert.equal(r2.opportunities_created, 1);
    const after = await counts();
    assert.equal(after.p, before.p + 1); assert.equal(after.o, before.o + 1);
    const o = (await c.query(`select o.approach, o.kind, c.name from opportunities o join companies c on c.id=o.company_id join projects p on p.id=o.project_id where p.sol_key='W911WN26QA049'`)).rows[0];
    assert.equal(o.approach, 'approach_prime'); assert.equal(o.kind, 'contractor_outreach'); assert.match(o.name, /Wsp Usa Solutions/i);
  });
  await c.end();
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
