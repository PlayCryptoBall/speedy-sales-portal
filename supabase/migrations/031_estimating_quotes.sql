-- Estimate requests and quotes.
-- An estimate request is what a contractor asked for (their quantities, their conditions). It is not an estimate, a
-- booking or an engineering assessment. Quotes are versioned; a version is frozen once approved and sent; prices come
-- from approved pricing rules or from rates a person typed and is accountable for (marked manual). Nothing here invents
-- a rate or derives cutting revenue from a project budget.

alter table public.workspaces add column if not exists settings jsonb not null default '{}';  -- {intake_owner, quote_valid_days, quote_terms}

-- a new workspace starts with the default workspace's service catalog (editable afterwards); prices are never copied
create or replace function private.workspace_seed_services() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.services (workspace_id, key, name, description, active, sort, request_fields, discovery_name)
  select new.id, key, name, description, active, sort, request_fields, discovery_name from public.services where workspace_id = private.default_ws() and new.id <> private.default_ws()
  on conflict do nothing;
  return null;
end $$;
create trigger workspaces_seed_services after insert on public.workspaces for each row execute function private.workspace_seed_services();
insert into public.services (workspace_id, key, name, description, active, sort, request_fields, discovery_name)
select w.id, s.key, s.name, s.description, s.active, s.sort, s.request_fields, s.discovery_name
from public.workspaces w cross join public.services s where s.workspace_id = private.default_ws() and w.id <> private.default_ws()
on conflict do nothing;

-- ---------------------------------------------------------------- pricing rules (empty until someone with authority approves them)
create table public.pricing_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default private.current_ws() references public.workspaces(id) on delete cascade,
  service_key text not null,
  kind text not null default 'work' check (kind in ('work', 'mobilization', 'minimum_charge', 'after_hours', 'access', 'scanning', 'removal', 'disposal', 'other')),
  description text not null,
  unit text not null references public.units(key),
  rate numeric not null check (rate >= 0),
  conditions text,                          -- when the rule applies (thickness range, hours, access), in words
  status text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  effective_from date not null default current_date,
  effective_to date,
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.pricing_rules enable row level security;
create view private.v_pricing_rules as select * from public.pricing_rules where private.ws_ok(workspace_id);

-- ---------------------------------------------------------------- estimate requests
create sequence public.er_ref_seq start 1001;
alter table public.contacts drop constraint if exists contacts_source_check;
alter table public.contacts add constraint contacts_source_check check (source in ('research', 'source_document', 'salesperson', 'import', 'refresh', 'estimate_request'));
alter table public.opportunities drop constraint if exists opportunities_kind_check;
alter table public.opportunities add constraint opportunities_kind_check check (kind in ('gov_bid', 'contractor_outreach', 'private_project', 'relationship', 'inbound_request'));
insert into public.sources (id, name, url, kind, category, method, geography, project_types, counties, coverage, schedule_note, access_notes, config)
values ('estimate_requests', 'Estimate requests', null, 'manual', 'Internal', 'Submitted by contractors through the estimate request app or entered by hand',
        'Where customers send work', 'Any', null, 'Inbound requests for pricing', 'As received', 'Contractor-supplied; quantities are theirs until verified.', '{}')
on conflict (id) do nothing;

create table public.estimate_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default private.current_ws() references public.workspaces(id) on delete cascade,
  ref text not null unique default ('ER-' || nextval('public.er_ref_seq')),
  source text not null default 'manual' check (source in ('estimate_app', 'manual', 'fixture')),
  is_fixture boolean not null default false,          -- test data from the integration fixtures; never counted as real work
  idempotency_key text,
  external_id text,
  received_at timestamptz not null default now(),
  submitted jsonb not null default '{}',              -- the payload exactly as received (untrusted data, never executed or followed)
  company_id uuid references public.companies(id),
  contact_id uuid references public.contacts(id),
  opportunity_id uuid references public.opportunities(id),
  project_id uuid references public.projects(id),
  company_name text, contact_name text, contact_phone text, contact_email text,
  job_address text, job_city text, job_county text,
  site_contact jsonb,                                  -- {name, phone}
  requested_date date, requested_date_flexible boolean,
  working_hours text check (working_hours in ('normal', 'nights', 'weekends', 'any', 'unknown')),
  access_notes text, work_area text,
  power_available text check (power_available in ('yes', 'no', 'unknown')),
  water_available text check (water_available in ('yes', 'no', 'unknown')),
  removal_required text check (removal_required in ('yes', 'no', 'unknown')),
  disposal_notes text,
  notes text,
  missing jsonb not null default '[]',                 -- [{scope, field, label}] what is needed before pricing
  status text not null default 'new' check (status in ('new', 'missing_info', 'ready', 'estimating', 'quoted', 'declined', 'duplicate')),
  status_note text,
  task_id uuid references public.tasks(id),
  created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
create unique index estimate_requests_idem on public.estimate_requests (workspace_id, idempotency_key) where idempotency_key is not null;
alter table public.estimate_requests enable row level security;
create view private.v_estimate_requests as select * from public.estimate_requests where private.ws_ok(workspace_id);

create table public.estimate_request_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.estimate_requests(id) on delete cascade,
  service_key text not null,
  service_name text not null,
  answers jsonb not null default '{}',     -- {field_key: {value, unit}} for measured fields, {field_key: value} for choices, text and yes/no
  normalized jsonb not null default '{}',  -- measured fields converted to base units, kept beside the original answer
  notes text,
  missing jsonb not null default '[]',
  sort int not null default 0
);
alter table public.estimate_request_items enable row level security;

-- validates one service's answers against its field definitions. Measured answers need a value and a unit the field allows.
create or replace function private.check_answers(p_fields jsonb, p_answers jsonb, out normalized jsonb, out missing jsonb) language plpgsql stable set search_path = '' as $$
declare f jsonb; a jsonb; v numeric; u text; dim text; base numeric;
begin
  normalized := '{}'; missing := '[]';
  for f in select * from jsonb_array_elements(coalesce(p_fields, '[]')) loop
    a := p_answers -> (f->>'key');
    dim := f->>'dimension';
    if dim in ('length', 'area', 'volume', 'count', 'thickness', 'diameter', 'depth', 'time') then
      if a is not null and a <> 'null'::jsonb and jsonb_typeof(a) <> 'object' then
        raise exception 'unit_required' using errcode = '22023', hint = format('%s needs a value and a unit, not a bare number.', f->>'label');
      end if;
      if a is null or a = 'null'::jsonb or nullif(a->>'value', '') is null then
        if (f->>'required')::boolean then missing := missing || jsonb_build_array(jsonb_build_object('field', f->>'key', 'label', f->>'label')); end if;
        continue;
      end if;
      begin v := (a->>'value')::numeric; exception when others then raise exception 'bad_number' using errcode = '22023', hint = format('%s is not a number.', f->>'label'); end;
      if v < 0 then raise exception 'bad_number' using errcode = '22023', hint = format('%s cannot be negative.', f->>'label'); end if;
      u := a->>'unit';
      if u is null then raise exception 'unit_required' using errcode = '22023', hint = format('%s needs a unit.', f->>'label'); end if;
      if not (f->'units') ? u then raise exception 'bad_unit' using errcode = '22023', hint = format('%s must be in %s, not %s.', f->>'label', (select string_agg(x, ', ') from jsonb_array_elements_text(f->'units') x), u); end if;
      select to_base into base from public.units where key = u;
      normalized := normalized || jsonb_build_object(f->>'key', jsonb_build_object('value', v, 'unit', u,
        'base_value', case when base is not null then round(v * base, 4) end,
        'base_unit', case (select dimension from public.units where key = u) when 'length' then 'in' when 'area' then 'sq_ft' when 'volume' then 'cu_yd' when 'count' then 'ea' when 'time' then 'hr' end));
    elsif (f->>'required')::boolean and (a is null or a = 'null'::jsonb or coalesce(a #>> '{}', '') = '') then
      missing := missing || jsonb_build_array(jsonb_build_object('field', f->>'key', 'label', f->>'label'));
    end if;
  end loop;
end $$;

-- the shared core of intake (app, manual entry, fixtures). Idempotent by (workspace, idempotency key).
create or replace function private.submit_estimate_request(p_ws uuid, p jsonb, p_source text, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.estimate_requests; v_key text := nullif(trim(coalesce(p->>'idempotency_key', '')), '');
  v_company uuid; v_contact uuid; v_co_name text := nullif(trim(coalesce(p #>> '{company,name}', '')), '');
  v_phone text := nullif(trim(coalesce(p #>> '{contact,phone}', '')), ''); v_email text := lower(nullif(trim(coalesce(p #>> '{contact,email}', '')), ''));
  v_cname text := nullif(trim(coalesce(p #>> '{contact,name}', '')), '');
  it jsonb; svc public.services; chk record; v_missing jsonb := '[]'; v_items int := 0; v_owner uuid; v_project uuid; v_opp uuid; v_task uuid; i int := 0;
begin
  if p_ws is null or not exists (select 1 from public.workspaces where id = p_ws) then raise exception 'bad_workspace' using errcode = '22023'; end if;
  if v_key is not null then
    select * into r from public.estimate_requests where workspace_id = p_ws and idempotency_key = v_key;
    if r.id is not null then return jsonb_build_object('ok', true, 'duplicate', true, 'id', r.id, 'ref', r.ref, 'status', r.status, 'missing', r.missing); end if;
  end if;
  if v_co_name is null then raise exception 'company_required' using errcode = '22023', hint = 'The contractor company name is required.'; end if;
  if jsonb_typeof(coalesce(p->'items', '[]')) <> 'array' or jsonb_array_length(coalesce(p->'items', '[]')) = 0 then
    raise exception 'service_required' using errcode = '22023', hint = 'Choose at least one service.'; end if;
  if jsonb_array_length(p->'items') > 20 then raise exception 'too_many_items' using errcode = '22023'; end if;
  if length(p::text) > 200000 then raise exception 'too_large' using errcode = '22001'; end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email' using errcode = '22023'; end if;

  -- company: match by normalized name, else create (marked from an estimate request)
  select id into v_company from public.companies where name_key = private.norm_key(v_co_name);
  if v_company is null then
    insert into public.companies (name, name_key, kind, phone, notes) values (v_co_name, private.norm_key(v_co_name), 'contractor', v_phone, 'Created from an estimate request')
    returning id into v_company;
  end if;
  -- contact: match by email, then phone, within the company and workspace; else create, unverified, details from the submitter
  if v_email is not null or v_phone is not null or v_cname is not null then
    select id into v_contact from public.contacts where company_id = v_company and (workspace_id = p_ws or workspace_id is null) and not archived
      and ((v_email is not null and lower(email) = v_email) or (v_phone is not null and regexp_replace(phone, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g')))
      order by (lower(email) = v_email) desc nulls last limit 1;
    if v_contact is null then
      insert into public.contacts (workspace_id, company_id, name, title, phone, email, source, verification, phone_source, email_source)
      values (p_ws, v_company, coalesce(v_cname, 'Contact from estimate request'), nullif(p #>> '{contact,title}', ''), v_phone, v_email, 'estimate_request', 'unverified',
              case when v_phone is not null then 'given by the requester' end, case when v_email is not null then 'given by the requester' end)
      returning id into v_contact;
    end if;
  end if;

  insert into public.estimate_requests (workspace_id, source, is_fixture, idempotency_key, external_id, submitted, company_id, contact_id,
    company_name, contact_name, contact_phone, contact_email, job_address, job_city, job_county, site_contact, requested_date, requested_date_flexible,
    working_hours, access_notes, work_area, power_available, water_available, removal_required, disposal_notes, notes, created_by)
  values (p_ws, p_source, p_source = 'fixture' or coalesce((p->>'is_fixture')::boolean, false), v_key, nullif(p->>'external_id', ''), p, v_company, v_contact,
    v_co_name, v_cname, v_phone, v_email, nullif(trim(p #>> '{job,address}'), ''), nullif(trim(p #>> '{job,city}'), ''), nullif(trim(p #>> '{job,county}'), ''),
    case when p #> '{job,site_contact}' is not null then p #> '{job,site_contact}' end,
    nullif(p #>> '{job,requested_date}', '')::date, (p #>> '{job,requested_date_flexible}')::boolean,
    coalesce(nullif(p #>> '{conditions,working_hours}', ''), 'unknown'), nullif(p #>> '{conditions,access}', ''), nullif(p #>> '{conditions,work_area}', ''),
    coalesce(nullif(p #>> '{conditions,power}', ''), 'unknown'), coalesce(nullif(p #>> '{conditions,water}', ''), 'unknown'),
    coalesce(nullif(p #>> '{conditions,removal}', ''), 'unknown'), nullif(p #>> '{conditions,disposal}', ''), nullif(left(p->>'notes', 5000), ''), p_user)
  returning * into r;

  for it in select * from jsonb_array_elements(p->'items') loop
    i := i + 1;
    select * into svc from public.services where workspace_id = p_ws and key = it->>'service' and active;
    if svc.id is null then raise exception 'unknown_service' using errcode = '22023', hint = format('Service %s is not offered in this workspace.', it->>'service'); end if;
    select * into chk from private.check_answers(svc.request_fields, coalesce(it->'answers', '{}'));
    insert into public.estimate_request_items (request_id, service_key, service_name, answers, normalized, notes, missing, sort)
    values (r.id, svc.key, svc.name, coalesce(it->'answers', '{}'), chk.normalized, nullif(left(it->>'notes', 2000), ''), chk.missing, i);
    v_missing := v_missing || (select coalesce(jsonb_agg(m || jsonb_build_object('scope', svc.name)), '[]') from jsonb_array_elements(chk.missing) m);
    v_items := v_items + 1;
  end loop;
  -- what an estimator needs before pricing, whatever the service
  if r.job_address is null then v_missing := v_missing || '[{"scope": "Job", "field": "job_address", "label": "Job address"}]'; end if;
  if v_phone is null and v_email is null then v_missing := v_missing || '[{"scope": "Contact", "field": "contact", "label": "A phone number or email for the requester"}]'; end if;
  if r.requested_date is null then v_missing := v_missing || '[{"scope": "Job", "field": "requested_date", "label": "Requested date"}]'; end if;
  if coalesce(jsonb_array_length(p->'attachments'), 0) = 0 then v_missing := v_missing || '[{"scope": "Files", "field": "attachments", "label": "Photos or drawings of the work area"}]'; end if;

  -- the job site becomes a project (one per request; merge later if the same job comes from discovery) and an inbound lead
  insert into public.projects (external_key, source_id, title, short_title, owner_name, location_text, city, county, region, stage, status_text, source_name, source_summary,
    services_likely, discovered_at, published_at)
  values ('er:' || r.id, 'estimate_requests', left(concat_ws(' at ', (select string_agg(service_name, ', ' order by sort) from public.estimate_request_items where request_id = r.id), r.job_address), 200),
    left(coalesce(r.job_address, v_co_name), 80), null, concat_ws(', ', r.job_address, r.job_city), r.job_city, r.job_county,
    coalesce((select region from public.fl_counties where name = r.job_county), 'Unknown'), 'preconstruction', 'Estimate requested by ' || v_co_name,
    'Estimate requests', 'Requested by ' || v_co_name || ' (' || r.ref || '). Quantities are the requester''s.',
    (select coalesce(array_agg(s.discovery_name), '{}') from public.estimate_request_items x join public.services s on s.workspace_id = p_ws and s.key = x.service_key where x.request_id = r.id and s.discovery_name is not null),
    now(), current_date)
  returning id into v_project;

  v_owner := coalesce((select (w.settings->>'intake_owner')::uuid from public.workspaces w where w.id = p_ws and private.is_member_of(p_ws, (w.settings->>'intake_owner')::uuid)),
    (select user_id from public.workspace_members where workspace_id = p_ws and role in ('owner', 'manager') order by role = 'owner' desc, added_at limit 1));
  insert into public.opportunities (workspace_id, project_id, company_id, kind, approach, title, stage, owner_id, claimed_at, services, next_action, next_action_due, created_by)
  values (p_ws, v_project, v_company, 'inbound_request', 'approach_prime', left(v_co_name || ' — estimate request ' || r.ref, 200),
    case when v_owner is null then 'available' when jsonb_array_length(v_missing) = 0 then 'quote_needed' else 'qualified' end, v_owner, case when v_owner is not null then now() end,
    (select coalesce(array_agg(service_name order by sort), '{}') from public.estimate_request_items where request_id = r.id),
    case when v_owner is not null then case when jsonb_array_length(v_missing) = 0 then 'Review ' || r.ref || ' and start the estimate' else 'Get the missing details for ' || r.ref end end,
    case when v_owner is not null then (now() at time zone 'America/New_York')::date + 1 end, p_user)
  returning id into v_opp;
  -- the estimating task: the next-step mirror creates it; link it to the request
  select id into v_task from public.tasks where workspace_id = p_ws and dedupe_key = 'next:' || v_opp and status = 'open';
  update public.tasks set kind = 'estimate', origin = 'estimate_request', contact_id = v_contact,
    notes = case when jsonb_array_length(v_missing) > 0 then 'Missing: ' || (select string_agg(m->>'label', '; ') from jsonb_array_elements(v_missing) m) end
   where id = v_task;
  insert into public.activities (workspace_id, opportunity_id, company_id, contact_id, user_id, kind, body, data)
  values (p_ws, v_opp, v_company, v_contact, p_user, 'system', 'Estimate request ' || r.ref || ' received (' || p_source || ')' ||
            case when jsonb_array_length(v_missing) > 0 then '; ' || jsonb_array_length(v_missing) || ' item(s) missing' else '' end,
          jsonb_build_object('estimate_request', r.id));
  update public.estimate_requests set missing = v_missing, status = case when jsonb_array_length(v_missing) > 0 then 'missing_info' else 'ready' end,
    project_id = v_project, opportunity_id = v_opp, task_id = v_task, updated_at = now()
   where id = r.id returning * into r;
  return jsonb_build_object('ok', true, 'duplicate', false, 'id', r.id, 'ref', r.ref, 'status', r.status, 'missing', r.missing, 'opportunity_id', v_opp, 'task_id', v_task);
end $$;

create or replace function private.is_member_of(p_ws uuid, p_user uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members where workspace_id = p_ws and user_id = p_user) $$;

-- signed-in entry (phone call or email turned into a request); lands in the caller's current workspace
create or replace function public.submit_estimate_request(p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active();
begin
  return private.submit_estimate_request(private.current_ws(), p, case when (p->>'is_fixture')::boolean then 'fixture' else 'manual' end, me.id);
end $$;

-- ---------------------------------------------------------------- integrations (the estimate request app)
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  kind text not null default 'estimate_app' check (kind in ('estimate_app')),
  key_hash text not null unique,            -- sha256 of the key; the key itself is shown once and never stored
  key_hint text not null,                   -- last 4 characters, to tell keys apart
  active boolean not null default true,
  max_per_hour int not null default 30,
  last_used_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.integrations enable row level security;
create table public.integration_events (
  id bigint generated always as identity primary key,
  integration_id uuid references public.integrations(id) on delete cascade,
  at timestamptz not null default now(),
  outcome text not null,                    -- accepted, duplicate, rejected, rate_limited, bad_key
  detail text,
  request_id uuid references public.estimate_requests(id)
);
alter table public.integration_events enable row level security;

create or replace function public.create_integration(p_name text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); v_ws uuid := private.current_ws(); v_key text; v_id uuid;
begin
  if not private.is_member(v_ws, array['owner', 'manager']) then raise exception 'workspace_manager_only' using errcode = '42501'; end if;
  v_key := 'erk_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.integrations (workspace_id, name, key_hash, key_hint, created_by)
  values (v_ws, coalesce(nullif(trim(p_name), ''), 'Estimate request app'), encode(extensions.digest(v_key, 'sha256'), 'hex'), right(v_key, 4), me.id)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'key', v_key, 'note', 'Copy this key now. It is not stored and cannot be shown again.');
end $$;

create or replace function public.list_integrations() returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ws uuid := private.current_ws();
begin
  perform private.require_active();
  if not private.is_member(v_ws, array['owner', 'manager']) then raise exception 'workspace_manager_only' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'key_hint', i.key_hint, 'active', i.active, 'max_per_hour', i.max_per_hour,
    'last_used_at', i.last_used_at, 'created_at', i.created_at,
    'recent', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'outcome', e.outcome, 'detail', e.detail) order by e.at desc), '[]')
               from (select * from public.integration_events where integration_id = i.id order by at desc limit 10) e)) order by i.created_at)
    from public.integrations i where i.workspace_id = v_ws), '[]');
end $$;

create or replace function public.set_integration_active(p_id uuid, p_active boolean) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active();
  if not exists (select 1 from public.integrations where id = p_id and private.is_member(workspace_id, array['owner', 'manager'])) then raise exception 'not_found' using errcode = 'P0002'; end if;
  update public.integrations set active = p_active where id = p_id;
  return public.list_integrations();
end $$;

-- called only by the estimate-intake edge function (service role) with the key the app sent
create or replace function public.intake_estimate_request(p_key text, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare i public.integrations; res jsonb; n int; v_err text; v_hint text;
begin
  select * into i from public.integrations where key_hash = encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex');
  if i.id is null or not i.active then
    insert into public.integration_events (integration_id, outcome, detail) values (i.id, 'bad_key', case when i.id is null then 'unknown key' else 'integration turned off' end);
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  select count(*) into n from public.integration_events where integration_id = i.id and at > now() - interval '1 hour' and outcome in ('accepted', 'rejected');
  if n >= i.max_per_hour then
    insert into public.integration_events (integration_id, outcome, detail) values (i.id, 'rate_limited', n || ' in the last hour');
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  if nullif(trim(coalesce(p->>'idempotency_key', '')), '') is null then
    insert into public.integration_events (integration_id, outcome, detail) values (i.id, 'rejected', 'missing idempotency_key');
    return jsonb_build_object('ok', false, 'error', 'idempotency_key_required');
  end if;
  begin
    res := private.submit_estimate_request(i.workspace_id, p, case when (p->>'is_fixture')::boolean then 'fixture' else 'estimate_app' end, null);
  exception when sqlstate '22023' or sqlstate '22001' then
    get stacked diagnostics v_err = message_text, v_hint = pg_exception_hint;
    insert into public.integration_events (integration_id, outcome, detail) values (i.id, 'rejected', left(concat_ws(': ', v_err, nullif(v_hint, '')), 300));
    return jsonb_build_object('ok', false, 'error', 'invalid', 'reason', v_err, 'detail', nullif(v_hint, ''));
  end;
  update public.integrations set last_used_at = now() where id = i.id;
  insert into public.integration_events (integration_id, outcome, detail, request_id)
  values (i.id, case when (res->>'duplicate')::boolean then 'duplicate' else 'accepted' end, res->>'ref', (res->>'id')::uuid);
  -- the app gets back only what it needs; nothing about other records
  return jsonb_build_object('ok', true, 'duplicate', (res->>'duplicate')::boolean, 'ref', res->>'ref', 'status', res->>'status', 'missing', res->'missing');
end $$;

create or replace function public.estimate_requests(p jsonb default '{}') returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active();
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'ref', r.ref, 'status', r.status, 'source', r.source, 'is_fixture', r.is_fixture, 'received_at', r.received_at,
      'company', r.company_name, 'company_id', r.company_id, 'contact', r.contact_name, 'job_address', r.job_address, 'job_city', r.job_city, 'requested_date', r.requested_date,
      'missing_count', jsonb_array_length(r.missing), 'opportunity_id', r.opportunity_id,
      'services', (select jsonb_agg(service_name order by sort) from public.estimate_request_items where request_id = r.id)) order by r.received_at desc)
    from private.v_estimate_requests r
    where (p->>'status' is null or r.status = p->>'status') and (coalesce((p->>'include_fixtures')::boolean, false) or not r.is_fixture)), '[]');
end $$;

create or replace function public.get_estimate_request(p_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.estimate_requests;
begin
  perform private.require_active();
  select * into r from private.v_estimate_requests where id = p_id;
  if r.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  return to_jsonb(r) - 'submitted' || jsonb_build_object(
    'items', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'service_key', i.service_key, 'service', i.service_name, 'answers', i.answers, 'normalized', i.normalized,
        'notes', i.notes, 'missing', i.missing, 'fields', (select request_fields from public.services where workspace_id = r.workspace_id and key = i.service_key)) order by i.sort), '[]')
      from public.estimate_request_items i where i.request_id = r.id),
    'disclaimer', 'A request is what the customer asked for. It is not an approved estimate, a confirmed booking or an engineering assessment.',
    'quotes', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'ref', q.ref)), '[]') from private.v_quotes q where q.estimate_request_id = r.id));
end $$;

-- the estimator resolves missing items or changes status; answers can be added (still marked as the requester's)
create or replace function public.update_estimate_request(p_id uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); r public.estimate_requests; v_missing jsonb;
begin
  select * into r from private.v_estimate_requests where id = p_id for update;
  if r.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  v_missing := case when p ? 'resolved' then (select coalesce(jsonb_agg(m), '[]') from jsonb_array_elements(r.missing) m where not ((p->'resolved') ? (m->>'field'))) else r.missing end;
  update public.estimate_requests set missing = v_missing,
    job_address = coalesce(nullif(trim(p->>'job_address'), ''), job_address), requested_date = coalesce(nullif(p->>'requested_date', '')::date, requested_date),
    status = coalesce(nullif(p->>'status', ''), case when status in ('new', 'missing_info') and jsonb_array_length(v_missing) = 0 then 'ready' else status end),
    status_note = coalesce(nullif(trim(p->>'status_note'), ''), status_note), updated_at = now()
  where id = r.id;
  insert into public.activities (opportunity_id, company_id, user_id, kind, body, data)
  values (r.opportunity_id, r.company_id, me.id, 'note', 'Estimate request ' || r.ref || ' updated' || coalesce(': ' || nullif(p->>'status_note', ''), ''),
          jsonb_build_object('estimate_request', r.id, 'resolved', p->'resolved', 'status', p->>'status'));
  return public.get_estimate_request(r.id);
end $$;

-- ---------------------------------------------------------------- quotes
create sequence public.quote_ref_seq start 501;
create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default private.current_ws() references public.workspaces(id) on delete cascade,
  ref text not null unique default ('Q-' || nextval('public.quote_ref_seq')),
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  estimate_request_id uuid references public.estimate_requests(id),
  title text not null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.quotes enable row level security;
create view private.v_quotes as select * from public.quotes where private.ws_ok(workspace_id);
alter view private.v_quotes alter column workspace_id set default private.current_ws();

create table public.quote_versions (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  version_no int not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'sent', 'accepted', 'rejected', 'superseded')),
  based_on uuid references public.quote_versions(id),
  scope_summary text,
  assumptions text[] not null default '{}',
  exclusions text[] not null default '{}',
  valid_until date,
  notes text,
  total numeric,                        -- frozen at approval; while a draft, totals are computed from the lines
  quick_amount numeric,                 -- an amount-only quote recorded without line items (from the older quote field)
  prepared_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id), approved_at timestamptz,
  sent_at timestamptz, sent_to text, sent_method text check (sent_method in ('email', 'portal', 'in_person', 'other')),
  decided_at timestamptz, decided_note text,
  created_at timestamptz not null default now(),
  unique (quote_id, version_no)
);
alter table public.quote_versions enable row level security;

create table public.quote_lines (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.quote_versions(id) on delete cascade,
  line_no int not null,
  kind text not null default 'work' check (kind in ('work', 'mobilization', 'minimum_charge', 'after_hours', 'access', 'scanning', 'removal', 'disposal', 'other')),
  service_key text,
  description text not null check (length(description) between 1 and 500),
  qty numeric not null check (qty >= 0),
  unit text not null references public.units(key),
  qty_source text not null default 'assumed' check (qty_source in ('contractor', 'verified', 'measured', 'assumed')),
  rate numeric not null check (rate >= 0),
  rate_source text not null check (rate_source in ('pricing_rule', 'manual')),
  pricing_rule_id uuid references public.pricing_rules(id),
  amount numeric generated always as (round(qty * rate, 2)) stored,
  created_at timestamptz not null default now()
);
alter table public.quote_lines enable row level security;

create table public.change_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default private.current_ws() references public.workspaces(id) on delete cascade,
  quote_id uuid not null references public.quotes(id) on delete cascade,
  against_version uuid not null references public.quote_versions(id),
  description text not null,
  requested_by text,
  status text not null default 'requested' check (status in ('requested', 'priced', 'approved', 'rejected')),
  priced_version uuid references public.quote_versions(id),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.change_requests enable row level security;

-- a version's content is frozen once approved: lines cannot change, and only the status can move forward
create or replace function private.quote_lines_frozen() returns trigger language plpgsql set search_path = '' as $$
declare s text;
begin
  select status into s from public.quote_versions where id = coalesce(new.version_id, old.version_id);
  if s <> 'draft' then raise exception 'version_frozen' using errcode = '22023', hint = 'This version is approved or sent. Make a new version to change it.'; end if;
  return coalesce(new, old);
end $$;
create trigger quote_lines_frozen before insert or update or delete on public.quote_lines for each row execute function private.quote_lines_frozen();

create or replace function private.quote_version_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status <> 'draft' and (new.scope_summary is distinct from old.scope_summary or new.assumptions is distinct from old.assumptions
     or new.exclusions is distinct from old.exclusions or new.valid_until is distinct from old.valid_until or new.total is distinct from old.total
     or new.quick_amount is distinct from old.quick_amount) then
    raise exception 'version_frozen' using errcode = '22023', hint = 'This version is approved or sent. Make a new version to change it.';
  end if;
  if not (old.status = new.status or (old.status, new.status) in (('draft', 'approved'), ('approved', 'draft'), ('approved', 'sent'), ('sent', 'accepted'), ('sent', 'rejected'),
      ('sent', 'superseded'), ('approved', 'superseded'), ('draft', 'superseded'), ('rejected', 'accepted'))) then
    raise exception 'bad_status_change' using errcode = '22023', hint = format('A %s version cannot become %s.', old.status, new.status);
  end if;
  return new;
end $$;
create trigger quote_version_guard before update on public.quote_versions for each row execute function private.quote_version_guard();

create or replace function private.version_total(p_version uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(v.total, case when exists (select 1 from public.quote_lines where version_id = v.id) then (select sum(amount) from public.quote_lines where version_id = v.id) else v.quick_amount end)
  from public.quote_versions v where v.id = p_version $$;

-- what needs a look before this version goes out
create or replace function private.version_flags(p_version uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(f), '[]') from (
    select jsonb_build_object('level', 'review', 'text', count(*) || ' line(s) use the customer''s quantities, not verified ones') f
      from public.quote_lines where version_id = p_version and qty_source = 'contractor' having count(*) > 0
    union all select jsonb_build_object('level', 'review', 'text', count(*) || ' line(s) use assumed quantities') from public.quote_lines where version_id = p_version and qty_source = 'assumed' having count(*) > 0
    union all select jsonb_build_object('level', 'review', 'text', count(*) || ' line(s) priced by hand, not from an approved pricing rule') from public.quote_lines where version_id = p_version and rate_source = 'manual' having count(*) > 0
    union all select jsonb_build_object('level', 'block', 'text', 'No price validity date') from public.quote_versions where id = p_version and valid_until is null
    union all select jsonb_build_object('level', 'review', 'text', 'No assumptions written down') from public.quote_versions where id = p_version and cardinality(assumptions) = 0
    union all select jsonb_build_object('level', 'review', 'text', 'No exclusions written down') from public.quote_versions where id = p_version and cardinality(exclusions) = 0
    union all select jsonb_build_object('level', 'block', 'text', 'No line items and no amount') from public.quote_versions v where id = p_version and quick_amount is null and not exists (select 1 from public.quote_lines where version_id = v.id)
    union all select jsonb_build_object('level', 'review', 'text', 'The estimate request still has ' || jsonb_array_length(r.missing) || ' missing item(s)')
      from public.quote_versions v join public.quotes q on q.id = v.quote_id join public.estimate_requests r on r.id = q.estimate_request_id
      where v.id = p_version and jsonb_array_length(r.missing) > 0
  ) x $$;

create or replace function private.quote_json(p_quote uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', q.id, 'ref', q.ref, 'title', q.title, 'opportunity_id', q.opportunity_id, 'estimate_request_id', q.estimate_request_id,
    'versions', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'version_no', v.version_no, 'status', v.status, 'scope_summary', v.scope_summary,
        'assumptions', v.assumptions, 'exclusions', v.exclusions, 'valid_until', v.valid_until, 'notes', v.notes, 'total', private.version_total(v.id),
        'quick_amount', v.quick_amount, 'prepared_by', (select full_name from public.profiles where id = v.prepared_by),
        'approved_by', (select full_name from public.profiles where id = v.approved_by), 'approved_at', v.approved_at, 'sent_at', v.sent_at, 'sent_to', v.sent_to,
        'sent_method', v.sent_method, 'decided_at', v.decided_at, 'decided_note', v.decided_note, 'flags', private.version_flags(v.id),
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'line_no', l.line_no, 'kind', l.kind, 'service_key', l.service_key, 'description', l.description,
            'qty', l.qty, 'unit', l.unit, 'qty_source', l.qty_source, 'rate', l.rate, 'rate_source', l.rate_source, 'amount', l.amount) order by l.line_no), '[]')
          from public.quote_lines l where l.version_id = v.id)) order by v.version_no desc), '[]')
      from public.quote_versions v where v.quote_id = q.id),
    'change_requests', (select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at), '[]') from public.change_requests c where c.quote_id = q.id))
  from public.quotes q where q.id = p_quote $$;

create or replace function private.quote_for_me(p_quote uuid, p_write boolean) returns public.quotes language plpgsql security definer set search_path = '' as $$
declare q public.quotes; o public.opportunities; me public.profiles := private.require_active();
begin
  select * into q from private.v_quotes where id = p_quote;
  if q.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  -- like the lead's quote amount, quote details are for the lead's owner and managers (reading and writing)
  select * into o from private.v_opportunities where id = q.opportunity_id;
  if o.owner_id is distinct from me.id and me.role <> 'manager' and not private.is_member(q.workspace_id, array['owner', 'manager']) then
    raise exception 'not_owner' using errcode = '42501'; end if;
  return q;
end $$;

create or replace function public.get_quote(p_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.quote_for_me(p_id, false); return private.quote_json(p_id); end $$;

-- new quote on a lead, version 1 as a draft; from an estimate request its items become lines with the customer's quantities
-- and no price (rate 0, manual) until an estimator prices them; approved pricing rules fill the rate when one matches
create or replace function public.create_quote(p_opportunity uuid, p jsonb default '{}') returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); o public.opportunities; q public.quotes; v uuid; r public.estimate_requests; it record; f jsonb; ans jsonb; pr public.pricing_rules; n int := 0;
begin
  select * into o from private.v_opportunities where id = p_opportunity;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if o.owner_id is distinct from me.id and me.role <> 'manager' then raise exception 'not_owner' using errcode = '42501'; end if;
  if p->>'estimate_request_id' is not null then
    select * into r from private.v_estimate_requests where id = (p->>'estimate_request_id')::uuid;
    if r.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  end if;
  insert into private.v_quotes (opportunity_id, estimate_request_id, title, created_by)
  values (o.id, r.id, coalesce(nullif(trim(p->>'title'), ''), o.title), me.id) returning * into q;
  insert into public.quote_versions (quote_id, version_no, prepared_by, valid_until, scope_summary)
  values (q.id, 1, me.id, current_date + coalesce((select (settings->>'quote_valid_days')::int from public.workspaces where id = q.workspace_id), 30), nullif(p->>'scope_summary', ''))
  returning id into v;
  if r.id is not null then
    for it in select * from public.estimate_request_items where request_id = r.id order by sort loop
      for f in select * from jsonb_array_elements((select request_fields from public.services where workspace_id = q.workspace_id and key = it.service_key)) loop
        ans := it.normalized -> (f->>'key');
        -- one line per measured quantity the customer gave that a price is usually per (length of cut, holes, openings, area)
        if ans is not null and f->>'dimension' in ('length', 'count', 'area', 'volume') then
          select * into pr from public.pricing_rules where workspace_id = q.workspace_id and service_key = it.service_key and kind = 'work' and status = 'approved'
            and unit = ans->>'unit' and effective_from <= current_date and (effective_to is null or effective_to >= current_date) order by effective_from desc limit 1;
          n := n + 1;
          insert into public.quote_lines (version_id, line_no, kind, service_key, description, qty, unit, qty_source, rate, rate_source, pricing_rule_id)
          values (v, n, 'work', it.service_key, it.service_name || ': ' || (f->>'label'), (ans->>'value')::numeric, ans->>'unit', 'contractor',
                  coalesce(pr.rate, 0), case when pr.id is not null then 'pricing_rule' else 'manual' end, pr.id);
        end if;
      end loop;
    end loop;
    update public.estimate_requests set status = 'estimating', updated_at = now() where id = r.id and status in ('new', 'missing_info', 'ready');
  end if;
  insert into public.activities (opportunity_id, company_id, user_id, kind, body, data)
  values (o.id, o.company_id, me.id, 'quote', 'Started quote ' || q.ref, jsonb_build_object('quote', q.id));
  return private.quote_json(q.id);
end $$;

create or replace function public.save_quote_line(p_version uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.quote_versions; q public.quotes; pr public.pricing_rules; v_rate numeric; v_src text;
begin
  select * into v from public.quote_versions where id = p_version;
  if v.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  q := private.quote_for_me(v.quote_id, true);
  if p->>'pricing_rule_id' is not null then
    select * into pr from public.pricing_rules where id = (p->>'pricing_rule_id')::uuid and workspace_id = q.workspace_id and status = 'approved';
    if pr.id is null then raise exception 'rule_not_approved' using errcode = '22023', hint = 'Only approved pricing rules can price a line.'; end if;
    if pr.unit <> p->>'unit' then raise exception 'unit_mismatch' using errcode = '22023', hint = format('That rule is priced per %s.', pr.unit); end if;
    v_rate := pr.rate; v_src := 'pricing_rule';
  else
    if nullif(p->>'rate', '') is null then raise exception 'rate_required' using errcode = '22023'; end if;
    v_rate := (p->>'rate')::numeric; v_src := 'manual';
  end if;
  if not exists (select 1 from public.units where key = p->>'unit') then raise exception 'bad_unit' using errcode = '22023'; end if;
  if p->>'id' is null then
    insert into public.quote_lines (version_id, line_no, kind, service_key, description, qty, unit, qty_source, rate, rate_source, pricing_rule_id)
    values (v.id, coalesce((select max(line_no) from public.quote_lines where version_id = v.id), 0) + 1, coalesce(nullif(p->>'kind', ''), 'work'), nullif(p->>'service_key', ''),
            trim(p->>'description'), (p->>'qty')::numeric, p->>'unit', coalesce(nullif(p->>'qty_source', ''), 'assumed'), v_rate, v_src, pr.id);
  else
    update public.quote_lines set kind = coalesce(nullif(p->>'kind', ''), kind), description = coalesce(nullif(trim(p->>'description'), ''), description),
      qty = coalesce((p->>'qty')::numeric, qty), unit = coalesce(nullif(p->>'unit', ''), unit), qty_source = coalesce(nullif(p->>'qty_source', ''), qty_source),
      rate = v_rate, rate_source = v_src, pricing_rule_id = pr.id
     where id = (p->>'id')::uuid and version_id = v.id;
  end if;
  return private.quote_json(q.id);
end $$;

create or replace function public.delete_quote_line(p_line uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_version uuid; q public.quotes;
begin
  select version_id into v_version from public.quote_lines where id = p_line;
  if v_version is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  q := private.quote_for_me((select quote_id from public.quote_versions where id = v_version), true);
  delete from public.quote_lines where id = p_line;
  return private.quote_json(q.id);
end $$;

create or replace function public.update_quote_version(p_version uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.quote_versions; q public.quotes;
begin
  select * into v from public.quote_versions where id = p_version;
  if v.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  q := private.quote_for_me(v.quote_id, true);
  update public.quote_versions set
    scope_summary = case when p ? 'scope_summary' then nullif(trim(p->>'scope_summary'), '') else scope_summary end,
    assumptions = case when p ? 'assumptions' then (select coalesce(array_agg(trim(x)), '{}') from jsonb_array_elements_text(p->'assumptions') x where trim(x) <> '') else assumptions end,
    exclusions = case when p ? 'exclusions' then (select coalesce(array_agg(trim(x)), '{}') from jsonb_array_elements_text(p->'exclusions') x where trim(x) <> '') else exclusions end,
    valid_until = case when p ? 'valid_until' then nullif(p->>'valid_until', '')::date else valid_until end,
    notes = case when p ? 'notes' then nullif(p->>'notes', '') else notes end
  where id = v.id;
  return private.quote_json(q.id);
end $$;

-- copy a version (draft or not) into a new draft; the old one stays as it was
create or replace function public.new_quote_version(p_from uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); v public.quote_versions; q public.quotes; n uuid;
begin
  select * into v from public.quote_versions where id = p_from;
  if v.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  q := private.quote_for_me(v.quote_id, true);
  insert into public.quote_versions (quote_id, version_no, based_on, scope_summary, assumptions, exclusions, valid_until, notes, quick_amount, prepared_by)
  values (q.id, (select max(version_no) + 1 from public.quote_versions where quote_id = q.id), v.id, v.scope_summary, v.assumptions, v.exclusions,
          greatest(v.valid_until, current_date + 30), v.notes, case when not exists (select 1 from public.quote_lines where version_id = v.id) then v.quick_amount end, me.id)
  returning id into n;
  insert into public.quote_lines (version_id, line_no, kind, service_key, description, qty, unit, qty_source, rate, rate_source, pricing_rule_id)
  select n, line_no, kind, service_key, description, qty, unit, qty_source, rate, rate_source, pricing_rule_id from public.quote_lines where version_id = v.id;
  return private.quote_json(q.id);
end $$;

-- approve (freezes the content and the total) and mark sent (records to whom and how; moves the lead to Quote sent)
create or replace function public.approve_quote_version(p_version uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); v public.quote_versions; q public.quotes; blocks jsonb;
begin
  select * into v from public.quote_versions where id = p_version for update;
  if v.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  q := private.quote_for_me(v.quote_id, true);
  if v.status <> 'draft' then raise exception 'not_draft' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(f->>'text'), '[]') into blocks from jsonb_array_elements(private.version_flags(v.id)) f where f->>'level' = 'block';
  if jsonb_array_length(blocks) > 0 then raise exception 'quote_incomplete' using errcode = '22023', hint = (select string_agg(x, '; ') from jsonb_array_elements_text(blocks) x); end if;
  if exists (select 1 from public.quote_lines where version_id = v.id and rate = 0 and kind = 'work') then
    raise exception 'unpriced_lines' using errcode = '22023', hint = 'Price every work line before approving.'; end if;
  update public.quote_versions set total = private.version_total(v.id) where id = v.id;
  update public.quote_versions set status = 'approved', approved_by = me.id, approved_at = now() where id = v.id;
  return private.quote_json(q.id);
end $$;

create or replace function public.mark_quote_sent(p_version uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); v public.quote_versions; q public.quotes; o public.opportunities; v_total numeric;
begin
  select * into v from public.quote_versions where id = p_version for update;
  if v.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  q := private.quote_for_me(v.quote_id, true);
  if v.status <> 'approved' then raise exception 'approve_first' using errcode = '22023', hint = 'Approve the version before recording it as sent.'; end if;
  if nullif(trim(coalesce(p->>'sent_to', '')), '') is null then raise exception 'sent_to_required' using errcode = '22023', hint = 'Say who received it.'; end if;
  update public.quote_versions set status = 'sent', sent_at = coalesce(nullif(p->>'sent_at', '')::timestamptz, now()), sent_to = trim(p->>'sent_to'),
    sent_method = coalesce(nullif(p->>'sent_method', ''), 'email') where id = v.id;
  -- earlier sent versions of this quote are replaced by this one
  update public.quote_versions set status = 'superseded' where quote_id = q.id and id <> v.id and status in ('sent', 'approved', 'draft');
  v_total := private.version_total(v.id);
  select * into o from private.v_opportunities where id = q.opportunity_id;
  -- the lead's quote fields follow the sent version (the board and reports read them)
  update public.opportunities set quote_amount = v_total, quote_sent_at = coalesce(nullif(p->>'sent_at', '')::date, current_date), quote_status = 'sent',
    stage = case when stage = any(private.active_stages()) then 'quote_sent' else stage end,
    last_activity_at = now(), last_activity_by = me.id, last_activity_summary = 'Quote ' || q.ref || ' v' || v.version_no || ' sent'
   where id = o.id;
  insert into public.activities (opportunity_id, company_id, user_id, kind, body, from_stage, to_stage, data)
  values (o.id, o.company_id, me.id, 'quote', 'Quote ' || q.ref || ' version ' || v.version_no || ' sent to ' || trim(p->>'sent_to') || ' (' || to_char(v_total, 'FM$999,999,990.00') || ')',
          o.stage, case when o.stage = any(private.active_stages()) then 'quote_sent' else o.stage end, jsonb_build_object('quote', q.id, 'version', v.id, 'total', v_total));
  update public.estimate_requests set status = 'quoted', updated_at = now() where id = q.estimate_request_id;
  return private.quote_json(q.id);
end $$;

create or replace function public.record_change_request(p_quote uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); q public.quotes; v_against uuid;
begin
  q := private.quote_for_me(p_quote, true);
  select id into v_against from public.quote_versions where quote_id = q.id and status in ('accepted', 'sent') order by (status = 'accepted') desc, version_no desc limit 1;
  if v_against is null then raise exception 'no_sent_version' using errcode = '22023', hint = 'A change request is recorded against a sent or accepted version.'; end if;
  if nullif(trim(coalesce(p->>'description', '')), '') is null then raise exception 'description_required' using errcode = '22023'; end if;
  insert into public.change_requests (workspace_id, quote_id, against_version, description, requested_by, created_by)
  values (q.workspace_id, q.id, v_against, trim(p->>'description'), nullif(trim(p->>'requested_by'), ''), me.id);
  return private.quote_json(q.id);
end $$;

-- pricing rules: anyone in the workspace can propose; only its owner or manager approves (recorded)
create or replace function public.pricing_rules_list() returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active();
  return coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('approved_by_name', (select full_name from public.profiles where id = r.approved_by)) order by r.service_key, r.kind, r.effective_from desc)
    from private.v_pricing_rules r where r.status <> 'retired'), '[]');
end $$;

create or replace function public.save_pricing_rule(p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); v_ws uuid := private.current_ws(); v_mgr boolean := private.is_member(private.current_ws(), array['owner', 'manager']);
begin
  if p->>'id' is null then
    if not exists (select 1 from public.services where workspace_id = v_ws and key = p->>'service_key') then raise exception 'unknown_service' using errcode = '22023'; end if;
    insert into private.v_pricing_rules (service_key, kind, description, unit, rate, conditions, effective_from, effective_to, created_by)
    values (p->>'service_key', coalesce(nullif(p->>'kind', ''), 'work'), trim(p->>'description'), p->>'unit', (p->>'rate')::numeric, nullif(trim(p->>'conditions'), ''),
            coalesce(nullif(p->>'effective_from', '')::date, current_date), nullif(p->>'effective_to', '')::date, me.id);
  elsif p->>'status' in ('approved', 'retired') then
    if not v_mgr then raise exception 'workspace_manager_only' using errcode = '42501'; end if;
    update private.v_pricing_rules set status = p->>'status', approved_by = case when p->>'status' = 'approved' then me.id else approved_by end,
      approved_at = case when p->>'status' = 'approved' then now() else approved_at end,
      effective_to = case when p->>'status' = 'retired' then current_date else effective_to end
     where id = (p->>'id')::uuid;
  else
    -- an approved rule is not edited in place: retire it and add a new one, so quotes keep pointing at the rate they used
    update private.v_pricing_rules set description = coalesce(nullif(trim(p->>'description'), ''), description), rate = coalesce((p->>'rate')::numeric, rate),
      conditions = coalesce(nullif(trim(p->>'conditions'), ''), conditions)
     where id = (p->>'id')::uuid and status = 'draft';
    if not found then raise exception 'not_editable' using errcode = '22023', hint = 'Approved rules are retired and replaced, not edited.'; end if;
  end if;
  return public.pricing_rules_list();
end $$;

-- ---------------------------------------------------------------- stage requirement: Quote sent needs a sent version
-- Moving a lead to Quote sent from the older quick flow (amount only) records that amount as a version, so every sent
-- quote exists as a version. Without a sent version or an amount the move is refused.
create or replace function private.require_quote_for_sent() returns trigger language plpgsql security definer set search_path = '' as $$
declare q uuid; v uuid;
begin
  if new.stage = 'quote_sent' and old.stage is distinct from 'quote_sent' then
    if exists (select 1 from public.quote_versions qv join public.quotes qq on qq.id = qv.quote_id where qq.opportunity_id = new.id and qv.status in ('sent', 'accepted')) then
      return new;
    end if;
    if new.quote_amount is null then
      raise exception 'quote_version_required' using errcode = '22023', hint = 'Record the quote (a version with its amount) before marking it sent.';
    end if;
    insert into public.quotes (workspace_id, opportunity_id, title, created_by) values (new.workspace_id, new.id, new.title, auth.uid()) returning id into q;
    insert into public.quote_versions (quote_id, version_no, status, quick_amount, total, prepared_by, valid_until, notes)
    values (q, 1, 'draft', new.quote_amount, new.quote_amount, auth.uid(), coalesce(new.quote_sent_at, current_date) + 30,
            'Recorded from the lead''s quote amount (no line items).') returning id into v;
    update public.quote_versions set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = v;
    update public.quote_versions set status = 'sent', sent_at = coalesce(new.quote_sent_at::timestamptz, now()), sent_to = 'not recorded', sent_method = 'other' where id = v;
  end if;
  return new;
end $$;
create trigger opportunities_quote_sent before update of stage on public.opportunities for each row execute function private.require_quote_for_sent();

revoke all on function public.submit_estimate_request(jsonb), public.create_integration(text), public.list_integrations(), public.set_integration_active(uuid, boolean),
  public.estimate_requests(jsonb), public.get_estimate_request(uuid), public.update_estimate_request(uuid, jsonb), public.get_quote(uuid), public.create_quote(uuid, jsonb),
  public.save_quote_line(uuid, jsonb), public.delete_quote_line(uuid), public.update_quote_version(uuid, jsonb), public.new_quote_version(uuid), public.approve_quote_version(uuid),
  public.mark_quote_sent(uuid, jsonb), public.record_change_request(uuid, jsonb), public.pricing_rules_list(), public.save_pricing_rule(jsonb) from public, anon;
grant execute on function public.submit_estimate_request(jsonb), public.create_integration(text), public.list_integrations(), public.set_integration_active(uuid, boolean),
  public.estimate_requests(jsonb), public.get_estimate_request(uuid), public.update_estimate_request(uuid, jsonb), public.get_quote(uuid), public.create_quote(uuid, jsonb),
  public.save_quote_line(uuid, jsonb), public.delete_quote_line(uuid), public.update_quote_version(uuid, jsonb), public.new_quote_version(uuid), public.approve_quote_version(uuid),
  public.mark_quote_sent(uuid, jsonb), public.record_change_request(uuid, jsonb), public.pricing_rules_list(), public.save_pricing_rule(jsonb) to authenticated;
revoke all on function public.intake_estimate_request(text, jsonb) from public, anon, authenticated;
grant execute on function public.intake_estimate_request(text, jsonb) to service_role;
