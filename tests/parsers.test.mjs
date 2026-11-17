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


await t('Every one of Speedy\'s eleven published services is recognized as documented scope', () => {
  const cases = { 'Road & bridge deconstruction': 'Removal of the existing bridge and barrier wall removal', 'Core drilling': 'Core drill 12 holes through the slab',
    'Wire sawing': 'Wire saw the pier cap', 'Slab sawing': 'Slab sawing for trench', 'Chain sawing': 'Concrete chain saw openings',
    'Hand sawing': 'Hand saw concrete at the stair', 'Curb sawing': 'Curb and gutter removal', 'Wall sawing': 'Wall sawing for new door openings',
    'Robotic demolition': 'Robotic demolition of the mezzanine', 'Breaking & removal': 'Concrete removal and haul-off', 'GPR scanning': 'GPR scan before coring' };
  for (const [svc, text] of Object.entries(cases)) {
    const c = C('Project', text);
    assert.equal(c.relevance, 'high', svc); assert.ok(c.services.includes(svc), `${svc}: ${c.services}`);
  }
});

await t('Diamond grinding (12th service): road and floor wording counts as inferred grinding scope', () => {
  const road = C('SR 528 concrete pavement restoration', 'Bump grinding and joint resealing of concrete pavement');
  assert.ok(['potential', 'high'].includes(road.relevance)); assert.ok(road.services.includes('Diamond grinding'), road.services.join());
  const floor = C('Distribution center refresh', 'Remove epoxy floor coating and polish concrete in the warehouse');
  assert.ok(floor.services.includes('Diamond grinding'), floor.services.join());
  assert.equal(C('Diamond grinding of the bridge deck').relevance, 'high');
});

// Synthetic records shaped exactly like the live feeds (no real owners or applicants in this public repository).
const orlPlan = (o) => ({ application_number: 'MPL2026-10001', application_name: 'Lakeside Commons', application_description: 'Master Plan', application_status: 'Open',
  address: '100 EXAMPLE AVE', application_date: '2026-09-01T00:00:00.000', last_action_date: '2026-11-10T00:00:00.000',
  application_comments: 'New 12 story office building 240,000 sf with a 3 level parking garage; demolish existing 20,000 sf retail building',
  parcel_id: '00-00-00-0000-00-001', applicant: 'Example Engineering Group (Jane Roe)', ...o });

await t('Orlando planning applications: commercial work kept, fences and variances dropped, engineer and contact recorded', () => {
  const keep = L.normalizeOrlandoPlanning(orlPlan());
  assert.equal(L.planningWanted(keep), true);
  assert.equal(L.planningWanted(L.normalizeOrlandoPlanning(orlPlan({ application_description: 'Variances' }))), false);
  assert.equal(L.planningWanted(L.normalizeOrlandoPlanning(orlPlan({ application_description: 'Pre Application Meeting', application_name: 'Fence in front yard', application_comments: 'six foot fence for a single family home' }))), false);
  assert.equal(L.planningWanted(L.normalizeOrlandoPlanning(orlPlan({ application_description: 'Pre Application Meeting', application_name: 'Former bank site', application_comments: 'redevelop the site as a 180 unit mixed use building' }))), true);
  // homeowner work in a historic district or a door swap downtown is not a lead, even when it says demolition or addition
  const homeowner = (o) => L.planningWanted(L.normalizeOrlandoPlanning(orlPlan({ application_description: 'Historic Preservation Board', ...o })));
  assert.equal(homeowner({ application_name: '27 Example Ave - Alterations', application_comments: 'Selective demolition and repair of house due to termite damage' }), false);
  assert.equal(homeowner({ application_name: '200 Example Ct', application_comments: '286 sq ft efficiency with kitchenette within attic of existing garage' }), false);
  assert.equal(homeowner({ application_description: 'Appearance Review Board', application_name: '27 E Example St - Minor review', application_comments: 'Remove and replace door, replacing window glass only' }), false);
  assert.equal(homeowner({ application_description: 'Appearance Review Board', application_name: '640 W Example St', application_comments: 'Demolition of an existing office building damaged beyond repair' }), true);
  assert.equal(homeowner({ application_name: '1400 Example St (Addition)', application_comments: 'Porch extension approx 230 sf' }), false);
  assert.equal(homeowner({ application_name: '346 Example (Addition)', application_comments: 'I want to build 2 apartments in my existing detached garage' }), false);
  assert.equal(homeowner({ application_description: 'Pre Application Meeting', application_name: 'Signage for Example Office Bldg', application_comments: 'new wall signs for the office building' }), false);
  assert.equal(homeowner({ application_description: 'Determination', application_name: '55 W Example St - mural 2', application_comments: 'mural on the retail building' }), false);
  assert.equal(homeowner({ application_description: 'Pre Application Meeting', application_name: 'Former bank site', application_comments: 'redevelop the site as a 180 unit mixed use building' }), true);
  assert.equal(L.poolWorthy('Demolition of an existing office building damaged beyond repair'), true);
  assert.equal(L.poolWorthy('build 2 apartments in my existing detached garage'), false);
  assert.equal(L.poolWorthy('Signage for Example Office Bldg'), false);
  const cls = L.classify(L.planningSections(keep, 'u'));
  const p = L.planningPayload(keep, cls, { source_id: 'orlando_planning', dataset_url: 'https://data.cityoforlando.net/resource/bhxy-4rji.json' });
  assert.equal(p.stage, 'design'); assert.equal(p.external_key, 'orlplan:MPL2026-10001'); assert.match(p.size_note, /240,000 sq ft/);
  assert.deepEqual(p.extras.stakeholders.map(x => x.role), ['engineer', 'applicant']);
  assert.equal(p.extras.signal_type, 'site_plan');
  assert.equal(L.planningStage('Zoning'), 'planning');
  if (cls.relevance === 'high' || cls.relevance === 'potential') assert.equal(p.opportunity.approach, 'approach_developer');
  else assert.equal(p.opportunity, undefined, 'weak signals stay on Early signals, out of the pool');
});

await t('Orange County cases: code-violation variances dropped, rezonings are entitlement, development plans are design, planner kept as a contact', () => {
  const base = { FOLDERRSN: 1, FOLDERNAME: 'Example PD / Lot 4 - Dealership DP', APPLICANT: 'Example Civil Engineers, Inc. (John Doe) (John Doe)',
    FOLDERTYPE: 'CDR Change Determination Review', FOLDERDESCRIPTION: 'To expand and renovate the existing dealership with a 4-level parking structure',
    ACREAGE: '5.0512', PARCELID_STR: '00-00-00-0000-00-002\r', USERNAME: 'Pat Planner', USERPHONE: '407-555-0100', EMAILADDRESS: 'pat@example.gov' };
  const c = L.normalizeCountyCase(base);
  assert.equal(L.countyCaseWanted(c), true);
  assert.equal(L.countyCaseWanted(L.normalizeCountyCase({ ...base, FOLDERTYPE: 'VA Zoning Variance', FOLDERDESCRIPTION: 'Variance to allow a 6 ft fence. NOTE: This is the result of a code violation' })), false);
  assert.equal(L.countyCaseWanted(L.normalizeCountyCase({ ...base, FOLDERNAME: '7000 Example Road', FOLDERTYPE: 'RZ Conventional Rezoning', FOLDERDESCRIPTION: 'To rezone from R-1A to R-1 to develop a single-family subdivision of 30 lots' })), false, 'house subdivisions are not Speedy work');
  assert.equal(L.countyCaseWanted(L.normalizeCountyCase({ ...base, FOLDERTYPE: 'RZ Conventional Rezoning', FOLDERDESCRIPTION: 'To rezone from A-2 to R-3 to allow 53 multi-family units' })), true);
  assert.equal(L.countyCaseStage('RZ Conventional Rezoning'), 'planning'); assert.equal(L.countyCaseStage('LUP Land Use Plan (PD)'), 'planning');
  assert.equal(L.countyCaseStage('DP Development Plan Review'), 'design');
  const p = L.countyCasePayload(c, L.classify([{ field: 'd', text: c.description }]), { source_id: 'orange_dev_cases', url: 'u' });
  assert.equal(p.stage, 'design'); assert.equal(p.extras.parcel_id, '00-00-00-0000-00-002'); assert.equal(p.extras.acreage, 5.05);
  const roles = p.extras.stakeholders.map(x => x.role);
  assert.deepEqual(roles, ['engineer', 'applicant', 'agency_contact']);
  assert.equal(p.extras.stakeholders[2].phone, '407-555-0100');
});

await t('Property sales: one record per deal, companies buying land or commercial buildings kept, houses, condos and apartments dropped', () => {
  const sale = (o) => L.normalizeSale({ PARCEL: '000000000000001', NAME1: 'EXAMPLE LAND HOLDINGS LLC', ADD1: '1 MAIN ST', ADD2: 'ORLANDO FL 32801',
    SALE_DATE: Date.UTC(2026, 9, 1), SALE_ADJ_VALUE: 4200000, DOR_CODE: '1000', ACREAGE: 6.2, ZONING_CODE: 'C-2', SITUS: '0 EXAMPLE RD', CITY_SITUS: 'UN-INCORPORATED', ...o });
  const units = [1, 2, 3].map(i => sale({ PARCEL: `00000000000010${i}`, DOR_CODE: '0122', NAME1: 'EXAMPLE CONDO VENTURES LLC', SITUS: `5 PARK ST UNIT ${i}` }));
  const groups = L.groupSales([sale(), ...units]);
  assert.equal(groups.length, 2, 'three condo units in one deal are one sale');
  assert.equal(L.saleWanted(groups.find(g => g[0].dor === '1000')), true);
  assert.equal(L.saleWanted(groups.find(g => g[0].dor === '0122')), false, 'condos are residential');
  assert.equal(L.saleWanted([sale({ DOR_CODE: '0310' })]), false, 'apartment trades are not construction');
  assert.equal(L.saleWanted([sale({ NAME1: 'JANE DOE' })]), false, 'a person buying land is not a development signal');
  assert.equal(L.saleWanted([sale({ SALE_ADJ_VALUE: 900000 })]), false);
  assert.equal(L.saleWanted([sale({ DOR_CODE: '1100', ACREAGE: 1.2, GROSS_AREA: 40000, AYB: 1988 })]), true, 'commercial building bought by a company');
  assert.equal(L.saleWanted([sale({ DOR_CODE: '1100', ACREAGE: 0.4, GROSS_AREA: 3500, SALE_ADJ_VALUE: 1600000 })]), false, 'a small shop is not a redevelopment signal');
  assert.equal(L.saleWanted([sale({ NAME1: 'JOHN EXAMPLE TRUST', DOR_CODE: '0000', ACREAGE: 5.1 })]), false, 'a family trust buying acreage is not a developer');
  assert.equal(L.saleWanted([sale({ DOR_CODE: '0000', ACREAGE: 6 })]), false, 'vacant residential acreage needs 10+ acres');
  const p = L.salePayload([sale()], { source_id: 'orange_land_sales' });
  assert.equal(p.stage, 'land'); assert.equal(p.relevance, 'review'); assert.equal(p.opportunity, undefined, 'sales never go straight to the pool');
  assert.match(p.title, /^Example Land Holdings LLC bought 6\.2 acres of vacant land at 0 Example Rd$/);
  assert.equal(p.city, null, 'unincorporated is not a city');
  assert.equal(p.extras.stakeholders[0].role, 'buyer'); assert.match(p.extras.stakeholders[0].address, /1 Main St/);
});

await t('Miami-Dade permits: grouped by master permit, builder from the master, trade permits and re-roofs dropped, value never summed', () => {
  const rec = (o) => L.normalizeMiamiDadePermit({ PermitNumber: '2027000001', MasterPermitNumber: '0000000000', PermitType: 'BLDG', ApplicationTypeDescription: 'ALTER - INTERIOR',
    ProposedUseDescription: 'RESTAURANT/CAFET/BAR/LOUNGE/NIGHT CLUB', DetailDescriptionComments: 'INT REMODEL/OFFICES', EstimatedValue: '1250000',
    ApplicationDate: Date.UTC(2026, 9, 20, 4), PermitIssuedDate: null, FolioNumber: '3000000000001', OwnerName: 'EXAMPLE ACRES LLC',
    PropertyAddress: '100 SW 1 ST', ArchitectName: 'EXAMPLE ARCHITECTS', ContractorNumber: 'CGC0000001', ContractorName: 'EXAMPLE BUILDERS\\, INC. DBA:EXAMPLE CONSTRUC',
    ContractorAddress: '1 BUILDER WAY', ContractorCity: 'MIAMI', ContractorState: 'FL', ContractorZip: '33101', ContractorPhone: '(305)555-0100', SquareFootage: '5200', ...o });
  const master = rec({ PermitNumber: '2026000100' });
  const roof = rec({ PermitNumber: '2027000002', MasterPermitNumber: '2026000100', ContractorName: 'EXAMPLE ROOFING INC', ContractorPhone: '(305)555-0111' });
  const pool = rec({ PermitNumber: '2027000003', DetailDescriptionComments: 'SWIMMING POOL', ApplicationTypeDescription: 'ADDITION - DETACHED', EstimatedValue: '550000' });
  const reroof = rec({ PermitNumber: '2027000004', ApplicationTypeDescription: 'REPAIR', DetailDescriptionComments: 'REPAIRS/RPL ROOF', ContractorName: 'EXAMPLE ROOF CORP' });
  const small = rec({ PermitNumber: '2027000005', ApplicationTypeDescription: 'ALTER - INTERIOR', EstimatedValue: '90000' });
  const demo = rec({ PermitNumber: '2027000006', ApplicationTypeDescription: 'DEMOLISH', DetailDescriptionComments: 'DEMO BLDG', EstimatedValue: '80000', ContractorName: 'OWNER' });
  const unit = rec({ PermitNumber: '2027000007', ProposedUseDescription: 'CONDO/APT INDIVIDUAL UNIT', EstimatedValue: '400000' });
  assert.equal(roof.master, '2026000100'); assert.equal(master.master, null); assert.equal(roof.processed, '2026-10-20');
  const groups = L.groupMiamiDade([roof, master, pool, reroof, small, demo, unit]);
  assert.equal(groups.length, 6, 'the roofing sub-permit joins its master');
  const job = groups.find(g => g.length === 2);
  assert.equal(L.mdLead(job).number, '2026000100'); assert.equal(L.mdValue(job), 1250000, 'sub-permits repeat the master value');
  const want = (n) => L.miamiDadeWanted(groups.find(g => g[0].number === n));
  assert.equal(L.miamiDadeWanted(job), true);
  assert.equal(want('2027000003'), false, 'pools are not Speedy work');
  assert.equal(want('2027000004'), false, 'a re-roof is not Speedy work');
  assert.equal(want('2027000005'), false, 'under $250,000');
  assert.equal(want('2027000006'), true, 'demolition from $50,000');
  assert.equal(want('2027000007'), false, 'a single condo unit');
  const cls = L.classify(L.miamiDadeSections(job));
  assert.notEqual(cls.relevance, 'low');
  const p = L.miamiDadePayload(job, cls, { source_id: 'miamidade_permits' });
  assert.equal(p.external_key, 'mdc:2026000100'); assert.deepEqual(p.alt_keys, ['mdc:2027000002']);
  assert.equal(p.county, 'Miami-Dade'); assert.equal(p.region, 'Southeast FL'); assert.equal(p.project_value, 1250000);
  assert.equal(p.opportunity.company_name, 'Example Builders, INC.'); assert.equal(p.opportunity.approach, 'approach_prime');
  const roles = p.extras.stakeholders.map(x => x.role);
  assert.deepEqual(roles, ['owner', 'contractor', 'architect', 'contractor']);
  assert.match(p.extras.stakeholders[3].name, /Example Roofing INC \(trade/);
  assert.equal(p.extras.parcel_id, '3000000000001'); assert.equal(p.extras.signal_type, 'permit');
  assert.match(p.source_url, /PermitNumber%3D'2026000100'|PermitNumber%3D%272026000100%27/);
  const d = L.miamiDadePayload(groups.find(g => g[0].number === '2027000006'), L.classify(L.miamiDadeSections(groups.find(g => g[0].number === '2027000006'))), { source_id: 'miamidade_permits' });
  assert.equal(d.opportunity.approach, 'approach_developer', 'owner-builder: approach the owner');
  assert.match(d.title, /^Demolition Building \(demolition, 100 Sw 1 St\)$/);
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
