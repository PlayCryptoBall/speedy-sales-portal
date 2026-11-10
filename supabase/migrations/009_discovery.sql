-- Speedy Sales Portal: statewide discovery expansion.
--   * six sales regions and all 67 counties (with FDOT districts) as reference data
--   * configurable service vocabulary (public.service_terms) that the refresh job classifies every record with
--   * evidence (documented vs inferred), relevance class and project category on projects
--   * cross-source matching (official numbers, award ids, similar titles in the same county) with ambiguous matches sent to review
--   * new sources (USAspending awards, City of Orlando permits) and a source inventory with access limits
--   * discovery monitoring for managers (public.discovery_overview) and alerts for high-value finds
-- Sales work (owners, stages, notes, activities, quotes, follow-ups) is not touched by anything here.

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------- regions and counties
update public.projects set region = 'Northeast FL' where region = 'North FL';
update public.projects set region = 'Southeast FL' where region = 'South FL';
-- ZIP 321xx (Daytona Beach, Palm Coast) is Volusia/Flagler, i.e. Central FL; it was mapped to North FL before.
update public.projects set region = 'Central FL' where region = 'Northeast FL' and county in ('Volusia','Flagler');

create table public.fl_counties (
  name text primary key,
  region text not null,
  fdot_district int not null check (fdot_district between 1 and 7)
);
alter table public.fl_counties enable row level security;
revoke all on public.fl_counties from anon, authenticated;

-- ---------------------------------------------------------------- projects: evidence, relevance, category, matching
alter table public.projects
  add column if not exists zip text,
  add column if not exists category text,
  add column if not exists relevance text check (relevance in ('high','potential','review','low')),
  add column if not exists relevance_score int,
  add column if not exists evidence jsonb not null default '[]',
  add column if not exists possible_duplicate_of uuid references public.projects(id) on delete set null,
  add column if not exists match_note text;
alter table public.projects drop constraint if exists projects_stage_check;
alter table public.projects add constraint projects_stage_check check (stage in ('planning','design','permitting','upcoming','bidding','bid_closed',
  'low_bidder','intent_to_award','awarded','preconstruction','under_construction','completed','cancelled','unknown'));
create index if not exists projects_title_trgm on public.projects using gin (lower(title) extensions.gin_trgm_ops);
create index if not exists projects_county_idx on public.projects (county);

create or replace function private.project_stage_rank(s text) returns int
language sql immutable set search_path = '' as $$
  select case s when 'unknown' then 0 when 'planning' then 1 when 'design' then 2 when 'permitting' then 3 when 'upcoming' then 4
    when 'bidding' then 5 when 'bid_closed' then 6 when 'low_bidder' then 7 when 'intent_to_award' then 8 when 'awarded' then 9
    when 'preconstruction' then 10 when 'under_construction' then 11 when 'completed' then 12 when 'cancelled' then 13 else 0 end
$$;
create or replace function private.relevance_rank(s text) returns int
language sql immutable set search_path = '' as $$
  select case s when 'low' then 1 when 'review' then 2 when 'potential' then 3 when 'high' then 4 else 0 end
$$;

-- ---------------------------------------------------------------- refresh runs: how much each run looked at
alter table public.refresh_runs
  add column if not exists examined int not null default 0,
  add column if not exists relevant int not null default 0,
  add column if not exists low int not null default 0;

-- ---------------------------------------------------------------- source inventory
alter table public.sources
  add column if not exists category text,
  add column if not exists method text,
  add column if not exists geography text,
  add column if not exists project_types text,
  add column if not exists counties text[];

update public.sources set category = 'Federal procurement', method = 'Public search API (JSON)', geography = 'Statewide (place of performance in Florida)',
  project_types = 'Solicitations, pre-solicitations, sources sought, awards', schedule_note = 'Daily, early morning. Retries hourly up to 3 times after a failure.'
 where id = 'sam_gov';
update public.sources set category = 'State transportation', method = 'Public letting results pages (HTML)', geography = 'Statewide: Central Office, Districts 1-7, Turnpike',
  project_types = 'Road and bridge contracts after bid opening: every bidder, apparent low bidder',
  coverage = 'Central Office, Districts 1-7 and Turnpike preliminary letting results. Home regions: low bid of $1M+; rest of Florida: $3M+ (both adjustable).'
 where id = 'fdot_lettings';
update public.sources set category = 'State transportation', method = 'PDF bid solicitation notices (manual)', geography = 'Statewide',
  project_types = 'Upcoming state road and bridge lettings with work descriptions',
  access_notes = 'Central Office and district Bid Solicitation Notices are published as PDFs on ftp.fdot.gov (one per proposal, with addenda and bid tabs). Public, no login. Not parsed automatically yet: PDF text extraction is the next step for this source.'
 where id = 'fdot_bid_notices';
update public.sources set category = 'Local procurement', method = 'Agency bid boards (manual)', geography = 'County, city, school district, airport, port and utility boards',
  project_types = 'Local solicitations, bid tabulations, awards',
  access_notes = 'Florida agencies use DemandStar, Bonfire, OpenGov Procurement, PlanetBids, IonWave, BidNet Direct and their own sites. Most need a free vendor account to see documents and plan holders, and their terms limit automated collection. Add finds from the portal (Add lead) until an agency feed or an authorized integration is set up.'
 where id = 'local_portals';
update public.sources set category = 'Private construction', method = 'News and owner announcements (manual)', geography = 'Statewide',
  project_types = 'Private projects before bidding: hospitals, towers, data centers, hotels, warehouses',
  access_notes = 'Business journals and GrowthSpotter are paywalled; leads are added from the portal with the article link.'
 where id = 'private_news';
update public.sources set category = 'Internal', method = 'One-time import', geography = 'Statewide' where id = 'legacy_import';
update public.sources set category = 'Internal', method = 'Added by a manager', geography = 'Statewide' where id = 'portal_manual';

insert into public.sources (id, name, url, kind, category, method, geography, project_types, counties, coverage, schedule_note, access_notes, config) values
 ('usaspending_awards', 'USAspending.gov federal construction awards', 'https://www.usaspending.gov/search', 'automated',
  'Federal awards', 'Public API (JSON)', 'Statewide (place of performance in Florida)',
  'New federal construction contract awards: named prime contractor, amount, location, solicitation number', null,
  'New contracts and task orders under construction NAICS codes (236, 237, 238 trades) performed in Florida, $250K and up. Links to the SAM.gov solicitation when the numbers match.',
  'Daily, early morning.', 'Official U.S. Treasury open data. No key needed. Awards appear here a few days after signing.',
  '{"lookback_days": 60, "min_amount": 250000, "max_new_per_run": 30}'),
 ('orlando_permits', 'City of Orlando commercial building permits', 'https://data.cityoforlando.net/Permitting/Permit-Applications/ryhf-m453', 'automated',
  'Private construction', 'City open data API (Socrata)', 'City of Orlando (Orange County)',
  'Commercial alterations, additions, repairs, demolition and large new buildings, with the contractor of record and phone', array['Orange'],
  'Commercial building permits valued at $500K and up filed in the last 45 days. The contractor of record is the company to call.',
  'Daily, Monday to Saturday.', 'City of Orlando open data portal, public, updated daily. Permit valuation is the applicant''s estimate, not Speedy''s scope.',
  '{"lookback_days": 45, "min_value": 500000, "max_new_per_run": 40}'),
 ('mfmp_vip', 'MyFloridaMarketPlace Vendor Information Portal (state agencies)', 'https://vendor.myfloridamarketplace.com/search/bids', 'manual',
  'State procurement', 'Web app (manual)', 'Statewide: state agencies and universities', 'State agency solicitations (replaced the Vendor Bid System in 2022)', null,
  'State agency and university bids.', 'Weekly manual review.',
  'The old Vendor Bid System is now an archive (ads before March 2022). The new portal is a single-page app without a documented public feed; check it by hand or ask DMS about a feed.', '{}'),
 ('paid_platforms', 'Paid construction lead services', null, 'paid',
  'Private construction', 'Subscription (not connected)', 'Statewide', 'Plan rooms, project starts, bidder lists',
  null, 'ConstructConnect, Dodge Construction Network, BuildingConnected, The Blue Book.', 'Not connected.',
  'These need a paid subscription or an invitation and their terms do not allow scraping. If Speedy subscribes, export their project lists and bring them in with Add lead or a CSV import; nothing here bypasses a login.', '{}'),
 ('other_permits', 'Other city and county permit data', null, 'manual',
  'Private construction', 'Open data portals (to be added)', 'Selected cities', 'Commercial building permits', null,
  'Miami-Dade, Tampa, Jacksonville, Fort Lauderdale, St. Petersburg and other permit portals.', 'Not automated yet.',
  'Gainesville publishes permits on Socrata without valuations; Miami-Dade, Tampa and Jacksonville use ArcGIS or Accela portals that each need their own adapter. The Orlando adapter is built so another Socrata city can be added from Settings.', '{}')
on conflict (id) do nothing;

-- ---------------------------------------------------------------- service vocabulary
create table public.service_terms (
  id bigint generated always as identity primary key,
  label text not null unique,
  pattern text not null check (length(pattern) between 2 and 600),
  kind text not null check (kind in ('direct','indicator','category','negative','exclude')),
  weight int not null default 0 check (weight between -5 and 5),
  services text[] not null default '{}',
  category text,
  enabled boolean not null default true,
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);
alter table public.service_terms enable row level security;
revoke all on public.service_terms from anon, authenticated;

-- seed (generated by scripts/gen_discovery_seed.mjs)
insert into public.fl_counties (name, region, fdot_district) values
 ('Orange', 'Central FL', 5),
 ('Osceola', 'Central FL', 5),
 ('Seminole', 'Central FL', 5),
 ('Lake', 'Central FL', 5),
 ('Volusia', 'Central FL', 5),
 ('Brevard', 'Central FL', 5),
 ('Polk', 'Central FL', 1),
 ('Sumter', 'Central FL', 5),
 ('Marion', 'Central FL', 5),
 ('Flagler', 'Central FL', 5),
 ('Hillsborough', 'Tampa Bay', 7),
 ('Pinellas', 'Tampa Bay', 7),
 ('Pasco', 'Tampa Bay', 7),
 ('Hernando', 'Tampa Bay', 7),
 ('Citrus', 'Tampa Bay', 7),
 ('Manatee', 'Tampa Bay', 1),
 ('Sarasota', 'Tampa Bay', 1),
 ('Duval', 'Northeast FL', 2),
 ('St. Johns', 'Northeast FL', 2),
 ('Clay', 'Northeast FL', 2),
 ('Nassau', 'Northeast FL', 2),
 ('Baker', 'Northeast FL', 2),
 ('Putnam', 'Northeast FL', 2),
 ('Alachua', 'Northeast FL', 2),
 ('Columbia', 'Northeast FL', 2),
 ('Union', 'Northeast FL', 2),
 ('Bradford', 'Northeast FL', 2),
 ('Levy', 'Northeast FL', 2),
 ('Gilchrist', 'Northeast FL', 2),
 ('Suwannee', 'Northeast FL', 2),
 ('Hamilton', 'Northeast FL', 2),
 ('Lafayette', 'Northeast FL', 2),
 ('Dixie', 'Northeast FL', 2),
 ('Lee', 'Southwest FL', 1),
 ('Collier', 'Southwest FL', 1),
 ('Charlotte', 'Southwest FL', 1),
 ('Hendry', 'Southwest FL', 1),
 ('Glades', 'Southwest FL', 1),
 ('DeSoto', 'Southwest FL', 1),
 ('Highlands', 'Southwest FL', 1),
 ('Hardee', 'Southwest FL', 1),
 ('Miami-Dade', 'Southeast FL', 6),
 ('Broward', 'Southeast FL', 4),
 ('Palm Beach', 'Southeast FL', 4),
 ('Monroe', 'Southeast FL', 6),
 ('Martin', 'Southeast FL', 4),
 ('St. Lucie', 'Southeast FL', 4),
 ('Indian River', 'Southeast FL', 4),
 ('Okeechobee', 'Southeast FL', 1),
 ('Escambia', 'Panhandle', 3),
 ('Santa Rosa', 'Panhandle', 3),
 ('Okaloosa', 'Panhandle', 3),
 ('Walton', 'Panhandle', 3),
 ('Bay', 'Panhandle', 3),
 ('Holmes', 'Panhandle', 3),
 ('Washington', 'Panhandle', 3),
 ('Jackson', 'Panhandle', 3),
 ('Calhoun', 'Panhandle', 3),
 ('Gulf', 'Panhandle', 3),
 ('Liberty', 'Panhandle', 3),
 ('Franklin', 'Panhandle', 3),
 ('Gadsden', 'Panhandle', 3),
 ('Leon', 'Panhandle', 3),
 ('Wakulla', 'Panhandle', 3),
 ('Jefferson', 'Panhandle', 3),
 ('Madison', 'Panhandle', 2),
 ('Taylor', 'Panhandle', 2)
on conflict (name) do update set region = excluded.region, fdot_district = excluded.fdot_district;

insert into public.service_terms (label, pattern, kind, weight, services, category) values
 ('core drilling', 'core[- ]?drill\w*|concrete cor(?:e|es|ing)\b|coring\b|core holes?|diamond drill\w*', 'direct', 3, array['Core drilling'], null),
 ('concrete penetrations', '(?:wall|floor|slab|concrete|utility|pipe|sleeve) penetrations?|new penetrations?', 'direct', 3, array['Core drilling','GPR scanning'], null),
 ('saw cutting', 'saw[- ]?cut\w*|concrete cutting|concrete saw\w*', 'direct', 3, array['Slab sawing','Wall sawing'], null),
 ('slab / flat sawing', 'slab saw\w*|flat saw\w*|trench cut\w*|cut (?:and|&) remove', 'direct', 3, array['Slab sawing'], null),
 ('wall sawing', 'wall saw\w*', 'direct', 3, array['Wall sawing'], null),
 ('structural openings', '(?:structural|wall|floor|slab) openings?|new (?:door|window) openings?|enlarge (?:the |existing )?openings?', 'direct', 3, array['Wall sawing','Slab sawing','Core drilling'], null),
 ('wire sawing', 'wire saw\w*', 'direct', 3, array['Wire sawing'], null),
 ('chain sawing (concrete)', '(?:concrete|masonry|block) chain ?saw\w*|chain ?saw\w* (?:concrete|masonry|block)', 'direct', 3, array['Chain sawing'], null),
 ('hand sawing (concrete)', 'hand ?saw\w* (?:concrete|masonry)|concrete hand ?saw\w*', 'direct', 3, array['Hand sawing'], null),
 ('curb removal / sawing', 'curb (?:and gutter )?(?:removal|remove\w*|saw\w*|cut\w*)|remov\w* (?:of )?(?:the )?(?:existing )?curb\w*', 'direct', 3, array['Curb sawing','Breaking & removal'], null),
 ('concrete removal', 'concrete (?:removal|demolition|breakout|break[- ]?out|breaking)|remov\w* (?:of )?(?:the )?(?:existing )?concrete|slab removal|(?:sidewalk|pavement|driveway|slab) (?:removal|demolition)|break(?:ing)? out (?:the )?(?:existing )?concrete', 'direct', 3, array['Breaking & removal'], null),
 ('bridge demolition', 'bridge (?:demolition|removal|deconstruction)|remov\w* (?:of )?(?:the )?(?:existing )?bridges?|demolish\w* (?:the )?(?:existing )?bridges?|deck (?:removal|replacement)|barrier (?:wall )?removal', 'direct', 3, array['Road & bridge deconstruction','Wire sawing','Wall sawing','Breaking & removal'], null),
 ('selective demolition', 'selective (?:demolition|demo)|interior demolition|controlled demolition|partial demolition', 'direct', 3, array['Selective demolition','Breaking & removal'], null),
 ('robotic demolition', 'robotic demolition|remote[- ]controlled demolition|brokk', 'direct', 3, array['Robotic demolition'], null),
 ('GPR / concrete scanning', 'gpr\b|ground[- ]penetrating radar|concrete scann\w*|(?:rebar|reinforc\w*|post[- ]?tension\w*|pt cables?|tendons?|conduits?) (?:locat\w*|scann\w*|detect\w*)|x-?ray(?:ing)? (?:of )?concrete', 'direct', 3, array['GPR scanning'], null),
 ('diamond grinding', 'diamond grind\w*|concrete (?:floor )?grind\w*|grind\w* (?:the )?(?:concrete|floor|slab)|trip hazards?', 'direct', 3, array['Diamond grinding'], null),
 ('surface preparation', 'surface prep\w*|shot ?blast\w*|scarif\w*|hydro[- ]?demolition', 'direct', 3, array['Surface preparation'], null),
 ('slab modifications', 'slab modifications?|structural (?:concrete )?(?:alterations?|modifications?)|trench\w* (?:in|through) (?:the )?(?:existing )?(?:slab|floor)', 'direct', 3, array['Slab sawing','Core drilling','GPR scanning'], null),
 ('bridge replacement', 'bridge replacement|replace (?:the )?(?:existing )?bridges?', 'indicator', 2, array['Road & bridge deconstruction','Wire sawing','Breaking & removal'], 'Transportation & infrastructure'),
 ('bridge rehabilitation', 'bridge (?:rehab\w*|repairs?|widening|improvements?|painting and repair)', 'indicator', 2, array['Road & bridge deconstruction','Wall sawing','Slab sawing'], 'Transportation & infrastructure'),
 ('expansion joints', 'expansion joints?|joint (?:repair|replacement|rehabilitation)', 'indicator', 2, array['Slab sawing'], 'Transportation & infrastructure'),
 ('concrete repair', 'concrete (?:repairs?|restoration|rehab\w*)|spall\w*', 'indicator', 2, array['Slab sawing','Breaking & removal','GPR scanning'], null),
 ('structural repair', 'structural (?:repairs?|restoration|rehab\w*|strengthening)', 'indicator', 2, array['Wall sawing','Slab sawing','Core drilling','GPR scanning'], null),
 ('concrete pavement', 'rigid pavement|concrete pavement|pavement (?:replacement|reconstruction|rehab\w*)|slab replacement|panel replacement', 'indicator', 2, array['Slab sawing','Breaking & removal'], 'Transportation & infrastructure'),
 ('airfield pavement', 'runways?|taxiways?|taxilanes?|aprons?\b|airfield', 'indicator', 2, array['Slab sawing','Breaking & removal'], 'Transportation & infrastructure'),
 ('waterfront structures', 'seawalls?|bulkheads?|wharf|wharves|piers?\b|docks?\b|boat ramps?', 'indicator', 2, array['Wall sawing','Wire sawing','Breaking & removal','Core drilling'], 'Transportation & infrastructure'),
 ('parking structure', 'parking (?:garage|structure|deck)s?', 'indicator', 2, array['Core drilling','GPR scanning','Slab sawing'], 'Transportation & infrastructure'),
 ('sidewalks / ADA', 'sidewalks?|ada (?:ramps?|improvements?|upgrades?|compliance)|curb ramps?', 'indicator', 1, array['Curb sawing','Slab sawing','Breaking & removal'], 'Transportation & infrastructure'),
 ('roadway reconstruction', 'road(?:way)? (?:widening|reconstruction)|widen\w*|interchanges?|intersection improvements?|complete streets?', 'indicator', 1, array['Slab sawing','Curb sawing','Breaking & removal'], 'Transportation & infrastructure'),
 ('drainage / culverts', 'culverts?|storm ?(?:drain|sewer|water)\w*|drainage (?:improvements?|repairs?)', 'indicator', 1, array['Core drilling','Wall sawing','Slab sawing'], 'Transportation & infrastructure'),
 ('lift / pump station', 'lift stations?|pump(?:ing)? stations?', 'indicator', 2, array['Core drilling','Wall sawing'], 'Utilities & industrial'),
 ('treatment plant', 'water treatment|wastewater|water reclamation|wwtp|wtp\b|treatment plant|clarifiers?|digesters?', 'indicator', 2, array['Core drilling','Wall sawing','Wire sawing'], 'Utilities & industrial'),
 ('utility mains / sewer', 'force mains?|water mains?|sanitary sewer|sewage|sewer (?:rehab\w*|replacement|improvements?|lining)|manholes?', 'indicator', 1, array['Core drilling','Slab sawing'], 'Utilities & industrial'),
 ('retrofit / plant upgrade', 'retrofit\w*|plant (?:upgrades?|expansion|improvements?)|equipment (?:pads?|foundations?)', 'indicator', 1, array['Core drilling','Slab sawing','GPR scanning'], null),
 ('renovation / alteration', 'renovat\w*|remodel\w*|alterations?|moderni[sz]ation|refurbish\w*|repurpos\w*', 'indicator', 2, array['Core drilling','GPR scanning','Slab sawing','Selective demolition'], null),
 ('interior build-out', 'interior (?:build[- ]?out|improvements?)|tenant improvements?|build[- ]?outs?', 'indicator', 1, array['Core drilling','GPR scanning','Selective demolition'], null),
 ('additions / tie-ins', 'tie[- ]?ins?|building additions?|\baddition\b|expansion of (?:the )?existing', 'indicator', 1, array['Core drilling','Wall sawing','Slab sawing'], null),
 ('elevator / stair work', 'elevator (?:addition|replacement|moderni\w*|pits?)|new (?:elevators?|stair\w*)', 'indicator', 1, array['Wall sawing','Core drilling','Slab sawing'], null),
 ('demolition', 'demolition|demolish\w*|tear[- ]?down|\bdemo\b', 'indicator', 2, array['Breaking & removal','Selective demolition','Robotic demolition'], null),
 ('MEP work in existing buildings', '(?:hvac|plumbing|electrical|mechanical) (?:upgrades?|replacements?|renovations?)', 'indicator', 1, array['Core drilling','GPR scanning'], null),
 ('post-tensioned structure', 'post[- ]?tension\w*', 'indicator', 1, array['GPR scanning'], null),
 ('large new building', 'large new building', 'indicator', 1, array['Core drilling','GPR scanning'], null),
 ('large construction project', 'large construction project', 'indicator', 1, array['Core drilling','GPR scanning','Slab sawing'], null),
 ('transportation', 'airports?|aviation|seaports?|\bports?\b|transit|rail\w*|bridges?|highways?|interstate|turnpike|roadways?|fdot|cbp|customs', 'category', 0, '{}'::text[], 'Transportation & infrastructure'),
 ('institutional', 'hospitals?|medical center|clinics?|veterans|\bva\b|schools?|college|university|campus|courthouse|jail|prison|detention|correctional|fire stations?|police|library|city hall|government center|federal building|military|air force|navy|army|barracks|dormitor\w*|space force|nasa|coast guard', 'category', 0, '{}'::text[], 'Institutional & government'),
 ('utilities & industrial', 'water|wastewater|sewer|utilit\w*|power plant|substation|manufacturing|industrial', 'category', 0, '{}'::text[], 'Utilities & industrial'),
 ('commercial', 'office|retail|shopping|mall\b|warehouse|distribution center|logistics|hotel|resort|restaurant|store\b', 'category', 0, '{}'::text[], 'Commercial'),
 ('private development', 'mixed[- ]use|multi-?family|apartments?|condo\w*|high[- ]rise|tower|data center|theme park|attraction|entertainment|stadium|arena|redevelopment', 'category', 0, '{}'::text[], 'Private development'),
 ('roofing', 'roof\w* (?:replacement|repairs?|restoration|systems?)|re-?roof\w*', 'negative', -2, '{}'::text[], null),
 ('HVAC equipment', 'chillers?|air handl\w*|\bahus?\b|cooling towers?|hvac (?:maintenance|service)', 'negative', -1, '{}'::text[], null),
 ('finishes / site extras', 'painting|paint\b|carpet\w*|furniture|signage|fenc\w*|landscap\w*|irrigation|mowing', 'negative', -2, '{}'::text[], null),
 ('professional services', 'design services|a-?e services|architect[- ]engineer\w*|engineering services|consult\w*|survey(?:ing)? services|feasibility study|inspection services|construction engineering and inspection|\bcei\b|program management|construction management services', 'negative', -3, '{}'::text[], null),
 ('non-construction services', 'janitorial|custodial|pest control|guard services|security services|staffing|software|it services|telecommunications|uniforms?|catering|food service|laundry|vehicles?|fuel|elevator maintenance|medical supplies|pharma\w*|ammunition|aircraft parts|spare parts', 'exclude', 0, '{}'::text[], null)
on conflict (label) do nothing;

-- ---------------------------------------------------------------- vocabulary access
create or replace function public.discovery_terms() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('label', label, 'pattern', pattern, 'kind', kind, 'weight', weight,
           'services', services, 'category', category) order by id), '[]')
  from public.service_terms where enabled
$$;

create or replace function public.service_terms_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := private.require_manager();
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'label', t.label, 'pattern', t.pattern, 'kind', t.kind, 'weight', t.weight,
            'services', t.services, 'category', t.category, 'enabled', t.enabled, 'note', t.note, 'updated_at', t.updated_at,
            'updated_by_name', (select full_name from public.profiles where id = t.updated_by)) order by
            array_position(array['direct','indicator','negative','exclude','category'], t.kind), t.label) from public.service_terms t), '[]');
end $$;

create or replace function public.save_service_term(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; v_id bigint := nullif(p->>'id', '')::bigint; v_kind text := coalesce(nullif(p->>'kind', ''), 'indicator');
        v_label text := nullif(trim(p->>'label'), ''); v_pattern text := nullif(trim(p->>'pattern'), ''); v_weight int;
begin
  me := private.require_manager();
  if v_id is not null and (p ? 'enabled') and not (p ? 'pattern') then
    update public.service_terms set enabled = (p->>'enabled')::boolean, updated_at = now(), updated_by = me.id where id = v_id;
    if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
    return jsonb_build_object('ok', true);
  end if;
  if v_label is null or v_pattern is null then raise exception 'missing_fields' using errcode = '22023', hint = 'A name and the words to look for are required.'; end if;
  if v_kind not in ('direct','indicator','category','negative','exclude') then raise exception 'bad_kind' using errcode = '22023'; end if;
  begin perform 'test' ~* v_pattern;
  exception when others then raise exception 'bad_pattern' using errcode = '22023', hint = 'The words to look for are not a valid pattern. Separate alternatives with | and avoid unmatched brackets.'; end;
  v_weight := coalesce(nullif(p->>'weight', '')::int, case v_kind when 'direct' then 3 when 'indicator' then 1 when 'negative' then -2 else 0 end);
  if v_id is null then
    insert into public.service_terms (label, pattern, kind, weight, services, category, note, updated_by)
    values (v_label, v_pattern, v_kind, v_weight, coalesce((select array_agg(x) from jsonb_array_elements_text(p->'services') x), '{}'),
            nullif(p->>'category', ''), nullif(trim(p->>'note'), ''), me.id)
    returning id into v_id;
  else
    update public.service_terms set label = v_label, pattern = v_pattern, kind = v_kind, weight = v_weight,
      services = coalesce((select array_agg(x) from jsonb_array_elements_text(p->'services') x), services),
      category = nullif(p->>'category', ''), note = nullif(trim(p->>'note'), ''), enabled = coalesce((p->>'enabled')::boolean, enabled),
      updated_at = now(), updated_by = me.id where id = v_id;
    if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when unique_violation then
  raise exception 'duplicate_label' using errcode = '22023', hint = 'A search term with this name already exists.';
end $$;

-- ---------------------------------------------------------------- refresh: save one project's facts
-- Matching order: own key -> a key another source gave it (award id, FDOT project number) -> solicitation number
-- -> a similar title in the same county or city from another source (merged only when clearly the same project;
-- otherwise saved separately and sent to review as a possible duplicate).
-- When a different source matches an existing project it only fills blank facts; the original source's text stays.
create or replace function public.refresh_upsert_project(p_run bigint, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.projects; v_new public.projects; cand record;
  v_key text := p->>'external_key';
  v_src text := coalesce(p->>'source_id', 'portal_manual');
  v_sol text := private.norm_sol(p->>'solicitation_no');
  v_alt text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(p->'alt_keys') x), '{}');
  v_rel text := nullif(p->>'relevance', '');
  v_pool boolean;
  v_reason text := nullif(p->>'review_reason', '');
  dup_of uuid; dup_note text;
  action text := 'unchanged';
  nchanges int := 0; material_changes text[] := '{}';
  flagged int := 0; created_opps int := 0; merged boolean := false;
  f text; oldv text; newv text; is_material boolean; cross_source boolean := false;
  facts text[] := array['title','short_title','owner_name','level','location_text','city','county','zip','region','category','status_text','project_value','value_label',
                        'size_note','solicitation_no','set_aside','deadline','deadline_is_date','deadline_note','published_at','source_url','source_name','source_summary'];
  new_stage text := nullif(p->>'stage', '');
  w jsonb := p->'winner';
  w_company uuid; o record; new_opp public.opportunities; tracker record; v_title text; v_comp uuid;
  notice text; review_now boolean;
begin
  if v_key is null then raise exception 'external_key required'; end if;
  if v_rel = 'low' then v_rel := 'review'; end if;            -- older payloads used "low" to mean "check before publishing"
  v_pool := coalesce(v_rel, 'high') in ('high','potential');

  -- 1. the same record under one of its keys or official numbers
  select * into v from public.projects where external_key = v_key or v_key = any(alt_keys) limit 1;
  if v.id is null and cardinality(v_alt) > 0 then
    select * into v from public.projects where external_key = any(v_alt) or alt_keys && v_alt order by created_at limit 1;
    if v.id is not null then merged := true; dup_note := 'Matched to an existing project by a shared award or project number'; end if;
  end if;
  if v.id is null and v_sol is not null then
    select * into v from public.projects where sol_key = v_sol order by (source_id = v_src) desc, created_at limit 1;
    if v.id is not null then merged := true; dup_note := 'Matched to an existing project by solicitation number ' || (p->>'solicitation_no'); end if;
  end if;
  -- 2. the same project on another source: similar title in the same county or city
  if v.id is null and nullif(p->>'title', '') is not null and (nullif(p->>'county', '') is not null or nullif(p->>'city', '') is not null) then
    select pj.id, pj.title, extensions.similarity(lower(pj.title), lower(p->>'title')) as sim,
           (pj.owner_name is not null and private.norm_key(pj.owner_name) = private.norm_key(p->>'owner_name')) as same_owner,
           (pj.winner_name is not null and private.norm_key(pj.winner_name) = private.norm_key(p#>>'{winner,name}')) as same_winner
      into cand
      from public.projects pj
     where pj.source_id <> v_src and pj.created_at > now() - interval '24 months'
       and ((nullif(p->>'county', '') is not null and pj.county = p->>'county') or (nullif(p->>'city', '') is not null and lower(pj.city) = lower(p->>'city')))
       and lower(pj.title) operator(extensions.%) lower(p->>'title')
     order by extensions.similarity(lower(pj.title), lower(p->>'title')) desc limit 1;
    if cand.id is not null then
      if cand.sim >= 0.9 or (cand.sim >= 0.7 and (cand.same_owner or cand.same_winner)) then
        select * into v from public.projects where id = cand.id;
        merged := true;
        dup_note := format('Matched to an existing project from another source (titles %s%% alike%s)', round(cand.sim * 100),
          case when cand.same_owner then ', same owner' when cand.same_winner then ', same contractor' else '' end);
      elsif cand.sim >= 0.45 then
        dup_of := cand.id;
        dup_note := format('Possible duplicate of "%s" (titles %s%% alike, same %s). Archive one if they are the same job.',
          left(cand.title, 90), round(cand.sim * 100), case when nullif(p->>'county', '') is not null then 'county' else 'city' end);
      end if;
    end if;
  end if;

  if v.id is null then
    -- brand new project
    insert into public.projects (external_key, alt_keys, source_id, title, short_title, owner_name, level, location_text, city, county, zip, region, category, stage,
      status_text, project_value, value_label, size_note, solicitation_no, sol_key, set_aside, deadline, deadline_is_date, deadline_note,
      published_at, discovered_at, last_verified_at, last_checked_at, verify_status, source_url, source_name, source_summary, scope_evidence,
      services_likely, pocs, bidders, relevance, relevance_score, evidence, possible_duplicate_of, match_note)
    values (v_key, array(select distinct x from unnest(v_alt) x where x <> v_key), v_src, p->>'title', p->>'short_title',
      p->>'owner_name', p->>'level', p->>'location_text', p->>'city', p->>'county', nullif(p->>'zip', ''), coalesce(p->>'region', 'Unknown'), nullif(p->>'category', ''),
      coalesce(new_stage, 'unknown'),
      p->>'status_text', nullif(p->>'project_value', '')::numeric, p->>'value_label', p->>'size_note', p->>'solicitation_no', v_sol, p->>'set_aside',
      nullif(p->>'deadline', '')::timestamptz, coalesce((p->>'deadline_is_date')::boolean, false), p->>'deadline_note',
      nullif(p->>'published_at', '')::date, now(), now(), now(), 'ok', p->>'source_url', p->>'source_name', p->>'source_summary',
      private.scope_evidence(concat_ws(' ', p->>'title', p->>'source_summary')),
      coalesce((select array_agg(x) from jsonb_array_elements_text(p->'services_likely') x), '{}'),
      coalesce(p->'pocs', '[]'), coalesce(p->'bidders', '[]'), v_rel, nullif(p->>'relevance_score', '')::int, coalesce(p->'evidence', '[]'),
      dup_of, dup_note)
    returning * into v;
    action := 'discovered';
    if p ? 'opportunity' then
      if nullif(p#>>'{opportunity,company_name}', '') is not null then
        v_comp := private.upsert_company(p#>>'{opportunity,company_name}', 'contractor');
        if nullif(p#>>'{opportunity,company_phone}', '') is not null
           and not exists (select 1 from public.contacts c where c.company_id = v_comp and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') = regexp_replace(p#>>'{opportunity,company_phone}', '\D', '', 'g')) then
          insert into public.contacts (company_id, title, phone, notes, source, source_url)
          values (v_comp, 'Main office', p#>>'{opportunity,company_phone}', nullif('Address on the permit: ' || (p#>>'{opportunity,company_address}'), 'Address on the permit: '),
                  'source_document', p->>'source_url');
        end if;
      end if;
      review_now := not v_pool or dup_of is not null;
      insert into public.opportunities (project_id, company_id, kind, approach, title, next_action, services, speedy_scope, needs_review, review_kind, review_reason)
      values (v.id, v_comp, coalesce(p#>>'{opportunity,kind}', 'gov_bid'), coalesce(p#>>'{opportunity,approach}', 'quote_bidders'),
              coalesce(p#>>'{opportunity,title}', v.title), p#>>'{opportunity,next_action}',
              coalesce((select array_agg(x) from jsonb_array_elements_text(p#>'{opportunity,services}') x), v.services_likely),
              p#>>'{opportunity,speedy_scope}',
              review_now, case when dup_of is not null then 'duplicate' when review_now then 'discovery' end,
              case when dup_of is not null then dup_note
                   when review_now then coalesce(v_reason, 'New from ' || coalesce((select name from public.sources where id = v_src), v_src) || ': check that it involves concrete work before publishing to the pool') end)
      returning * into new_opp;
      insert into public.activities (opportunity_id, company_id, kind, body, data)
      values (new_opp.id, v_comp, 'refresh', 'Found by the ' || coalesce((select name from public.sources where id = v_src), v_src) || ' refresh' || coalesce('. ' || v_reason, ''),
              jsonb_build_object('run_id', p_run, 'relevance', v_rel));
      created_opps := 1;
      if new_opp.needs_review then flagged := 1; end if;
      if not new_opp.needs_review and v_rel = 'high' then
        perform private.notify_managers(new_opp.id, 'discovery', 'Confirmed Speedy scope: ' || coalesce(v.short_title, v.title),
          coalesce(v_reason, 'The source names cutting, coring, scanning or removal work.') || coalesce(' (' || v.region || ')', ''), 'disc:' || v.id);
      end if;
    end if;
  else
    -- existing project: compare facts, keep sales work untouched
    cross_source := v.source_id <> v_src and not (v_key = v.external_key or v_key = any(v.alt_keys));
    if v_key <> v.external_key and not (v_key = any(v.alt_keys)) then
      update public.projects set alt_keys = array_append(alt_keys, v_key), match_note = coalesce(match_note, dup_note) where id = v.id;
      merged := true;
    end if;
    if cardinality(v_alt) > 0 then
      update public.projects set alt_keys = (select coalesce(array_agg(distinct k), '{}') from unnest(alt_keys || v_alt) k where k <> external_key)
      where id = v.id;
    end if;
    foreach f in array facts loop
      if p ? f and nullif(p->>f, '') is not null then
        execute format('select ($1).%I::text', f) into oldv using v;
        newv := p->>f;
        if f = 'deadline' then
          if oldv is not null and nullif(newv, '')::timestamptz = oldv::timestamptz then continue; end if;
        elsif f = 'project_value' then
          if oldv is not null and newv::numeric = oldv::numeric then continue; end if;
        elsif f = 'deadline_is_date' then
          if oldv is not null and newv::boolean = oldv::boolean then continue; end if;
        elsif f = 'published_at' then
          if oldv is not null and newv::date = oldv::date then continue; end if;
        elsif oldv is not distinct from newv then continue;
        end if;
        -- another source matched this project: only fill in what is missing
        if cross_source and oldv is not null then continue; end if;
        -- keep curated legacy text unless the source gives a real change to a material field
        if v.source_id = 'legacy_import' and f in ('title','short_title','location_text','source_summary','size_note','value_label','owner_name','source_url','source_name','city','county','region') and oldv is not null then
          continue;
        end if;
        is_material := f in ('deadline','solicitation_no');
        execute format('update public.projects set %I = ($2 ->> %L)::%s where id = $1', f, f,
          (select format_type(a.atttypid, a.atttypmod) from pg_attribute a where a.attrelid = 'public.projects'::regclass and a.attname = f))
          using v.id, p;
        insert into public.refresh_changes (run_id, project_id, field, old_value, new_value, material)
        values (p_run, v.id, f, case when f = 'deadline' and oldv is not null then private.fmt_ts(oldv::timestamptz) else oldv end,
                case when f = 'deadline' then private.fmt_ts(newv::timestamptz) else newv end, is_material);
        nchanges := nchanges + 1;
        if is_material then
          material_changes := material_changes || case when f = 'deadline'
            then format('Deadline changed from %s to %s', coalesce(private.fmt_ts(oldv::timestamptz), 'not set'), private.fmt_ts(newv::timestamptz))
            else format('%s changed from %s to %s', initcap(replace(f, '_', ' ')), coalesce(oldv, 'blank'), newv) end;
        end if;
      end if;
    end loop;
    if p ? 'solicitation_no' then update public.projects set sol_key = coalesce(private.norm_sol(solicitation_no), sol_key) where id = v.id; end if;

    -- stage: only forward, except a cancellation or a re-opened bid with a new future deadline
    if new_stage is not null and new_stage <> v.stage then
      if private.project_stage_rank(new_stage) > private.project_stage_rank(v.stage) and not (new_stage = 'cancelled' and cross_source) or (new_stage = 'cancelled' and not cross_source)
         or (new_stage = 'bidding' and v.stage in ('bid_closed','cancelled','upcoming') and nullif(p->>'deadline', '')::timestamptz > now() and not cross_source) then
        update public.projects set stage = new_stage where id = v.id;
        insert into public.refresh_changes (run_id, project_id, field, old_value, new_value, material)
        values (p_run, v.id, 'stage', v.stage, new_stage, new_stage in ('cancelled','bidding','awarded','intent_to_award','low_bidder'));
        nchanges := nchanges + 1;
        if new_stage = 'cancelled' then material_changes := material_changes || 'The agency cancelled this project'::text;
        elsif new_stage = 'bidding' and v.stage in ('bid_closed','cancelled') then material_changes := material_changes || 'Bidding reopened'::text;
        elsif new_stage = 'bidding' and v.stage = 'upcoming' then material_changes := material_changes || 'Solicitation is now open for bids'::text;
        end if;
      end if;
    end if;

    if p ? 'pocs' and jsonb_array_length(coalesce(p->'pocs', '[]')) > 0 and p->'pocs' is distinct from v.pocs and not (cross_source and jsonb_array_length(v.pocs) > 0) then
      update public.projects set pocs = p->'pocs' where id = v.id;
      insert into public.refresh_changes (run_id, project_id, field, old_value, new_value, material)
      values (p_run, v.id, 'contacts', v.pocs::text, (p->'pocs')::text, jsonb_array_length(v.pocs) > 0);
      nchanges := nchanges + 1;
      if jsonb_array_length(v.pocs) > 0 then material_changes := material_changes || 'Agency contact changed in the notice'::text; end if;
    end if;
    if p ? 'bidders' and jsonb_array_length(coalesce(p->'bidders', '[]')) > 0 and p->'bidders' is distinct from v.bidders then
      update public.projects set bidders = p->'bidders' where id = v.id;
      insert into public.refresh_changes (run_id, project_id, field, old_value, new_value, material)
      values (p_run, v.id, 'bidders', jsonb_array_length(v.bidders)::text || ' bidders', jsonb_array_length(p->'bidders')::text || ' bidders', false);
      nchanges := nchanges + 1;
    end if;
    if p ? 'services_likely' and cardinality(v.services_likely) = 0 then
      update public.projects set services_likely = coalesce((select array_agg(x) from jsonb_array_elements_text(p->'services_likely') x), '{}') where id = v.id;
    end if;
    -- evidence: keep what was found before, add new terms; relevance only goes up from a refresh
    if jsonb_array_length(coalesce(p->'evidence', '[]')) > 0 then
      update public.projects set evidence = (
        select coalesce(jsonb_agg(e), '[]') from (
          select e from jsonb_array_elements(coalesce(v.evidence, '[]')) e
          union all
          select n from jsonb_array_elements(p->'evidence') n
           where not exists (select 1 from jsonb_array_elements(coalesce(v.evidence, '[]')) e2 where e2->>'term' = n->>'term')
          limit 15) x)
      where id = v.id;
    end if;
    if v_rel is not null and private.relevance_rank(v_rel) > private.relevance_rank(v.relevance) then
      update public.projects set relevance = v_rel, relevance_score = nullif(p->>'relevance_score', '')::int where id = v.id;
      if v.relevance is not null then
        insert into public.refresh_changes (run_id, project_id, field, old_value, new_value, material)
        values (p_run, v.id, 'relevance', v.relevance, v_rel, false);
        nchanges := nchanges + 1;
      end if;
    end if;
    action := case when nchanges > 0 then 'updated' else 'unchanged' end;
  end if;

  -- winner: low bidder < intended award < executed award. Never downgrade.
  if w is not null and nullif(w->>'name', '') is not null then
    select * into v_new from public.projects where id = v.id;
    if v_new.winner_name is null
       or private.winner_rank(w->>'status') > private.winner_rank(v_new.winner_status)
       or (private.winner_rank(w->>'status') = private.winner_rank(v_new.winner_status) and private.norm_key(w->>'name') <> private.norm_key(v_new.winner_name)) then
      w_company := private.upsert_company(w->>'name', 'contractor');
      update public.projects set winner_name = w->>'name', winner_amount = nullif(w->>'amount', '')::numeric, winner_status = w->>'status',
        winner_as_of = coalesce(nullif(w->>'as_of', '')::date, current_date), winner_source_url = coalesce(w->>'source_url', p->>'source_url'),
        winner_company_id = w_company,
        stage = case when private.project_stage_rank(stage) < private.project_stage_rank(case w->>'status' when 'low_bidder' then 'low_bidder' when 'intended' then 'intent_to_award' else 'awarded' end)
                     then case w->>'status' when 'low_bidder' then 'low_bidder' when 'intended' then 'intent_to_award' else 'awarded' end else stage end
      where id = v.id;
      insert into public.refresh_changes (run_id, project_id, field, old_value, new_value, material)
      values (p_run, v.id, 'winner', case when v_new.winner_name is null then null else v_new.winner_name || ' (' || v_new.winner_status || ')' end,
              (w->>'name') || ' (' || (w->>'status') || ')', true);
      nchanges := nchanges + 1;
      material_changes := material_changes || (case w->>'status' when 'low_bidder' then 'Apparent low bidder: ' when 'intended' then 'Intended award: ' else 'Awarded: ' end
                                               || (w->>'name') || coalesce(' at $' || to_char((w->>'amount')::numeric, 'FM999,999,999,990'), '')
                                               || case when w->>'status' = 'low_bidder' then ' (not a final award)' else '' end);
      if action = 'unchanged' then action := 'updated'; end if;

      -- one outreach opportunity per winner per project; reuse an existing one
      if not exists (select 1 from private.project_opps(v.id) x where x.company_id = w_company) then
        select * into tracker from private.project_opps(v.id) x
         where x.kind = 'gov_bid' order by (x.owner_id is not null) desc, x.created_at limit 1;
        v_title := coalesce(v_new.short_title, v_new.title);
        review_now := action = 'discovered' and tracker.owner_id is null and (not v_pool or dup_of is not null);
        insert into public.opportunities (project_id, company_id, kind, approach, title, next_action, services, speedy_scope,
                                          stage, owner_id, claimed_at, needs_review, review_kind, review_reason)
        values (v.id, w_company, 'contractor_outreach', 'approach_prime',
                initcap(lower(split_part(w->>'name', '(', 1))) || ' — ' || v_title,
                case w->>'status' when 'low_bidder' then 'Call their estimator or PM now: they are the apparent low bidder (award not final yet) and will line up subs soon. Confirm award status on the call.'
                                 else 'Call their estimator or PM and offer cutting, coring, GPR and removal for this job.' end,
                v_new.services_likely, (select speedy_scope from public.opportunities where id = tracker.id),
                case when tracker.owner_id is not null then 'claimed' else 'available' end, tracker.owner_id,
                case when tracker.owner_id is not null then now() end,
                review_now, case when review_now and dup_of is not null then 'duplicate' when review_now then 'discovery' end,
                case when review_now and dup_of is not null then dup_note
                     when review_now then coalesce(v_reason || '. ', '') || 'New award found by the refresh: confirm the awardee builds (not a design or service firm) and the job has concrete work, then publish' end)
        returning * into new_opp;
        created_opps := created_opps + 1;
        if new_opp.needs_review then flagged := flagged + 1; end if;
        insert into public.activities (opportunity_id, company_id, kind, body, data)
        values (new_opp.id, w_company, 'refresh', 'Created by refresh: ' || material_changes[cardinality(material_changes)] ||
                coalesce('. Follows ' || tracker.ref, ''), jsonb_build_object('run_id', p_run, 'from_opportunity', tracker.id, 'relevance', v_rel));
        if tracker.owner_id is not null then
          insert into public.ownership_history (opportunity_id, action, to_user, reason)
          values (new_opp.id, 'assign', tracker.owner_id, 'Follow-through from ' || tracker.ref || ', which you own');
          perform private.notify(tracker.owner_id, new_opp.id, 'award', 'Winner posted: ' || v_title,
            material_changes[cardinality(material_changes)] || '. New outreach opportunity ' || new_opp.ref || ' is in your pipeline.');
        elsif tracker.id is not null and tracker.stage = 'available' then
          update public.opportunities set stage = 'archived', superseded_by = new_opp.id, closed_at = now(),
            outcome_reason = 'Bid closed. Follow-up continues as ' || new_opp.ref || ' (call the winner).' where id = tracker.id;
          insert into public.activities (opportunity_id, kind, from_stage, to_stage, body, data)
          values (tracker.id, 'refresh', 'available', 'archived', 'Winner posted; replaced by ' || new_opp.ref || ' so the pool has one lead per action',
                  jsonb_build_object('run_id', p_run, 'superseded_by', new_opp.id));
        end if;
        if not new_opp.needs_review and new_opp.owner_id is null and coalesce(v_rel, v_new.relevance) in ('high','potential') and w->>'status' in ('awarded','intended') then
          perform private.notify_managers(new_opp.id, 'award', 'New award: ' || initcap(lower(split_part(w->>'name', '(', 1))) || ' — ' || v_title,
            material_changes[cardinality(material_changes)] || coalesce(' (' || v_new.region || ')', ''), 'award:' || v.id || ':' || w_company);
        end if;
      else
        merged := true;
      end if;
    end if;
  end if;

  -- notify owners and flag records when something material changed
  if cardinality(material_changes) > 0 then
    notice := array_to_string(material_changes, '; ');
    for o in select * from private.project_opps(v.id) loop
      insert into public.activities (opportunity_id, company_id, kind, body, data)
      values (o.id, o.company_id, 'refresh', 'Source update: ' || notice, jsonb_build_object('run_id', p_run));
      if o.owner_id is not null and o.stage not in ('won','lost','disqualified','archived') then
        perform private.notify(o.owner_id, o.id, 'source_change', 'Update on ' || o.ref, notice,
          'chg:' || o.id || ':' || md5(notice));
      end if;
      if exists (select 1 from public.projects where id = v.id and stage = 'cancelled') and o.stage not in ('won','lost','disqualified','archived') then
        update public.opportunities set needs_review = true, review_kind = 'cancelled',
          review_reason = 'Source says the project was cancelled. Confirm, then archive or keep.' where id = o.id and not needs_review;
        if found then flagged := flagged + 1; end if;
      end if;
    end loop;
  end if;

  update public.projects set last_verified_at = now(), last_checked_at = now(), verify_status = 'ok', updated_at = now() where id = v.id;
  perform private.rescore(x.id) from private.project_opps(v.id) x;
  return jsonb_build_object('action', action, 'project_id', v.id, 'changes', nchanges, 'material', material_changes,
    'merged', merged, 'flagged', flagged, 'opportunities_created', created_opps, 'duplicate_of', dup_of, 'match_note', dup_note);
end $$;

create or replace function public.refresh_finish_run(p_run bigint, p_status text, p_counts jsonb, p_log jsonb, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.refresh_runs;
begin
  update public.refresh_runs set status = p_status, finished_at = now(),
    fetched = coalesce((p_counts->>'fetched')::int, 0), discovered = coalesce((p_counts->>'discovered')::int, 0),
    updated = coalesce((p_counts->>'updated')::int, 0), merged = coalesce((p_counts->>'merged')::int, 0),
    flagged = coalesce((p_counts->>'flagged')::int, 0), unchanged = coalesce((p_counts->>'unchanged')::int, 0),
    errors = coalesce((p_counts->>'errors')::int, 0), examined = coalesce((p_counts->>'examined')::int, 0),
    relevant = coalesce((p_counts->>'relevant')::int, 0), low = coalesce((p_counts->>'low')::int, 0),
    log = coalesce(p_log, '[]'), error = p_error
  where id = p_run returning * into r;
  update public.sources set last_status = p_status, last_error = case when p_status = 'success' then null else p_error end,
    last_success_at = case when p_status in ('success','partial') then now() else last_success_at end,
    consecutive_failures = case when p_status = 'failed' then consecutive_failures + 1 else 0 end
  where id = r.source_id;
  if p_status = 'failed' then
    perform private.notify_managers(null, 'refresh_failed', 'Refresh failed: ' || (select name from public.sources where id = r.source_id),
      coalesce(p_error, 'See Sources and refreshes for the log.') || ' Existing records were kept and are not marked as freshly verified.',
      'fail:' || r.source_id || ':' || current_date);
  end if;
  perform private.snapshot_pool();
end $$;

-- ---------------------------------------------------------------- discovery monitoring (managers)
create or replace function public.discovery_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := private.require_manager();
  return jsonb_build_object(
    'summary', (select jsonb_build_object(
        'sources_configured', (select count(*) from public.sources where kind <> 'legacy' and id <> 'portal_manual'),
        'sources_automated', (select count(*) from public.sources where kind = 'automated' and enabled),
        'sources_ok', (select count(*) from public.sources where kind = 'automated' and enabled and last_status = 'success' and last_success_at > now() - interval '2 days'),
        'sources_errors', (select count(*) from public.sources where kind = 'automated' and enabled and last_status in ('failed','partial')),
        'sources_stale', (select count(*) from public.sources where kind = 'automated' and enabled and (last_success_at is null or last_success_at < now() - interval '3 days')),
        'examined_7d', coalesce(sum(r.examined), 0), 'relevant_7d', coalesce(sum(r.relevant), 0),
        'discovered_7d', coalesce(sum(r.discovered), 0), 'updated_7d', coalesce(sum(r.updated), 0), 'merged_7d', coalesce(sum(r.merged), 0),
        'runs_7d', count(*), 'failed_runs_7d', count(*) filter (where r.status = 'failed'),
        'duplicates_open', (select count(*) from public.opportunities where needs_review and review_kind = 'duplicate'),
        'awaiting_review', (select count(*) from public.opportunities where needs_review),
        'high_7d', (select count(*) from public.projects where discovered_at > now() - interval '7 days' and relevance = 'high'),
        'potential_7d', (select count(*) from public.projects where discovered_at > now() - interval '7 days' and relevance = 'potential'),
        'awards_7d', (select count(distinct c.project_id) from public.refresh_changes c join public.projects p on p.id = c.project_id
                       where c.field = 'winner' and c.created_at > now() - interval '7 days' and coalesce(p.relevance, 'potential') in ('high','potential')))
      from public.refresh_runs r where r.started_at > now() - interval '7 days'),
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'category', s.category, 'method', s.method,
          'geography', s.geography, 'project_types', s.project_types, 'coverage', s.coverage, 'access_notes', s.access_notes, 'schedule_note', s.schedule_note,
          'url', s.url, 'enabled', s.enabled, 'last_run_at', s.last_run_at, 'last_success_at', s.last_success_at, 'last_status', s.last_status, 'last_error', s.last_error,
          'last_run', (select jsonb_build_object('id', r.id, 'status', r.status, 'started_at', r.started_at, 'examined', r.examined, 'relevant', r.relevant,
                         'low', r.low, 'discovered', r.discovered, 'updated', r.updated, 'merged', r.merged, 'flagged', r.flagged, 'errors', r.errors)
                       from public.refresh_runs r where r.source_id = s.id order by r.started_at desc limit 1),
          'found_30d', (select count(*) from public.projects p where p.source_id = s.id and p.discovered_at > now() - interval '30 days'),
          'relevant_30d', (select count(*) from public.projects p where p.source_id = s.id and p.discovered_at > now() - interval '30 days' and p.relevance in ('high','potential')),
          'open_leads', (select count(*) from public.opportunities o join public.projects p on p.id = o.project_id
                          where p.source_id = s.id and o.stage not in ('won','lost','disqualified','archived')))
        order by case s.kind when 'automated' then 0 when 'legacy' then 3 else 1 end, s.name), '[]') from public.sources s where s.id <> 'portal_manual'),
    'regions', (select coalesce(jsonb_agg(x order by x.region), '[]') from (
        select r.region, (select count(*) from public.fl_counties c where c.region = r.region) as counties,
          (select count(*) from public.opportunities o join public.projects p on p.id = o.project_id where p.region = r.region and o.stage = 'available' and not o.needs_review) as available,
          (select count(*) from public.projects p where p.region = r.region and p.discovered_at > now() - interval '30 days') as found_30d
        from (select distinct region from public.fl_counties) r) x),
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'n', n) order by n desc), '[]') from (
        select coalesce(p.category, 'Not classified') as category, count(*) n from public.projects p
         where exists (select 1 from public.opportunities o where o.project_id = p.id and o.stage not in ('won','lost','disqualified','archived'))
         group by 1) c),
    'relevance', (select jsonb_object_agg(coalesce(relevance, 'not classified'), n) from (
        select relevance, count(*) n from public.projects where discovered_at > now() - interval '30 days' group by 1) r),
    'counties', (select coalesce(jsonb_agg(jsonb_build_object('county', c.name, 'region', c.region, 'fdot_district', c.fdot_district,
          'found_90d', (select count(*) from public.projects p where p.county = c.name and p.discovered_at > now() - interval '90 days'),
          'open_leads', (select count(*) from public.opportunities o join public.projects p on p.id = o.project_id
                          where p.county = c.name and o.stage not in ('won','lost','disqualified','archived')),
          'sources_90d', (select coalesce(jsonb_agg(distinct s.name), '[]') from public.projects p join public.sources s on s.id = p.source_id
                           where p.county = c.name and p.discovered_at > now() - interval '90 days'),
          'local_sources', (select coalesce(jsonb_agg(s.name), '[]') from public.sources s where s.kind = 'automated' and s.enabled and c.name = any(s.counties)))
        order by c.region, c.name), '[]') from public.fl_counties c)
  );
end $$;

-- ---------------------------------------------------------------- updated: scoring, daily upkeep, board and lead detail
-- Services Speedy sells (speedycon.com/service). "Core" ones get full fit points.
create or replace function private.core_services() returns text[]
language sql immutable set search_path = '' as $$
  select array['GPR scanning','Core drilling','Wall sawing','Slab sawing','Wire sawing','Chain sawing','Hand sawing','Curb sawing','Flat sawing',
               'Breaking & removal','Road & bridge deconstruction','Robotic demolition','Selective demolition']
$$;

create or replace function private.score(p_opp uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o public.opportunities;
  p public.projects;
  svc text[];
  ncore int := 0; ngrind int := 0;
  fit int := 0; urg int := 0;
  pts int; txt text;
  f jsonb := '[]'; u jsonb := '[]';
  days numeric;
  cq int := 0; ctxt text := 'No phone or email on file yet';
  c record;
  prio text;
  stage text;
begin
  select * into o from public.opportunities where id = p_opp;
  if o.id is null then return null; end if;
  select * into p from public.projects where id = o.project_id;

  svc := case when cardinality(o.services_confirmed) > 0 then o.services_confirmed
              when cardinality(o.services) > 0 then o.services
              else coalesce(p.services_likely, '{}') end;
  select count(*) filter (where s = any(private.core_services())), count(*) filter (where s ilike '%grind%')
    into ncore, ngrind from unnest(svc) s;

  -- 1. service fit (20): does the likely work match what Speedy sells
  pts := case when ncore >= 3 then 20 when ncore = 2 then 16 when ncore = 1 then 11 when ngrind > 0 then 7 else 0 end;
  txt := case when ncore > 0 then 'Likely Speedy work: ' || array_to_string(svc[1:4], ', ')
              when ngrind > 0 then 'Grinding only'
              else 'No cutting, coring, GPR or removal identified' end;
  fit := fit + pts; f := f || jsonb_build_object('factor','Service fit','points',pts,'max',20,'text',txt);

  -- 2. evidence of scope (25): confirmed by a contact > described in the source > inferred by us
  if cardinality(o.services_confirmed) > 0 then
    pts := 25; txt := 'Confirmed by the contact: ' || array_to_string(o.services_confirmed, ', ');
  elsif exists (select 1 from jsonb_array_elements(coalesce(p.evidence, '[]')) e where e->>'confidence' = 'documented') then
    pts := 21; txt := 'Source documents ' || (select string_agg(distinct e->>'term', ', ') from jsonb_array_elements(p.evidence) e where e->>'confidence' = 'documented')
                       || ' (not a confirmed request for pricing)';
  elsif coalesce(p.scope_evidence, '{}') && array['demolition','concrete removal','concrete cutting','core drilling','GPR / scanning'] then
    pts := 20; txt := 'Source describes ' || array_to_string(p.scope_evidence[1:4], ', ') || ' (not a confirmed request for pricing)';
  elsif cardinality(coalesce(p.scope_evidence, '{}')) > 0 then
    pts := 12; txt := 'Source describes related work: ' || array_to_string(p.scope_evidence[1:4], ', ') || ' (our services inferred)';
  elsif jsonb_array_length(coalesce(p.evidence, '[]')) > 0 then
    pts := 12; txt := 'Inferred from the project type: ' || (select string_agg(distinct e->>'term', ', ') from jsonb_array_elements(p.evidence) e) || ' (not stated as a requirement)';
  else
    pts := 5; txt := 'Scope inferred from the project type; not stated in the source';
  end if;
  fit := fit + pts; f := f || jsonb_build_object('factor','Scope evidence','points',pts,'max',25,'text',txt);

  -- 3. project stage (20)
  stage := coalesce(p.stage, case when o.kind = 'relationship' then 'completed' else 'unknown' end);
  if stage = 'bidding' and p.deadline is not null and p.deadline < now() then stage := 'bid_closed'; end if;
  pts := case stage
    when 'low_bidder' then 18 when 'intent_to_award' then 19 when 'awarded' then 20 when 'preconstruction' then 20
    when 'under_construction' then 16 when 'permitting' then 17 when 'design' then 6 when 'bidding' then 15 when 'bid_closed' then 11 when 'upcoming' then 9
    when 'planning' then 5 when 'completed' then 4 when 'cancelled' then 0 else 6 end;
  txt := case stage
    when 'low_bidder' then 'Apparent low bidder known (award not final)'
    when 'intent_to_award' then 'Intended awardee known'
    when 'awarded' then 'Contractor awarded'
    when 'preconstruction' then 'Builder picked, work about to start'
    when 'permitting' then 'Permit filed with the contractor named'
    when 'design' then 'In design; builder may not be picked'
    when 'under_construction' then 'Under construction'
    when 'bidding' then 'Open for bids'
    when 'bid_closed' then 'Bids closed, award not posted yet'
    when 'upcoming' then 'Procurement announced, not open yet'
    when 'planning' then 'Early planning, builder may not be picked'
    when 'completed' then 'Past project (relationship follow-up)'
    when 'cancelled' then 'Cancelled'
    else 'Project stage unknown' end;
  if o.kind = 'relationship' then pts := 10; txt := 'Existing relationship, no new project confirmed'; end if;
  fit := fit + pts; f := f || jsonb_build_object('factor','Project stage','points',pts,'max',20,'text',txt);

  -- 4. location (20): Orlando office first, the rest of Florida still counts
  pts := case coalesce(p.region, 'Unknown') when 'Central FL' then 20 when 'Tampa Bay' then 16 when 'Northeast FL' then 14
    when 'Southwest FL' then 13 when 'Southeast FL' then 13 when 'Panhandle' then 9 else 10 end;
  txt := coalesce(p.region, 'Region unknown') || coalesce(' (' || coalesce(p.city, p.county) || ')', '');
  fit := fit + pts; f := f || jsonb_build_object('factor','Location','points',pts,'max',20,'text',txt);

  -- 5. contact quality (15)
  for c in select * from public.contacts where company_id = o.company_id and not archived loop
    if c.verified and (c.phone is not null or c.email is not null) then
      if cq < 15 then cq := 15; ctxt := 'Verified contact: ' || coalesce(c.name, c.phone, c.email); end if;
    elsif c.name is not null and (c.phone is not null or c.email is not null) then
      if cq < 11 then cq := 11; ctxt := 'Named contact from research (not yet verified)'; end if;
    elsif c.phone is not null or c.email is not null then
      if cq < 7 then cq := 7; ctxt := 'Main phone or email only'; end if;
    elsif c.web is not null then
      if cq < 2 then cq := 2; ctxt := 'Website only'; end if;
    end if;
  end loop;
  if cq < 10 and p.pocs is not null and jsonb_array_length(p.pocs) > 0 then
    if exists (select 1 from jsonb_array_elements(p.pocs) e where coalesce(e->>'email', e->>'phone') is not null and e->>'name' is not null) then
      cq := 10; ctxt := 'Named agency contact in the notice';
    elsif cq < 4 then cq := 4; ctxt := 'Agency office or web page only';
    end if;
  end if;
  fit := fit + cq; f := f || jsonb_build_object('factor','Contact quality','points',cq,'max',15,'text',ctxt);

  -- urgency (timing only)
  if stage = 'cancelled' then
    urg := 0; u := u || jsonb_build_object('text','Project cancelled');
  elsif stage in ('bidding','upcoming') and p.deadline is not null and p.deadline >= now() then
    days := extract(epoch from (p.deadline - now())) / 86400.0;
    urg := case when days <= 3 then 95 when days <= 7 then 85 when days <= 14 then 70 when days <= 30 then 50 else 30 end;
    u := u || jsonb_build_object('text', format('%s due in %s day%s', case when stage = 'upcoming' then 'Response' else 'Bids' end,
            greatest(ceil(days), 0)::int, case when ceil(days) = 1 then '' else 's' end));
  elsif stage = 'bid_closed' then
    urg := 45; u := u || jsonb_build_object('text','Bids closed; find out who won, then call them');
  elsif stage in ('low_bidder','intent_to_award','awarded') then
    if p.winner_as_of is not null then
      days := current_date - p.winner_as_of;
      urg := case when days <= 21 then 90 when days <= 60 then 70 when days <= 180 then 50 else 35 end;
      u := u || jsonb_build_object('text', case when days <= 21 then format('Builder picked %s days ago: subs are being lined up now', days::int)
                                                when days <= 60 then format('Builder picked %s days ago', days::int)
                                                when days <= 180 then format('Picked about %s months ago; work likely underway', round(days / 30.0)::int)
                                                else 'Picked over 6 months ago; check what work remains' end);
    else
      urg := 55; u := u || jsonb_build_object('text','Builder known; award date not recorded');
    end if;
  elsif stage = 'permitting' then
    urg := 65; u := u || jsonb_build_object('text','Permit filed: the contractor is buying out trades now');
  elsif stage = 'preconstruction' then
    urg := 70; u := u || jsonb_build_object('text','Starting soon: trade packages being bought out');
  elsif stage = 'under_construction' then
    urg := 60; u := u || jsonb_build_object('text','Under construction: cutting, coring and tie-in work comes up throughout');
  elsif stage = 'upcoming' then
    urg := 25; u := u || jsonb_build_object('text','Procurement expected; no date yet');
  elsif stage in ('planning','design') then
    urg := 20; u := u || jsonb_build_object('text','Early stage');
  else
    urg := 20; u := u || jsonb_build_object('text','No timing information');
  end if;

  prio := case when fit >= 68 and urg >= 60 then 'Hot'
               when fit >= 55 or (fit >= 45 and urg >= 70) then 'Warm'
               else 'Later' end;
  return jsonb_build_object('fit', fit, 'urgency', urg, 'priority', prio,
    'reasons', jsonb_build_object('fit', f, 'urgency', u,
      'summary', case prio when 'Hot' then 'Hot: strong fit (' || fit || '/100) and it needs a call soon (' || urg || '/100)'
                           when 'Warm' then 'Warm: fit ' || fit || '/100, urgency ' || urg || '/100'
                           else 'Later: fit ' || fit || '/100, urgency ' || urg || '/100' end));
end $$;

create or replace function public.daily_maintenance() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; o record; stale int := private.setting_int('stale_days', 14); closed int := 0; n_stale int := 0; n_due int := 0; n_soon int := 0; n_review int := 0; n_hot int := 0;
begin
  if auth.uid() is not null then perform private.require_manager(); end if;
  -- 1. bids whose deadline passed: mark closed and point unowned trackers at the award
  for r in select * from public.projects where stage = 'bidding' and deadline < now() loop
    update public.projects set stage = 'bid_closed', updated_at = now() where id = r.id;
    insert into public.refresh_changes (project_id, field, old_value, new_value, material) values (r.id, 'stage', 'bidding', 'bid_closed', true);
    for o in select * from private.project_opps(r.id) where stage not in ('won','lost','disqualified','archived') loop
      insert into public.activities (opportunity_id, company_id, kind, body) values (o.id, o.company_id, 'system', 'Bid deadline passed (' || private.fmt_ts(r.deadline) || '). Next: find the low bidder or awardee.');
      if o.owner_id is null and o.kind = 'gov_bid' and o.approach in ('plan_holders','quote_bidders') then
        update public.opportunities set approach = 'track_award', next_action = 'Bids closed ' || to_char(r.deadline at time zone 'America/New_York', 'Mon DD') ||
          '. Check the bid tabulation or award notice, then call the winner.' where id = o.id;
      elsif o.owner_id is not null then
        perform private.notify(o.owner_id, o.id, 'deadline_passed', 'Bids closed: ' || o.ref, 'Find the low bidder or awardee and follow up.', 'closed:' || o.id);
      end if;
    end loop;
    closed := closed + 1;
  end loop;
  -- 2. stale claims: suggest review, never auto-release
  for o in select * from public.opportunities where stage = any(private.active_stages()) and coalesce(last_activity_at, claimed_at) < now() - make_interval(days => stale) loop
    perform private.notify(o.owner_id, o.id, 'stale', 'No activity on ' || o.ref || ' in ' || stale || '+ days',
      'Log a call or note, set a follow-up, or release it so a teammate can work it.', 'stale:' || o.id || ':' || coalesce(o.last_activity_at, o.claimed_at)::date);
    perform private.notify_managers(o.id, 'stale', 'Claim to review: ' || o.ref, (select full_name from public.profiles where id = o.owner_id) ||
      ' has had no logged activity for ' || stale || '+ days.', 'stale:' || o.id || ':' || coalesce(o.last_activity_at, o.claimed_at)::date, o.owner_id);
    n_stale := n_stale + 1;
  end loop;
  -- 3. follow-ups due today or overdue
  for o in select * from public.opportunities where stage = any(private.active_stages()) and next_action_due <= (now() at time zone 'America/New_York')::date loop
    perform private.notify(o.owner_id, o.id, 'follow_up_due', case when o.next_action_due < (now() at time zone 'America/New_York')::date then 'Overdue: ' else 'Due today: ' end || o.ref,
      coalesce(o.next_action, o.title), 'due:' || o.id || ':' || o.next_action_due);
    n_due := n_due + 1;
  end loop;
  -- 4. bid deadlines within 3 days on owned work
  for o in select x.*, p.deadline as dl from public.opportunities x join public.projects p on p.id = x.project_id
           where x.owner_id is not null and x.stage = any(private.active_stages()) and p.stage in ('bidding','upcoming') and p.deadline between now() and now() + interval '3 days' loop
    perform private.notify(o.owner_id, o.id, 'deadline_soon', 'Deadline soon: ' || o.ref, 'Due ' || private.fmt_ts(o.dl), 'soon:' || o.id || ':' || o.dl::date);
    n_soon := n_soon + 1;
  end loop;
  -- 5. managers: one daily note about new finds waiting for review, and unclaimed Hot bids closing within 5 days
  select count(*) into n_review from public.opportunities where needs_review and stage = 'available';
  if n_review > 0 then
    perform private.notify_managers(null, 'review_digest', n_review || ' new find' || case when n_review = 1 then '' else 's' end || ' waiting for review',
      'Sources and refreshes > Review queue. Publish the ones with real concrete work; archive the rest.', 'digest:' || current_date);
  end if;
  for o in select x.*, p.deadline as dl from public.opportunities x join public.projects p on p.id = x.project_id
           where x.owner_id is null and x.stage = 'available' and not x.needs_review and x.priority = 'Hot'
             and p.stage = 'bidding' and p.deadline between now() and now() + interval '5 days' loop
    perform private.notify_managers(o.id, 'deadline_soon', 'Unclaimed Hot bid closes ' || to_char(o.dl at time zone 'America/New_York', 'Mon DD'),
      o.title || '. Assign it or let it go.', 'hotdl:' || o.id);
    n_hot := n_hot + 1;
  end loop;
  perform private.rescore(id) from public.opportunities where stage not in ('archived');
  perform private.snapshot_pool();
  return jsonb_build_object('bids_closed', closed, 'stale', n_stale, 'due', n_due, 'deadline_soon', n_soon, 'review_queue', n_review, 'unclaimed_hot_deadlines', n_hot);
end $$;

create or replace function public.get_board() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles; mgr boolean; stale int;
begin
  me := private.require_active();
  mgr := me.role = 'manager';
  stale := private.setting_int('stale_days', 14);
  return coalesce((
    select jsonb_agg(jsonb_strip_nulls(to_jsonb(x)))
    from (
      select o.id, o.ref, o.title, o.kind, o.approach, o.stage, o.owner_id,
        own.full_name as owner_name, o.claimed_at,
        (o.owner_id is null or o.owner_id = me.id or mgr) as can_see_details,
        case when o.owner_id is null or o.owner_id = me.id or mgr then o.next_action end as next_action,
        case when o.owner_id = me.id or mgr then o.next_action_due end as next_action_due,
        o.last_activity_at, lab.full_name as last_activity_by_name,
        case when o.owner_id = me.id or mgr then o.last_activity_summary end as last_activity_summary,
        o.priority, o.fit_score, o.urgency_score, o.priority_reasons->>'summary' as priority_summary,
        o.services, o.services_confirmed,
        case when o.owner_id = me.id or mgr then o.quote_amount end as quote_amount,
        case when o.owner_id = me.id or mgr then o.expected_work_date end as expected_work_date,
        case when mgr or o.owner_id = me.id then o.needs_review end as needs_review,
        case when mgr or o.owner_id = me.id then o.review_reason end as review_reason,
        (o.stage = any(private.active_stages()) and coalesce(o.last_activity_at, o.claimed_at) < now() - make_interval(days => stale)) as stale,
        o.created_at, o.updated_at,
        o.company_id, c.name as company_name, c.kind as company_kind,
        o.project_id, p.title as project_title, p.short_title, p.city, p.county, p.zip, p.region, p.stage as project_stage,
        p.category, p.relevance, (select count(*) from jsonb_array_elements(p.evidence) e where e->>'confidence' = 'documented') as documented_terms,
        p.status_text, p.deadline, p.deadline_is_date, p.level, p.owner_name as project_owner,
        p.project_value, p.value_label, p.source_id, s.name as source_name, p.source_url, p.published_at,
        p.discovered_at, p.last_verified_at, p.verify_status, p.winner_name, p.winner_status, p.solicitation_no,
        (select jsonb_agg(jsonb_build_object('name', ow.full_name, 'count', ow.n))
           from (select pp.full_name, count(*) n from public.opportunities x join public.profiles pp on pp.id = x.owner_id
                 where o.company_id is not null and x.company_id = o.company_id and x.id <> o.id
                   and x.stage = any(private.active_stages()) and x.owner_id is distinct from me.id
                 group by pp.full_name) ow) as company_owners,
        (select count(*) from public.contacts ct where ct.company_id = o.company_id and not ct.archived and (ct.phone is not null or ct.email is not null)) as contact_count,
        lower(concat_ws(' ', o.ref, o.title, c.name, p.title, p.city, p.county, p.zip, p.owner_name, p.solicitation_no, p.winner_name,
          (select string_agg(concat_ws(' ', ct.name, ct.phone, ct.email), ' ') from public.contacts ct where ct.company_id = o.company_id and not ct.archived),
          (select string_agg(concat_ws(' ', e->>'name', e->>'email', e->>'phone'), ' ') from jsonb_array_elements(p.pocs) e))) as search_text
      from public.opportunities o
      left join public.projects p on p.id = o.project_id
      left join public.companies c on c.id = o.company_id
      left join public.sources s on s.id = p.source_id
      left join public.profiles own on own.id = o.owner_id
      left join public.profiles lab on lab.id = o.last_activity_by
      where mgr or not (o.stage = 'available' and o.needs_review)
    ) x), '[]'::jsonb);
end $$;

create or replace function public.get_opportunity(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles; mgr boolean; o public.opportunities; p public.projects; full_access boolean; stale int;
begin
  me := private.require_active();
  mgr := me.role = 'manager';
  select * into o from public.opportunities where id = p_id;
  if o.id is null or (not mgr and o.stage = 'available' and o.needs_review) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into p from public.projects where id = o.project_id;
  full_access := mgr or o.owner_id = me.id;
  stale := private.setting_int('stale_days', 14);
  return jsonb_strip_nulls(jsonb_build_object(
    'id', o.id, 'ref', o.ref, 'title', o.title, 'kind', o.kind, 'approach', o.approach, 'approach_note', o.approach_note,
    'stage', o.stage, 'owner_id', o.owner_id, 'owner_name', (select full_name from public.profiles where id = o.owner_id),
    'claimed_at', o.claimed_at, 'is_mine', o.owner_id = me.id, 'full_access', full_access,
    'next_action', case when o.owner_id is null or full_access then o.next_action end,
    'next_action_due', case when full_access then o.next_action_due end,
    'last_activity_at', o.last_activity_at,
    'last_activity_by_name', (select full_name from public.profiles where id = o.last_activity_by),
    'stale', (o.stage = any(private.active_stages()) and coalesce(o.last_activity_at, o.claimed_at) < now() - make_interval(days => stale)),
    'stale_days', stale,
    'services', o.services, 'speedy_scope', o.speedy_scope, 'services_confirmed', o.services_confirmed,
    'scope_confirmed_note', case when full_access then o.scope_confirmed_note end,
    'quote_amount', case when full_access then o.quote_amount end,
    'quote_sent_at', case when full_access then o.quote_sent_at end,
    'expected_work_date', case when full_access then o.expected_work_date end,
    'outcome_reason', case when full_access then o.outcome_reason end,
    'priority', o.priority, 'fit_score', o.fit_score, 'urgency_score', o.urgency_score, 'priority_reasons', o.priority_reasons,
    'needs_review', case when full_access then o.needs_review end,
    'review_reason', case when full_access then o.review_reason end,
    'legacy_priority', o.legacy_priority, 'legacy', o.legacy, 'created_at', o.created_at, 'updated_at', o.updated_at,
    'superseded_by', (select jsonb_build_object('id', s.id, 'ref', s.ref, 'title', s.title) from public.opportunities s where s.id = o.superseded_by),
    'project', case when p.id is null then null else jsonb_build_object(
      'id', p.id, 'title', p.title, 'short_title', p.short_title, 'owner_name', p.owner_name, 'level', p.level,
      'location_text', p.location_text, 'city', p.city, 'county', p.county, 'zip', p.zip, 'region', p.region,
      'category', p.category, 'relevance', p.relevance, 'relevance_score', p.relevance_score, 'evidence', p.evidence, 'match_note', p.match_note,
      'possible_duplicate', (select jsonb_build_object('id', d.id, 'title', d.title, 'source_name', d.source_name, 'source_url', d.source_url,
                               'opps', (select jsonb_agg(jsonb_build_object('id', x.id, 'ref', x.ref)) from public.opportunities x where x.project_id = d.id))
                             from public.projects d where d.id = p.possible_duplicate_of and mgr),
      'other_sources', (select jsonb_agg(distinct split_part(k, ':', 1)) from unnest(p.alt_keys) k where split_part(k, ':', 1) not in (split_part(p.external_key, ':', 1), 'fpn', 'piid')),
      'stage', p.stage, 'status_text', p.status_text, 'project_value', p.project_value, 'value_label', p.value_label,
      'size_note', p.size_note, 'solicitation_no', p.solicitation_no, 'set_aside', p.set_aside,
      'deadline', p.deadline, 'deadline_is_date', p.deadline_is_date, 'deadline_note', p.deadline_note,
      'published_at', p.published_at, 'discovered_at', p.discovered_at, 'discovered_note', p.discovered_note,
      'imported_at', p.imported_at, 'last_verified_at', p.last_verified_at, 'last_checked_at', p.last_checked_at,
      'verify_status', p.verify_status, 'source_url', p.source_url, 'source_name', p.source_name,
      'source_id', p.source_id, 'source_label', (select name from public.sources where id = p.source_id),
      'source_summary', p.source_summary, 'scope_evidence', p.scope_evidence, 'services_likely', p.services_likely,
      'pocs', p.pocs, 'winner_name', p.winner_name, 'winner_amount', p.winner_amount, 'winner_status', p.winner_status,
      'winner_as_of', p.winner_as_of, 'winner_source_url', p.winner_source_url, 'bidders', p.bidders,
      'recent_changes', (select jsonb_agg(jsonb_build_object('field', rc.field, 'old', rc.old_value, 'new', rc.new_value,
                             'material', rc.material, 'at', rc.created_at) order by rc.created_at desc)
                         from (select * from public.refresh_changes where project_id = p.id order by created_at desc limit 15) rc)) end,
    'also_covers', (select jsonb_agg(jsonb_build_object('id', pj.id, 'title', pj.title, 'stage', pj.stage, 'status_text', pj.status_text,
                       'winner_name', pj.winner_name, 'winner_status', pj.winner_status, 'source_url', pj.source_url,
                       'solicitation_no', pj.solicitation_no, 'deadline', pj.deadline))
                    from public.opportunity_projects op join public.projects pj on pj.id = op.project_id where op.opportunity_id = o.id),
    'company', (select jsonb_build_object('id', c.id, 'name', c.name, 'kind', c.kind, 'hq', c.hq, 'website', c.website, 'phone', c.phone)
                from public.companies c where c.id = o.company_id),
    'contacts', (select jsonb_agg(jsonb_build_object('id', ct.id, 'name', ct.name, 'title', ct.title, 'phone', ct.phone, 'email', ct.email,
                    'web', ct.web, 'verified', ct.verified, 'verified_at', ct.verified_at,
                    'verified_by_name', (select full_name from public.profiles where id = ct.verified_by),
                    'source', ct.source, 'notes', ct.notes) order by ct.verified desc, ct.created_at)
                 from public.contacts ct where ct.company_id = o.company_id and not ct.archived),
    'timeline', (select jsonb_agg(case when full_access or a.user_id = me.id or a.kind in ('claim','release','assign','import','system','refresh','review') then
                      jsonb_build_object('id', a.id, 'at', a.created_at, 'kind', a.kind, 'outcome', a.outcome, 'body', a.body,
                        'from_stage', a.from_stage, 'to_stage', a.to_stage, 'data', a.data,
                        'user_name', coalesce((select full_name from public.profiles where id = a.user_id), 'System'),
                        'contact_name', (select name from public.contacts where id = a.contact_id))
                    else jsonb_build_object('id', a.id, 'at', a.created_at, 'kind', a.kind, 'hidden', true,
                        'user_name', coalesce((select full_name from public.profiles where id = a.user_id), 'System')) end
                  order by a.created_at desc, a.id desc)
                 from public.activities a where a.opportunity_id = o.id),
    'ownership', (select jsonb_agg(jsonb_build_object('action', h.action, 'at', h.created_at, 'reason', h.reason,
                     'from', (select full_name from public.profiles where id = h.from_user),
                     'to', (select full_name from public.profiles where id = h.to_user),
                     'by', coalesce((select full_name from public.profiles where id = h.by_user), 'System')) order by h.created_at desc, h.id desc)
                  from public.ownership_history h where h.opportunity_id = o.id),
    'company_opps', (select jsonb_agg(jsonb_build_object('id', x.id, 'ref', x.ref, 'title', x.title, 'stage', x.stage,
                        'owner_name', (select full_name from public.profiles where id = x.owner_id), 'last_activity_at', x.last_activity_at,
                        'project_title', (select title from public.projects where id = x.project_id)) order by x.last_activity_at desc nulls last)
                     from public.opportunities x where o.company_id is not null and x.company_id = o.company_id and x.id <> o.id
                       and (mgr or not (x.stage = 'available' and x.needs_review))),
    'project_opps', (select jsonb_agg(jsonb_build_object('id', x.id, 'ref', x.ref, 'title', x.title, 'stage', x.stage, 'kind', x.kind,
                        'company_name', (select name from public.companies where id = x.company_id),
                        'owner_name', (select full_name from public.profiles where id = x.owner_id)))
                     from public.opportunities x where o.project_id is not null and x.id <> o.id
                       and (x.project_id = o.project_id or exists (select 1 from public.opportunity_projects l where l.opportunity_id = x.id and l.project_id = o.project_id))
                       and (mgr or not (x.stage = 'available' and x.needs_review))),
    'company_contact_log', (select jsonb_agg(jsonb_build_object('at', a.created_at, 'kind', a.kind,
                               'user_name', (select full_name from public.profiles where id = a.user_id),
                               'contact_name', (select name from public.contacts where id = a.contact_id),
                               'ref', (select ref from public.opportunities where id = a.opportunity_id)) order by a.created_at desc)
                            from (select * from public.activities a2 where o.company_id is not null and a2.company_id = o.company_id
                                    and a2.kind in ('call','email','text','visit','meeting') and a2.opportunity_id is distinct from o.id
                                  order by a2.created_at desc limit 8) a)
  ));
end $$;

-- ---------------------------------------------------------------- who may call what
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  public.me(), public.update_my_profile(text, text), public.get_board(), public.get_opportunity(uuid),
  public.claim_opportunity(uuid, boolean), public.release_opportunity(uuid, text), public.assign_opportunity(uuid, uuid, text),
  public.log_activity(uuid, jsonb), public.save_contact(jsonb), public.get_notifications(), public.mark_notifications_read(bigint[]),
  public.team_overview(), public.person_activity(uuid), public.resolve_review(uuid, text, text), public.update_setting(text, jsonb), public.add_lead(jsonb),
  public.sources_status(), public.export_rows(text), public.import_preview(jsonb), public.import_apply(jsonb, text),
  public.daily_maintenance(), public.list_users(), public.discovery_overview(), public.service_terms_list(), public.save_service_term(jsonb)
to authenticated;
grant execute on function public.discovery_terms() to service_role;

-- rescore everything once so the new evidence and region names show up
select private.rescore();
