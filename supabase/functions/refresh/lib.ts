// Pure parsing and mapping helpers for the refresh job (no Deno or network APIs, so they can be unit tested).

export const REGION_BY_COUNTY: Record<string, string> = {};
const R: Record<string, string[]> = {
  'Central FL': ['Orange', 'Osceola', 'Seminole', 'Lake', 'Volusia', 'Brevard', 'Polk', 'Sumter', 'Marion', 'Flagler'],
  'Tampa Bay': ['Hillsborough', 'Pinellas', 'Pasco', 'Hernando', 'Citrus', 'Manatee', 'Sarasota'],
  'North FL': ['Duval', 'St. Johns', 'Clay', 'Nassau', 'Baker', 'Putnam', 'Alachua', 'Columbia', 'Union', 'Bradford', 'Levy', 'Gilchrist',
    'Suwannee', 'Hamilton', 'Lafayette', 'Dixie'],
  'Southwest FL': ['Lee', 'Collier', 'Charlotte', 'Hendry', 'Glades', 'DeSoto', 'Highlands', 'Hardee'],
  'South FL': ['Miami-Dade', 'Broward', 'Palm Beach', 'Monroe', 'Martin', 'St. Lucie', 'Indian River', 'Okeechobee'],
  'Panhandle': ['Escambia', 'Santa Rosa', 'Okaloosa', 'Walton', 'Bay', 'Holmes', 'Washington', 'Jackson', 'Calhoun', 'Gulf', 'Liberty',
    'Franklin', 'Gadsden', 'Leon', 'Wakulla', 'Jefferson', 'Madison', 'Taylor'],
};
for (const [region, counties] of Object.entries(R)) for (const c of counties) REGION_BY_COUNTY[c.toUpperCase()] = region;

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
  if ([327, 328, 329, 338, 344, 347].includes(z)) return 'Central FL';
  if ([335, 336, 337, 342, 346].includes(z)) return 'Tampa Bay';
  if ([320, 321, 322, 326].includes(z)) return 'North FL';
  if ([339, 341].includes(z)) return 'Southwest FL';
  if ([330, 331, 332, 333, 334, 349].includes(z)) return 'South FL';
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
  if (!tracked) {
    Object.assign(p, {
      title: `FDOT contract ${c.contract}, ${county} County`,
      short_title: `FDOT ${c.contract} (${county})`,
      owner_name: fdotDistrictName(district), level: 'FDOT', county, region: regionForCounty(county),
      location_text: `${county} County`, stage: low ? 'low_bidder' : 'bid_closed',
      deadline: `${letting.iso}T10:30:00-05:00`,
      size_note: low ? `Low bid ${money(low.amount)}${c.finProject ? '; FPN ' + c.finProject : ''}` : null,
      source_summary: 'FDOT preliminary letting results list bidders and amounts only. Open the letting notice for the work description.',
      services_likely: [], relevance: 'low',
    });
  }
  return p;
}

// ---------------------------------------------------------------- SAM.gov
export const SAM_SEARCH = 'https://sam.gov/api/prod/sgs/v1/search/';
export interface SamNotice {
  id: string; title: string; type: string; sol: string | null; originalSol: string | null; active: boolean; canceled: boolean;
  published: string | null; modified: string | null; deadline: string | null; agency: string; office: string; officeState: string | null;
  awardee: string | null; awardAmount: number | null; snippet: string; parent: string | null;
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
    awardAmount: r.award?.amount ? Number(r.award.amount) : null, snippet: '', parent: null,
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
  return {
    stage, deadline, award, latest, solNotice, text, city: city ? titleCase(city) : null, zip, region: regionForZip(zip), pocs,
    setAside: details?.data2?.solicitation?.setAside || details?.typeOfSetAsideDescription || null,
  };
}

export function samPayload(key: string, notices: SamNotice[], facts: ReturnType<typeof samFacts>, tracked: boolean) {
  const n = facts.latest;
  const p: Record<string, unknown> = {
    external_key: `sam:${n.id}`,
    alt_keys: notices.map(x => `sam:${x.id}`),
    source_id: 'sam_gov',
    solicitation_no: facts.solNotice?.sol || (n.type === 'Award Notice' ? n.originalSol : n.sol) || key,
    status_text: `${n.type} posted ${n.published ? new Date(n.published).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }) : ''}` +
      (n.canceled ? ' (cancelled)' : ''),
    source_url: `https://sam.gov/opp/${n.id}/view`,
    source_name: 'SAM.gov',
    stage: facts.stage,
  };
  if (facts.deadline) { p.deadline = facts.deadline; p.deadline_is_date = false; }
  if (facts.pocs.length) p.pocs = facts.pocs;
  if (facts.award) p.winner = { name: titleCase(facts.award.awardee!), amount: facts.award.awardAmount, status: 'awarded',
    as_of: (facts.award.published || '').slice(0, 10) || null, source_url: `https://sam.gov/opp/${facts.award.id}/view` };
  const earliest = notices[notices.length - 1];
  if (!tracked) {
    Object.assign(p, {
      title: n.title, short_title: n.title.length > 60 ? n.title.slice(0, 57) + '...' : n.title,
      owner_name: n.agency, level: 'Federal', city: facts.city, region: facts.region,
      location_text: facts.city ? `${facts.city}, FL` : 'Florida (place of performance)',
      published_at: (earliest.published || '').slice(0, 10) || null,
      set_aside: facts.setAside,
      source_summary: notices.map(x => x.snippet).filter(Boolean)[0]?.slice(0, 600) || null,
      services_likely: likelyServices(facts.text), relevance: relevance(facts.text),
    });
    if (!facts.award) {
      p.opportunity = {
        kind: 'gov_bid',
        approach: facts.stage === 'bidding' ? 'quote_bidders' : facts.stage === 'bid_closed' ? 'track_award' : 'watch',
        title: n.title,
        next_action: facts.stage === 'bidding' ? 'Find who is bidding (interested vendors list, pre-bid sign-in) and offer them cutting, coring, GPR and removal pricing.'
          : facts.stage === 'bid_closed' ? 'Bids closed: watch for the award, then call the winner.'
          : 'Watch for the solicitation; note the set-aside and site visit dates.',
        services: likelyServices(facts.text),
      };
    }
  }
  return p;
}
