-- 022: source health that does not trust "last refreshed", and an honest jurisdiction coverage registry.
-- Health tracks the last attempt, last success, last new record and last full verification separately, and judges a quiet
-- source against how often it normally produces new records (FDOT lets monthly; Orlando permits arrive daily).

-- how many days without a new record is normal for each source
update public.sources set config = coalesce(config, '{}') || jsonb_build_object('expect_new_days', d)
from (values ('fdot_lettings', 35), ('sam_gov', 4), ('usaspending_awards', 10), ('orlando_permits', 4), ('orlando_planning', 4),
             ('orange_dev_cases', 21), ('orange_land_sales', 30)) v(id, d)
where sources.id = v.id and not (coalesce(config, '{}') ? 'expect_new_days');

create or replace function private.source_health(p_id text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.sources; last_new timestamptz; last_run public.refresh_runs; n_pipeline int; expect int; v_status text; why text; zero_read boolean;
begin
  select * into s from public.sources where id = p_id;
  if s.id is null then return null; end if;
  select max(started_at) into last_new from public.refresh_runs where source_id = s.id and discovered > 0 and started_at <= now();
  select * into last_run from public.refresh_runs where source_id = s.id and status <> 'running' and started_at <= now() order by started_at desc limit 1;
  select count(*) into n_pipeline from public.projects p where p.source_id = s.id and p.merged_into is null
    and exists (select 1 from public.opportunities o where o.project_id = p.id and o.stage <> 'archived');
  expect := coalesce((s.config->>'expect_new_days')::int, 14);
  zero_read := last_run.status = 'success' and coalesce(last_run.examined, 0) = 0;
  if s.kind = 'paid' then v_status := 'Unsupported'; why := 'Paid service; not collected.';
  elsif s.kind = 'needs_credentials' then v_status := 'Requires manual acquisition'; why := coalesce(s.access_notes, 'Needs a login; records are added by hand.');
  elsif s.kind <> 'automated' then v_status := 'Requires manual acquisition'; why := 'Added by hand or imported.';
  elsif not s.enabled then v_status := 'Not yet integrated'; why := 'Turned off.';
  elsif s.last_run_at is null then v_status := 'Not yet integrated'; why := 'Configured, never run.';
  elsif s.last_success_at is null or s.last_status = 'failed' then v_status := 'Failed'; why := coalesce(left(s.last_error, 160), 'Last run failed.');
  elsif s.last_success_at < now() - interval '30 hours' then v_status := 'Stale'; why := 'No successful run in 30 hours.';
  elsif zero_read then v_status := 'Degraded'; why := 'Last run succeeded but read zero records from the source. Check the feed.';
  elsif last_new is not null and last_new < now() - make_interval(days => expect) then v_status := 'Stale'; why := format('No new records in %s days (normal is within %s).', extract(day from now() - last_new)::int, expect);
  elsif s.last_status = 'partial' then v_status := 'Degraded'; why := coalesce(left(s.last_error, 160), 'Part of the last run failed.');
  else v_status := 'Healthy'; why := case when last_run.discovered > 0 then format('%s new on the last run.', last_run.discovered) else 'Working; nothing new on the last run, which is normal for this source.' end;
  end if;
  return jsonb_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'category', s.category, 'url', s.url, 'geography', s.geography, 'counties', s.counties,
    'status', v_status, 'why', why, 'last_attempt', s.last_run_at, 'last_success', s.last_success_at, 'last_new', last_new, 'expect_new_days', expect,
    'last_examined', last_run.examined, 'last_discovered', last_run.discovered, 'last_updated', last_run.updated, 'in_pipeline', n_pipeline,
    'access', s.access_notes, 'method', s.method);
end $$;

-- ---------------------------------------------------------------- jurisdiction registry
create table if not exists public.coverage_registry (
  id bigint generated always as identity primary key,
  county text,                       -- null = statewide
  jurisdiction text not null,        -- e.g. 'City of Orlando', 'Orange County', 'State of Florida'
  data_type text not null check (data_type in ('permits','planning','procurement','awards','property','roads','federal','companies','records')),
  source_id text references public.sources(id),
  url text, method text, scope_note text, restrictions text,
  status text check (status in ('Healthy','Degraded','Stale','Failed','Unsupported','Requires manual acquisition','Not yet integrated')),
  business_value int not null default 0,  -- rough priority for the next integration (0-100)
  checked_at date, unique (county, jurisdiction, data_type));
alter table public.coverage_registry enable row level security;
revoke all on public.coverage_registry from anon, authenticated;

insert into public.coverage_registry (county, jurisdiction, data_type, source_id, url, method, scope_note, restrictions, status, business_value, checked_at) values
 (null, 'FDOT and Florida''s Turnpike', 'roads', 'fdot_lettings', 'https://www.fdot.gov/contracts/lettings', 'FDOT letting result files', 'State road and bridge lettings, bidders and apparent low bidders, all 7 districts', null, null, 0, '2026-11-16'),
 (null, 'Federal agencies (SAM.gov)', 'federal', 'sam_gov', 'https://sam.gov/opportunities', 'SAM.gov public API', 'Federal construction solicitations with a Florida place of performance', 'API key; daily request limit', null, 0, '2026-11-16'),
 (null, 'Federal agencies (USAspending)', 'awards', 'usaspending_awards', 'https://www.usaspending.gov', 'USAspending API', 'Federal construction contract awards in Florida', null, null, 0, '2026-11-16'),
 ('Orange', 'City of Orlando', 'permits', 'orlando_permits', 'https://data.cityoforlando.net/Permitting/Permit-Applications/ryhf-m453', 'Socrata open data API', 'Commercial permit applications with contractor, phone and owner', null, null, 0, '2026-11-16'),
 ('Orange', 'City of Orlando', 'planning', 'orlando_planning', 'https://data.cityoforlando.net/Permitting/Planning-Applications/bhxy-4rji', 'Socrata open data API', 'Rezonings, master plans, design review, pre-application meetings', null, null, 0, '2026-11-16'),
 ('Orange', 'Orange County', 'planning', 'orange_dev_cases', 'https://fasttrack.ocfl.net/OnlineServices/DevelopmentCases.aspx', 'County ArcGIS service', 'Development and zoning cases while on public notice', 'Service rejects some field combinations; fields are read in groups', null, 0, '2026-11-16'),
 ('Orange', 'Orange County', 'property', 'orange_land_sales', 'https://ocpaweb.ocpafl.org/', 'County ArcGIS service (Property Appraiser parcels)', 'Qualified sales of $1.5M+ of land and commercial buildings', 'Sales post a few weeks after closing', null, 0, '2026-11-16'),
 ('Orange', 'Orange County', 'permits', null, 'https://fasttrack.ocfl.net/', 'Fast Track online services', 'Unincorporated Orange County building permits', 'No bulk feed confirmed yet', 'Not yet integrated', 90, '2026-11-16'),
 ('Broward', 'City of Fort Lauderdale', 'permits', null, 'https://gis.fortlauderdale.gov/server/rest/services/BuildingPermits/MapServer/0', 'City ArcGIS service', 'Permits with owner, contractor, phone and cost', 'Feed stopped updating on 2026-03-16', 'Stale', 40, '2026-11-16'),
 (null, 'Florida Division of Corporations (Sunbiz)', 'companies', null, 'https://search.sunbiz.org', 'Web search', 'Company officers and registered agents', 'Bot protection blocks automated lookups; opened by the salesperson', 'Requires manual acquisition', 30, '2026-11-16'),
 (null, 'MyFloridaMarketPlace / Vendor Bid System', 'procurement', null, null, 'Not yet assessed', 'State agency solicitations', 'Access method not yet confirmed', 'Not yet integrated', 70, null),
 (null, 'County clerks (notices of commencement)', 'records', null, null, 'Official records search, county by county', 'Notices of commencement name owner, contractor and surety', 'Search pages differ by county; some limit automated use', 'Requires manual acquisition', 60, null),
 ('Hillsborough', 'Hillsborough County and City of Tampa', 'permits', null, null, 'Not yet assessed', 'Commercial permits for the Tampa office territory', null, 'Not yet integrated', 85, null),
 ('Miami-Dade', 'Miami-Dade County', 'permits', null, null, 'Not yet assessed', 'Building permits (county open data)', null, 'Not yet integrated', 80, null),
 ('Duval', 'City of Jacksonville', 'permits', null, null, 'Not yet assessed', 'Commercial permits for the Jacksonville office territory', null, 'Not yet integrated', 75, null),
 ('Broward', 'Broward County', 'permits', null, null, 'Not yet assessed', 'Commercial permits for the Fort Lauderdale office territory', null, 'Not yet integrated', 75, null),
 ('Palm Beach', 'Palm Beach County', 'permits', null, null, 'Not yet assessed', 'Commercial permits', null, 'Not yet integrated', 65, null),
 ('Pinellas', 'Pinellas County', 'permits', null, null, 'Not yet assessed', 'Commercial permits', null, 'Not yet integrated', 60, null),
 ('Seminole', 'Seminole County', 'permits', null, null, 'Not yet assessed', 'Commercial permits next to Orlando', null, 'Not yet integrated', 70, null),
 ('Osceola', 'Osceola County', 'permits', null, null, 'Not yet assessed', 'Commercial permits next to Orlando', null, 'Not yet integrated', 65, null)
on conflict (county, jurisdiction, data_type) do nothing;

-- One call for the coverage page: source health, the registry, and a county matrix of what is actually collected.
create or replace function public.coverage_status() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; health jsonb;
begin
  me := private.require_manager();
  select jsonb_object_agg(id, private.source_health(id)) into health from public.sources;
  return jsonb_build_object(
    'sources', (select jsonb_agg(h order by case h->>'status' when 'Failed' then 0 when 'Stale' then 1 when 'Degraded' then 2 when 'Healthy' then 3 else 4 end, h->>'name')
                from jsonb_each(health) e(k, h)),
    'registry', (select jsonb_agg(jsonb_build_object('county', r.county, 'jurisdiction', r.jurisdiction, 'data_type', r.data_type, 'url', r.url, 'method', r.method,
                   'scope', r.scope_note, 'restrictions', r.restrictions, 'value', r.business_value, 'checked_at', r.checked_at, 'source_id', r.source_id,
                   'status', coalesce(health->r.source_id->>'status', r.status), 'why', health->r.source_id->>'why')
                 order by r.county nulls first, r.jurisdiction, r.data_type) from public.coverage_registry r),
    'counties', (select jsonb_agg(jsonb_build_object('county', c.name, 'region', c.region,
                   'roads', health->'fdot_lettings'->>'status', 'federal', health->'sam_gov'->>'status',
                   'local', coalesce((select jsonb_agg(jsonb_build_object('type', r.data_type, 'jurisdiction', r.jurisdiction, 'status', coalesce(health->r.source_id->>'status', r.status)))
                                      from public.coverage_registry r where r.county = c.name), '[]'),
                   'leads', (select count(*) from public.opportunities o join public.projects p on p.id = o.project_id where p.county = c.name and o.stage <> 'archived'))
                 order by c.region, c.name) from public.fl_counties c),
    'next', (select jsonb_agg(jsonb_build_object('jurisdiction', r.jurisdiction, 'data_type', r.data_type, 'value', r.business_value, 'scope', r.scope_note) order by r.business_value desc)
             from public.coverage_registry r where r.status in ('Not yet integrated','Stale') and r.business_value > 0),
    'note', 'Statewide sources cover state roads and federal work in every county. A county with only those has no local permit, planning or procurement coverage.');
end $$;
revoke all on function public.coverage_status() from public, anon;
grant execute on function public.coverage_status() to authenticated;

-- managers hear about a failed or stale source once a day, not on every page load
create or replace function private.source_health_alerts() returns int
language plpgsql security definer set search_path = '' as $$
declare h jsonb; n int := 0;
begin
  for h in select private.source_health(id) from public.sources where kind = 'automated' and enabled loop
    if h->>'status' in ('Failed','Stale','Degraded') then
      perform private.notify_managers(null, 'refresh_failed', (h->>'name') || ': ' || lower(h->>'status'), h->>'why', 'health:' || (h->>'id') || ':' || current_date);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
