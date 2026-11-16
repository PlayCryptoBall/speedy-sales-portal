-- 017: early signals (Mercator-style). Private projects found before the permit: property sales, rezonings,
-- comp-plan amendments, master and site plans, design review, with the people and companies behind each one.
-- Sources: City of Orlando planning applications, Orange County development and zoning cases on public notice,
-- Orange County Property Appraiser qualified sales. All public, free, no login.

-- ---------------------------------------------------------------- projects: land stage, stakeholders, parcel
alter table public.projects drop constraint if exists projects_stage_check;
alter table public.projects add constraint projects_stage_check check (stage in ('land','planning','design','permitting','upcoming','bidding','bid_closed',
  'low_bidder','intent_to_award','awarded','preconstruction','under_construction','completed','cancelled','unknown'));
alter table public.projects
  add column if not exists stakeholders jsonb not null default '[]',
  add column if not exists parcel_id text,
  add column if not exists signal_type text check (signal_type in ('land_sale','rezoning','site_plan','permit')),
  add column if not exists acreage numeric;
create index if not exists projects_signal_idx on public.projects (signal_type, created_at desc) where signal_type is not null;
create index if not exists projects_parcel_idx on public.projects (parcel_id) where parcel_id is not null;

create or replace function private.project_stage_rank(s text) returns int
language sql immutable set search_path = '' as $$
  select case s when 'unknown' then 0 when 'land' then 1 when 'planning' then 2 when 'design' then 3 when 'permitting' then 4 when 'upcoming' then 5
    when 'bidding' then 6 when 'bid_closed' then 7 when 'low_bidder' then 8 when 'intent_to_award' then 9 when 'awarded' then 10
    when 'preconstruction' then 11 when 'under_construction' then 12 when 'completed' then 13 when 'cancelled' then 14 else 0 end
$$;

-- Called by the refresh job right after refresh_upsert_project. Stakeholders are merged by role and name, so a later
-- record adds people without dropping the ones an earlier record named.
create or replace function public.refresh_project_extras(p_key text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.projects; merged jsonb;
begin
  select * into v from public.projects where external_key = p_key or p_key = any(alt_keys) limit 1;
  if v.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if jsonb_typeof(p->'stakeholders') = 'array' then
    select coalesce(jsonb_agg(x order by ord), '[]') into merged from (
      select distinct on (lower(x->>'role'), lower(regexp_replace(x->>'name', '[^A-Za-z0-9]', '', 'g'))) x, ord
        from (select x, 0 as ord from jsonb_array_elements(v.stakeholders) x
              union all select x, 1 from jsonb_array_elements(p->'stakeholders') x) s
       where nullif(x->>'name', '') is not null
       order by lower(x->>'role'), lower(regexp_replace(x->>'name', '[^A-Za-z0-9]', '', 'g')), ord desc) d;
  else merged := v.stakeholders;
  end if;
  update public.projects set stakeholders = merged,
    parcel_id = coalesce(nullif(p->>'parcel_id', ''), parcel_id),
    signal_type = coalesce(nullif(p->>'signal_type', ''), signal_type),
    acreage = coalesce(nullif(p->>'acreage', '')::numeric, acreage)
  where id = v.id;
  -- link a parcel's later records to its earlier ones (sale -> rezoning -> site plan -> permit) as one development story
  return jsonb_build_object('ok', true, 'same_parcel', (select count(*) from public.projects x where x.parcel_id = coalesce(nullif(p->>'parcel_id', ''), v.parcel_id) and x.id <> v.id));
end $$;
revoke all on function public.refresh_project_extras(text, jsonb) from public, anon, authenticated;
grant execute on function public.refresh_project_extras(text, jsonb) to service_role;

-- ---------------------------------------------------------------- sources
insert into public.sources (id, name, url, kind, category, method, geography, project_types, counties, coverage, schedule_note, access_notes, config) values
 ('orlando_planning', 'City of Orlando planning applications', 'https://data.cityoforlando.net/Permitting/Planning-Applications/bhxy-4rji', 'automated',
  'Early signals', 'City open data API (Socrata)', 'City of Orlando (Orange County)',
  'Rezonings, comp-plan amendments, master plans, conditional uses, design review, pre-application meetings for commercial and multi-family work', array['Orange'],
  'Planning applications with activity in the last 60 days that describe commercial, institutional, industrial or multi-family building work. Months before a permit.',
  'Daily at 4:15 AM Eastern.', 'City of Orlando open data, public, updated daily. Staff notes are informal; scope is inferred, never confirmed.',
  '{"lookback_days": 60, "max_new_per_run": 60}'),
 ('orange_dev_cases', 'Orange County development and zoning cases', 'https://fasttrack.ocfl.net/OnlineServices/DevelopmentCases.aspx', 'automated',
  'Early signals', 'County GIS service (ArcGIS)', 'Unincorporated Orange County',
  'Rezonings, PD land use plans, development plans, change determinations, special exceptions on public notice, with the applicant (often the civil engineer) and the county planner', array['Orange'],
  'Cases currently on public notice (rezoning signs and mailed notices). Gone from the feed once the hearing is over, so each run keeps what it saw.',
  'Daily at 4:15 AM Eastern.', 'Orange County public GIS, no login. The county''s date fields fail to query, so the first-seen date is used.',
  '{"layers": [0, 2]}'),
 ('orange_land_sales', 'Orange County property sales (land and commercial)', 'https://ocpaweb.ocpafl.org/', 'automated',
  'Early signals', 'County GIS service (ArcGIS)', 'All of Orange County',
  'Qualified sales of $1.5M and up: vacant commercial, industrial or institutional land, large vacant tracts, and commercial or industrial buildings bought by companies', array['Orange'],
  'Who just bought land or a building that is likely to be built on or renovated. The earliest signal, often 1 to 3 years before construction.',
  'Daily at 4:15 AM Eastern (the appraiser posts sales a few weeks after closing).', 'Orange County Property Appraiser data via the county''s public GIS. Apartment trades, condos and houses are left out.',
  '{"lookback_days": 75, "min_price": 1500000, "min_vacant_acres": 5, "max_new_per_run": 60}')
on conflict (id) do update set name = excluded.name, url = excluded.url, kind = excluded.kind, category = excluded.category, method = excluded.method,
  geography = excluded.geography, project_types = excluded.project_types, counties = excluded.counties, coverage = excluded.coverage,
  schedule_note = excluded.schedule_note, access_notes = excluded.access_notes;

-- ---------------------------------------------------------------- Early signals list (everyone signed in)
-- Projects in the land, planning and design stages, newest first, whether or not anyone is working them yet.
create or replace function public.early_signals(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; v_days int := least(greatest(coalesce((p->>'days')::int, 90), 1), 730);
  v_type text := nullif(p->>'type', ''); v_q text := nullif(trim(p->>'q'), ''); v_region text := nullif(p->>'region', '');
  v_tracked text := coalesce(nullif(p->>'tracked', ''), 'all'); v_limit int := least(coalesce((p->>'limit')::int, 200), 500);
begin
  me := private.require_active();
  return jsonb_build_object(
    'counts', (select jsonb_object_agg(t, n) from (select signal_type t, count(*) n from public.projects
                where signal_type is not null and stage in ('land','planning','design') and created_at > now() - make_interval(days => v_days) group by 1) c),
    'items', coalesce((select jsonb_agg(row order by sort_at desc) from (
      select jsonb_build_object('id', pj.id, 'title', pj.title, 'stage', pj.stage, 'signal_type', pj.signal_type, 'city', pj.city, 'county', pj.county,
          'region', pj.region, 'location_text', pj.location_text, 'size_note', pj.size_note, 'value_label', pj.value_label, 'status_text', pj.status_text,
          'summary', left(pj.source_summary, 280), 'source_name', pj.source_name, 'source_url', pj.source_url, 'parcel_id', pj.parcel_id, 'acreage', pj.acreage,
          'relevance', pj.relevance, 'services', pj.services_likely, 'stakeholders', pj.stakeholders, 'found_at', pj.created_at, 'published_at', pj.published_at,
          'opportunity', (select jsonb_build_object('id', o.id, 'ref', o.ref, 'stage', o.stage, 'mine', o.owner_id = me.id,
                             'owner', case when o.owner_id is null then null else (select full_name from public.profiles where id = o.owner_id) end)
                            from public.opportunities o where o.project_id = pj.id and o.stage <> 'archived' order by o.created_at limit 1),
          'same_parcel', (select count(*) from public.projects x where pj.parcel_id is not null and x.parcel_id = pj.parcel_id and x.id <> pj.id)) as row,
        coalesce(pj.published_at::timestamptz, pj.created_at) sort_at
      from public.projects pj
      where pj.signal_type is not null and pj.stage in ('land','planning','design')
        and pj.created_at > now() - make_interval(days => v_days)
        and (v_type is null or pj.signal_type = v_type)
        and (v_region is null or pj.region = v_region)
        and (v_q is null or pj.title ilike '%' || v_q || '%' or pj.source_summary ilike '%' || v_q || '%' or pj.stakeholders::text ilike '%' || v_q || '%')
        and (v_tracked = 'all'
             or (v_tracked = 'untracked' and not exists (select 1 from public.opportunities o where o.project_id = pj.id and o.stage <> 'archived'))
             or (v_tracked = 'tracked' and exists (select 1 from public.opportunities o where o.project_id = pj.id and o.stage <> 'archived')))
      order by sort_at desc limit v_limit) s), '[]'));
end $$;

-- Turn a signal into a lead claimed by the person who tracks it (or open the existing lead).
create or replace function public.track_signal(p_project uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; pj public.projects; o public.opportunities; v_comp uuid; who text; r jsonb;
begin
  me := private.require_active();
  select * into pj from public.projects where id = p_project;
  if pj.id is null or pj.signal_type is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into o from public.opportunities where project_id = pj.id and stage <> 'archived' order by created_at limit 1;
  if o.id is not null then return jsonb_build_object('ok', true, 'id', o.id, 'existing', true); end if;
  select x->>'name' into who from jsonb_array_elements(pj.stakeholders) x
   where x->>'role' in ('buyer','developer','owner') order by case x->>'role' when 'developer' then 1 when 'buyer' then 2 else 3 end limit 1;
  who := coalesce(who, pj.owner_name);
  if who is not null then v_comp := private.upsert_company(who, 'developer'); end if;
  insert into public.opportunities (project_id, company_id, kind, approach, title, next_action, services, needs_review)
  values (pj.id, v_comp, 'private_project', 'approach_developer', left(coalesce(who || ' — ', '') || coalesce(pj.short_title, pj.title), 200),
          case pj.stage when 'land' then 'Find out what ' || coalesce(who, 'the buyer') || ' plans to build or renovate here, and who their general contractor will be.'
            when 'planning' then 'Introduce Speedy to ' || coalesce(who, 'the applicant') || ' and ask who will build it; check back when site plans are filed.'
            else 'Ask ' || coalesce(who, 'the applicant') || ' for the general contractor and civil engineer, and offer scanning, coring and cutting.' end,
          pj.services_likely, false)
  returning * into o;
  insert into public.activities (opportunity_id, company_id, user_id, kind, body)
  values (o.id, v_comp, me.id, 'system', 'Tracked from Early signals (' || replace(pj.signal_type, '_', ' ') || ')');
  r := public.claim_opportunity(o.id, true);
  return jsonb_build_object('ok', true, 'id', o.id, 'claimed', coalesce((r->>'ok')::boolean, false), 'message', r->>'message');
end $$;

-- Stakeholders and parcel for the lead panel (any signed-in user; these are public records).
create or replace function public.project_people(p_project uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; pj public.projects;
begin
  me := private.require_active();
  select * into pj from public.projects where id = p_project;
  if pj.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  return jsonb_build_object('stakeholders', pj.stakeholders, 'parcel_id', pj.parcel_id, 'signal_type', pj.signal_type, 'acreage', pj.acreage, 'county', pj.county,
    'related', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'stage', x.stage, 'signal_type', x.signal_type, 'source_name', x.source_name,
                         'found_at', x.created_at, 'opp', (select o.id from public.opportunities o where o.project_id = x.id and o.stage <> 'archived' limit 1)) order by x.created_at)
                         from public.projects x where pj.parcel_id is not null and x.parcel_id = pj.parcel_id and x.id <> pj.id), '[]'));
end $$;

revoke all on function public.early_signals(jsonb), public.track_signal(uuid), public.project_people(uuid) from public, anon;
grant execute on function public.early_signals(jsonb), public.track_signal(uuid), public.project_people(uuid) to authenticated;

-- ---------------------------------------------------------------- company names: keep LLC, LP, JV and similar in capitals
create or replace function private.nice_company(p text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    initcap(lower(trim(split_part(p, '(', 1)))),
    '\mLlc\M', 'LLC', 'g'), '\mPllc\M', 'PLLC', 'g'), '\mLlp\M', 'LLP', 'g'), '\mLp\M', 'LP', 'g'), '\mJv\M', 'JV', 'g'),
    '\mIi(i?)\M', 'II\1', 'g'), '\mUsa\M', 'USA', 'g')
$$;
create or replace function private.upsert_company(p_name text, p_kind text default 'contractor') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid; k text := private.norm_key(p_name);
begin
  if k is null or k = '' then return null; end if;
  select id into v from public.companies where name_key = k or k = any(aliases) limit 1;
  if v is null then
    insert into public.companies (name, name_key, kind) values (private.nice_company(p_name), k, p_kind)
    on conflict (name_key) do nothing returning id into v;
    if v is null then select id into v from public.companies where name_key = k; end if;
  end if;
  return v;
end $$;
-- names written by the old routine ("Example Llc"); a name a person typed differently is left as it is
update public.companies set name = regexp_replace(regexp_replace(regexp_replace(regexp_replace(name,
    '\mLlc\M', 'LLC', 'g'), '\mLp\M', 'LP', 'g'), '\mJv\M', 'JV', 'g'), '\mLlp\M', 'LLP', 'g'), updated_at = now()
 where name ~ '\m(Llc|Lp|Jv|Llp)\M';
update public.opportunities set title = regexp_replace(regexp_replace(title, '\mLlc\M', 'LLC', 'g'), '\mJv\M', 'JV', 'g')
 where title ~ '\m(Llc|Jv)\M';
