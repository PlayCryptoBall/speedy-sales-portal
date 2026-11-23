-- Awards, jobs and handoffs, invoices, payments, attribution and commission.
-- Each money layer is its own record: quoted (quote versions) -> awarded (awards) -> jobs -> invoiced -> collected.
-- Commission is only money owed under a recorded, approved agreement; anything else is labelled a scenario.

create table public.awards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default private.current_ws() references public.workspaces(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  quote_version_id uuid references public.quote_versions(id),
  amount numeric check (amount is null or amount >= 0),
  confirmed_on date not null,
  method text not null check (method in ('signed_quote', 'purchase_order', 'subcontract', 'email', 'verbal', 'recorded')),
  reference text,                 -- PO number, subcontract number, email subject
  note text,
  recorded_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.awards enable row level security;
create view private.v_awards as select * from public.awards where private.ws_ok(workspace_id);
alter view private.v_awards alter column workspace_id set default private.current_ws();

create sequence public.job_ref_seq start 2001;
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default private.current_ws() references public.workspaces(id) on delete cascade,
  ref text not null unique default ('J-' || nextval('public.job_ref_seq')),
  award_id uuid references public.awards(id),
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  title text not null,
  amount numeric check (amount is null or amount >= 0),       -- this job's share of the award
  status text not null default 'ready_for_scheduling' check (status in ('ready_for_scheduling', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  handoff jsonb not null default '{}',
  handoff_reviewed_by uuid references public.profiles(id), handoff_reviewed_at timestamptz,
  requested_start date,
  scheduled_start date,
  schedule_source text,          -- who confirmed the date (dispatch, the scheduler); a date is never set without it
  completed_on date,
  cancelled_reason text,
  direct_cost numeric check (direct_cost is null or direct_cost >= 0),   -- for profit-based commission only, entered by someone who knows it
  follow_up_on date,
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduled_needs_source check (scheduled_start is null or schedule_source is not null)
);
alter table public.jobs enable row level security;
create view private.v_jobs as select * from public.jobs where private.ws_ok(workspace_id);
alter view private.v_jobs alter column workspace_id set default private.current_ws();

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default private.current_ws() references public.workspaces(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  number text not null,
  amount numeric not null check (amount >= 0),
  issued_on date not null,
  due_on date,
  status text not null default 'issued' check (status in ('issued', 'void')),
  void_reason text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (workspace_id, number)
);
alter table public.invoices enable row level security;
create view private.v_invoices as select * from public.invoices where private.ws_ok(workspace_id);
alter view private.v_invoices alter column workspace_id set default private.current_ws();

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default private.current_ws() references public.workspaces(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  amount numeric not null check (amount <> 0),       -- negative = credit or refund
  received_on date not null,
  method text,
  reference text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.payments enable row level security;

create table public.attributions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default private.current_ws() references public.workspaces(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  role text not null check (role in ('sourced', 'developed', 'quoted', 'closed')),
  user_id uuid references public.profiles(id),
  person_name text,              -- someone without a login (an estimator, an office manager)
  share numeric not null default 1 check (share > 0 and share <= 1),
  note text,
  set_by uuid references public.profiles(id),
  set_at timestamptz not null default now(),
  constraint attribution_who check (user_id is not null or nullif(trim(person_name), '') is not null)
);
create unique index attributions_one on public.attributions (opportunity_id, role, coalesce(user_id::text, lower(person_name)));
alter table public.attributions enable row level security;

create table public.commission_agreements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default private.current_ws() references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  title text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'ended')),
  effective_from date not null,
  effective_to date,
  basis text not null check (basis in ('revenue', 'gross_profit')),
  profit_definition text,          -- required for gross_profit: exactly what is subtracted
  trigger_event text not null check (trigger_event in ('booked', 'completed', 'invoiced', 'collected')),
  first_job_rate numeric not null check (first_job_rate >= 0 and first_job_rate <= 1),
  repeat_rate numeric not null check (repeat_rate >= 0 and repeat_rate <= 1),
  credited_roles text[] not null default '{sourced,closed}',
  eligible_services text[],        -- null = all services
  eligible_company_ids uuid[],     -- null = all accounts
  excluded_company_ids uuid[] not null default '{}',
  approved_by_name text,           -- who approved it at the company (not a login)
  approved_on date,
  document_note text,              -- where the signed agreement is (or a document id once documents exist)
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint active_needs_approval check (status <> 'active' or (approved_by_name is not null and approved_on is not null)),
  constraint profit_needs_definition check (basis <> 'gross_profit' or profit_definition is not null)
);
alter table public.commission_agreements enable row level security;

-- ---------------------------------------------------------------- handoff and award
create or replace function private.build_handoff(p_job uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'built_at', now(),
    'customer', jsonb_build_object('company', c.name, 'company_id', c.id, 'phone', c.phone,
      'contacts', (select coalesce(jsonb_agg(jsonb_build_object('name', k.name, 'title', k.title, 'role', k.buying_role,
          'phone', case when k.do_not_contact then null else k.phone end, 'email', case when k.do_not_contact or k.email_is_guess then null else k.email end,
          'verification', k.verification)), '[]')
        from public.contacts k where k.company_id = c.id and not k.archived and (k.workspace_id is null or k.workspace_id = j.workspace_id))),
    'site', jsonb_build_object('address', coalesce(er.job_address, p.location_text), 'city', coalesce(er.job_city, p.city), 'county', coalesce(er.job_county, p.county),
      'site_contact', er.site_contact, 'working_hours', er.working_hours, 'access', er.access_notes, 'work_area', er.work_area,
      'power', er.power_available, 'water', er.water_available, 'removal', er.removal_required, 'disposal', er.disposal_notes, 'requested_date', er.requested_date),
    'accepted_scope', case when v.id is not null then jsonb_build_object('quote_ref', q.ref, 'version_no', v.version_no, 'total', private.version_total(v.id),
        'scope_summary', v.scope_summary, 'assumptions', v.assumptions, 'exclusions', v.exclusions,
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('description', l.description, 'qty', l.qty, 'unit', l.unit, 'qty_source', l.qty_source, 'kind', l.kind) order by l.line_no), '[]')
                  from public.quote_lines l where l.version_id = v.id)) end,
    'services', to_jsonb(o.services),
    'customer_requirements', a.note,
    'unresolved', (select coalesce(jsonb_agg(x), '[]') from (
        select 'Estimate request still missing: ' || (m->>'label') x from jsonb_array_elements(coalesce(er.missing, '[]')) m
        union all select f->>'text' from jsonb_array_elements(case when v.id is not null then private.version_flags(v.id) else '[]' end) f where f->>'level' = 'review'
        union all select 'No accepted quote version is linked to this award' where v.id is null
        union all select 'No requested start date' where coalesce(er.requested_date, j.requested_start) is null) z),
    'scheduling', jsonb_build_object('status', j.status, 'requested_start', coalesce(j.requested_start, er.requested_date), 'scheduled_start', j.scheduled_start,
      'confirmed_by', j.schedule_source, 'note', 'Dates are set only when dispatch confirms them; nothing here books a crew.'))
  from public.jobs j
  join public.opportunities o on o.id = j.opportunity_id
  left join public.projects p on p.id = o.project_id
  left join public.companies c on c.id = o.company_id
  left join public.awards a on a.id = j.award_id
  left join public.quote_versions v on v.id = a.quote_version_id
  left join public.quotes q on q.id = v.quote_id
  left join public.estimate_requests er on er.id = coalesce(q.estimate_request_id, (select id from public.estimate_requests where opportunity_id = o.id order by received_at desc limit 1))
  where j.id = p_job $$;

-- fills attribution roles nobody has set yet: sourced (who added or first claimed it), developed (owner), quoted (who
-- prepared the accepted version), closed (who recorded the award). People can change these afterwards.
create or replace function private.default_attributions(p_opp uuid, p_closer uuid, p_version uuid) returns void language plpgsql security definer set search_path = '' as $$
declare o public.opportunities; v_quoter uuid;
begin
  select * into o from public.opportunities where id = p_opp;
  select prepared_by into v_quoter from public.quote_versions where id = p_version;
  insert into public.attributions (workspace_id, opportunity_id, role, user_id, note)
  select o.workspace_id, o.id, x.role, x.uid, 'set automatically when the award was recorded' from (values
    ('sourced', coalesce(o.created_by, (select to_user from public.ownership_history where opportunity_id = o.id and action = 'claim' order by created_at limit 1), o.owner_id)),
    ('developed', o.owner_id), ('quoted', v_quoter), ('closed', p_closer)) x(role, uid)
  where x.uid is not null and not exists (select 1 from public.attributions a where a.opportunity_id = o.id and a.role = x.role)
  on conflict do nothing;
end $$;

create or replace function public.record_award(p_opportunity uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); o public.opportunities; v public.quote_versions; a public.awards; j uuid; v_amount numeric;
begin
  select * into o from private.v_opportunities where id = p_opportunity for update;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if o.owner_id is distinct from me.id and me.role <> 'manager' then raise exception 'not_owner' using errcode = '42501'; end if;
  if coalesce(p->>'method', '') not in ('signed_quote', 'purchase_order', 'subcontract', 'email', 'verbal') then
    raise exception 'confirmation_required' using errcode = '22023', hint = 'Say how the customer confirmed the award (signed quote, PO, subcontract, email or verbal).'; end if;
  if p->>'quote_version_id' is not null then
    select qv.* into v from public.quote_versions qv join public.quotes q on q.id = qv.quote_id where qv.id = (p->>'quote_version_id')::uuid and q.opportunity_id = o.id;
    if v.id is null then raise exception 'bad_version' using errcode = '22023'; end if;
    if v.status not in ('sent', 'rejected', 'accepted') then raise exception 'version_not_sent' using errcode = '22023', hint = 'A draft or unsent version cannot be awarded.'; end if;
  end if;
  v_amount := coalesce(nullif(p->>'amount', '')::numeric, case when v.id is not null then private.version_total(v.id) end);
  insert into private.v_awards (opportunity_id, quote_version_id, amount, confirmed_on, method, reference, note, recorded_by)
  values (o.id, v.id, v_amount, coalesce(nullif(p->>'confirmed_on', '')::date, (now() at time zone 'America/New_York')::date), p->>'method',
          nullif(trim(p->>'reference'), ''), nullif(trim(p->>'note'), ''), me.id)
  returning * into a;
  if v.id is not null then
    update public.quote_versions set status = 'accepted', decided_at = now(), decided_note = 'Awarded: ' || a.method || coalesce(' ' || a.reference, '') where id = v.id and status <> 'accepted';
    update public.quote_versions set status = 'superseded' where quote_id = v.quote_id and id <> v.id and status in ('sent', 'approved', 'draft');
  end if;
  update public.opportunities set stage = 'won', closed_at = now(), quote_status = 'accepted',
    outcome_reason = coalesce(nullif(trim(p->>'note'), ''), 'Awarded (' || replace(a.method, '_', ' ') || coalesce(', ' || a.reference, '') || ')'),
    next_action = null, next_action_due = null, last_activity_at = now(), last_activity_by = me.id, last_activity_summary = 'Award recorded'
   where id = o.id;
  insert into private.v_jobs (award_id, opportunity_id, title, amount, requested_start, created_by)
  values (a.id, o.id, o.title, a.amount, nullif(p->>'requested_start', '')::date, me.id) returning id into j;
  update public.jobs set handoff = private.build_handoff(j) where id = j;
  insert into public.tasks (workspace_id, opportunity_id, company_id, kind, title, due_at, assigned_to, origin, dedupe_key, created_by)
  values (o.workspace_id, o.id, o.company_id, 'handoff', 'Review the job handoff and send it to scheduling', private.due_at_et((now() at time zone 'America/New_York')::date + 1),
          coalesce(o.owner_id, me.id), 'system', 'handoff:' || j, me.id) on conflict do nothing;
  perform private.default_attributions(o.id, me.id, v.id);
  insert into public.activities (opportunity_id, company_id, user_id, kind, body, from_stage, to_stage, data)
  values (o.id, o.company_id, me.id, 'stage', 'Award recorded: ' || replace(a.method, '_', ' ') || coalesce(' ' || a.reference, '') ||
            coalesce(' for ' || to_char(a.amount, 'FM$999,999,990.00'), ' (no amount recorded)'), o.stage, 'won',
          jsonb_build_object('award', a.id, 'job', j));
  return jsonb_build_object('ok', true, 'award_id', a.id, 'job_id', j);
end $$;

-- stage requirement: Awarded needs an award record. The older board flow (a reason typed when moving to Awarded) is kept:
-- the typed reason becomes the recorded confirmation and the amount comes only from a sent version, never from a draft.
create or replace function private.require_award_for_won() returns trigger language plpgsql security definer set search_path = '' as $$
declare v uuid; a uuid; j uuid;
begin
  if new.stage = 'won' and old.stage is distinct from 'won' and not exists (select 1 from public.awards where opportunity_id = new.id) then
    if nullif(trim(coalesce(new.outcome_reason, '')), '') is null then
      raise exception 'award_confirmation_required' using errcode = '22023', hint = 'Record how the customer confirmed the award.';
    end if;
    select qv.id into v from public.quote_versions qv join public.quotes q on q.id = qv.quote_id
     where q.opportunity_id = new.id and qv.status in ('accepted', 'sent') order by (qv.status = 'accepted') desc, qv.sent_at desc nulls last limit 1;
    insert into public.awards (workspace_id, opportunity_id, quote_version_id, amount, confirmed_on, method, note, recorded_by)
    values (new.workspace_id, new.id, v, case when v is not null then private.version_total(v) end, (now() at time zone 'America/New_York')::date, 'recorded',
            new.outcome_reason, auth.uid()) returning id into a;
    if v is not null then update public.quote_versions set status = 'accepted', decided_at = now(), decided_note = 'Awarded' where id = v and status = 'sent'; end if;
    insert into public.jobs (workspace_id, award_id, opportunity_id, title, amount, created_by)
    values (new.workspace_id, a, new.id, new.title, case when v is not null then private.version_total(v) end, auth.uid()) returning id into j;
    update public.jobs set handoff = private.build_handoff(j) where id = j;
    perform private.default_attributions(new.id, coalesce(auth.uid(), new.owner_id), v);
  end if;
  return new;
end $$;
create trigger opportunities_award_won after update of stage on public.opportunities for each row execute function private.require_award_for_won();

-- ---------------------------------------------------------------- jobs, invoices, payments
create or replace function private.job_for_me(p_job uuid) returns public.jobs language plpgsql security definer set search_path = '' as $$
declare j public.jobs; o public.opportunities; me public.profiles := private.require_active();
begin
  select * into j from private.v_jobs where id = p_job;
  if j.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into o from public.opportunities where id = j.opportunity_id;
  if o.owner_id is distinct from me.id and me.role <> 'manager' and not private.is_member(j.workspace_id, array['owner', 'manager']) then
    raise exception 'not_owner' using errcode = '42501'; end if;
  return j;
end $$;

create or replace function private.job_json(p_job uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(j) || jsonb_build_object(
    'invoices', (select coalesce(jsonb_agg(to_jsonb(i) || jsonb_build_object('paid', coalesce((select sum(amount) from public.payments where invoice_id = i.id), 0),
        'balance', i.amount - coalesce((select sum(amount) from public.payments where invoice_id = i.id), 0),
        'payments', (select coalesce(jsonb_agg(to_jsonb(pm) order by pm.received_on), '[]') from public.payments pm where pm.invoice_id = i.id)) order by i.issued_on), '[]')
      from public.invoices i where i.job_id = j.id),
    'award', (select to_jsonb(a) from public.awards a where a.id = j.award_id),
    'reviewed_by_name', (select full_name from public.profiles where id = j.handoff_reviewed_by))
  from public.jobs j where j.id = p_job $$;

create or replace function public.get_job(p_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.job_for_me(p_id); return private.job_json(p_id); end $$;

create or replace function public.update_job(p_id uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); j public.jobs := private.job_for_me(p_id); o public.opportunities; v_status text := nullif(p->>'status', '');
begin
  select * into o from public.opportunities where id = j.opportunity_id;
  if (p->>'refresh_handoff')::boolean then update public.jobs set handoff = private.build_handoff(j.id), updated_at = now() where id = j.id; end if;
  if (p->>'handoff_reviewed')::boolean then
    update public.jobs set handoff = private.build_handoff(j.id), handoff_reviewed_by = me.id, handoff_reviewed_at = now(), updated_at = now() where id = j.id;
    update public.tasks set status = 'done', completed_at = now(), completed_by = me.id, outcome = 'Handoff reviewed' where dedupe_key = 'handoff:' || j.id and status = 'open';
  end if;
  if v_status = 'scheduled' and (nullif(p->>'scheduled_start', '') is null or nullif(trim(coalesce(p->>'schedule_source', '')), '') is null) then
    raise exception 'schedule_confirmation_required' using errcode = '22023', hint = 'A job is scheduled only with a date and who confirmed it (dispatch).';
  end if;
  if v_status = 'completed' and nullif(p->>'completed_on', '') is null then raise exception 'completed_date_required' using errcode = '22023'; end if;
  if v_status = 'cancelled' and nullif(trim(coalesce(p->>'cancelled_reason', '')), '') is null then raise exception 'reason_required' using errcode = '22023'; end if;
  update public.jobs set
    status = coalesce(v_status, status),
    requested_start = case when p ? 'requested_start' then nullif(p->>'requested_start', '')::date else requested_start end,
    scheduled_start = case when v_status = 'scheduled' or p ? 'scheduled_start' then nullif(p->>'scheduled_start', '')::date else scheduled_start end,
    schedule_source = case when v_status = 'scheduled' or p ? 'schedule_source' then nullif(trim(p->>'schedule_source'), '') else schedule_source end,
    completed_on = case when v_status = 'completed' then (p->>'completed_on')::date else completed_on end,
    cancelled_reason = case when v_status = 'cancelled' then trim(p->>'cancelled_reason') else cancelled_reason end,
    direct_cost = case when p ? 'direct_cost' then nullif(p->>'direct_cost', '')::numeric else direct_cost end,
    amount = case when p ? 'amount' then nullif(p->>'amount', '')::numeric else amount end,
    follow_up_on = case when v_status = 'completed' then coalesce(nullif(p->>'follow_up_on', '')::date, (p->>'completed_on')::date + 60)
                        when p ? 'follow_up_on' then nullif(p->>'follow_up_on', '')::date else follow_up_on end,
    notes = case when p ? 'notes' then nullif(p->>'notes', '') else notes end, updated_at = now()
  where id = j.id returning * into j;
  if v_status = 'completed' then
    -- repeat business: a check-in after the job, and one for anything left unresolved
    insert into public.tasks (workspace_id, opportunity_id, company_id, kind, title, due_at, assigned_to, origin, dedupe_key, created_by)
    values (j.workspace_id, o.id, o.company_id, 'call', 'Check in after job ' || j.ref || ': how it went, and what is coming up next',
            private.due_at_et(j.follow_up_on), coalesce(o.owner_id, me.id), 'system', 'repeat:' || j.id, me.id) on conflict do nothing;
    update public.company_accounts set relationship = case when relationship in ('prospect', 'active') then 'customer' when relationship = 'customer' then 'repeat' else relationship end,
      updated_at = now() where workspace_id = j.workspace_id and company_id = o.company_id;
    insert into public.company_accounts (workspace_id, company_id, relationship) values (j.workspace_id, o.company_id, 'customer') on conflict do nothing;
  end if;
  if v_status is not null then
    insert into public.activities (opportunity_id, company_id, user_id, kind, body, data)
    values (o.id, o.company_id, me.id, 'note', 'Job ' || j.ref || ': ' || replace(v_status, '_', ' ') ||
      coalesce(' (' || to_char(j.scheduled_start, 'Mon DD') || ', confirmed by ' || j.schedule_source || ')', ''), jsonb_build_object('job', j.id));
  end if;
  return private.job_json(j.id);
end $$;

create or replace function public.save_invoice(p_job uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); j public.jobs := private.job_for_me(p_job);
begin
  if p->>'id' is not null then
    if p->>'status' = 'void' then
      if nullif(trim(coalesce(p->>'void_reason', '')), '') is null then raise exception 'reason_required' using errcode = '22023'; end if;
      update private.v_invoices set status = 'void', void_reason = trim(p->>'void_reason') where id = (p->>'id')::uuid and job_id = j.id;
    end if;
    return private.job_json(j.id);
  end if;
  if nullif(trim(coalesce(p->>'number', '')), '') is null or nullif(p->>'amount', '') is null or nullif(p->>'issued_on', '') is null then
    raise exception 'invoice_incomplete' using errcode = '22023', hint = 'Number, amount and issue date are required.'; end if;
  insert into private.v_invoices (job_id, number, amount, issued_on, due_on, created_by)
  values (j.id, trim(p->>'number'), (p->>'amount')::numeric, (p->>'issued_on')::date, nullif(p->>'due_on', '')::date, me.id);
  return private.job_json(j.id);
end $$;

create or replace function public.record_payment(p_invoice uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); i public.invoices;
begin
  select * into i from private.v_invoices where id = p_invoice;
  if i.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.job_for_me(i.job_id);
  if i.status = 'void' then raise exception 'invoice_void' using errcode = '22023'; end if;
  if nullif(p->>'amount', '') is null or (p->>'amount')::numeric = 0 or nullif(p->>'received_on', '') is null then
    raise exception 'payment_incomplete' using errcode = '22023', hint = 'Amount and date received are required.'; end if;
  insert into public.payments (workspace_id, invoice_id, amount, received_on, method, reference, created_by)
  values (i.workspace_id, i.id, (p->>'amount')::numeric, (p->>'received_on')::date, nullif(p->>'method', ''), nullif(p->>'reference', ''), me.id);
  return private.job_json(i.job_id);
end $$;

-- quoted, awarded, completed, invoiced and collected for one lead, each from its own records
create or replace function public.money_summary(p_opportunity uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); o public.opportunities; r jsonb;
begin
  select * into o from private.v_opportunities where id = p_opportunity;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if o.owner_id is distinct from me.id and me.role <> 'manager' then raise exception 'not_owner' using errcode = '42501'; end if;
  select jsonb_build_object(
    'quoted', (select private.version_total(v.id) from public.quote_versions v join public.quotes q on q.id = v.quote_id
                where q.opportunity_id = o.id and v.status in ('sent', 'accepted') order by (v.status = 'accepted') desc, v.sent_at desc nulls last limit 1),
    'awarded', (select sum(amount) from public.awards where opportunity_id = o.id),
    'awards_without_amount', (select count(*) from public.awards where opportunity_id = o.id and amount is null),
    'completed', (select sum(amount) from public.jobs where opportunity_id = o.id and status = 'completed'),
    'invoiced', (select sum(i.amount) from public.invoices i join public.jobs j on j.id = i.job_id where j.opportunity_id = o.id and i.status = 'issued'),
    'collected', (select sum(pm.amount) from public.payments pm join public.invoices i on i.id = pm.invoice_id join public.jobs j on j.id = i.job_id
                   where j.opportunity_id = o.id and i.status = 'issued'),
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object('id', j.id, 'ref', j.ref, 'status', j.status, 'amount', j.amount, 'scheduled_start', j.scheduled_start,
        'handoff_reviewed', j.handoff_reviewed_at is not null) order by j.created_at), '[]') from public.jobs j where j.opportunity_id = o.id),
    'attribution', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'role', a.role, 'user_id', a.user_id,
        'name', coalesce((select full_name from public.profiles where id = a.user_id), a.person_name), 'share', a.share, 'note', a.note) order by a.role), '[]')
      from public.attributions a where a.opportunity_id = o.id)) into r;
  -- checks a reader can trust: invoices above the award, payments above invoices
  r := r || jsonb_build_object('warnings', to_jsonb(array_remove(array[
    case when (r->>'invoiced')::numeric > (r->>'awarded')::numeric then 'Invoiced is more than awarded: record the change order or check the invoice.' end,
    case when (r->>'collected')::numeric > (r->>'invoiced')::numeric then 'Collected is more than invoiced.' end,
    case when (r->>'awards_without_amount')::int > 0 then 'An award has no amount recorded.' end], null)));
  return r;
end $$;

create or replace function public.set_attribution(p_opportunity uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); o public.opportunities;
begin
  select * into o from private.v_opportunities where id = p_opportunity;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if o.owner_id is distinct from me.id and me.role <> 'manager' then raise exception 'not_owner' using errcode = '42501'; end if;
  if p->>'role' not in ('sourced', 'developed', 'quoted', 'closed') then raise exception 'bad_role' using errcode = '22023'; end if;
  if (p->>'remove')::boolean then
    delete from public.attributions where opportunity_id = o.id and role = p->>'role'
      and coalesce(user_id::text, lower(person_name)) = coalesce(p->>'user_id', lower(p->>'person_name'));
  else
    if p->>'user_id' is not null and not private.is_member_of(o.workspace_id, (p->>'user_id')::uuid) then raise exception 'not_a_member' using errcode = '22023'; end if;
    insert into public.attributions (workspace_id, opportunity_id, role, user_id, person_name, share, note, set_by)
    values (o.workspace_id, o.id, p->>'role', nullif(p->>'user_id', '')::uuid, nullif(trim(p->>'person_name'), ''), coalesce(nullif(p->>'share', '')::numeric, 1), nullif(p->>'note', ''), me.id)
    on conflict (opportunity_id, role, coalesce(user_id::text, lower(person_name))) do update set share = excluded.share, note = excluded.note, set_by = me.id, set_at = now();
  end if;
  insert into public.activities (opportunity_id, company_id, user_id, kind, body, data)
  values (o.id, o.company_id, me.id, 'note', 'Attribution changed: ' || (p->>'role'), p);
  return public.money_summary(o.id);
end $$;

-- ---------------------------------------------------------------- commission
create or replace function public.save_commission_agreement(p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); v_ws uuid := private.current_ws(); v_id uuid;
begin
  if not private.is_member(v_ws, array['owner', 'manager']) and coalesce(nullif(p->>'user_id', '')::uuid, me.id) <> me.id then
    raise exception 'workspace_manager_only' using errcode = '42501'; end if;
  insert into public.commission_agreements (id, workspace_id, user_id, title, status, effective_from, effective_to, basis, profit_definition, trigger_event,
    first_job_rate, repeat_rate, credited_roles, eligible_services, eligible_company_ids, excluded_company_ids, approved_by_name, approved_on, document_note, notes, created_by)
  values (coalesce(nullif(p->>'id', '')::uuid, gen_random_uuid()), v_ws, coalesce(nullif(p->>'user_id', '')::uuid, me.id), trim(p->>'title'), coalesce(nullif(p->>'status', ''), 'draft'),
    (p->>'effective_from')::date, nullif(p->>'effective_to', '')::date, p->>'basis', nullif(trim(p->>'profit_definition'), ''), p->>'trigger_event',
    (p->>'first_job_rate')::numeric, (p->>'repeat_rate')::numeric, coalesce((select array_agg(x) from jsonb_array_elements_text(p->'credited_roles') x), '{sourced,closed}'),
    (select array_agg(x) from jsonb_array_elements_text(p->'eligible_services') x), (select array_agg(x::uuid) from jsonb_array_elements_text(p->'eligible_company_ids') x),
    coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p->'excluded_company_ids') x), '{}'),
    nullif(trim(p->>'approved_by_name'), ''), nullif(p->>'approved_on', '')::date, nullif(p->>'document_note', ''), nullif(p->>'notes', ''), me.id)
  on conflict (id) do update set title = excluded.title, status = excluded.status, effective_from = excluded.effective_from, effective_to = excluded.effective_to,
    basis = excluded.basis, profit_definition = excluded.profit_definition, trigger_event = excluded.trigger_event, first_job_rate = excluded.first_job_rate,
    repeat_rate = excluded.repeat_rate, credited_roles = excluded.credited_roles, eligible_services = excluded.eligible_services,
    eligible_company_ids = excluded.eligible_company_ids, excluded_company_ids = excluded.excluded_company_ids, approved_by_name = excluded.approved_by_name,
    approved_on = excluded.approved_on, document_note = excluded.document_note, notes = excluded.notes
  where public.commission_agreements.workspace_id = v_ws
  returning id into v_id;
  return (select to_jsonb(c) from public.commission_agreements c where id = v_id);
end $$;

-- every commission line traces to its agreement and to the award, job, invoice or payment it is calculated from.
-- With no active agreement the lines are labelled 'no_agreement' (no amount), or 'scenario' when a what-if rate is given.
create or replace function public.commission_report(p jsonb default '{}') returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); v_ws uuid := private.current_ws(); v_user uuid := coalesce(nullif(p->>'user_id', '')::uuid, me.id);
  v_from date := coalesce(nullif(p->>'from', '')::date, date_trunc('year', now())::date); v_to date := coalesce(nullif(p->>'to', '')::date, current_date);
  v_scn numeric := nullif(p->>'scenario_rate', '')::numeric; v_scn_trigger text := coalesce(nullif(p->>'scenario_trigger', ''), 'collected');
  lines jsonb := '[]'; e record; ag public.commission_agreements; v_share numeric; v_rate numeric; v_repeat boolean; v_base numeric; v_status text; v_amount numeric;
begin
  if v_user <> me.id and not private.is_member(v_ws, array['owner', 'manager']) then raise exception 'workspace_manager_only' using errcode = '42501'; end if;
  for e in
    with ev as (
      select 'booked' as event, a.confirmed_on as on_date, a.amount as base, a.opportunity_id as opp, 'award' as rec_type, a.id as rec_id, null::uuid as job_id from public.awards a
       where a.workspace_id = v_ws
      union all select 'completed', j.completed_on, j.amount, j.opportunity_id, 'job', j.id, j.id from public.jobs j where j.workspace_id = v_ws and j.status = 'completed'
      union all select 'invoiced', i.issued_on, i.amount, j.opportunity_id, 'invoice', i.id, j.id from public.invoices i join public.jobs j on j.id = i.job_id
       where i.workspace_id = v_ws and i.status = 'issued' and j.status <> 'cancelled'
      union all select 'collected', pm.received_on, pm.amount, j.opportunity_id, 'payment', pm.id, j.id from public.payments pm join public.invoices i on i.id = pm.invoice_id
       join public.jobs j on j.id = i.job_id where pm.workspace_id = v_ws and i.status = 'issued')
    select ev.*, o.ref, o.title, o.company_id, o.services, (select name from public.companies where id = o.company_id) company
    from ev join public.opportunities o on o.id = ev.opp
    where ev.on_date between v_from and v_to
    order by ev.on_date
  loop
    select * into ag from public.commission_agreements c where c.workspace_id = v_ws and c.user_id = v_user and c.status in ('active', 'ended')
      and c.approved_on is not null and c.trigger_event = e.event and c.effective_from <= e.on_date and (c.effective_to is null or c.effective_to >= e.on_date)
      order by c.effective_from desc limit 1;
    if ag.id is null and not (v_scn is not null and e.event = v_scn_trigger) then continue; end if;
    -- the user's credit on this lead: their largest share among the credited roles
    select max(share) into v_share from public.attributions where opportunity_id = e.opp and user_id = v_user
      and role = any(coalesce(ag.credited_roles, coalesce((select array_agg(x) from jsonb_array_elements_text(p->'scenario_roles') x), '{sourced,closed}')));
    if v_share is null then continue; end if;
    -- first job or repeat: had this company awarded work in this workspace before this lead's first award?
    v_repeat := exists (select 1 from public.awards a2 join public.opportunities o2 on o2.id = a2.opportunity_id
                         where a2.workspace_id = v_ws and o2.company_id = e.company_id and o2.id <> e.opp
                           and a2.confirmed_on < coalesce((select min(confirmed_on) from public.awards where opportunity_id = e.opp), e.on_date));
    v_base := e.base; v_status := 'owed'; v_amount := null;
    if ag.id is not null then
      if e.company_id = any(ag.excluded_company_ids) or (ag.eligible_company_ids is not null and not e.company_id = any(ag.eligible_company_ids))
         or (ag.eligible_services is not null and not (e.services && ag.eligible_services)) then
        v_status := 'not_eligible';
      elsif ag.basis = 'gross_profit' then
        -- profit = revenue minus the job's recorded direct cost, in proportion to this record's share of the job amount
        if e.job_id is null or (select direct_cost from public.jobs where id = e.job_id) is null or coalesce((select amount from public.jobs where id = e.job_id), 0) = 0 then
          v_status := 'needs_cost';
        else
          v_base := round(e.base * (1 - (select direct_cost / amount from public.jobs where id = e.job_id)), 2);
        end if;
      end if;
      v_rate := case when v_repeat then ag.repeat_rate else ag.first_job_rate end;
    else
      v_status := 'scenario'; v_rate := v_scn;
    end if;
    if v_status in ('owed', 'scenario') and v_base is not null then v_amount := round(v_base * v_rate * v_share, 2); end if;
    lines := lines || jsonb_build_array(jsonb_build_object('date', e.on_date, 'event', e.event, 'record_type', e.rec_type, 'record_id', e.rec_id,
      'opportunity_id', e.opp, 'ref', e.ref, 'title', e.title, 'company', e.company, 'repeat', v_repeat, 'base', v_base, 'rate', v_rate, 'share', v_share,
      'amount', v_amount, 'status', v_status, 'agreement_id', ag.id, 'agreement', ag.title));
  end loop;
  return jsonb_build_object('user_id', v_user, 'from', v_from, 'to', v_to, 'lines', lines,
    'owed', (select coalesce(sum((l->>'amount')::numeric), 0) from jsonb_array_elements(lines) l where l->>'status' = 'owed'),
    'scenario', (select coalesce(sum((l->>'amount')::numeric), 0) from jsonb_array_elements(lines) l where l->>'status' = 'scenario'),
    'agreements', (select coalesce(jsonb_agg(to_jsonb(c) order by c.effective_from), '[]') from public.commission_agreements c where c.workspace_id = v_ws and c.user_id = v_user),
    'note', case when not exists (select 1 from public.commission_agreements c where c.workspace_id = v_ws and c.user_id = v_user and c.status = 'active' and c.approved_on is not null)
            then 'No approved commission agreement is recorded. Amounts shown are scenarios, not money owed.' end);
end $$;

revoke all on function public.record_award(uuid, jsonb), public.get_job(uuid), public.update_job(uuid, jsonb), public.save_invoice(uuid, jsonb), public.record_payment(uuid, jsonb),
  public.money_summary(uuid), public.set_attribution(uuid, jsonb), public.save_commission_agreement(jsonb), public.commission_report(jsonb) from public, anon;
grant execute on function public.record_award(uuid, jsonb), public.get_job(uuid), public.update_job(uuid, jsonb), public.save_invoice(uuid, jsonb), public.record_payment(uuid, jsonb),
  public.money_summary(uuid), public.set_attribution(uuid, jsonb), public.save_commission_agreement(jsonb), public.commission_report(jsonb) to authenticated;
