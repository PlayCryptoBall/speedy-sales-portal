-- Workspaces: a workspace is a company the user sells for (its branding, services, territories and pricing), or a private
-- prospecting space. Public intelligence (sources, projects, the company directory) stays shared reference data. Pursuit
-- records (opportunities, activities, contacts people add) carry workspace_id and are visible only inside the caller's
-- current workspace, which must be one they belong to. Enforced in the database: user-facing functions read and write
-- pursuit tables through private.v_* views filtered by membership. Scheduled jobs (no signed-in user) see everything.
-- Reversible: see the down section at the end (kept commented).

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'company' check (kind in ('company', 'personal')),
  owner_id uuid references public.profiles(id),
  branding jsonb not null default '{}',      -- {display_name, short_name, logo_url, phone, email, website, accent}
  service_area jsonb not null default '{}',  -- {home_offices:[{name, county}], counties:[...], regions:[...]}
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index workspaces_one_default on public.workspaces (is_default) where is_default;
create unique index workspaces_one_personal on public.workspaces (owner_id) where kind = 'personal';
alter table public.workspaces enable row level security;

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'manager', 'member')),
  added_at timestamptz not null default now(),
  added_by uuid references public.profiles(id),
  primary key (workspace_id, user_id)
);
alter table public.workspace_members enable row level security;

alter table public.profiles add column current_workspace_id uuid references public.workspaces(id);

-- the shared company workspace every existing record belongs to
insert into public.workspaces (name, kind, is_default, branding, service_area)
values ('Speedy Concrete Cutting', 'company', true,
  '{"display_name": "Speedy Concrete Cutting", "short_name": "Speedy", "product_name": "Sales Portal"}',
  '{"home_offices": [{"name": "Orlando", "county": "Orange"}, {"name": "Tampa", "county": "Hillsborough"}, {"name": "Fort Lauderdale", "county": "Broward"}, {"name": "Jacksonville", "county": "Duval"}],
    "primary_region": "Central FL"}');
insert into public.workspace_members (workspace_id, user_id, role)
select w.id, p.id, case when p.role = 'manager' then 'manager' else 'member' end
from public.workspaces w cross join public.profiles p where w.is_default;

-- ---------------------------------------------------------------- membership helpers
create or replace function private.default_ws() returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.workspaces where is_default limit 1 $$;

-- the caller's current workspace: their chosen one if they still belong to it, else the shared default if they belong to it
create or replace function private.current_ws() returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p.current_workspace_id from public.profiles p join public.workspace_members m on m.workspace_id = p.current_workspace_id and m.user_id = p.id
      where p.id = auth.uid()),
    (select m.workspace_id from public.workspace_members m where m.user_id = auth.uid() and m.workspace_id = private.default_ws()),
    (select m.workspace_id from public.workspace_members m where m.user_id = auth.uid() order by m.added_at limit 1),
    case when auth.uid() is null then private.default_ws() end) $$;

-- may the caller see a pursuit row of this workspace? Jobs with no signed-in user see all.
create or replace function private.ws_ok(p_ws uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is null or (p_ws is not null and p_ws = private.current_ws()) $$;

create or replace function private.is_member(p_ws uuid, p_roles text[] default null) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members where workspace_id = p_ws and user_id = auth.uid() and (p_roles is null or role = any(p_roles))) $$;

-- ---------------------------------------------------------------- scope pursuit tables
alter table public.opportunities add column workspace_id uuid references public.workspaces(id);
update public.opportunities set workspace_id = private.default_ws();
alter table public.opportunities alter column workspace_id set default private.current_ws(), alter column workspace_id set not null;
create index opportunities_ws on public.opportunities (workspace_id);

alter table public.activities add column workspace_id uuid references public.workspaces(id);
update public.activities a set workspace_id = coalesce((select o.workspace_id from public.opportunities o where o.id = a.opportunity_id), private.default_ws());
alter table public.activities alter column workspace_id set default private.current_ws(), alter column workspace_id set not null;
create index activities_ws on public.activities (workspace_id);
-- an activity on a lead always belongs to the lead's workspace
create or replace function private.activity_ws() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.opportunity_id is not null then
    select workspace_id into new.workspace_id from public.opportunities where id = new.opportunity_id;
  end if;
  if new.workspace_id is null then new.workspace_id := private.current_ws(); end if;
  return new;
end $$;
create trigger activities_ws before insert on public.activities for each row execute function private.activity_ws();

-- contacts: null workspace = taken from a public record (shared); otherwise added inside a workspace and private to it
alter table public.contacts add column workspace_id uuid references public.workspaces(id);
update public.contacts set workspace_id = private.default_ws() where source not in ('source_document', 'refresh');
alter table public.contacts alter column workspace_id set default private.current_ws();
create index contacts_ws on public.contacts (workspace_id);

alter table public.ownership_history add column if not exists workspace_id uuid references public.workspaces(id);
update public.ownership_history h set workspace_id = (select workspace_id from public.opportunities o where o.id = h.opportunity_id);

create view private.v_opportunities as select * from public.opportunities where private.ws_ok(workspace_id);
create view private.v_activities as select * from public.activities where private.ws_ok(workspace_id);
create view private.v_contacts as select * from public.contacts where workspace_id is null or private.ws_ok(workspace_id);
-- base-table defaults and the activity trigger apply to inserts through these views
alter view private.v_opportunities alter column workspace_id set default private.current_ws();
alter view private.v_activities alter column workspace_id set default private.current_ws();
alter view private.v_contacts alter column workspace_id set default private.current_ws();

-- ---------------------------------------------------------------- route user-facing functions through the views
-- Rewrites the live definitions of every database function except the refresh entry points (service role only) and the
-- workspace helpers above. With no signed-in user (scheduled jobs, refresh) the views return every row, so jobs behave as
-- before; for a signed-in person they return only the current workspace. Function bodies are otherwise unchanged.
-- Rule for later migrations: user-facing code reads and writes pursuit rows through private.v_* (see docs/PROGRESS.md).
do $$
declare f record; d text; n int := 0;
begin
  for f in
    select p.oid, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname in ('public', 'private') and p.prokind = 'f'
      and not (s.nspname = 'public' and p.proname like 'refresh\_%')
      and p.proname not in ('activity_ws', 'profile_join_default', 'current_ws', 'ws_ok', 'default_ws', 'is_member')
      and pg_get_functiondef(p.oid) ~ 'public\.(opportunities|activities|contacts)\M'
  loop
    d := pg_get_functiondef(f.oid);
    d := regexp_replace(d, 'public\.opportunities\M', 'private.v_opportunities', 'g');
    d := regexp_replace(d, 'public\.activities\M', 'private.v_activities', 'g');
    d := regexp_replace(d, 'public\.contacts\M', 'private.v_contacts', 'g');
    execute d;
    n := n + 1;
  end loop;
  raise notice 'routed % functions through workspace views', n;
end $$;

-- ---------------------------------------------------------------- workspace actions
create or replace function public.my_workspaces() returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active();
  return jsonb_build_object('current', private.current_ws(), 'items', coalesce((
    select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'kind', w.kind, 'role', m.role, 'branding', w.branding,
        'service_area', w.service_area, 'is_default', w.is_default,
        'members', (select count(*) from public.workspace_members x where x.workspace_id = w.id),
        'leads', (select count(*) from public.opportunities o where o.workspace_id = w.id and o.stage <> 'archived'))
      order by w.is_default desc, w.kind, w.name)
    from public.workspaces w join public.workspace_members m on m.workspace_id = w.id and m.user_id = auth.uid()), '[]'));
end $$;

create or replace function public.set_workspace(p_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active();
  if not private.is_member(p_id) then raise exception 'not_a_member' using errcode = '42501'; end if;
  update public.profiles set current_workspace_id = p_id where id = auth.uid();
  return public.my_workspaces();
end $$;

-- every active person gets one private prospecting workspace; called by the app at sign-in
create or replace function public.ensure_personal_workspace() returns jsonb language plpgsql security definer set search_path = '' as $$
declare v uuid; v_name text;
begin
  perform private.require_active();
  select id into v from public.workspaces where owner_id = auth.uid() and kind = 'personal';
  if v is null then
    select coalesce(nullif(split_part(full_name, ' ', 1), ''), 'My') || '''s prospecting' into v_name from public.profiles where id = auth.uid();
    insert into public.workspaces (name, kind, owner_id, branding) values (v_name, 'personal', auth.uid(), jsonb_build_object('display_name', v_name))
    returning id into v;
    insert into public.workspace_members (workspace_id, user_id, role, added_by) values (v, auth.uid(), 'owner', auth.uid());
  end if;
  return public.my_workspaces();
end $$;

-- branding, services offered and territory are per workspace; owners and managers of the workspace may change them
create or replace function public.update_workspace(p_id uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active();
  if not private.is_member(p_id, array['owner', 'manager']) then raise exception 'workspace_manager_only' using errcode = '42501'; end if;
  update public.workspaces set
    name = coalesce(nullif(trim(p->>'name'), ''), name),
    branding = case when p ? 'branding' then branding || (p->'branding') else branding end,
    service_area = case when p ? 'service_area' then p->'service_area' else service_area end,
    updated_at = now()
  where id = p_id;
  return public.my_workspaces();
end $$;

-- membership is changed on purpose and recorded: only the workspace's owner or manager, never a personal workspace
create or replace function public.set_workspace_member(p_ws uuid, p_user uuid, p_role text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.workspaces;
begin
  perform private.require_active();
  select * into v from public.workspaces where id = p_ws;
  if v.id is null then raise exception 'not_found'; end if;
  if v.kind = 'personal' then raise exception 'personal_workspace_is_private' using errcode = '42501'; end if;
  if not private.is_member(p_ws, array['owner', 'manager']) then raise exception 'workspace_manager_only' using errcode = '42501'; end if;
  if p_role is null then
    delete from public.workspace_members where workspace_id = p_ws and user_id = p_user and role <> 'owner';
  else
    if p_role not in ('manager', 'member') then raise exception 'bad_role'; end if;
    insert into public.workspace_members (workspace_id, user_id, role, added_by) values (p_ws, p_user, p_role, auth.uid())
    on conflict (workspace_id, user_id) do update set role = excluded.role;
  end if;
  insert into public.activities (workspace_id, user_id, kind, body, data)
  values (p_ws, auth.uid(), 'system', case when p_role is null then 'Removed a member from the workspace' else 'Workspace membership set to ' || p_role end,
    jsonb_build_object('member', p_user, 'role', p_role));
  return jsonb_build_object('ok', true);
end $$;

-- new active profiles join the shared default workspace (the existing behaviour: the team shares one pool)
create or replace function private.profile_join_default() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.active and private.default_ws() is not null then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (private.default_ws(), new.id, case when new.role = 'manager' then 'manager' else 'member' end)
    on conflict do nothing;
  end if;
  return new;
end $$;
create trigger profiles_join_default after insert or update of active on public.profiles for each row execute function private.profile_join_default();

revoke all on function public.my_workspaces(), public.set_workspace(uuid), public.ensure_personal_workspace(), public.update_workspace(uuid, jsonb),
  public.set_workspace_member(uuid, uuid, text) from public, anon;
grant execute on function public.my_workspaces(), public.set_workspace(uuid), public.ensure_personal_workspace(), public.update_workspace(uuid, jsonb),
  public.set_workspace_member(uuid, uuid, text) to authenticated;

-- down (manual, after restoring function definitions from backup_20261122 or by re-running migrations 001-028):
--   drop trigger profiles_join_default on public.profiles; drop trigger activities_ws on public.activities;
--   drop view private.v_opportunities, private.v_activities, private.v_contacts;
--   alter table public.opportunities drop column workspace_id; alter table public.activities drop column workspace_id;
--   alter table public.contacts drop column workspace_id; alter table public.ownership_history drop column workspace_id;
--   alter table public.profiles drop column current_workspace_id; drop table public.workspace_members, public.workspaces;
