// Default discovery vocabulary, built from Speedy's published services (speedycon.com/service):
// road & bridge deconstruction, core drilling, wire, slab, chain, hand, curb and wall sawing, robotic demolition,
// concrete breaking & removal and GPR scanning, plus selective demolition, grinding and surface preparation.
//
// The live copy is the public.service_terms table (managers edit it in Sources > Settings). This file seeds it
// (scripts/gen_terms_sql.mjs) and is the fallback when the table cannot be read.
//
// kind:  direct    = the text names work Speedy does. Counts as DOCUMENTED scope.
//        indicator = a project type that usually needs Speedy's work. Counts as INFERRED scope.
//        category  = only sets the project category (weight 0).
//        negative  = lowers relevance (roofing, painting, design services...).
//        exclude   = not construction work at all (janitorial, software...), unless a direct term also appears.
export interface Term { label: string; pattern: string; kind: 'direct' | 'indicator' | 'category' | 'negative' | 'exclude'; weight: number; services: string[]; category?: string }

export const SVC = {
  RB: 'Road & bridge deconstruction', CD: 'Core drilling', WI: 'Wire sawing', SS: 'Slab sawing', CH: 'Chain sawing', HS: 'Hand sawing',
  CU: 'Curb sawing', WS: 'Wall sawing', RD: 'Robotic demolition', BR: 'Breaking & removal', GPR: 'GPR scanning',
  SD: 'Selective demolition', DG: 'Diamond grinding', SP: 'Surface preparation',
};
export const CAT = { T: 'Transportation & infrastructure', C: 'Commercial', I: 'Institutional & government', U: 'Utilities & industrial', P: 'Private development' };
const { RB, CD, WI, SS, CH, HS, CU, WS, RD, BR, GPR, SD, DG, SP } = SVC;

const d = (label: string, pattern: string, services: string[]): Term => ({ label, pattern, kind: 'direct', weight: 3, services });
const i = (label: string, pattern: string, weight: number, services: string[], category?: string): Term => ({ label, pattern, kind: 'indicator', weight, services, category });
const c = (label: string, pattern: string, category: string): Term => ({ label, pattern, kind: 'category', weight: 0, services: [], category });
const n = (label: string, pattern: string, weight: number): Term => ({ label, pattern, kind: 'negative', weight, services: [] });
const x = (label: string, pattern: string): Term => ({ label, pattern, kind: 'exclude', weight: 0, services: [] });

export const DEFAULT_TERMS: Term[] = [
  // ---- documented scope
  d('core drilling', String.raw`core[- ]?drill\w*|concrete cor(?:e|es|ing)\b|coring\b|core holes?|diamond drill\w*`, [CD]),
  d('concrete penetrations', String.raw`(?:wall|floor|slab|concrete|utility|pipe|sleeve) penetrations?|new penetrations?`, [CD, GPR]),
  d('saw cutting', String.raw`saw[- ]?cut\w*|concrete cutting|concrete saw\w*`, [SS, WS]),
  d('slab / flat sawing', String.raw`slab saw\w*|flat saw\w*|trench cut\w*|cut (?:and|&) remove`, [SS]),
  d('wall sawing', String.raw`wall saw\w*`, [WS]),
  d('structural openings', String.raw`(?:structural|wall|floor|slab) openings?|new (?:door|window) openings?|enlarge (?:the |existing )?openings?`, [WS, SS, CD]),
  d('wire sawing', String.raw`wire saw\w*`, [WI]),
  d('chain sawing (concrete)', String.raw`(?:concrete|masonry|block) chain ?saw\w*|chain ?saw\w* (?:concrete|masonry|block)`, [CH]),
  d('hand sawing (concrete)', String.raw`hand ?saw\w* (?:concrete|masonry)|concrete hand ?saw\w*`, [HS]),
  d('curb removal / sawing', String.raw`curb (?:and gutter )?(?:removal|remove\w*|saw\w*|cut\w*)|remov\w* (?:of )?(?:the )?(?:existing )?curb\w*`, [CU, BR]),
  d('concrete removal', String.raw`concrete (?:removal|demolition|breakout|break[- ]?out|breaking)|remov\w* (?:of )?(?:the )?(?:existing )?concrete|slab removal|(?:sidewalk|pavement|driveway|slab) (?:removal|demolition)|break(?:ing)? out (?:the )?(?:existing )?concrete`, [BR]),
  d('bridge demolition', String.raw`bridge (?:demolition|removal|deconstruction)|remov\w* (?:of )?(?:the )?(?:existing )?bridges?|demolish\w* (?:the )?(?:existing )?bridges?|deck (?:removal|replacement)|barrier (?:wall )?removal`, [RB, WI, WS, BR]),
  d('selective demolition', String.raw`selective (?:demolition|demo)|interior demolition|controlled demolition|partial demolition`, [SD, BR]),
  d('robotic demolition', String.raw`robotic demolition|remote[- ]controlled demolition|brokk`, [RD]),
  d('GPR / concrete scanning', String.raw`gpr\b|ground[- ]penetrating radar|concrete scann\w*|(?:rebar|reinforc\w*|post[- ]?tension\w*|pt cables?|tendons?|conduits?) (?:locat\w*|scann\w*|detect\w*)|x-?ray(?:ing)? (?:of )?concrete`, [GPR]),
  d('diamond grinding', String.raw`diamond grind\w*|concrete (?:floor )?grind\w*|grind\w* (?:the )?(?:concrete|floor|slab)|trip hazards?`, [DG]),
  d('surface preparation', String.raw`surface prep\w*|shot ?blast\w*|scarif\w*|hydro[- ]?demolition`, [SP]),
  d('slab modifications', String.raw`slab modifications?|structural (?:concrete )?(?:alterations?|modifications?)|trench\w* (?:in|through) (?:the )?(?:existing )?(?:slab|floor)`, [SS, CD, GPR]),
  // ---- inferred scope (project types that usually need Speedy)
  i('bridge replacement', String.raw`bridge replacement|replace (?:the )?(?:existing )?bridges?`, 2, [RB, WI, BR], CAT.T),
  i('bridge rehabilitation', String.raw`bridge (?:rehab\w*|repairs?|widening|improvements?|painting and repair)`, 2, [RB, WS, SS], CAT.T),
  i('expansion joints', String.raw`expansion joints?|joint (?:repair|replacement|rehabilitation)`, 2, [SS], CAT.T),
  i('concrete repair', String.raw`concrete (?:repairs?|restoration|rehab\w*)|spall\w*`, 2, [SS, BR, GPR]),
  i('structural repair', String.raw`structural (?:repairs?|restoration|rehab\w*|strengthening)`, 2, [WS, SS, CD, GPR]),
  i('concrete pavement', String.raw`rigid pavement|concrete pavement|pavement (?:replacement|reconstruction|rehab\w*)|slab replacement|panel replacement`, 2, [SS, BR], CAT.T),
  i('airfield pavement', String.raw`runways?|taxiways?|taxilanes?|aprons?\b|airfield`, 2, [SS, BR], CAT.T),
  i('waterfront structures', String.raw`seawalls?|bulkheads?|wharf|wharves|piers?\b|docks?\b|boat ramps?`, 2, [WS, WI, BR, CD], CAT.T),
  i('parking structure', String.raw`parking (?:garage|structure|deck)s?`, 2, [CD, GPR, SS], CAT.T),
  i('sidewalks / ADA', String.raw`sidewalks?|ada (?:ramps?|improvements?|upgrades?|compliance)|curb ramps?`, 1, [CU, SS, BR], CAT.T),
  i('roadway reconstruction', String.raw`road(?:way)? (?:widening|reconstruction)|widen\w*|interchanges?|intersection improvements?|complete streets?`, 1, [SS, CU, BR], CAT.T),
  i('drainage / culverts', String.raw`culverts?|storm ?(?:drain|sewer|water)\w*|drainage (?:improvements?|repairs?)`, 1, [CD, WS, SS], CAT.T),
  i('lift / pump station', String.raw`lift stations?|pump(?:ing)? stations?`, 2, [CD, WS], CAT.U),
  i('treatment plant', String.raw`water treatment|wastewater|water reclamation|wwtp|wtp\b|treatment plant|clarifiers?|digesters?`, 2, [CD, WS, WI], CAT.U),
  i('utility mains / sewer', String.raw`force mains?|water mains?|sanitary sewer|sewage|sewer (?:rehab\w*|replacement|improvements?|lining)|manholes?`, 1, [CD, SS], CAT.U),
  i('retrofit / plant upgrade', String.raw`retrofit\w*|plant (?:upgrades?|expansion|improvements?)|equipment (?:pads?|foundations?)`, 1, [CD, SS, GPR]),
  i('renovation / alteration', String.raw`renovat\w*|remodel\w*|alterations?|moderni[sz]ation|refurbish\w*|repurpos\w*`, 2, [CD, GPR, SS, SD]),
  i('interior build-out', String.raw`interior (?:build[- ]?out|improvements?)|tenant improvements?|build[- ]?outs?`, 1, [CD, GPR, SD]),
  i('additions / tie-ins', String.raw`tie[- ]?ins?|building additions?|\baddition\b|expansion of (?:the )?existing`, 1, [CD, WS, SS]),
  i('elevator / stair work', String.raw`elevator (?:addition|replacement|moderni\w*|pits?)|new (?:elevators?|stair\w*)`, 1, [WS, CD, SS]),
  i('demolition', String.raw`demolition|demolish\w*|tear[- ]?down|\bdemo\b`, 2, [BR, SD, RD]),
  i('MEP work in existing buildings', String.raw`(?:hvac|plumbing|electrical|mechanical) (?:upgrades?|replacements?|renovations?)`, 1, [CD, GPR]),
  i('post-tensioned structure', String.raw`post[- ]?tension\w*`, 1, [GPR]),
  i('large new building', String.raw`large new building`, 1, [CD, GPR]),
  i('large construction project', String.raw`large construction project`, 1, [CD, GPR, SS]),
  // ---- category only
  c('transportation', String.raw`airports?|aviation|seaports?|\bports?\b|transit|rail\w*|bridges?|highways?|interstate|turnpike|roadways?|fdot|cbp|customs`, CAT.T),
  c('institutional', String.raw`hospitals?|medical center|clinics?|veterans|\bva\b|schools?|college|university|campus|courthouse|jail|prison|detention|correctional|fire stations?|police|library|city hall|government center|federal building|military|air force|navy|army|barracks|dormitor\w*|space force|nasa|coast guard`, CAT.I),
  c('utilities & industrial', String.raw`water|wastewater|sewer|utilit\w*|power plant|substation|manufacturing|industrial`, CAT.U),
  c('commercial', String.raw`office|retail|shopping|mall\b|warehouse|distribution center|logistics|hotel|resort|restaurant|store\b`, CAT.C),
  c('private development', String.raw`mixed[- ]use|multi-?family|apartments?|condo\w*|high[- ]rise|tower|data center|theme park|attraction|entertainment|stadium|arena|redevelopment`, CAT.P),
  // ---- lowers relevance
  n('roofing', String.raw`roof\w* (?:replacement|repairs?|restoration|systems?)|re-?roof\w*`, -2),
  n('HVAC equipment', String.raw`chillers?|air handl\w*|\bahus?\b|cooling towers?|hvac (?:maintenance|service)`, -1),
  n('finishes / site extras', String.raw`painting|paint\b|carpet\w*|furniture|signage|fenc\w*|landscap\w*|irrigation|mowing`, -2),
  n('professional services', String.raw`design services|a-?e services|architect[- ]engineer\w*|engineering services|consult\w*|survey(?:ing)? services|feasibility study|inspection services|construction engineering and inspection|\bcei\b|program management|construction management services`, -3),
  // ---- not construction work
  x('non-construction services', String.raw`janitorial|custodial|pest control|guard services|security services|staffing|software|it services|telecommunications|uniforms?|catering|food service|laundry|vehicles?|fuel|elevator maintenance|medical supplies|pharma\w*|ammunition|aircraft parts|spare parts`),
];
