-- Core concrete-cutting domain: services catalog, company relationships per workspace, contact verification and
-- do-not-contact, project participants (every company on a project with its role), tasks, and the full pipeline stages.
-- Pursuit rows (company_accounts, tasks) are workspace-scoped and read through private.v_* views by user-facing code.

-- ---------------------------------------------------------------- services catalog (per workspace)
-- request_fields drives the estimate request form: each field has a dimension and allowed units, so quantities never
-- lose their units (inches are never read as feet; length, area, volume and count are separate dimensions).
create table public.services (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  key text not null,
  name text not null,
  description text not null default '',
  active boolean not null default true,
  sort int not null default 100,
  request_fields jsonb not null default '[]',
  discovery_name text,          -- the name the discovery vocabulary uses (service_terms.services), so evidence maps to this service
  created_at timestamptz not null default now(),
  unique (workspace_id, key)
);
alter table public.services enable row level security;

create table public.units (
  key text primary key,
  dimension text not null check (dimension in ('length', 'area', 'volume', 'count', 'thickness', 'diameter', 'depth', 'time', 'weight', 'lump_sum')),
  label text not null,
  to_base numeric             -- factor to the dimension's base unit (inches for length-like, sq ft, cu yd, each); null = not convertible
);
insert into public.units (key, dimension, label, to_base) values
 ('in', 'length', 'inches', 1), ('ft', 'length', 'feet', 12), ('lf', 'length', 'linear feet', 12), ('mm', 'length', 'millimetres', 0.0393701), ('m', 'length', 'metres', 39.3701),
 ('sq_ft', 'area', 'square feet', 1), ('sq_yd', 'area', 'square yards', 9), ('sq_in', 'area', 'square inches', 0.00694444),
 ('cu_yd', 'volume', 'cubic yards', 1), ('cu_ft', 'volume', 'cubic feet', 0.037037),
 ('ea', 'count', 'each', 1), ('hole', 'count', 'holes', 1), ('opening', 'count', 'openings', 1),
 ('hr', 'time', 'hours', 1), ('day', 'time', 'days', 8), ('ton', 'weight', 'tons', 1), ('ls', 'lump_sum', 'lump sum', null);
alter table public.units enable row level security;

-- field helpers for the seed below: f(key, label, dimension, units[], required)
create or replace function private.rf(k text, label text, dim text, units text[], req boolean default false, extra jsonb default '{}') returns jsonb
language sql immutable as $$ select jsonb_build_object('key', k, 'label', label, 'dimension', dim, 'units', to_jsonb(units), 'required', req) || extra $$;

-- default catalog for the shared workspace, from the services the company publishes (docs/SERVICES.md) plus trench cutting
insert into public.services (workspace_id, key, name, description, sort, discovery_name, request_fields)
select private.default_ws(), x.key, x.name, x.descr, x.sort, x.disc, x.fields from (values
 ('slab_sawing', 'Slab sawing', 'Flat sawing of slabs and pavement.', 10, 'Slab sawing', jsonb_build_array(
    private.rf('cut_length', 'Total length of cut', 'length', array['lf', 'ft', 'in', 'm'], true), private.rf('thickness', 'Slab thickness', 'thickness', array['in', 'mm']),
    private.rf('reinforcement', 'Rebar, mesh or post-tension', 'choice', null, false, '{"options": ["unknown", "none", "mesh", "rebar", "post_tension"]}'),
    private.rf('surface', 'Surface', 'choice', null, false, '{"options": ["interior_slab", "exterior_slab", "pavement", "elevated_deck"]}'))),
 ('trench_cutting', 'Trench cutting', 'Parallel cuts and removal for plumbing, electrical or drainage trenches.', 15, 'Slab sawing', jsonb_build_array(
    private.rf('trench_length', 'Trench length', 'length', array['lf', 'ft', 'm'], true), private.rf('trench_width', 'Trench width', 'length', array['in', 'ft', 'mm'], true),
    private.rf('thickness', 'Slab thickness', 'thickness', array['in', 'mm']), private.rf('remove_concrete', 'Remove the cut concrete', 'boolean', null))),
 ('wall_sawing', 'Wall sawing', 'Openings in concrete and masonry walls.', 20, 'Wall sawing', jsonb_build_array(
    private.rf('opening_count', 'Number of openings', 'count', array['ea', 'opening'], true), private.rf('opening_width', 'Opening width', 'length', array['in', 'ft', 'mm'], true),
    private.rf('opening_height', 'Opening height', 'length', array['in', 'ft', 'mm'], true), private.rf('wall_thickness', 'Wall thickness', 'thickness', array['in', 'mm']),
    private.rf('wall_material', 'Wall material', 'choice', null, false, '{"options": ["concrete", "block", "brick", "unknown"]}'))),
 ('core_drilling', 'Core drilling', 'Round holes through slabs, walls and decks.', 30, 'Core drilling', jsonb_build_array(
    private.rf('core_count', 'Number of holes', 'count', array['ea', 'hole'], true), private.rf('core_diameter', 'Hole diameter', 'diameter', array['in', 'mm'], true),
    private.rf('core_depth', 'Depth (thickness drilled)', 'depth', array['in', 'mm', 'ft'], true),
    private.rf('orientation', 'Orientation', 'choice', null, true, '{"options": ["floor_down", "wall_horizontal", "overhead"]}'))),
 ('wire_sawing', 'Wire sawing', 'Thick or massive reinforced sections, piers, underwater cuts.', 40, 'Wire sawing', jsonb_build_array(
    private.rf('cut_area', 'Cut area', 'area', array['sq_ft', 'sq_in'], true), private.rf('member', 'What is being cut', 'text', null))),
 ('gpr_scanning', 'GPR scanning', 'Locating rebar, post-tension cables and conduits before cutting or drilling.', 50, 'GPR scanning', jsonb_build_array(
    private.rf('scan_locations', 'Locations to scan', 'count', array['ea'], true), private.rf('scan_area', 'Area to scan', 'area', array['sq_ft']),
    private.rf('targets', 'Looking for', 'choice', null, false, '{"options": ["rebar", "post_tension", "conduit", "all"]}'),
    private.rf('report_required', 'Written report required', 'boolean', null))),
 ('concrete_removal', 'Concrete removal', 'Breaking, loading and haul-off of concrete.', 60, 'Breaking & removal', jsonb_build_array(
    private.rf('removal_area', 'Area to remove', 'area', array['sq_ft', 'sq_yd'], true), private.rf('thickness', 'Thickness', 'thickness', array['in', 'mm']),
    private.rf('removal_volume', 'Volume (if known)', 'volume', array['cu_yd', 'cu_ft']), private.rf('haul_off', 'Haul-off and disposal by us', 'boolean', null))),
 ('selective_demolition', 'Selective demolition', 'Controlled interior or structural demolition.', 70, 'Selective demolition', jsonb_build_array(
    private.rf('description', 'What is coming out', 'text', null, true), private.rf('area', 'Area', 'area', array['sq_ft'])))
 , ('road_bridge', 'Road and bridge deconstruction', 'Bridge decks, barrier walls, piers, roadway.', 80, 'Road & bridge deconstruction', '[]'::jsonb)
 , ('chain_sawing', 'Chain sawing', 'Deep square-cornered openings in walls and masonry.', 90, 'Chain sawing', '[]'::jsonb)
 , ('hand_sawing', 'Hand sawing', 'Tight-access cuts.', 91, 'Hand sawing', '[]'::jsonb)
 , ('curb_sawing', 'Curb sawing', 'Curb and gutter cuts and removal.', 92, 'Curb sawing', '[]'::jsonb)
 , ('robotic_demolition', 'Robotic demolition', 'Remote-controlled demolition.', 93, 'Robotic demolition', '[]'::jsonb)
 , ('diamond_grinding', 'Diamond grinding', 'Pavement, deck and floor grinding.', 94, 'Diamond grinding', '[]'::jsonb)
 , ('surface_prep', 'Surface preparation', 'Grinding, shot blasting, hydrodemolition.', 95, 'Surface preparation', '[]'::jsonb)
) as x(key, name, descr, sort, disc, fields)
where private.default_ws() is not null;

-- ---------------------------------------------------------------- companies: types and per-workspace relationship
alter table public.companies drop constraint if exists companies_kind_check;
alter table public.companies add constraint companies_kind_check check (kind in ('contractor', 'general_contractor', 'mechanical', 'plumbing', 'electrical',
  'fire_protection', 'demolition', 'utility', 'site_civil', 'owner', 'facility_manager', 'developer', 'agency', 'design', 'supplier', 'other'));
alter table public.companies add column if not exists service_area text;

-- how a workspace relates to a company: vendor onboarding, relationship, suppression. Notes and history are private.
create table public.company_accounts (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  relationship text not null default 'prospect' check (relationship in ('prospect', 'active', 'customer', 'repeat', 'dormant', 'do_not_pursue')),
  vendor_status text not null default 'not_started' check (vendor_status in ('not_started', 'requested', 'in_progress', 'approved', 'expired', 'not_required')),
  vendor_requirements text,          -- what their onboarding needs (W-9, COI limits, prequal form...) as they told us
  vendor_updated_at timestamptz,
  do_not_contact boolean not null default false,
  do_not_contact_reason text,
  do_not_contact_at timestamptz,
  notes text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id),
  primary key (workspace_id, company_id)
);
alter table public.company_accounts enable row level security;
create view private.v_company_accounts as select * from public.company_accounts where private.ws_ok(workspace_id);

-- ---------------------------------------------------------------- contacts: provenance per detail, buying role, suppression
alter table public.contacts
  add column verification text not null default 'unverified' check (verification in ('published', 'user_confirmed', 'unverified')),
  add column buying_role text check (buying_role in ('estimator', 'project_manager', 'superintendent', 'purchasing', 'owner_rep', 'facility_manager', 'executive', 'office', 'other')),
  add column phone_source text, add column phone_verified_at timestamptz,
  add column email_source text, add column email_verified_at timestamptz,
  add column email_is_guess boolean not null default false,   -- a guessed pattern; never shown as verified
  add column do_not_contact boolean not null default false,
  add column do_not_contact_reason text, add column do_not_contact_at timestamptz;
update public.contacts set verification = case when source = 'source_document' then 'published' when verified then 'user_confirmed' else 'unverified' end,
  phone_source = case when phone is not null then coalesce(source_url, source) end, email_source = case when email is not null then coalesce(source_url, source) end,
  phone_verified_at = case when phone is not null and verified then verified_at end, email_verified_at = case when email is not null and verified then verified_at end;
-- the views were created before these columns existed
create or replace view private.v_contacts as select * from public.contacts where workspace_id is null or private.ws_ok(workspace_id);
alter view private.v_contacts alter column workspace_id set default private.current_ws();

-- ---------------------------------------------------------------- project participants
-- Every company on a project and its role: owner, developer, bidders with rank and price, low bidder, intended and awarded
-- contractor, subs, designers, agency contacts. Shared public intelligence (no workspace). Rows from sources are kept in
-- step with the project by private.sync_participants; rows people add (origin 'user') are never touched by it.
create table public.project_participants (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  company_id uuid references public.companies(id),
  name text not null,
  name_key text not null,
  role text not null check (role in ('owner', 'developer', 'buyer', 'seller', 'applicant', 'bidder', 'low_bidder', 'intended_awardee', 'awarded_contractor',
    'subcontractor', 'architect', 'engineer', 'agency_contact', 'tenant', 'other')),
  rank int,
  amount numeric,
  status text,
  phone text, email text, address text,
  source_name text, source_url text, as_of date,
  origin text not null default 'source' check (origin in ('source', 'user')),
  current boolean not null default true,     -- false once the source stops listing it (kept for history)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, role, name_key)
);
create index project_participants_company on public.project_participants (company_id);
alter table public.project_participants enable row level security;

create or replace function private.sync_participants(p_project uuid) returns int language plpgsql security definer set search_path = '' as $$
declare v public.projects; n int := 0; seen text[] := '{}'; r record; k text; c uuid;
begin
  select * into v from public.projects where id = p_project;
  if v.id is null then return 0; end if;
  for r in
    select x.name, x.role, x.rank, x.amount, x.status, x.phone, x.email, x.address, x.src, x.url, x.as_of from (
      select b->>'name' as name, 'bidder' as role, (b->>'rank')::int as rank, (b->>'amount')::numeric as amount, null::text as status,
             null::text as phone, null::text as email, null::text as address, v.source_name as src, v.source_url as url, v.winner_as_of as as_of
        from jsonb_array_elements(coalesce(v.bidders, '[]')) b
      union all
      select v.winner_name, case v.winner_status when 'low_bidder' then 'low_bidder' when 'intended' then 'intended_awardee' else 'awarded_contractor' end,
             null, v.winner_amount, v.winner_status, null, null, null, v.source_name, coalesce(v.winner_source_url, v.source_url), v.winner_as_of
        where v.winner_name is not null and v.winner_name !~* '^\d+ award holders'
      union all
      select v.owner_name, 'owner', null, null, null, null, null, null, v.source_name, v.source_url, null where nullif(trim(v.owner_name), '') is not null
      union all
      select s->>'name', case when s->>'role' in ('owner', 'developer', 'buyer', 'seller', 'applicant', 'architect', 'engineer', 'agency_contact') then s->>'role'
                              when s->>'role' = 'contractor' then 'subcontractor' else 'other' end,
             null, null, null, s->>'phone', s->>'email', s->>'address', coalesce(s->>'source', v.source_name), coalesce(s->>'url', v.source_url), null
        from jsonb_array_elements(coalesce(v.stakeholders, '[]')) s
    ) x where nullif(trim(x.name), '') is not null
  loop
    k := private.norm_key(r.name);
    if k is null or k = '' or (r.role || '|' || k) = any(seen) then continue; end if;
    seen := seen || (r.role || '|' || k);
    select id into c from public.companies where name_key = k limit 1;
    insert into public.project_participants (project_id, company_id, name, name_key, role, rank, amount, status, phone, email, address, source_name, source_url, as_of)
    values (v.id, c, r.name, k, r.role, r.rank, r.amount, r.status, r.phone, r.email, r.address, r.src, r.url, r.as_of)
    on conflict (project_id, role, name_key) do update set company_id = coalesce(excluded.company_id, public.project_participants.company_id),
      rank = excluded.rank, amount = excluded.amount, status = excluded.status, phone = coalesce(excluded.phone, public.project_participants.phone),
      email = coalesce(excluded.email, public.project_participants.email), address = coalesce(excluded.address, public.project_participants.address),
      source_name = excluded.source_name, source_url = excluded.source_url, as_of = excluded.as_of, current = true, updated_at = now()
    where public.project_participants.origin = 'source';
    n := n + 1;
  end loop;
  update public.project_participants set current = false, updated_at = now()
   where project_id = v.id and origin = 'source' and current and not ((role || '|' || name_key) = any(seen));
  -- a bidder that is also the low bidder or awardee keeps both rows: the bid (rank, price) and the outcome
  return n;
end $$;

create or replace function private.projects_sync_participants() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.bidders is distinct from old.bidders or new.winner_name is distinct from old.winner_name
     or new.winner_status is distinct from old.winner_status or new.stakeholders is distinct from old.stakeholders or new.owner_name is distinct from old.owner_name then
    perform private.sync_participants(new.id);
  end if;
  return null;
end $$;
create trigger projects_participants after insert or update on public.projects for each row execute function private.projects_sync_participants();
select count(private.sync_participants(id)) from public.projects;

-- ---------------------------------------------------------------- tasks
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default private.current_ws() references public.workspaces(id) on delete cascade,
  opportunity_id uuid references public.opportunities(id) on delete cascade,
  company_id uuid references public.companies(id),
  contact_id uuid references public.contacts(id),
  kind text not null default 'follow_up' check (kind in ('call', 'email', 'follow_up', 'research', 'estimate', 'site_visit', 'send_quote', 'drawings', 'vendor_setup', 'handoff', 'other')),
  title text not null check (length(title) between 1 and 300),
  notes text,
  due_at timestamptz,
  assigned_to uuid references public.profiles(id),
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  outcome text,
  completed_at timestamptz,
  completed_by uuid references public.profiles(id),
  origin text not null default 'user' check (origin in ('user', 'next_action', 'estimate_request', 'system', 'import')),
  dedupe_key text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index tasks_dedupe on public.tasks (workspace_id, dedupe_key) where dedupe_key is not null and status = 'open';
create index tasks_open on public.tasks (workspace_id, assigned_to, due_at) where status = 'open';
alter table public.tasks enable row level security;
create view private.v_tasks as select * from public.tasks where private.ws_ok(workspace_id);
alter view private.v_tasks alter column workspace_id set default private.current_ws();

-- a date-only follow-up is due at 9:00 AM Eastern on that date (DST handled by the time zone rules)
create or replace function private.due_at_et(d date) returns timestamptz language sql immutable as $$
  select case when d is null then null else (d::timestamp + time '09:00') at time zone 'America/New_York' end $$;

-- each active lead's "next step" is mirrored as one open task, so the task list and the lead never disagree
alter table public.opportunities add column if not exists no_action_reason text;
-- views select * at creation time: rebuild after a column is added so their row type matches the table again
create or replace view private.v_opportunities as select * from public.opportunities where private.ws_ok(workspace_id);
alter view private.v_opportunities alter column workspace_id set default private.current_ws();
create or replace function private.mirror_next_action() returns trigger language plpgsql security definer set search_path = '' as $$
declare k text := 'next:' || new.id;
begin
  if new.stage = any(private.active_stages()) and (new.next_action is not null or new.next_action_due is not null) and new.owner_id is not null then
    update public.tasks set title = coalesce(new.next_action, 'Follow up'), due_at = private.due_at_et(new.next_action_due), assigned_to = new.owner_id, updated_at = now()
     where workspace_id = new.workspace_id and dedupe_key = k and status = 'open';
    if not found then
      insert into public.tasks (workspace_id, opportunity_id, company_id, kind, title, due_at, assigned_to, origin, dedupe_key, created_by)
      values (new.workspace_id, new.id, new.company_id, 'follow_up', coalesce(new.next_action, 'Follow up'), private.due_at_et(new.next_action_due), new.owner_id,
              'next_action', k, coalesce(auth.uid(), new.owner_id));
    end if;
  else
    update public.tasks set status = 'cancelled', outcome = case when new.stage = any(private.active_stages()) then 'next step cleared' else 'lead closed or released' end,
      completed_at = now(), updated_at = now()
     where workspace_id = new.workspace_id and dedupe_key = k and status = 'open';
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------- pipeline stages
-- Existing keys keep their meaning; labels follow the sales process. New active steps sit between them.
update public.stages set label = 'New', description = 'Owned; not worked yet.' where key = 'claimed';
update public.stages set label = 'Research', description = 'Owned; finding the buyer, the right contact and the scope before the first call.' where key = 'researching';
update public.stages set label = 'Scope discussion', description = 'Talking scope with the buyer: services, quantities, schedule.' where key = 'qualified';
update public.stages set label = 'Ready for estimating', description = 'Enough scope to price. Estimating has been asked.' where key = 'quote_needed';
update public.stages set label = 'Awarded', description = 'Customer confirmed the award (recorded with how it was confirmed).' where key = 'won';
update public.stages set label = 'Deferred', description = 'Not now. Keep the relationship warm and set a date to revisit.' where key = 'nurture';
update public.stages set description = 'Not a fit for this company''s services or territory.' where key = 'disqualified';
insert into public.stages (key, label, sort, phase, description) values
 ('contact_confirmed', 'Contact confirmed', 27, 'active', 'The buying contact is identified with a working phone or email; no conversation yet.'),
 ('drawings_requested', 'Drawings requested', 44, 'active', 'Asked for drawings, specs or photos to confirm scope and quantities.'),
 ('site_visit', 'Site visit', 46, 'active', 'A walk of the site is set or done to confirm conditions and quantities.'),
 ('quote_prep', 'Quote preparation', 55, 'active', 'Quote is being priced and reviewed.'),
 ('cancelled', 'Cancelled', 95, 'lost', 'The project or the scope was cancelled by the owner or the buyer.')
on conflict (key) do nothing;

create or replace function private.active_stages() returns text[] language sql immutable set search_path = '' as $$
  select array['claimed', 'researching', 'contact_confirmed', 'contacted', 'qualified', 'drawings_requested', 'site_visit', 'quote_needed', 'quote_prep', 'quote_sent', 'follow_up'] $$;

-- the ownership rule now covers every active stage (it was missing 'researching')
alter table public.opportunities drop constraint owner_matches_stage;
alter table public.opportunities add constraint owner_matches_stage check (
  (stage = 'available' and owner_id is null)
  or (stage in ('claimed', 'researching', 'contact_confirmed', 'contacted', 'qualified', 'drawings_requested', 'site_visit', 'quote_needed', 'quote_prep', 'quote_sent', 'follow_up') and owner_id is not null)
  or stage in ('won', 'lost', 'nurture', 'disqualified', 'archived', 'cancelled'));

create trigger opportunities_next_task after insert or update of next_action, next_action_due, stage, owner_id on public.opportunities
  for each row execute function private.mirror_next_action();
-- existing next steps become tasks once (no notifications, no changes to the leads)
update public.opportunities set next_action = next_action where stage = any(private.active_stages()) and (next_action is not null or next_action_due is not null) and owner_id is not null;

-- every function that lists active stages learns the new ones; log_activity also treats Cancelled as a closing outcome
do $$
declare f record; d text; n int := 0;
begin
  for f in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname in ('public', 'private') and p.prokind = 'f' and p.proname <> 'active_stages'
              and pg_get_functiondef(p.oid) ~ '''qualified'',\s*''quote_needed''' loop
    d := regexp_replace(pg_get_functiondef(f.oid), '''qualified'',\s*''quote_needed''',
      '''contact_confirmed'', ''qualified'', ''drawings_requested'', ''site_visit'', ''quote_needed'', ''quote_prep''', 'g');
    execute d; n := n + 1;
  end loop;
  select pg_get_functiondef('public.log_activity(uuid, jsonb)'::regprocedure) into d;
  d := replace(d, $q$o.stage in ('claimed','researching','contacted','qualified','follow_up')$q$,
                  $q$o.stage in ('claimed','researching','contact_confirmed','contacted','qualified','drawings_requested','site_visit','follow_up')$q$);
  d := replace(d, $q$elsif o.stage in ('claimed','researching') and$q$, $q$elsif o.stage in ('claimed','researching','contact_confirmed') and$q$);
  d := replace(d, $q$if v_stage in ('won','lost','disqualified') and$q$, $q$if v_stage in ('won','lost','disqualified','cancelled') and$q$);
  d := replace(d, $q$n.closed_at := case when v_stage in ('won','lost','disqualified','archived')$q$, $q$n.closed_at := case when v_stage in ('won','lost','disqualified','archived','cancelled')$q$);
  execute d;
  raise notice 'stage lists updated in % functions plus log_activity', n;
end $$;

-- ---------------------------------------------------------------- user-facing actions
create or replace function public.services_catalog() returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active();
  return jsonb_build_object('services', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'name', name, 'description', description, 'active', active,
      'fields', request_fields, 'discovery_name', discovery_name) order by sort, name) from public.services where workspace_id = private.current_ws()), '[]'),
    'units', (select jsonb_object_agg(key, jsonb_build_object('dimension', dimension, 'label', label)) from public.units));
end $$;

create or replace function public.save_service(p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ws uuid := private.current_ws(); v_key text := lower(regexp_replace(coalesce(p->>'key', p->>'name', ''), '[^a-zA-Z0-9]+', '_', 'g'));
begin
  perform private.require_active();
  if not private.is_member(v_ws, array['owner', 'manager']) then raise exception 'workspace_manager_only' using errcode = '42501'; end if;
  if v_key = '' or nullif(trim(p->>'name'), '') is null then raise exception 'name_required' using errcode = '22023'; end if;
  if p ? 'fields' and jsonb_typeof(p->'fields') <> 'array' then raise exception 'bad_fields' using errcode = '22023'; end if;
  insert into public.services (workspace_id, key, name, description, active, sort, request_fields, discovery_name)
  values (v_ws, v_key, trim(p->>'name'), coalesce(p->>'description', ''), coalesce((p->>'active')::boolean, true), coalesce((p->>'sort')::int, 100),
          coalesce(p->'fields', '[]'), nullif(p->>'discovery_name', ''))
  on conflict (workspace_id, key) do update set name = excluded.name, description = excluded.description, active = excluded.active,
    sort = excluded.sort, request_fields = case when p ? 'fields' then excluded.request_fields else public.services.request_fields end,
    discovery_name = coalesce(excluded.discovery_name, public.services.discovery_name);
  return public.services_catalog();
end $$;

-- tasks: list mine (or the team's for managers), create, complete. Completing the mirrored "next step" of an active lead
-- needs the next step or an explicit reason why nothing is scheduled.
create or replace function public.task_list(p jsonb default '{}') returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); v_scope text := coalesce(p->>'scope', 'mine'); v_now timestamptz := now();
begin
  if v_scope = 'team' and me.role <> 'manager' then raise exception 'manager_only' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by x->>'sort_due', x->>'created_at') from (
    select jsonb_build_object('id', t.id, 'title', t.title, 'kind', t.kind, 'notes', t.notes, 'due_at', t.due_at, 'status', t.status, 'origin', t.origin,
      'overdue', t.status = 'open' and t.due_at < v_now, 'sort_due', coalesce(t.due_at, 'infinity'::timestamptz)::text, 'created_at', t.created_at,
      'assigned_to', t.assigned_to, 'assignee', (select full_name from public.profiles where id = t.assigned_to),
      'opportunity', case when o.id is not null then jsonb_build_object('id', o.id, 'ref', o.ref, 'title', o.title, 'stage', o.stage) end,
      'company', case when c.id is not null then jsonb_build_object('id', c.id, 'name', c.name) end,
      'contact', case when k.id is not null then jsonb_build_object('id', k.id, 'name', k.name, 'phone', case when k.do_not_contact then null else k.phone end,
        'email', case when k.do_not_contact or k.email_is_guess then null else k.email end, 'do_not_contact', k.do_not_contact) end) x
    from private.v_tasks t
    left join private.v_opportunities o on o.id = t.opportunity_id
    left join public.companies c on c.id = coalesce(t.company_id, o.company_id)
    left join private.v_contacts k on k.id = t.contact_id
    where (case when p->>'status' = 'done' then t.status = 'done' and t.completed_at > v_now - interval '14 days' else t.status = 'open' end)
      and (v_scope = 'team' or t.assigned_to = me.id or (t.assigned_to is null and t.created_by = me.id))
      and (p->>'opportunity_id' is null or t.opportunity_id = (p->>'opportunity_id')::uuid)
    limit 500) s), '[]');
end $$;

create or replace function public.save_task(p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); o public.opportunities; v_id uuid := nullif(p->>'id', '')::uuid; t public.tasks;
  v_due timestamptz := coalesce(nullif(p->>'due_at', '')::timestamptz, private.due_at_et(nullif(p->>'due_date', '')::date));
begin
  if nullif(trim(coalesce(p->>'title', '')), '') is null and v_id is null then raise exception 'title_required' using errcode = '22023'; end if;
  if p->>'opportunity_id' is not null then
    select * into o from private.v_opportunities where id = (p->>'opportunity_id')::uuid;
    if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
    if o.owner_id is distinct from me.id and me.role <> 'manager' then raise exception 'not_owner' using errcode = '42501'; end if;
  end if;
  if v_id is null then
    insert into private.v_tasks (opportunity_id, company_id, contact_id, kind, title, notes, due_at, assigned_to, created_by)
    values (o.id, coalesce(nullif(p->>'company_id', '')::uuid, o.company_id), nullif(p->>'contact_id', '')::uuid, coalesce(nullif(p->>'kind', ''), 'follow_up'),
            trim(p->>'title'), nullif(p->>'notes', ''), v_due, coalesce(nullif(p->>'assigned_to', '')::uuid, o.owner_id, me.id), me.id)
    returning * into t;
  else
    update private.v_tasks set title = coalesce(nullif(trim(p->>'title'), ''), title), notes = case when p ? 'notes' then nullif(p->>'notes', '') else notes end,
      due_at = case when p ? 'due_at' or p ? 'due_date' then v_due else due_at end, kind = coalesce(nullif(p->>'kind', ''), kind), updated_at = now()
     where id = v_id and status = 'open' and (assigned_to = me.id or created_by = me.id or me.role = 'manager') returning * into t;
    if t.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  end if;
  return jsonb_build_object('ok', true, 'id', t.id);
end $$;

create or replace function public.complete_task(p_id uuid, p jsonb default '{}') returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); t public.tasks; o public.opportunities; v_next text := nullif(trim(coalesce(p->>'next_action', '')), '');
  v_next_due date := nullif(p->>'next_action_due', '')::date; v_reason text := nullif(trim(coalesce(p->>'no_action_reason', '')), '');
begin
  select * into t from private.v_tasks where id = p_id for update;
  if t.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if t.status <> 'open' then return jsonb_build_object('ok', false, 'reason', 'already_closed'); end if;
  if t.assigned_to is distinct from me.id and t.created_by is distinct from me.id and me.role <> 'manager' then raise exception 'not_owner' using errcode = '42501'; end if;
  if t.opportunity_id is not null then select * into o from private.v_opportunities where id = t.opportunity_id; end if;
  -- the lead's own next step: replace it or say why nothing is scheduled
  if t.origin = 'next_action' and o.id is not null and o.stage = any(private.active_stages()) and v_next is null and v_reason is null then
    raise exception 'next_step_required' using errcode = '22023', hint = 'Set the next step and date, or say why nothing is scheduled.';
  end if;
  update public.tasks set status = coalesce(nullif(p->>'status', ''), 'done'), outcome = nullif(trim(coalesce(p->>'outcome', '')), ''),
    completed_at = now(), completed_by = me.id, updated_at = now(), dedupe_key = case when origin = 'next_action' then null else dedupe_key end
   where id = t.id;
  if t.status = 'open' and o.id is not null then
    insert into public.activities (opportunity_id, company_id, user_id, kind, body, data)
    values (o.id, o.company_id, me.id, 'follow_up', concat_ws(': ', 'Done: ' || t.title, nullif(trim(coalesce(p->>'outcome', '')), '')), jsonb_build_object('task', t.id));
    if t.origin = 'next_action' then
      update public.opportunities set next_action = v_next, next_action_due = v_next_due, no_action_reason = case when v_next is null then v_reason end,
        last_activity_at = now(), last_activity_by = me.id, last_activity_summary = 'Task done: ' || t.title
       where id = o.id;
    else
      update public.opportunities set last_activity_at = now(), last_activity_by = me.id, last_activity_summary = 'Task done: ' || t.title where id = o.id;
    end if;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- contact details with where each came from; guessed emails are kept apart and never shown as verified; do-not-contact
-- suppresses phone and email everywhere the app offers them
create or replace function public.save_contact_details(p_id uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); k public.contacts;
begin
  select * into k from private.v_contacts where id = p_id for update;
  if k.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p ? 'verification' and p->>'verification' not in ('user_confirmed', 'unverified') then raise exception 'bad_verification' using errcode = '22023',
    hint = 'Published is set only from a source document.'; end if;
  update public.contacts set
    buying_role = case when p ? 'buying_role' then nullif(p->>'buying_role', '') else buying_role end,
    verification = case when p->>'verification' = 'user_confirmed' then 'user_confirmed' when p->>'verification' = 'unverified' and verification <> 'published' then 'unverified' else verification end,
    phone_verified_at = case when (p->>'phone_confirmed')::boolean then now() else phone_verified_at end,
    phone_source = case when (p->>'phone_confirmed')::boolean then 'confirmed by ' || coalesce(me.full_name, 'user') else phone_source end,
    email_verified_at = case when (p->>'email_confirmed')::boolean then now() else email_verified_at end,
    email_source = case when (p->>'email_confirmed')::boolean then 'confirmed by ' || coalesce(me.full_name, 'user') else email_source end,
    email_is_guess = case when (p->>'email_confirmed')::boolean then false when p ? 'email_is_guess' then (p->>'email_is_guess')::boolean else email_is_guess end,
    do_not_contact = coalesce((p->>'do_not_contact')::boolean, do_not_contact),
    do_not_contact_reason = case when (p->>'do_not_contact')::boolean then coalesce(nullif(trim(p->>'do_not_contact_reason'), ''), do_not_contact_reason)
                                 when (p->>'do_not_contact')::boolean is false then null else do_not_contact_reason end,
    do_not_contact_at = case when (p->>'do_not_contact')::boolean and not do_not_contact then now() when (p->>'do_not_contact')::boolean is false then null else do_not_contact_at end,
    updated_at = now()
  where id = k.id;
  if (p->>'do_not_contact')::boolean is distinct from k.do_not_contact and p ? 'do_not_contact' then
    insert into public.activities (company_id, contact_id, user_id, kind, body, data)
    values (k.company_id, k.id, me.id, 'contact', case when (p->>'do_not_contact')::boolean then 'Marked do not contact' else 'Do not contact removed' end,
            jsonb_build_object('reason', p->>'do_not_contact_reason'));
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.save_company_account(p_company uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); v_ws uuid := private.current_ws();
begin
  if not exists (select 1 from public.companies where id = p_company) then raise exception 'not_found' using errcode = 'P0002'; end if;
  insert into public.company_accounts (workspace_id, company_id, updated_by) values (v_ws, p_company, me.id) on conflict do nothing;
  update public.company_accounts set
    relationship = coalesce(nullif(p->>'relationship', ''), relationship),
    vendor_status = coalesce(nullif(p->>'vendor_status', ''), vendor_status),
    vendor_requirements = case when p ? 'vendor_requirements' then nullif(trim(p->>'vendor_requirements'), '') else vendor_requirements end,
    vendor_updated_at = case when p ? 'vendor_status' or p ? 'vendor_requirements' then now() else vendor_updated_at end,
    do_not_contact = coalesce((p->>'do_not_contact')::boolean, do_not_contact),
    do_not_contact_reason = case when p ? 'do_not_contact_reason' then nullif(trim(p->>'do_not_contact_reason'), '') else do_not_contact_reason end,
    do_not_contact_at = case when (p->>'do_not_contact')::boolean and not do_not_contact then now() when (p->>'do_not_contact')::boolean is false then null else do_not_contact_at end,
    notes = case when p ? 'notes' then nullif(p->>'notes', '') else notes end,
    updated_at = now(), updated_by = me.id
  where workspace_id = v_ws and company_id = p_company;
  if p ? 'kind' then update public.companies set kind = p->>'kind', updated_at = now() where id = p_company; end if;
  if p ? 'service_area' then update public.companies set service_area = nullif(trim(p->>'service_area'), ''), updated_at = now() where id = p_company; end if;
  return (select to_jsonb(a) from public.company_accounts a where workspace_id = v_ws and company_id = p_company);
end $$;

create or replace function public.project_participants(p_project uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active();
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'role', x.role, 'rank', x.rank, 'amount', x.amount, 'status', x.status,
      'company_id', x.company_id, 'phone', x.phone, 'email', x.email, 'source_name', x.source_name, 'source_url', x.source_url, 'as_of', x.as_of,
      'current', x.current, 'origin', x.origin,
      'our_lead', (select jsonb_build_object('id', o.id, 'ref', o.ref, 'stage', o.stage) from private.v_opportunities o
                    where o.project_id = x.project_id and o.company_id = x.company_id and x.company_id is not null and o.stage <> 'archived' limit 1))
      order by case x.role when 'awarded_contractor' then 1 when 'intended_awardee' then 2 when 'low_bidder' then 3 when 'bidder' then 4 when 'owner' then 5 else 6 end,
               x.rank nulls last, x.name)
    from public.project_participants x where x.project_id = p_project), '[]');
end $$;

revoke all on function public.services_catalog(), public.save_service(jsonb), public.task_list(jsonb), public.save_task(jsonb), public.complete_task(uuid, jsonb),
  public.save_contact_details(uuid, jsonb), public.save_company_account(uuid, jsonb), public.project_participants(uuid) from public, anon;
grant execute on function public.services_catalog(), public.save_service(jsonb), public.task_list(jsonb), public.save_task(jsonb), public.complete_task(uuid, jsonb),
  public.save_contact_details(uuid, jsonb), public.save_company_account(uuid, jsonb), public.project_participants(uuid) to authenticated;
