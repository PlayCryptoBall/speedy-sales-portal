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
  assert.equal(p.winner.status, 'low_bidder'); assert.equal(p.region, 'Central FL'); assert.equal(p.relevance, 'review');
  assert.match(p.status_text, /Not an award/);
  const tracked = L.fdotPayload(r.contracts[0], letting, '08', true);
  assert.equal(tracked.title, undefined, 'tracked records keep their curated title');
});

await t('Regions from counties and ZIP codes', () => {
  assert.equal(L.regionForCounty('ORANGE'), 'Central FL'); assert.equal(L.regionForCounty('MIAMI DADE'), 'Southeast FL');
  assert.equal(L.regionForCounty('ST JOHNS'), 'Northeast FL'); assert.equal(L.regionForZip('32827'), 'Central FL');
  assert.equal(L.regionForZip('33039-1299'), 'Southeast FL'); assert.equal(L.regionForZip(null), 'Unknown');
  assert.equal(L.regionForZip('32114'), 'Central FL', 'Daytona Beach ZIPs are Central FL');
  assert.equal(Object.values(L.REGIONS).flat().length, 67, 'all 67 counties');
  assert.equal(L.countyForCity('Kennedy Space Center'), 'Brevard'); assert.equal(L.regionForCounty('SAINT JOHNS'), 'Northeast FL'); assert.equal(L.countyName('Saint Lucie'), 'St. Lucie'); assert.equal(L.countyForCity('ft. lauderdale'), 'Broward');
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

await t('SAM.gov deadline extension posted as a Special Notice amendment wins over the original date', () => {
  const list = JSON.parse(fx('sam_sgs_amended_deadline.json'))._embedded.results.map(L.normalizeSgs);
  const notices = [...L.groupNotices(list).values()][0];
  const f = L.samFacts(notices, null);
  assert.equal(f.deadline, '2026-11-16T15:30:00-05:00');
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

// ---------------------------------------------------------------- discovery: classification and new sources
const C = (title, description, value) => L.classify([{ field: 'title', text: title }, { field: 'description', text: description || '' }], undefined, { value });

await t('Scenario 1: a direct concrete cutting solicitation is high priority, documented, and Speedy bids it directly', () => {
  const c = C('Concrete Coring and Saw Cutting Services, Building 1050', 'Provide all labor to core drill and saw cut existing slabs.');
  assert.equal(c.relevance, 'high');
  assert.ok(c.evidence.some(e => e.confidence === 'documented' && e.term === 'core drilling'));
  assert.ok(c.services.includes('Core drilling') && c.services.includes('Slab sawing'));
  const n = { id: 'a'.repeat(32), title: 'Concrete Coring and Saw Cutting Services, Building 1050', type: 'Solicitation', sol: 'N6945026Q0101', originalSol: null,
    active: true, canceled: false, published: '2026-11-01', modified: '2026-11-01', deadline: '2099-01-15T14:00:00-05:00', agency: 'Navy', office: 'NAVFAC SE',
    officeState: 'FL', awardee: null, awardAmount: null, snippet: 'Provide all labor to core drill and saw cut existing slabs.', parent: null };
  const facts = L.samFacts([n], { data2: { placeOfPerformance: { city: { name: 'JACKSONVILLE' }, zip: '32212' } } });
  const p = L.samPayload('N6945026Q0101', [n], facts, false);
  assert.equal(p.relevance, 'high'); assert.equal(p.opportunity.approach, 'bid_direct'); assert.equal(p.county, 'Duval'); assert.equal(p.region, 'Northeast FL');
  assert.match(p.opportunity.next_action, /submit Speedy's bid/);
});

await t('Scenario 2: a general renovation whose specifications call for sawcutting and coring is documented from the spec text', () => {
  const c = L.classify([{ field: 'title', text: 'Building 22 Renovation' },
    { field: 'specifications', doc: 'Section 02 41 19 Selective Demolition', page: 3,
      text: 'The Contractor shall saw cut and remove the existing slab for new plumbing trenches. Core drill floor penetrations after GPR scanning.' }]);
  assert.equal(c.relevance, 'high');
  const e = c.evidence.find(x => x.term === 'saw cutting');
  assert.equal(e.field, 'specifications'); assert.equal(e.page, 3); assert.match(e.snippet, /saw cut and remove/i);
  assert.ok(c.evidence.some(x => x.term === 'GPR / concrete scanning'));
});

await t('Scenario 3: a bridge replacement with demolition and barrier removal points to road & bridge deconstruction', () => {
  const c = C('SR 50 over Econlockhatchee River bridge replacement', 'Work includes removal of the existing bridge and concrete barrier wall removal.');
  assert.equal(c.relevance, 'high');
  assert.ok(c.services.includes('Road & bridge deconstruction'));
  assert.equal(c.category, 'Transportation & infrastructure');
  const title = C('SR 50 bridge replacement', '');
  assert.equal(title.relevance, 'potential', 'project type alone is inferred, not documented');
  assert.ok(title.evidence.every(e => e.confidence === 'inferred'));
});

const usaRow = { generated_internal_id: 'CONT_AWD_140P5326C0007_1443_-NONE-_-NONE-', 'Award ID': '140P5326C0007', 'Recipient Name': 'OAC ACTION CONSTRUCTION CORP.',
  'Award Amount': 4957922, Description: 'AWARD TASK ORDER FOR DEMOLITION OF THE EXISTING VISITOR CENTER AND CONSTRUCTION OF A NEW CONTACT STATION',
  'Start Date': '2026-09-22', 'Awarding Agency': 'Department of the Interior', 'Awarding Sub Agency': 'National Park Service', 'Place of Performance Zip5': '32780', NAICS: { code: '236220' } };
await t('Scenario 4: a new federal award names the prime contractor, links to its solicitation and is routed as an awarded-project lead', () => {
  const a = L.normalizeUsa(usaRow);
  const cls = L.classify([{ field: 'award description', text: a.description }], undefined, { value: a.amount });
  assert.equal(cls.relevance, 'potential');
  const p = L.usaPayload(a, { place_of_performance: { county_name: 'BREVARD', city_name: 'TITUSVILLE', zip5: '32780' }, date_signed: '2026-09-22',
    latest_transaction_contract_data: { solicitation_identifier: '140P5326R0003' } }, cls);
  assert.equal(p.stage, 'awarded'); assert.equal(p.winner.status, 'awarded'); assert.equal(p.winner.name, 'Oac Action Construction Corp.');
  assert.equal(p.county, 'Brevard'); assert.equal(p.region, 'Central FL'); assert.equal(p.solicitation_no, '140P5326R0003');
  assert.deepEqual(p.alt_keys, ['piid:140P5326C0007']); assert.equal(p.project_value, 4957922);
  assert.match(p.title, /^Award task order for demolition/);
});

const permitRow = { permit_number: 'BLD2026-12345', application_type: 'Building Permit', worktype: 'Alteration', permit_address: '5201 RALEIGH ST',
  property_owner_name: 'VETERANS AFFAIRS SECRETARY', contractor: 'BERNARDO PEREZ', contractor_name: 'OHL ARELLANO CONSTRUCTION COMPANY',
  contractor_address: '7380 WEST SAND LAKE RD,STE # 605,ORLANDO, FL 32819', contractor_phone_number: '(407)553-8900', plan_review_type: 'Commercial',
  estimated_cost: '7000000', project_name: 'FDVA RENOVATION & RETROFIT OF LAKE BALDWIN FACILITY', application_status: 'Open', processed_date: '2026-10-20T00:00:00.000' };
await t('Scenario 5: a private commercial permit is a potential (inferred) lead with the contractor of record to call', () => {
  const x = L.normalizeOrlandoPermit(permitRow);
  const cls = L.classify(L.permitSections(x, 'https://example.test'), undefined, { value: x.value });
  assert.equal(cls.relevance, 'potential');
  assert.ok(cls.evidence.length && cls.evidence.every(e => e.confidence === 'inferred'), 'nothing in a permit is a confirmed request');
  assert.equal(cls.category, 'Institutional & government');
  const p = L.permitPayload(x, cls, { city: 'Orlando', county: 'Orange', source_id: 'orlando_permits', key_prefix: 'orlando', dataset_url: 'https://data.cityoforlando.net/resource/ryhf-m453.json' });
  assert.equal(p.external_key, 'orlando:BLD2026-12345'); assert.equal(p.stage, 'permitting'); assert.equal(p.region, 'Central FL');
  assert.equal(p.opportunity.company_name, 'Ohl Arellano Construction Company'); assert.equal(p.opportunity.approach, 'approach_prime');
  assert.equal(p.opportunity.company_phone, '(407)553-8900'); assert.match(p.value_label, /\$7,000,000 permit valuation/);
  const roof = L.classify(L.permitSections({ ...x, worktype: 'Roof', project: 'REROOF OFFICE BUILDING', owner: 'ABC LLC' }, ''));
  assert.equal(roof.relevance, 'low');
});

await t('Unrelated and non-construction records are kept out (roofing, HVAC, janitorial, design services)', () => {
  assert.equal(C('Design build roof replacement Wilkie Ferguson Federal Building').relevance, 'low');
  assert.equal(C('BB - Replace deteriorated AHU 21, 22, 23 and 24').relevance, 'low');
  assert.equal(C('Janitorial services, Orlando VA Medical Center').relevance, 'low');
  assert.equal(C('A-E services for bridge inspection', 'Architect-engineer services').relevance, 'low');
  assert.equal(C('Janitorial and concrete core drilling services').relevance, 'high', 'a named Speedy service still counts');
  assert.equal(C('Construction of U.S. Customs facility', '', 144_000_000).relevance, 'review', 'big jobs with no scope go to review, not the pool');
});

await t('Search terms are configurable: a manager-added term changes the result, a broken pattern is skipped', () => {
  const custom = [...(L.classify([], undefined).evidence), { label: 'helipad', pattern: 'helipad', kind: 'direct', weight: 3, services: ['Slab sawing'] }, { label: 'bad', pattern: '(', kind: 'direct', weight: 3, services: [] }];
  const c = L.classify([{ field: 'title', text: 'Rooftop helipad rebuild' }], custom);
  assert.equal(c.relevance, 'high'); assert.equal(c.evidence[0].term, 'helipad');
});

await t('SAM.gov: pages are followed until the last page, and notices without a solicitation number are read by notice id', () => {
  assert.equal(L.morePages(50, 50, 0, 4, 54), true, '"repair" had 54 results: page 2 is needed');
  assert.equal(L.morePages(4, 50, 1, 4, 54), false);
  assert.equal(L.morePages(50, 50, 3, 4, 900), false, 'page cap');
  assert.equal(L.isNoticeId('6A0DEFA1AEE74F0EA5251A7E67E57587'), true); assert.equal(L.isNoticeId('W912EP26R0012'), false);
  const n = L.normalizeDetails({ id: '6a0defa1aee74f0ea5251a7e67e57587', archived: false, cancelled: false, postedDate: '2026-08-11T19:46:51Z',
    data2: { type: 's', title: 'SPOTFi Campus Industry Day', solicitationNumber: '', solicitation: { deadlines: {} } }, description: [{ body: '<p>MILCON projects</p>' }] });
  assert.equal(n.type, 'Special Notice'); assert.equal(n.sol, null); assert.equal(n.snippet, 'MILCON projects');
  const p = L.samPayload('6A0DEFA1AEE74F0EA5251A7E67E57587', [n], L.samFacts([n], null), true);
  assert.equal(p.solicitation_no, undefined, 'a notice id is never stored as a solicitation number');
});

await t('FDOT letting results now cover all of Florida and go to review with an inferred-scope note', () => {
  const r = L.parseFdotReport(fx('fdot_report_08261103.html'));
  const p = L.fdotPayload(r.contracts[0], { id: '08261103', date: '11/3/2026', iso: '2026-11-03', url: 'u' }, '08', false);
  assert.equal(p.relevance, 'review'); assert.equal(p.category, 'Transportation & infrastructure');
  assert.equal(p.evidence[0].confidence, 'inferred');
});

await t('Next action follows the verified stage and route', () => {
  assert.match(L.nextActionFor('low_bidder', 'approach_prime', { company: 'SUPERIOR CONSTRUCTION' }), /apparent low bidder \(award not final\)/);
  assert.match(L.nextActionFor('bidding', 'quote_bidders', { services: ['Wall sawing'] }), /Find who is bidding/);
  assert.match(L.nextActionFor('permitting', 'approach_prime', { company: 'X' }), /contractor of record/);
  assert.match(L.nextActionFor('cancelled', 'watch'), /Cancelled/);
});


await t('Permits: one lead per builder and owner, inspection firms and "TBD" are not treated as builders, review codes stripped from names', () => {
  const mkP = (n, extra) => L.normalizeOrlandoPermit({ ...permitRow, permit_number: n, ...extra });
  const g = L.groupPermits([mkP('BLD2026-4', { project_name: 'SPC: BP-507 AIRSIDE RESTROOM REFURBISHMENT AS4', contractor_name: 'BALFOUR BEATTY CONSTRUCTION LLC', property_owner_name: 'GREATER ORLANDO AVIATION AUTHORITY', estimated_cost: '14052559' }),
    mkP('BLD2026-3', { project_name: 'SPC: BP-507 AIRSIDE RESTROOM REFURBISHMENT AS3', contractor_name: 'BALFOUR BEATTY CONSTRUCTION LLC', property_owner_name: 'GREATER ORLANDO AVIATION AUTHORITY', estimated_cost: '14465583' }),
    mkP('BLD2026-9', { project_name: 'PP - OUC LAKE HIGHLAND WATER TREATMENT PLT', contractor_name: 'UES PROFESSIONAL SOLUTIONS, LLC.', property_owner_name: 'ORLANDO UTILITIES COMMISSION' })]);
  assert.equal(g.length, 2); assert.deepEqual(g[0].map(x => x.number), ['BLD2026-3', 'BLD2026-4']);
  const cls = L.classify(g[0].flatMap(x => L.permitSections(x, '')));
  const p = L.permitPayload(g[0][1], cls, { city: 'Orlando', county: 'Orange', source_id: 'orlando_permits', key_prefix: 'orlando', dataset_url: 'u' }, g[0]);
  assert.match(p.title, /^Bp-507 Airside Restroom Refurbishment As4 .*\(2 permits\)$/); assert.equal(p.project_value, 28518142);
  assert.deepEqual(p.alt_keys, ['orlando:BLD2026-4']);
  assert.equal(L.builderOf(g[1][0]), null, 'an engineering / inspection firm is not the builder');
  const q = L.permitPayload(g[1][0], cls, { city: 'Orlando', county: 'Orange', source_id: 'orlando_permits', key_prefix: 'orlando', dataset_url: 'u' });
  assert.equal(q.opportunity.approach, 'approach_developer'); assert.equal(q.opportunity.company_name, undefined);
  assert.equal(L.builderOf({ ...g[0][0], contractor: 'TBD' }), null);
  assert.equal(L.cleanPermitName('Pp - OMD Blue Origin RTU Installation'), 'Blue Origin RTU Installation');
});


await t('Real SAM.gov records that were missed before are now caught (from the Nov 9 live audit)', () => {
  const r = (title, d = '') => C(title, d).relevance;
  assert.equal(r('Reconfigure and Modernize the 1600-member LTC Luis E. Martinez Army Reserve Center (ARC) in Perrine, FL'), 'potential');
  assert.equal(r('Kissimmee River Restoration (KRR) Project, S-69 Weir Repair'), 'potential');
  assert.equal(r('Avon Park Delta Ramp Repairs'), 'potential');
  assert.equal(r('St. Lucie South Jetty Repair Industry Day'), 'potential');
  assert.equal(r('Y1DZ--675-106 Expand Radiology & Oncology  Minor Construction - Lake Nona'), 'potential');
  assert.equal(r('Y1DA--573-21-106 EHRM Infrastructure  Upgrades and Data Center Construction - Gainesville VAMC'), 'review');
  assert.equal(r('(PROJ 675-24-106) BB Upgrade Lake Baldwin Pharmacy Hazardous Mixing Room - Construction'), 'review', '"Pharmacy" is not a pharmaceuticals purchase');
  assert.equal(r('P110 Cape Canaveral Railhead and Transfer Facilities', 'FOR THE DESIGN-BID-BUILD (DBB) CONSTRUCTION PROJECT'), 'review');
  assert.equal(r('Replace Elevators at FDC Miami'), 'review');
  assert.equal(r('Everglades National Park, Flamingo Marina Bulkhead Rehabilitation', 'The project work includes the removal of the existing concrete cap'), 'high');
  assert.equal(r('J045--FY 27 Grease Trap and Lift Station Maintenance'), 'low', 'a maintenance service contract is not a construction lead');
  assert.equal(r('Hoist and Cranes Maintenance Services FY27'), 'low');
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
