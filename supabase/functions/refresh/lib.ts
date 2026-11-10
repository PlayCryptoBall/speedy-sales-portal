// Pure parsing and mapping helpers for the refresh job (no Deno or network APIs, so they can be unit tested).
import { DEFAULT_TERMS, type Term } from './terms.ts';

export const REGION_BY_COUNTY: Record<string, string> = {};
// Six sales regions covering all 67 counties (same table as public.fl_counties).
export const REGIONS: Record<string, string[]> = {
  'Central FL': ['Orange', 'Osceola', 'Seminole', 'Lake', 'Volusia', 'Brevard', 'Polk', 'Sumter', 'Marion', 'Flagler'],
  'Tampa Bay': ['Hillsborough', 'Pinellas', 'Pasco', 'Hernando', 'Citrus', 'Manatee', 'Sarasota'],
  'Northeast FL': ['Duval', 'St. Johns', 'Clay', 'Nassau', 'Baker', 'Putnam', 'Alachua', 'Columbia', 'Union', 'Bradford', 'Levy', 'Gilchrist',
    'Suwannee', 'Hamilton', 'Lafayette', 'Dixie'],
  'Southwest FL': ['Lee', 'Collier', 'Charlotte', 'Hendry', 'Glades', 'DeSoto', 'Highlands', 'Hardee'],
  'Southeast FL': ['Miami-Dade', 'Broward', 'Palm Beach', 'Monroe', 'Martin', 'St. Lucie', 'Indian River', 'Okeechobee'],
  'Panhandle': ['Escambia', 'Santa Rosa', 'Okaloosa', 'Walton', 'Bay', 'Holmes', 'Washington', 'Jackson', 'Calhoun', 'Gulf', 'Liberty',
    'Franklin', 'Gadsden', 'Leon', 'Wakulla', 'Jefferson', 'Madison', 'Taylor'],
};
const R = REGIONS;
for (const [region, counties] of Object.entries(R)) for (const c of counties) REGION_BY_COUNTY[c.toUpperCase()] = region;

// Cities that federal and state notices name, mapped to their county.
const CITY_LIST = `Orlando,Winter Park,Apopka,Ocoee,Winter Garden,Maitland,Lake Buena Vista,Bay Lake:Orange|Kissimmee,St. Cloud,Saint Cloud,Celebration:Osceola|Sanford,Altamonte Springs,Oviedo,Lake Mary,Longwood,Casselberry,Winter Springs:Seminole|Clermont,Leesburg,Tavares,Eustis,Mount Dora,Groveland:Lake|Daytona Beach,DeLand,Deland,Deltona,Ormond Beach,Port Orange,New Smyrna Beach:Volusia|Melbourne,Palm Bay,Titusville,Cocoa,Cocoa Beach,Cape Canaveral,Merritt Island,Patrick SFB,Patrick AFB,Patrick Space Force Base,Kennedy Space Center,Rockledge,Satellite Beach,Viera:Brevard|Lakeland,Winter Haven,Bartow,Haines City,Lake Wales,Davenport,Auburndale:Polk|The Villages,Bushnell,Wildwood:Sumter|Ocala:Marion|Palm Coast,Bunnell:Flagler|Tampa,Brandon,Plant City,Temple Terrace,Riverview,MacDill AFB,Ruskin:Hillsborough|St. Petersburg,Saint Petersburg,St Petersburg,Clearwater,Largo,Pinellas Park,Dunedin,Tarpon Springs,Oldsmar:Pinellas|New Port Richey,Zephyrhills,Dade City,Wesley Chapel,Land O Lakes:Pasco|Brooksville,Spring Hill:Hernando|Inverness,Crystal River:Citrus|Bradenton,Palmetto:Manatee|Sarasota,Venice,North Port:Sarasota|Jacksonville,Jacksonville Beach,Atlantic Beach,Mayport,Neptune Beach:Duval|St. Augustine,Saint Augustine,St Augustine,Ponte Vedra Beach,Ponte Vedra:St. Johns|Orange Park,Green Cove Springs,Fleming Island:Clay|Fernandina Beach,Yulee:Nassau|Gainesville:Alachua|Lake City:Columbia|Palatka:Putnam|Starke:Bradford|Macclenny:Baker|Live Oak:Suwannee|Chiefland:Levy|Fort Myers,Ft. Myers,Cape Coral,Bonita Springs,Lehigh Acres,Estero:Lee|Naples,Marco Island,Immokalee:Collier|Punta Gorda,Port Charlotte:Charlotte|Sebring,Avon Park:Highlands|Arcadia:DeSoto|Wauchula:Hardee|Clewiston,LaBelle:Hendry|Moore Haven:Glades|Miami,Hialeah,Miami Beach,Homestead,Doral,Coral Gables,North Miami,Miami Gardens,Kendall:Miami-Dade|Fort Lauderdale,Ft. Lauderdale,Ft Lauderdale,Hollywood,Pembroke Pines,Pompano Beach,Coral Springs,Davie,Plantation,Sunrise,Miramar,Deerfield Beach,Dania Beach:Broward|West Palm Beach,Boca Raton,Delray Beach,Boynton Beach,Jupiter,Palm Beach Gardens,Riviera Beach,Wellington,Belle Glade:Palm Beach|Key West,Marathon,Key Largo:Monroe|Stuart:Martin|Port St. Lucie,Port Saint Lucie,Port St Lucie,Fort Pierce,Ft. Pierce,Ft Pierce:St. Lucie|Vero Beach,Sebastian:Indian River|Okeechobee:Okeechobee|Pensacola:Escambia|Milton,Navarre,Gulf Breeze:Santa Rosa|Fort Walton Beach,Destin,Crestview,Eglin AFB,Hurlburt Field,Niceville:Okaloosa|Panama City,Panama City Beach,Tyndall AFB,Lynn Haven:Bay|Tallahassee:Leon|Quincy:Gadsden|Marianna:Jackson|Chipley:Washington|DeFuniak Springs,Santa Rosa Beach:Walton|Apalachicola:Franklin|Port St. Joe:Gulf|Perry:Taylor|Monticello:Jefferson|Crawfordville:Wakulla`;
export const CITY_COUNTY: Record<string, string> = {};
for (const grp of CITY_LIST.split('|')) { const [cities, county] = grp.split(':'); for (const c of cities.split(',')) CITY_COUNTY[c.trim().toUpperCase()] = county; }
export function countyForCity(city?: string | null): string | null {
  return city ? CITY_COUNTY[city.trim().toUpperCase().replace(/\s+/g, ' ')] || null : null;
}

export function countyName(raw: string): string {
  const s = (raw || '').trim().toUpperCase().replace(/ COUNTY$/, '');
  const fix: Record<string, string> = { 'MIAMI DADE': 'Miami-Dade', 'DADE': 'Miami-Dade', 'ST JOHNS': 'St. Johns', 'ST. JOHNS': 'St. Johns',
    'ST LUCIE': 'St. Lucie', 'ST. LUCIE': 'St. Lucie', 'DESOTO': 'DeSoto', 'DE SOTO': 'DeSoto' };
  if (fix[s]) return fix[s];
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
export function regionForCounty(c: string): string {
  return REGION_BY_COUNTY[countyName(c).toUpperCase()] || 'Unknown';
}
// First three digits of a Florida ZIP code -> sales region.
export function regionForZip(zip?: string | null): string {
  const z = parseInt(String(zip || '').slice(0, 3), 10);
  if (!z) return 'Unknown';
  if ([321, 327, 328, 329, 338, 344, 347].includes(z)) return 'Central FL';   // 321 = Daytona Beach / Palm Coast
  if ([335, 336, 337, 342, 346].includes(z)) return 'Tampa Bay';
  if ([320, 322, 326].includes(z)) return 'Northeast FL';
  if ([339, 341].includes(z)) return 'Southwest FL';
  if ([330, 331, 332, 333, 334, 349].includes(z)) return 'Southeast FL';
  if ([323, 324, 325].includes(z)) return 'Panhandle';
  return 'Unknown';
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
export const stripTags = (s: string) => decode((s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\b(Llc|Inc|Jv|Co|Ii|Iii|Usa)\b/g, m => m.toUpperCase());

// ---------------------------------------------------------------- FDOT letting results
export const FDOT_DISTRICTS = ['99', '01', '02', '03', '04', '05', '06', '07', '08'];
export const FDOT_BASE = 'https://bidletting.fdot.gov';
export const fdotDistrictName = (d: string) => d === '99' ? 'FDOT Central Office' : d === '08' ? "Florida's Turnpike Enterprise" : `FDOT District ${parseInt(d, 10)}`;

export interface Letting { id: string; date: string; iso: string; url: string }
export function parseFdotList(html: string): Letting[] {
  const out: Letting[] = [];
  const re = /<div id="([A-Z0-9]{2}\d{6})">\s*<a id="(\d{1,2}\/\d{1,2}\/\d{4})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const [mo, d, y] = m[2].split('/').map(Number);
    out.push({ id: m[1], date: m[2], iso: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      url: `${FDOT_BASE}/LettingResults/DisplayPreliminaryReport?id=${m[1]}&lettingDate=${m[2]}` });
  }
  return out;
}

export interface FdotContract { contract: string; finProject: string | null; county: string; bidders: { name: string; amount: number | null; rank: number }[] }
export interface FdotReport { complete: boolean; status: string; lettingDate: string | null; contracts: FdotContract[] }
export function parseFdotReport(html: string): FdotReport {
  const status = (html.match(/class="resultsComplete">([^<]+)</) || [])[1]?.trim() || '';
  const lettingDate = (html.match(/PRELIMINARY\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+LETTING/i) || [])[1] || null;
  const contracts: FdotContract[] = [];
  const blocks = html.split(/<div id="contractHeader"/).slice(1);
  for (const b of blocks) {
    const field = (label: string) => {
      const m = b.match(new RegExp(`<span>${label}:</span>\\s*([^<]*)<`, 'i'));
      return m ? decode(m[1]).trim() : '';
    };
    const contract = field('Contract No');
    if (!contract) continue;
    const bidders: FdotContract['bidders'] = [];
    const re = /<div class="vendorName">\s*([^<]+?)\s*<\/div>[\s\S]*?<div class="bidTotal">\s*([^<]*)<\/div>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b))) {
      const name = decode(m[1]).trim();
      if (/CONTRACTOR'?S NAME/i.test(name)) continue;
      const amt = parseFloat(m[2].replace(/[$,\s]/g, ''));
      bidders.push({ name, amount: isFinite(amt) ? amt : null, rank: 0 });
    }
    bidders.sort((a, z) => (a.amount ?? Infinity) - (z.amount ?? Infinity)).forEach((x, i) => x.rank = i + 1);
    contracts.push({ contract: contract.toUpperCase(), finProject: field('Fin Prj No') || null, county: field('County'), bidders });
  }
  const complete = /complete/i.test(status) && contracts.some(c => c.bidders.length > 0);
  return { complete, status, lettingDate, contracts };
}

export function fdotPayload(c: FdotContract, letting: Letting, district: string, tracked: boolean) {
  const low = c.bidders[0];
  const county = countyName(c.county);
  const money = (n: number | null | undefined) => n == null ? '' : '$' + Math.round(n).toLocaleString('en-US');
  const status = `Preliminary results ${letting.date}: ${c.bidders.length} bid${c.bidders.length === 1 ? '' : 's'}` +
    (low ? `; apparent low bid ${money(low.amount)} by ${titleCase(low.name)}` : '') + '. Not an award until FDOT posts it.';
  const p: Record<string, unknown> = {
    external_key: `fdot:${c.contract.replace(/-R0$/, '')}`,
    source_id: 'fdot_lettings',
    solicitation_no: c.contract,
    status_text: status,
    source_url: letting.url,
    source_name: 'FDOT letting results',
    bidders: c.bidders.map(b => ({ name: titleCase(b.name), amount: b.amount, rank: b.rank })),
  };
  if (low) p.winner = { name: titleCase(low.name), amount: low.amount, status: 'low_bidder', as_of: letting.iso, source_url: letting.url };
  if (c.finProject) p.alt_keys = [`fpn:${c.finProject.replace(/[^0-9]/g, '')}`];
  if (!tracked) {
    const statewide = /DIST|ST-?WIDE/i.test(c.county);
    Object.assign(p, {
      title: `FDOT contract ${c.contract}, ${statewide ? 'district-wide' : county + ' County'}`,
      short_title: `FDOT ${c.contract} (${statewide ? 'district-wide' : county})`,
      owner_name: fdotDistrictName(district), level: 'FDOT', county: statewide ? null : county, region: regionForCounty(county),
      location_text: statewide ? 'District-wide' : `${county} County`, stage: low ? 'low_bidder' : 'bid_closed',
      deadline: `${letting.iso}T10:30:00-05:00`, category: 'Transportation & infrastructure',
      size_note: low ? `Low bid ${money(low.amount)}${c.finProject ? '; FPN ' + c.finProject : ''}` : null,
      source_summary: 'FDOT preliminary letting results list bidders and amounts only. Open the letting notice for the work description.',
      services_likely: [], relevance: 'review', relevance_score: 1,
      evidence: [{ term: 'FDOT road/bridge construction contract', kind: 'indicator', confidence: 'inferred', field: 'letting results',
        doc: 'FDOT preliminary letting results', url: letting.url, services: ['Slab sawing', 'Curb sawing', 'Breaking & removal'],
        snippet: 'Letting results give no work description. Pavement, curb and sidewalk sawcutting and removal are common on FDOT contracts but are not confirmed here.' }],
      review_reason: 'FDOT letting result with no work description: open the letting notice, confirm concrete work, then publish',
    });
  }
  return p;
}

// ---------------------------------------------------------------- SAM.gov
export const SAM_SEARCH = 'https://sam.gov/api/prod/sgs/v1/search/';
export interface SamNotice {
  id: string; title: string; type: string; sol: string | null; originalSol: string | null; active: boolean; canceled: boolean;
  published: string | null; modified: string | null; deadline: string | null; agency: string; office: string; officeState: string | null;
  awardee: string | null; awardAmount: number | null; snippet: string; parent: string | null; awardNumber?: string | null;
}
export function normalizeSgs(r: any): SamNotice {
  const org = (r.organizationHierarchy || []) as any[];
  const snippet = stripTags((r.descriptions || [])[0]?.content || '');
  const orig = snippet.match(/Original Solicitation Number:\s*([A-Z0-9-]+)/i);
  return {
    id: r._id, title: (r.title || '').trim(), type: r.type?.value || '', sol: r.solicitationNumber || null,
    originalSol: orig ? orig[1] : null, active: !!r.isActive, canceled: !!r.isCanceled,
    published: r.publishDate || null, modified: r.modifiedDate || null,
    deadline: r.responseDateActual || r.responseDate || null,
    agency: org.filter(o => o.level <= 3).map(o => o.name).join(' / '),
    office: org.length ? org[org.length - 1].name : '', officeState: org.length ? org[org.length - 1].address?.state || null : null,
    awardee: r.award?.awardee?.name || null, awardAmount: null, snippet, parent: r.parentNoticeId || null,
    awardNumber: r.award?.number || null,
  };
}
// Official API (api.sam.gov, needs a free key) mapped to the same shape.
export function normalizeOfficial(r: any): SamNotice {
  return {
    id: r.noticeId, title: (r.title || '').trim(), type: r.type || r.baseType || '', sol: r.solicitationNumber || null, originalSol: null,
    active: r.active === 'Yes', canceled: /cancel/i.test(r.type || '') || /cancel/i.test(r.archiveType || ''),
    published: r.postedDate || null, modified: r.postedDate || null, deadline: r.responseDeadLine || null,
    agency: (r.fullParentPathName || '').split('.').slice(0, 3).join(' / '), office: (r.fullParentPathName || '').split('.').pop() || '',
    officeState: r.officeAddress?.state || null, awardee: r.award?.awardee?.name || null,
    awardAmount: r.award?.amount ? Number(r.award.amount) : null, snippet: r.description && !/^https?:/.test(r.description) ? stripTags(r.description).slice(0, 1500) : '', parent: null,
    awardNumber: r.award?.number || null,
  };
}

const STRONG = /\b(demoli\w*|concrete|slab|pavement|paving|apron|taxiway|taxilane|runway|sidewalk|curb|bridge|culvert|foundation|seawall|bulkhead|wharf|pier|dock|renovat\w*|alteration|repair (and|&) (replace|alter)\w*|construct(ion)?|design[- ]build|matoc|satoc|idiq construction|structural|spall\w*|ada (upgrade|improvement)|lift station|sewer|water main|storm ?water|drainage|parking (garage|structure|lot)|elevator moderni[sz]ation|hangar|dormitory|barracks|facility (renovation|repair|upgrade))\b/i;
const EXCLUDE = /\b(janitorial|custodial|mowing|lawn|grounds maintenance|landscap\w*|software|license|it services|medical (supplies|equipment)|pharma\w*|food|catering|laundry|uniform|consult\w*|training|travel|vehicle|fuel|pest control|guard services|security services|furniture|printing|staffing|telecommunications|network equipment|laptop|computer|ammunition|aircraft parts|spare parts|repair parts|a-?e services|architect[- ]engineer|engineering services|survey(ing)? services|environmental (services|consulting)|hvac maintenance|elevator maintenance)\b/i;
export function relevance(text: string): 'high' | 'low' | 'skip' {
  if (EXCLUDE.test(text) && !/\b(demoli|concrete|paving|pavement|renovat)/i.test(text)) return 'skip';
  if (STRONG.test(text)) return /\b(demoli|concrete|slab|pavement|paving|sidewalk|curb|bridge|renovat|spall|seawall|apron|taxiway|runway|foundation|culvert|parking)/i.test(text) ? 'high' : 'low';
  return 'skip';
}

const SERVICE_HINTS: [RegExp, string][] = [
  [/demoli|remov|tear ?down|abatement/i, 'Breaking & removal'], [/renovat|alteration|retrofit|elevator|tie-?in|utility|sewer|water|drain|lift station/i, 'Core drilling'],
  [/renovat|alteration|slab|floor|elevator|existing/i, 'GPR scanning'], [/bridge|wall|barrier|seawall|structural|wharf|pier/i, 'Wall sawing'],
  [/slab|pavement|paving|apron|taxiway|runway|sidewalk|parking|road/i, 'Slab sawing'], [/bridge|pier|wharf|massive|dam|weir/i, 'Wire sawing'],
  [/curb|sidewalk|ada/i, 'Curb sawing'], [/grind|trip hazard|sidewalk/i, 'Diamond grinding'],
];
export function likelyServices(text: string): string[] {
  const out = new Set<string>();
  for (const [re, s] of SERVICE_HINTS) if (re.test(text)) out.add(s);
  return [...out];
}

// Group notices that belong to one procurement (same solicitation, or an award that names it).
export function groupNotices(list: SamNotice[]): Map<string, SamNotice[]> {
  const g = new Map<string, SamNotice[]>();
  for (const n of list) {
    const key = (n.type === 'Award Notice' && n.originalSol ? n.originalSol : n.sol || n.id).toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (!g.has(key)) g.set(key, []);
    g.get(key)!.push(n);
  }
  for (const v of g.values()) v.sort((a, b) => String(b.published).localeCompare(String(a.published)));
  return g;
}

// Facts for one procurement from all of its notices.
export function samFacts(notices: SamNotice[], details?: any) {
  const latest = notices[0];
  const award = notices.find(n => n.type === 'Award Notice' && n.awardee);
  const solNotice = notices.find(n => /solicitation/i.test(n.type) && !/pre/i.test(n.type));
  const anyCanceled = notices.some(n => n.canceled) && latest.canceled;
  // newest dated notice wins: amendments that extend a deadline are often posted as Special Notices.
  // Once a solicitation exists, pre-solicitation and sources-sought response dates no longer count.
  const dated = notices.filter(n => n.deadline && !(solNotice && /presolicitation|sources sought/i.test(n.type)));
  const deadline = dated[0]?.deadline || null;
  let stage = 'upcoming';
  if (anyCanceled) stage = 'cancelled';
  else if (award) stage = 'awarded';
  else if (solNotice) stage = deadline && new Date(deadline) > new Date() ? 'bidding' : 'bid_closed';
  else if (notices.some(n => /sources sought|presolicitation|special notice/i.test(n.type))) stage = 'upcoming';
  const text = notices.map(n => `${n.title} ${n.snippet}`).join(' ');
  const pop = details?.data2?.placeOfPerformance || details?.placeOfPerformance || {};
  const zip = pop.zip || null;
  const city = pop.city?.name || null;
  const pocs = ((details?.data2?.pointOfContact || details?.pointOfContact || []) as any[])
    .map(c => ({ name: c.fullName || null, title: c.title || null, email: c.email || null, phone: c.phone || null }))
    .filter(c => c.name || c.email || c.phone);
  const description = stripTags((details?.description || [])[0]?.body || '').slice(0, 4000);
  const cityName = city ? titleCase(city) : null;
  return {
    stage, deadline, award, latest, solNotice, text, city: cityName, zip, region: regionForZip(zip), pocs, description,
    county: countyForCity(cityName),
    setAside: details?.data2?.solicitation?.setAside || details?.typeOfSetAsideDescription || null,
  };
}

// ---------------------------------------------------------------- classification
// Every discovered record is checked against Speedy's service vocabulary (public.service_terms).
//   high      = the text names Speedy work (documented scope)         -> goes to the pool
//   potential = project type that usually needs Speedy (score >= 2)    -> goes to the pool, marked "inferred"
//   review    = weak or unclear signal (score 1)                       -> manager review queue
//   low       = nothing relevant, or not construction                  -> not added
export interface Section { field: string; text: string | null | undefined; doc?: string; url?: string; page?: number | null }
export interface Evidence { term: string; kind: string; confidence: 'documented' | 'inferred'; field: string; doc?: string; url?: string; page?: number | null; snippet: string; services: string[] }
export interface Classification { relevance: 'high' | 'potential' | 'review' | 'low'; score: number; services: string[]; evidence: Evidence[]; category: string | null; reason: string; excluded: boolean }

const compiled = new WeakMap<Term[], { t: Term; re: RegExp }[]>();
function compile(terms: Term[]) {
  let c = compiled.get(terms);
  if (!c) {
    c = [];
    for (const t of terms) { try { c.push({ t, re: new RegExp(`\\b(?:${t.pattern})`, 'i') }); } catch { /* a bad pattern typed in Settings is skipped */ } }
    compiled.set(terms, c);
  }
  return c;
}
function snippetAround(text: string, idx: number, len: number) {
  const a = Math.max(0, idx - 90), b = Math.min(text.length, idx + len + 110);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ').trim() + (b < text.length ? '…' : '');
}
export function classify(sections: Section[], terms: Term[] = DEFAULT_TERMS, opts: { value?: number | null } = {}): Classification {
  const evidence: Evidence[] = [];
  const seen = new Set<string>();
  let score = 0, direct = 0, excluded = false;
  const cats = new Map<string, number>();
  const services = new Set<string>();
  for (const { t, re } of compile(terms)) {
    for (const s of sections) {
      const text = (s.text || '').toString();
      if (!text) continue;
      const m = re.exec(text);
      if (!m) continue;
      if (t.kind === 'exclude') { excluded = true; break; }
      if (t.category) cats.set(t.category, (cats.get(t.category) || 0) + (t.kind === 'category' ? 1 : 2));
      if (t.kind === 'category') break;
      if (t.kind === 'negative') { if (!seen.has(t.label)) { seen.add(t.label); score += t.weight; } break; }
      if (seen.has(t.label)) break;
      seen.add(t.label);
      if (t.kind === 'direct') { direct++; score += t.weight; } else score += t.weight;
      t.services.forEach(x => services.add(x));
      evidence.push({ term: t.label, kind: t.kind, confidence: t.kind === 'direct' ? 'documented' : 'inferred', field: s.field, doc: s.doc, url: s.url,
        page: s.page ?? null, snippet: snippetAround(text, m.index, m[0].length), services: t.services });
      break;
    }
  }
  const category = [...cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  let relevance: Classification['relevance'];
  let reason: string;
  if (direct > 0) {
    relevance = 'high';
    reason = 'Source names Speedy work: ' + evidence.filter(e => e.confidence === 'documented').map(e => e.term).join(', ');
  } else if (excluded) {
    relevance = 'low'; reason = 'Not construction work';
  } else if (score >= 2) {
    relevance = 'potential';
    reason = 'Inferred from the project type: ' + evidence.map(e => e.term).join(', ') + ' (not confirmed in the source)';
  } else if (score >= 1 || ((opts.value ?? 0) >= 20_000_000 && score >= 0 && evidence.length + cats.size > 0)) {
    relevance = 'review';
    reason = evidence.length ? 'Weak signal: ' + evidence.map(e => e.term).join(', ') + '. Check the scope before publishing'
      : 'Large construction project with no scope described. Check the scope before publishing';
  } else {
    relevance = 'low'; reason = evidence.length ? 'Signals outweighed by unrelated scope' : 'No cutting, coring, scanning or removal signals';
  }
  return { relevance, score, services: [...services], evidence: evidence.slice(0, 12), category, reason, excluded };
}

// What a salesperson should do next, from the verified project stage and the route.
export function nextActionFor(stage: string, route: string, opts: { company?: string | null; services?: string[]; deadline?: string | null } = {}) {
  const svc = (opts.services || []).slice(0, 3).join(', ').toLowerCase() || 'cutting, coring, scanning and removal';
  const who = opts.company ? titleCase(opts.company) : 'the contractor';
  const due = opts.deadline ? ` before ${new Date(opts.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}` : '';
  if (stage === 'cancelled') return 'Cancelled by the owner. Confirm, then archive.';
  if (route === 'bid_direct') return `Get the bid package, price the ${svc} scope and submit Speedy's bid${due}.`;
  if (['planning', 'design', 'upcoming'].includes(stage)) return `Early stage: note the procurement timeline and introduce Speedy (${svc}) to the owner's team and likely bidders.`;
  if (stage === 'bidding') return `Find who is bidding (plan holders, pre-bid sign-in) and send them Speedy pricing for ${svc}${due}.`;
  if (stage === 'bid_closed') return 'Bids closed: check the bid tabulation or award notice, then call the winner.';
  if (stage === 'low_bidder') return `Call ${who}'s estimator or PM: apparent low bidder (award not final). Offer ${svc}.`;
  if (['intent_to_award', 'awarded'].includes(stage)) return `Call ${who}'s estimator or PM about ${svc} on this job; subs are being lined up.`;
  if (['permitting', 'preconstruction'].includes(stage)) return `Call ${who} (contractor of record) about ${svc} before work starts.`;
  if (stage === 'under_construction') return `Work is underway: call ${who}'s superintendent or PM about remaining ${svc}.`;
  return `Confirm the scope and the builder, then offer ${svc}.`;
}

// ---------------------------------------------------------------- SAM.gov
export const SAM_TYPE: Record<string, string> = { o: 'Solicitation', k: 'Combined Synopsis/Solicitation', p: 'Presolicitation', r: 'Sources Sought',
  s: 'Special Notice', a: 'Award Notice', i: 'Intent to Bundle Requirements', u: 'Justification', g: 'Sale of Surplus Property' };
// One notice read by its notice id (used when a notice has no solicitation number, so it cannot be searched by number).
export function normalizeDetails(j: any): SamNotice | null {
  if (!j?.data2) return null;
  const d2 = j.data2;
  return {
    id: j.id || j.opportunityId, title: (d2.title || '').trim(), type: SAM_TYPE[d2.type] || d2.type || '', sol: d2.solicitationNumber || null,
    originalSol: null, active: j.archived !== true && j.archived !== 'true', canceled: j.cancelled === true || j.cancelled === 'true',
    published: j.postedDate || null, modified: j.modifiedDate || null, deadline: d2.solicitation?.deadlines?.response || null,
    agency: '', office: '', officeState: null, awardee: d2.award?.awardee?.name || null,
    awardAmount: d2.award?.amount ? Number(d2.award.amount) : null, snippet: stripTags((j.description || [])[0]?.body || '').slice(0, 1500),
    parent: null, awardNumber: d2.award?.number || null,
  };
}
export const isNoticeId = (s?: string | null) => !!s && /^[0-9a-f]{32}$/i.test(s.replace(/[^0-9a-z]/gi, ''));
// Page through a search until a short page or the page cap.
export function morePages(got: number, size: number, page: number, maxPages: number, total?: number | null) {
  if (got < size) return false;
  if (total != null && (page + 1) * size >= total) return false;
  return page + 1 < maxPages;
}

export function samPayload(key: string, notices: SamNotice[], facts: ReturnType<typeof samFacts>, tracked: boolean, terms: Term[] = DEFAULT_TERMS) {
  const n = facts.latest;
  const realSol = [facts.solNotice?.sol, n.type === 'Award Notice' ? n.originalSol : n.sol, key].find(x => x && !isNoticeId(x)) || null;
  const awardNos = notices.map(x => x.awardNumber).filter(Boolean) as string[];
  const p: Record<string, unknown> = {
    external_key: `sam:${n.id}`,
    alt_keys: [...notices.map(x => `sam:${x.id}`), ...awardNos.map(a => `piid:${a.toUpperCase().replace(/[^A-Z0-9]/g, '')}`)],
    source_id: 'sam_gov',
    status_text: `${n.type} posted ${n.published ? new Date(n.published).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }) : ''}` +
      (n.canceled ? ' (cancelled)' : ''),
    source_url: `https://sam.gov/opp/${n.id}/view`,
    source_name: 'SAM.gov',
    stage: facts.stage,
  };
  if (realSol) p.solicitation_no = realSol;
  if (facts.deadline) { p.deadline = facts.deadline; p.deadline_is_date = false; }
  if (facts.pocs.length) p.pocs = facts.pocs;
  if (facts.award) p.winner = { name: titleCase(facts.award.awardee!), amount: facts.award.awardAmount, status: 'awarded',
    as_of: (facts.award.published || '').slice(0, 10) || null, source_url: `https://sam.gov/opp/${facts.award.id}/view` };
  const url = `https://sam.gov/opp/${n.id}/view`;
  const cls = classify([
    { field: 'title', text: notices.map(x => x.title).join(' | '), doc: 'SAM.gov notice title', url },
    { field: 'description', text: facts.description || notices.map(x => x.snippet).filter(Boolean).join(' '), doc: `SAM.gov ${n.type || 'notice'} description`, url },
  ], terms, { value: facts.award?.awardAmount ?? null });
  Object.assign(p, { relevance: cls.relevance, relevance_score: cls.score, evidence: cls.evidence, category: cls.category, review_reason: cls.reason });
  if (facts.zip) p.zip = String(facts.zip).slice(0, 5);
  const earliest = notices[notices.length - 1];
  if (!tracked) {
    Object.assign(p, {
      title: n.title, short_title: n.title.length > 60 ? n.title.slice(0, 57) + '...' : n.title,
      owner_name: n.agency, level: 'Federal', city: facts.city, county: facts.county, region: facts.region,
      location_text: facts.city ? `${facts.city}, FL` : 'Florida (place of performance)',
      published_at: (earliest.published || '').slice(0, 10) || null,
      set_aside: facts.setAside,
      source_summary: (facts.description || notices.map(x => x.snippet).filter(Boolean)[0] || '').slice(0, 600) || null,
      services_likely: cls.services.length ? cls.services : likelyServices(facts.text),
    });
    if (!facts.award) {
      // Speedy bids directly only when the notice itself is for Speedy's kind of work (e.g. "Concrete coring services").
      const titleDirect = cls.evidence.some(e => e.confidence === 'documented' && e.field === 'title');
      const approach = facts.stage === 'bidding' ? (titleDirect ? 'bid_direct' : 'quote_bidders') : facts.stage === 'bid_closed' ? 'track_award' : 'watch';
      p.opportunity = {
        kind: 'gov_bid', approach, title: n.title,
        next_action: nextActionFor(facts.stage, approach, { services: cls.services, deadline: facts.deadline }),
        services: cls.services.length ? cls.services : likelyServices(facts.text),
      };
    }
  }
  return p;
}

// ---------------------------------------------------------------- USAspending.gov (federal contract awards = named prime contractors)
export const USA_NAICS = ['236210', '236220', '237110', '237120', '237310', '237990', '238110', '238190', '238910', '238990'];
export function usaSearchBody(from: string, to: string, naics: string[], page: number, limit = 100) {
  return {
    filters: { time_period: [{ start_date: from, end_date: to, date_type: 'new_awards_only' }], award_type_codes: ['A', 'B', 'C', 'D'],
      place_of_performance_locations: [{ country: 'USA', state: 'FL' }], naics_codes: { require: naics } },
    fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Description', 'Start Date', 'Awarding Agency', 'Awarding Sub Agency',
      'Place of Performance City Code', 'Place of Performance Zip5', 'NAICS', 'generated_internal_id'],
    page, limit, sort: 'Award Amount', order: 'desc', subawards: false,
  };
}
export interface UsaAward { id: string; piid: string; recipient: string; amount: number | null; description: string; start: string | null;
  agency: string; subAgency: string; zip: string | null; naics: string | null }
export function normalizeUsa(r: any): UsaAward {
  return { id: r.generated_internal_id, piid: r['Award ID'], recipient: r['Recipient Name'] || '', amount: r['Award Amount'] ?? null,
    description: (r.Description || '').replace(/\s+/g, ' ').trim(), start: r['Start Date'] || null, agency: r['Awarding Agency'] || '',
    subAgency: r['Awarding Sub Agency'] || '', zip: r['Place of Performance Zip5'] || null, naics: r.NAICS?.code || r.NAICS || null };
}
const sentence = (s: string) => s.toLowerCase().replace(/(^|[.!?]\s+)([a-z])/g, (_m, a, b) => a + b.toUpperCase())
  .replace(/\b(u\.?s\.?|va|ksc|nasa|faa|cbp|usace|ada|hvac|fl|afb|sfb|nas|mcs|vamc|ir|pet|mri|atct|rtr)\b/gi, m => m.toUpperCase());
export function usaPayload(a: UsaAward, detail: any, cls: Classification, minimal = false) {
  const pop = detail?.place_of_performance || {};
  const county = pop.county_name ? countyName(pop.county_name) : null;
  const zip = pop.zip5 || a.zip;
  const city = pop.city_name ? titleCase(pop.city_name) : null;
  const sol = detail?.latest_transaction_contract_data?.solicitation_identifier || null;
  const signed = detail?.date_signed || a.start;
  const desc = (detail?.description || a.description || '').replace(/\s+/g, ' ').trim();
  const title = sentence(desc).replace(/\s+/g, ' ').slice(0, 140) || `Federal construction award ${a.piid}`;
  const url = `https://www.usaspending.gov/award/${a.id}`;
  const p: Record<string, unknown> = {
    external_key: `usaspending:${a.id}`, alt_keys: [`piid:${a.piid.toUpperCase().replace(/[^A-Z0-9]/g, '')}`],
    source_id: 'usaspending_awards', source_url: url, source_name: 'USAspending.gov',
    status_text: `Contract awarded ${signed ? new Date(signed + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''} to ${titleCase(a.recipient)} (award ${a.piid})`,
    stage: 'awarded',
    winner: { name: titleCase(a.recipient), amount: a.amount, status: 'awarded', as_of: signed, source_url: url },
    relevance: cls.relevance, relevance_score: cls.score, evidence: cls.evidence, category: cls.category || CAT_FED, review_reason: cls.reason,
  };
  if (sol) p.solicitation_no = sol;
  if (!minimal) Object.assign(p, {
    title, short_title: title.length > 60 ? title.slice(0, 57) + '...' : title,
    owner_name: [a.agency, a.subAgency].filter((x, i, arr) => x && arr.indexOf(x) === i).join(' / '), level: 'Federal',
    city, county, zip, region: county ? regionForCounty(county) : regionForZip(zip),
    location_text: city ? `${city}, FL` : county ? `${county} County` : 'Florida', project_value: a.amount,
    value_label: a.amount ? `$${Math.round(a.amount).toLocaleString('en-US')} award` : null,
    published_at: signed, source_summary: desc.slice(0, 600),
    size_note: detail?.period_of_performance?.end_date ? `Performance period to ${detail.period_of_performance.end_date}` : null,
    services_likely: cls.services,
  });
  return p;
}
const CAT_FED = 'Institutional & government';

// ---------------------------------------------------------------- building permits (Socrata open data)
export interface Permit { number: string; worktype: string; appType: string; address: string; owner: string; contractor: string; phone: string | null;
  contractorAddress: string | null; value: number | null; status: string; processed: string | null; issued: string | null; project: string; sqft: number | null }
export function normalizeOrlandoPermit(r: any): Permit {
  const clean = (s: any) => String(s ?? '').replace(/\s+/g, ' ').trim();
  return {
    number: clean(r.permit_number), worktype: clean(r.worktype), appType: clean(r.application_type), address: clean(r.permit_address),
    owner: clean(r.property_owner_name || r.parcel_owner_name), contractor: clean(r.contractor_name || r.contractor),
    phone: clean(r.contractor_phone_number) || null, contractorAddress: clean(r.contractor_address) || null,
    value: r.estimated_cost != null && isFinite(Number(r.estimated_cost)) ? Number(r.estimated_cost) : null,
    status: clean(r.application_status), processed: r.processed_date ? String(r.processed_date).slice(0, 10) : null,
    issued: r.issue_permit_date ? String(r.issue_permit_date).slice(0, 10) : null, project: clean(r.project_name),
    sqft: r.square_footage && Number(r.square_footage) > 0 ? Number(r.square_footage) : null,
  };
}
export function permitSections(x: Permit, url: string): Section[] {
  const work = /^alt/i.test(x.worktype) ? 'Commercial alteration' : /^add/i.test(x.worktype) ? 'Commercial building addition'
    : /^demo/i.test(x.worktype) ? 'Commercial demolition' : /^repair/i.test(x.worktype) ? 'Commercial structural repair'
    : /^new/i.test(x.worktype) ? ((x.value ?? 0) >= 5_000_000 ? 'Large new building' : 'New building') : x.worktype;
  return [
    { field: 'permit work type', text: work, doc: `City of Orlando permit ${x.number}`, url },
    { field: 'project name', text: x.project, doc: `City of Orlando permit ${x.number}`, url },
    { field: 'property owner', text: x.owner, doc: `City of Orlando permit ${x.number}`, url },
  ];
}
export function permitPayload(x: Permit, cls: Classification, cfg: { city: string; county: string; source_id: string; key_prefix: string; dataset_url: string }) {
  const url = `${cfg.dataset_url}?permit_number=${encodeURIComponent(x.number)}`;
  const stage = x.issued ? 'preconstruction' : 'permitting';
  const work = /^alt/i.test(x.worktype) ? 'alteration' : /^add/i.test(x.worktype) ? 'addition' : /^demo/i.test(x.worktype) ? 'demolition'
    : /^repair/i.test(x.worktype) ? 'repair' : 'new building';
  const name = x.project ? titleCase(x.project) : `Commercial ${work}, ${titleCase(x.address)}`;
  const money = x.value ? `$${Math.round(x.value).toLocaleString('en-US')}` : null;
  const title = `${name}${x.project ? ` (${work}, ${titleCase(x.address)})` : ''}`.slice(0, 160);
  const company = x.contractor ? titleCase(x.contractor.replace(/\s*\(.*$/, '')) : null;
  return {
    external_key: `${cfg.key_prefix}:${x.number}`, source_id: cfg.source_id, source_url: url, source_name: `City of ${cfg.city} permit data`,
    solicitation_no: null, title, short_title: title.length > 60 ? title.slice(0, 57) + '...' : title,
    owner_name: x.owner ? titleCase(x.owner) : null, level: 'Private', city: cfg.city, county: cfg.county, region: regionForCounty(cfg.county),
    location_text: `${titleCase(x.address)}, ${cfg.city}`, stage,
    status_text: `Commercial ${work} permit ${x.number}: ${x.status || 'filed'}${x.processed ? `, applied ${x.processed}` : ''}${x.issued ? `, issued ${x.issued}` : ''}`,
    project_value: x.value, value_label: money ? `${money} permit valuation` : null, published_at: x.processed,
    size_note: x.sqft ? `${x.sqft.toLocaleString('en-US')} sq ft` : null,
    source_summary: `Permit ${x.number} (${x.appType}, ${x.worktype}) at ${titleCase(x.address)}. Contractor of record: ${company || 'not listed'}.`,
    services_likely: cls.services, relevance: cls.relevance, relevance_score: cls.score, evidence: cls.evidence,
    category: cls.category, review_reason: cls.reason,
    pocs: x.phone || x.contractor ? [{ name: company, title: 'Permit contractor of record', phone: x.phone, email: null }] : [],
    opportunity: company ? {
      kind: 'private_project', approach: 'approach_prime', title: `${company} — ${name}`.slice(0, 200),
      company_name: company, company_phone: x.phone, company_address: x.contractorAddress,
      next_action: nextActionFor(stage, 'approach_prime', { company, services: cls.services }),
      services: cls.services,
    } : {
      kind: 'private_project', approach: 'approach_developer', title: name,
      next_action: 'No contractor on the permit yet: call the owner to find out who is building it.', services: cls.services,
    },
  };
}
