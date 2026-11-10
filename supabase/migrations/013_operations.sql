-- Speedy Sales Portal: daily operations.
--   * quote tracking fields on opportunities (requested, status, sent, amount, decision date) and clearer call outcomes
--   * company profiles across projects, watchlists, saved searches, personal preferences (territory, services, notifications)
--   * a configurable morning schedule in Eastern time with a verified morning snapshot, retries and a 6 AM alert
--   * a morning briefing per person, a manager team report, and a missed-opportunity checker
-- Nothing here changes existing leads, owners, notes or history.

-- ---------------------------------------------------------------- quotes
alter table public.opportunities
  add column if not exists quote_requested_at date,
  add column if not exists quote_status text check (quote_status in ('requested','in_progress','sent','accepted','declined','no_response')),
  add column if not exists quote_decision_date date,
  add column if not exists quote_service text;
update public.opportunities set quote_status = case when stage = 'won' then 'accepted' when stage = 'lost' then 'declined' else 'sent' end
 where quote_sent_at is not null and quote_status is null;
update public.opportunities o set quote_status = 'requested',
  quote_requested_at = coalesce((select min(a.created_at)::date from public.activities a where a.opportunity_id = o.id and a.to_stage = 'quote_needed'), o.updated_at::date)
 where o.stage = 'quote_needed' and o.quote_status is null;
create index if not exists opportunities_company_idx on public.opportunities (company_id);
create index if not exists opportunities_owner_stage_idx on public.opportunities (owner_id, stage);
create index if not exists activities_company_idx on public.activities (company_id, created_at desc);
create index if not exists activities_created_idx on public.activities (created_at desc);

-- ---------------------------------------------------------------- personal preferences
alter table public.profiles add column if not exists prefs jsonb not null default '{}';

-- Notification kinds a person can turn off (managers' system alerts and anything not listed always arrive).
create or replace function private.notify_category(p_kind text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_kind in ('follow_up','follow_up_due','overdue','stale','stale_claim') then 'follow_ups'
    when p_kind in ('assign','assigned','manager_update','handoff') then 'assignments'
    when p_kind in ('deadline','deadline_soon') then 'deadlines'
    when p_kind in ('source_change','award','watch') then 'updates'
    when p_kind in ('discovery','review_digest') then 'discoveries'
    else null end
$$;

create or replace function private.notify(p_user uuid, p_opp uuid, p_kind text, p_title text, p_body text, p_dedupe text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare cat text := private.notify_category(p_kind);
begin
  if p_user is null then return; end if;
  if cat is not null and exists (select 1 from public.profiles where id = p_user and prefs #>> array['notify', cat] = 'false') then return; end if;
  insert into public.notifications (user_id, opportunity_id, kind, title, body, dedupe_key)
  values (p_user, p_opp, p_kind, p_title, p_body, p_dedupe)
  on conflict (dedupe_key) do nothing;
end $$;

create or replace function public.update_my_prefs(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; v jsonb;
begin
  me := private.require_active();
  v := coalesce(me.prefs, '{}');
  if p ? 'territory' then
    if exists (select 1 from jsonb_array_elements_text(p->'territory') x where x not in (select distinct region from public.fl_counties)) then
      raise exception 'bad_region' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('territory', p->'territory');
  end if;
  if p ? 'services' then v := v || jsonb_build_object('services', p->'services'); end if;
  if p ? 'notify' then
    v := v || jsonb_build_object('notify', coalesce(v->'notify', '{}') || (select coalesce(jsonb_object_agg(key, value), '{}') from jsonb_each(p->'notify')
          where key in ('follow_ups','assignments','deadlines','updates','discoveries') and jsonb_typeof(value) = 'boolean'));
  end if;
  update public.profiles set prefs = v where id = me.id;
  return jsonb_build_object('ok', true, 'prefs', v);
end $$;

-- ---------------------------------------------------------------- saved searches and watchlists
create table if not exists public.saved_searches (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  list text not null check (list in ('pool','mine','all','gov')),
  name text not null check (length(name) between 1 and 60),
  params jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (user_id, list, name)
);
create table if not exists public.watches (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((company_id is null) <> (project_id is null))
);
create unique index if not exists watches_company_uq on public.watches (user_id, company_id) where company_id is not null;
create unique index if not exists watches_project_uq on public.watches (user_id, project_id) where project_id is not null;
alter table public.saved_searches enable row level security;
alter table public.watches enable row level security;
revoke all on public.saved_searches, public.watches from anon, authenticated;

create or replace function public.my_saved_searches() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := private.require_active();
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'list', list, 'name', name, 'params', params) order by list, name)
                   from public.saved_searches where user_id = me.id), '[]');
end $$;

create or replace function public.save_search(p_list text, p_name text, p_params jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; v bigint;
begin
  me := private.require_active();
  if p_list = 'all' and me.role <> 'manager' then raise exception 'manager_only' using errcode = '42501'; end if;
  if (select count(*) from public.saved_searches where user_id = me.id) >= 30 then raise exception 'too_many' using errcode = '22023', hint = 'Up to 30 saved searches.'; end if;
  insert into public.saved_searches (user_id, list, name, params) values (me.id, p_list, trim(p_name), coalesce(p_params, '{}'))
  on conflict (user_id, list, name) do update set params = excluded.params returning id into v;
  return jsonb_build_object('ok', true, 'id', v);
end $$;

create or replace function public.delete_search(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := private.require_active();
  delete from public.saved_searches where id = p_id and user_id = me.id;
  return jsonb_build_object('ok', found);
end $$;

create or replace function public.toggle_watch(p_company uuid default null, p_project uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := private.require_active();
  if (p_company is null) = (p_project is null) then raise exception 'one_target' using errcode = '22023'; end if;
  delete from public.watches where user_id = me.id and company_id is not distinct from p_company and project_id is not distinct from p_project;
  if found then return jsonb_build_object('watching', false); end if;
  insert into public.watches (user_id, company_id, project_id) values (me.id, p_company, p_project);
  return jsonb_build_object('watching', true);
end $$;

-- A material source change notifies people watching the project; a new award notifies people watching the
-- contractor and anyone actively working another lead with that contractor.
create or replace function private.on_refresh_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.projects; w record; txt text;
begin
  if not new.material then return new; end if;
  select * into p from public.projects where id = new.project_id;
  txt := case new.field when 'winner' then 'Award update: ' || coalesce(new.new_value, '') when 'deadline' then 'Deadline changed to ' || coalesce(new.new_value, '')
              when 'stage' then 'Stage changed to ' || replace(coalesce(new.new_value, ''), '_', ' ') else initcap(replace(new.field, '_', ' ')) || ' changed' end;
  for w in select user_id from public.watches where project_id = p.id loop
    perform private.notify(w.user_id, null, 'watch', 'Watched project: ' || coalesce(p.short_title, p.title), txt, 'watch:' || new.id || ':' || w.user_id);
  end loop;
  if new.field = 'winner' and p.winner_company_id is not null then
    for w in select distinct user_id from (
               select user_id from public.watches where company_id = p.winner_company_id
               union select owner_id from public.opportunities where company_id = p.winner_company_id and owner_id is not null
                 and stage in ('claimed','contacted','qualified','quote_needed','quote_sent','follow_up','won','nurture') and project_id <> p.id) x loop
      perform private.notify(w.user_id, null, 'watch', 'A contractor you work with has a new award',
        txt || ' — ' || coalesce(p.short_title, p.title) || coalesce(' (' || p.region || ')', ''), 'cowin:' || p.id || ':' || p.winner_company_id || ':' || w.user_id);
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists refresh_change_watch on public.refresh_changes;
create trigger refresh_change_watch after insert on public.refresh_changes for each row execute function private.on_refresh_change();

-- ---------------------------------------------------------------- company profile
-- Everyone signed in sees who is working a contractor and when they were last contacted, so two people do not
-- make the same introductory call. Note text is shown only to managers, the person who wrote it, and the lead's owner.
create or replace function public.get_company(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles; c public.companies; mgr boolean;
begin
  me := private.require_active();
  mgr := me.role = 'manager';
  select * into c from public.companies where id = p_id;
  if c.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'company', jsonb_build_object('id', c.id, 'name', c.name, 'kind', c.kind, 'hq', c.hq, 'website', c.website, 'phone', c.phone, 'aliases', c.aliases),
    'watching', exists (select 1 from public.watches where user_id = me.id and company_id = c.id),
    'locations', (select coalesce(jsonb_agg(distinct x), '[]') from (
        select nullif(concat_ws(', ', p.city, p.region), '') x from public.opportunities o join public.projects p on p.id = o.project_id where o.company_id = c.id
        union select nullif(concat_ws(', ', p.city, p.region), '') from public.projects p where p.winner_company_id = c.id) l where x is not null),
    'contacts', (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'title', k.title, 'phone', k.phone, 'email', k.email,
                   'verified', k.verified, 'source', k.source, 'source_url', k.source_url) order by k.verified desc, k.created_at), '[]')
                 from public.contacts k where k.company_id = c.id and not k.archived),
    'opportunities', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'ref', o.ref, 'title', o.title, 'stage', o.stage, 'priority', o.priority,
                   'owner_id', o.owner_id, 'owner_name', u.full_name, 'next_action_due', case when mgr or o.owner_id = me.id then o.next_action_due end,
                   'last_activity_at', o.last_activity_at, 'needs_review', o.needs_review,
                   'quote_status', case when mgr or o.owner_id = me.id then o.quote_status end,
                   'quote_amount', case when mgr or o.owner_id = me.id then o.quote_amount end,
                   'project', jsonb_build_object('id', p.id, 'title', p.title, 'city', p.city, 'region', p.region, 'stage', p.stage, 'value', p.project_value, 'source_name', p.source_name))
                   order by (o.stage in ('won','lost','disqualified','archived')), o.updated_at desc), '[]')
                 from public.opportunities o join public.projects p on p.id = o.project_id left join public.profiles u on u.id = o.owner_id
                 where o.company_id = c.id and (not o.needs_review or mgr)),
    'awards', (select coalesce(jsonb_agg(jsonb_build_object('project_id', p.id, 'title', p.title, 'status', p.winner_status, 'amount', p.winner_amount,
                   'as_of', p.winner_as_of, 'owner', p.owner_name, 'region', p.region, 'source_url', p.winner_source_url) order by p.winner_as_of desc nulls last), '[]')
               from public.projects p where p.winner_company_id = c.id),
    'bids', (select coalesce(jsonb_agg(jsonb_build_object('project_id', p.id, 'title', p.title, 'amount', b->>'amount', 'rank', b->>'rank')), '[]')
             from public.projects p, jsonb_array_elements(p.bidders) b
             where private.norm_key(b->>'name') = c.name_key and p.winner_company_id is distinct from c.id),
    'history', (select coalesce(jsonb_agg(h order by h->>'at' desc), '[]') from (
        select jsonb_build_object('at', a.created_at, 'kind', a.kind, 'outcome', a.outcome, 'user_name', u.full_name, 'ref', o.ref, 'opportunity_id', o.id,
                 'body', case when mgr or a.user_id = me.id or o.owner_id = me.id then a.body end) h
          from public.activities a left join public.opportunities o on o.id = a.opportunity_id left join public.profiles u on u.id = a.user_id
         where (a.company_id = c.id or o.company_id = c.id) and a.kind in ('call','email','text','visit','meeting','note','quote','follow_up')
         order by a.created_at desc limit 40) x),
    'summary', (select jsonb_build_object(
        'open', count(*) filter (where o.stage in ('available','claimed','contacted','qualified','quote_needed','quote_sent','follow_up','nurture')),
        'won', count(*) filter (where o.stage = 'won'), 'lost', count(*) filter (where o.stage = 'lost'),
        'quotes', count(*) filter (where o.quote_status is not null),
        'owners', (select coalesce(jsonb_agg(distinct u.full_name), '[]') from public.opportunities x join public.profiles u on u.id = x.owner_id
                   where x.company_id = c.id and x.stage in ('claimed','contacted','qualified','quote_needed','quote_sent','follow_up','nurture')),
        'last_contact_at', (select max(a.created_at) from public.activities a left join public.opportunities y on y.id = a.opportunity_id
                            where (a.company_id = c.id or y.company_id = c.id) and a.kind in ('call','email','text','visit','meeting')),
        'next_follow_up', (select min(x.next_action_due) from public.opportunities x where x.company_id = c.id and (mgr or x.owner_id = me.id)
                           and x.stage in ('claimed','contacted','qualified','quote_needed','quote_sent','follow_up','nurture')))
      from public.opportunities o where o.company_id = c.id)
  );
end $$;

-- ---------------------------------------------------------------- morning schedule (Eastern time)
insert into public.settings (key, value, description) values
 ('refresh_schedule', '{"enabled": true, "morning": "04:15", "verify": "05:15", "snapshot": "05:30", "alert": "06:00", "midday": "12:15", "afternoon": "16:15", "midday_sources": ["fdot_lettings","sam_gov"], "afternoon_sources": ["fdot_lettings","usaspending_awards"]}',
  'Refresh times in Eastern time: morning collection, verify and retry, morning snapshot, manager alert if anything is late, and the lighter midday and afternoon checks.')
on conflict (key) do nothing;

create table if not exists public.morning_snapshots (
  day date primary key,
  started_at timestamptz,
  verify_at timestamptz,
  verified_at timestamptz,
  status text not null default 'collecting' check (status in ('collecting','verifying','ready','partial','failed')),
  sources jsonb not null default '[]',
  retries jsonb not null default '[]',
  summary jsonb not null default '{}',
  alerted_at timestamptz
);
create table if not exists private.scheduler_steps (day date not null, step text not null, done_at timestamptz not null default now(), detail jsonb, primary key (day, step));
alter table public.morning_snapshots enable row level security;
revoke all on public.morning_snapshots from anon, authenticated;

create or replace function private.hhmm(t text) returns int language sql immutable set search_path = '' as $$
  select split_part(t, ':', 1)::int * 60 + split_part(t, ':', 2)::int
$$;

-- Overlapping runs: a source that is already running (started in the last 8 minutes) is not started again.
create or replace function public.refresh_start_run(p_source text, p_trigger text default 'schedule', p_user uuid default null, p_attempt int default 1)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v bigint;
begin
  perform pg_advisory_xact_lock(hashtext('refresh:' || p_source));
  if p_trigger <> 'test' and exists (select 1 from public.refresh_runs where source_id = p_source and status = 'running' and started_at > now() - interval '8 minutes') then
    raise exception 'already_running' using errcode = '55P03', hint = 'This source is already refreshing.';
  end if;
  update public.refresh_runs set status = 'failed', finished_at = now(), error = 'Run stopped without finishing (time limit or crash)'
   where source_id = p_source and status = 'running' and started_at <= now() - interval '8 minutes';
  insert into public.refresh_runs (source_id, trigger, triggered_by, attempt) values (p_source, p_trigger, p_user, p_attempt) returning id into v;
  update public.sources set last_run_at = now() where id = p_source;
  return v;
end $$;

-- Status of every automated source for the run cycle that started at p_since.
create or replace function private.cycle_sources(p_since timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name,
           'status', case when r.id is null then 'not_run' when r.status = 'running' then 'running' else r.status end,
           'finished_at', r.finished_at, 'examined', r.examined, 'discovered', r.discovered, 'updated', r.updated, 'error', r.error) order by s.name), '[]')
  from public.sources s
  left join lateral (select * from public.refresh_runs x where x.source_id = s.id and x.started_at >= p_since - interval '5 minutes'
                     order by (x.status = 'success') desc, x.started_at desc limit 1) r on true
  where s.kind = 'automated' and s.enabled
$$;

create or replace function private.snapshot_summary(p_since timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'new_projects', (select count(*) from public.projects where discovered_at >= p_since),
    'new_relevant', (select count(*) from public.projects where discovered_at >= p_since and relevance in ('high','potential')),
    'new_documented', (select count(*) from public.projects where discovered_at >= p_since and relevance = 'high'),
    'new_awards', (select count(distinct project_id) from public.refresh_changes where field = 'winner' and created_at >= p_since),
    'updated_projects', (select count(distinct project_id) from public.refresh_changes where created_at >= p_since),
    'awaiting_review', (select count(*) from public.opportunities where needs_review),
    'unowned_hot', (select count(*) from public.opportunities where stage = 'available' and not needs_review and priority = 'Hot'),
    'available', (select count(*) from public.opportunities where stage = 'available' and not needs_review))
$$;

create or replace function private.scheduler_tick(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  cfg jsonb; loc timestamp := p_now at time zone 'America/New_York'; d date; m int; did text[] := '{}';
  s record; snap public.morning_snapshots; srcs jsonb; n_ok int; n_total int; delayed text; retried jsonb := '[]';
begin
  d := loc::date; m := extract(hour from loc)::int * 60 + extract(minute from loc)::int;
  select value into cfg from public.settings where key = 'refresh_schedule';
  if cfg is null or not coalesce((cfg->>'enabled')::boolean, true) then return jsonb_build_object('skipped', 'disabled'); end if;

  -- 1. morning collection: every automated source once (late ticks inside 75 minutes still start it)
  if m >= private.hhmm(cfg->>'morning') and m < private.hhmm(cfg->>'morning') + 75 then
    insert into private.scheduler_steps (day, step) values (d, 'morning') on conflict do nothing;
    if found then
      insert into public.morning_snapshots (day, started_at, status) values (d, p_now, 'collecting')
      on conflict (day) do update set started_at = excluded.started_at, status = 'collecting';
      for s in select id from public.sources where kind = 'automated' and enabled order by id loop perform private.call_refresh(s.id); end loop;
      did := did || 'morning'::text;
    end if;
  end if;

  -- 2. verify: retry anything that failed, stopped or never started
  if m >= private.hhmm(cfg->>'verify') and m < private.hhmm(cfg->>'verify') + 60 then
    insert into private.scheduler_steps (day, step) values (d, 'verify') on conflict do nothing;
    if found then
      select * into snap from public.morning_snapshots where day = d;
      if snap.day is not null then
        for s in select x->>'id' id, x->>'status' st from jsonb_array_elements(private.cycle_sources(snap.started_at)) x
                 where x->>'status' in ('failed','partial','not_run') loop
          perform private.call_refresh(s.id);
          retried := retried || jsonb_build_object('id', s.id, 'was', s.st, 'at', p_now);
        end loop;
        update public.morning_snapshots set status = 'verifying', verify_at = p_now, retries = retried where day = d;
      end if;
      did := did || 'verify'::text;
    end if;
  end if;

  -- 3. snapshot: re-rank and close out, then record what is verified
  if m >= private.hhmm(cfg->>'snapshot') and m < private.hhmm(cfg->>'snapshot') + 120 then
    insert into private.scheduler_steps (day, step) values (d, 'snapshot') on conflict do nothing;
    if found then
      perform public.daily_maintenance();
      insert into public.morning_snapshots (day, started_at, status) values (d, p_now, 'failed') on conflict (day) do nothing;
      select * into snap from public.morning_snapshots where day = d;
      srcs := private.cycle_sources(snap.started_at);
      select count(*) filter (where x->>'status' = 'success'), count(*) into n_ok, n_total from jsonb_array_elements(srcs) x;
      update public.morning_snapshots set sources = srcs, verified_at = p_now,
        status = case when n_total > 0 and n_ok = n_total then 'ready' when n_ok > 0 then 'partial' else 'failed' end,
        summary = private.snapshot_summary(snap.started_at) || jsonb_build_object('sources_ok', n_ok, 'sources_total', n_total)
      where day = d;
      did := did || 'snapshot'::text;
    end if;
  end if;

  -- 4. alert managers if the morning data is not complete by the alert time (late successes are counted first)
  if m >= private.hhmm(cfg->>'alert') and m < private.hhmm(cfg->>'alert') + 120 then
    insert into private.scheduler_steps (day, step) values (d, 'alert') on conflict do nothing;
    if found then
      select * into snap from public.morning_snapshots where day = d;
      if snap.day is not null and snap.status in ('partial','failed','collecting','verifying') then
        srcs := private.cycle_sources(snap.started_at);
        select count(*) filter (where x->>'status' = 'success'), count(*) into n_ok, n_total from jsonb_array_elements(srcs) x;
        if n_total > 0 and n_ok = n_total then
          update public.morning_snapshots set sources = srcs, status = 'ready', verified_at = p_now,
            summary = summary || jsonb_build_object('sources_ok', n_ok, 'sources_total', n_total) where day = d;
          select * into snap from public.morning_snapshots where day = d;
        else
          update public.morning_snapshots set sources = srcs, status = case when n_ok > 0 then 'partial' else 'failed' end,
            summary = summary || jsonb_build_object('sources_ok', n_ok, 'sources_total', n_total) where day = d;
          select * into snap from public.morning_snapshots where day = d;
        end if;
      end if;
      if snap.day is null or snap.status <> 'ready' then
        select string_agg((x->>'name') || ' (' || replace(x->>'status', '_', ' ') || coalesce(': ' || left(x->>'error', 120), '') || ')', '; ')
          into delayed from jsonb_array_elements(coalesce(snap.sources, '[]')) x where x->>'status' <> 'success';
        perform private.notify_managers(null, 'morning_refresh',
          case when snap.day is null then 'Morning refresh did not start' else 'Morning refresh incomplete: ' || coalesce(snap.summary->>'sources_ok', '0') || ' of ' || coalesce(snap.summary->>'sources_total', '?') || ' sources' end,
          coalesce('Delayed: ' || delayed || '. ', '') || 'Leads from the sources that worked are up to date; the others keep their last verified data. Sources and refreshes has the logs.',
          'morning:' || d);
        update public.morning_snapshots set alerted_at = p_now where day = d;
      end if;
      did := did || 'alert'::text;
    end if;
  end if;

  -- 5. lighter midday and afternoon checks
  if m >= private.hhmm(cfg->>'midday') and m < private.hhmm(cfg->>'midday') + 60 then
    insert into private.scheduler_steps (day, step) values (d, 'midday') on conflict do nothing;
    if found then
      for s in select x id from jsonb_array_elements_text(cfg->'midday_sources') x join public.sources y on y.id = x and y.enabled loop perform private.call_refresh(s.id); end loop;
      did := did || 'midday'::text;
    end if;
  end if;
  if m >= private.hhmm(cfg->>'afternoon') and m < private.hhmm(cfg->>'afternoon') + 60 then
    insert into private.scheduler_steps (day, step) values (d, 'afternoon') on conflict do nothing;
    if found then
      for s in select x id from jsonb_array_elements_text(cfg->'afternoon_sources') x join public.sources y on y.id = x and y.enabled loop perform private.call_refresh(s.id); end loop;
      did := did || 'afternoon'::text;
    end if;
  end if;
  return jsonb_build_object('et', to_char(loc, 'YYYY-MM-DD HH24:MI'), 'ran', did);
end $$;

-- Morning data status for everyone (no error text or logs; managers see those on Sources and refreshes).
create or replace function public.data_freshness() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles; s public.morning_snapshots;
begin
  me := private.require_active();
  select * into s from public.morning_snapshots order by day desc limit 1;
  return jsonb_build_object(
    'day', s.day, 'verified_at', s.verified_at, 'status', s.status,
    'sources_ok', coalesce((s.summary->>'sources_ok')::int, 0), 'sources_total', coalesce((s.summary->>'sources_total')::int, 0),
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'last_success_at', x.last_success_at,
                  'ok', x.last_status = 'success' and x.last_success_at > now() - interval '30 hours') order by x.name), '[]')
                from public.sources x where x.kind = 'automated' and x.enabled),
    'last_success_at', (select max(last_success_at) from public.sources where kind = 'automated'));
end $$;

-- ---------------------------------------------------------------- morning briefing
-- What changed since the morning collection started (or the last 24 hours), for the person signed in.
create or replace function public.my_briefing() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles; s public.morning_snapshots; since timestamptz; terr text[]; svc text[]; mgr boolean; out jsonb;
begin
  me := private.require_active();
  mgr := me.role = 'manager';
  select * into s from public.morning_snapshots order by day desc limit 1;
  since := coalesce(least(s.started_at, now() - interval '20 hours'), now() - interval '24 hours');
  terr := coalesce((select array_agg(x) from jsonb_array_elements_text(me.prefs->'territory') x), array[(select value #>> '{}' from public.settings where key = 'home_region')]);
  svc := (select array_agg(x) from jsonb_array_elements_text(me.prefs->'services') x);
  out := jsonb_build_object(
    'since', since, 'territory', to_jsonb(terr),
    'snapshot', case when s.day is null then null else jsonb_build_object('day', s.day, 'status', s.status, 'verified_at', s.verified_at,
                  'sources_ok', s.summary->'sources_ok', 'sources_total', s.summary->'sources_total') end,
    'new_hot', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'title', o.title, 'region', p.region, 'city', p.city, 'priority', o.priority) order by o.fit_score desc nulls last), '[]')
                from public.opportunities o join public.projects p on p.id = o.project_id
                where o.stage = 'available' and not o.needs_review and o.created_at >= since and o.priority = 'Hot' and p.region = any(terr)),
    'new_hot_elsewhere', (select count(*) from public.opportunities o join public.projects p on p.id = o.project_id
                where o.stage = 'available' and not o.needs_review and o.created_at >= since and o.priority = 'Hot' and not (p.region = any(terr))),
    'new_awards', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'title', o.title, 'region', p.region)), '[]')
                from public.opportunities o join public.projects p on p.id = o.project_id
                where o.kind = 'contractor_outreach' and o.stage = 'available' and not o.needs_review and o.created_at >= since),
    'new_matching', case when svc is null then null else (select count(*) from public.opportunities o
                where o.stage = 'available' and not o.needs_review and o.created_at >= since and o.services && svc) end,
    'my_deadlines', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'title', o.title, 'deadline', p.deadline) order by p.deadline), '[]')
                from public.opportunities o join public.projects p on p.id = o.project_id
                where o.owner_id = me.id and o.stage in ('claimed','contacted','qualified','quote_needed','quote_sent','follow_up')
                  and p.deadline between now() and now() + interval '7 days'),
    'my_overdue', (select count(*) from public.opportunities where owner_id = me.id and next_action_due < current_date
                and stage in ('claimed','contacted','qualified','quote_needed','quote_sent','follow_up','nurture')),
    'my_due_today', (select count(*) from public.opportunities where owner_id = me.id and next_action_due = current_date
                and stage in ('claimed','contacted','qualified','quote_needed','quote_sent','follow_up','nurture')),
    'my_quote_followups', (select count(*) from public.opportunities where owner_id = me.id and quote_status in ('sent','no_response')
                and stage in ('quote_sent','follow_up') and coalesce(last_activity_at, now() - interval '30 days') < now() - interval '5 days'),
    'my_changes', (select count(distinct c.project_id) from public.refresh_changes c join public.opportunities o on o.project_id = c.project_id
                where o.owner_id = me.id and c.material and c.created_at >= since));
  if mgr then
    out := out || jsonb_build_object('team', jsonb_build_object(
      'new_relevant', (select count(*) from public.projects where discovered_at >= since and relevance in ('high','potential')),
      'new_awards', (select count(distinct project_id) from public.refresh_changes where field = 'winner' and created_at >= since),
      'awaiting_review', (select count(*) from public.opportunities where needs_review),
      'unowned_hot', (select count(*) from public.opportunities where stage = 'available' and not needs_review and priority = 'Hot'),
      'stage_moves', (select coalesce(jsonb_object_agg(to_stage, n), '{}') from (select to_stage, count(*) n from public.activities
                      where to_stage is not null and created_at >= since and kind <> 'refresh' group by 1) x),
      'overdue_by_person', (select coalesce(jsonb_agg(jsonb_build_object('name', u.full_name, 'id', u.id, 'n', n) order by n desc), '[]') from (
                      select owner_id, count(*) n from public.opportunities where next_action_due < current_date
                        and stage in ('claimed','contacted','qualified','quote_needed','quote_sent','follow_up','nurture') group by 1) x
                      join public.profiles u on u.id = x.owner_id),
      'failed_sources', (select coalesce(jsonb_agg(x->>'name'), '[]') from jsonb_array_elements(coalesce(s.sources, '[]')) x where x->>'status' <> 'success')));
  end if;
  return out;
end $$;

-- ---------------------------------------------------------------- team report (managers)
-- Activity (what people did) is kept apart from outcomes (what came of it). Win rate shows only with 5+ closed leads.
create or replace function public.team_report(p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles; d_from timestamptz; d_to timestamptz; f_user uuid := nullif(p->>'user_id', '')::uuid;
        f_region text := nullif(p->>'region', ''); f_source text := nullif(p->>'source_id', ''); stale int;
        conv text[] := array['reached','spoke','requested_info','interested','not_interested','quote_requested','call_back','meeting_set','sent_info'];
begin
  me := private.require_manager();
  d_from := coalesce(nullif(p->>'from', '')::date, current_date - 30)::timestamptz;
  d_to := (coalesce(nullif(p->>'to', '')::date, current_date) + 1)::timestamptz;
  stale := coalesce((select (value #>> '{}')::int from public.settings where key = 'stale_days'), 14);
  return (with opp as (
      select o.* from public.opportunities o join public.projects pj on pj.id = o.project_id
       where (f_region is null or pj.region = f_region) and (f_source is null or pj.source_id = f_source)),
    act as (
      select a.* from public.activities a join opp o on o.id = a.opportunity_id
       where a.created_at >= d_from and a.created_at < d_to and a.user_id is not null and (f_user is null or a.user_id = f_user)),
    per as (
      select u.id, u.full_name,
        (select count(*) from public.ownership_history h join opp o on o.id = h.opportunity_id where h.to_user = u.id and h.action in ('claim','assign','reassign') and h.created_at >= d_from and h.created_at < d_to) as claimed,
        count(a.*) filter (where a.kind in ('call','email','text','visit','meeting')) as attempts,
        count(a.*) filter (where a.kind in ('call','email','text','visit','meeting') and a.outcome = any(conv)) as conversations,
        count(a.*) filter (where a.data->'changes' ? 'next_action_due') as follow_ups_set,
        count(a.*) filter (where a.to_stage = 'quote_needed') as quotes_requested,
        count(a.*) filter (where a.to_stage = 'quote_sent') as quotes_sent,
        count(a.*) filter (where a.to_stage = 'won') as won,
        count(a.*) filter (where a.to_stage = 'lost') as lost,
        (select count(*) from opp o where o.owner_id = u.id and o.stage in ('claimed','contacted','qualified','quote_needed','quote_sent','follow_up')) as active_now,
        (select count(*) from opp o where o.owner_id = u.id and o.stage in ('claimed','contacted','qualified','quote_needed','quote_sent','follow_up')
           and coalesce(o.last_activity_at, o.claimed_at) < now() - make_interval(days => stale)) as inactive_now,
        (select count(*) from opp o where o.owner_id = u.id and o.next_action_due < current_date
           and o.stage in ('claimed','contacted','qualified','quote_needed','quote_sent','follow_up','nurture')) as overdue_now
      from public.profiles u left join act a on a.user_id = u.id
      where u.active and (f_user is null or u.id = f_user)
      group by u.id, u.full_name),
    moves as (
      select a.opportunity_id, a.from_stage, a.created_at, lag(a.created_at) over (partition by a.opportunity_id order by a.created_at) prev
        from public.activities a join opp o on o.id = a.opportunity_id where a.to_stage is not null),
    stage_time as (
      select from_stage stage, round(avg(extract(epoch from (created_at - prev)) / 86400)::numeric, 1) days, count(*) n
        from moves where prev is not null and created_at >= d_from and created_at < d_to
         and from_stage in ('claimed','contacted','qualified','quote_needed','quote_sent','follow_up') group by 1)
    select jsonb_build_object(
      'from', d_from::date, 'to', (d_to - interval '1 day')::date, 'stale_days', stale,
      'people', (select coalesce(jsonb_agg(to_jsonb(per) order by per.full_name), '[]') from per),
      'totals', (select jsonb_build_object('claimed', sum(claimed), 'attempts', sum(attempts), 'conversations', sum(conversations),
                   'follow_ups_set', sum(follow_ups_set), 'quotes_requested', sum(quotes_requested), 'quotes_sent', sum(quotes_sent),
                   'won', sum(won), 'lost', sum(lost), 'inactive_now', sum(inactive_now), 'overdue_now', sum(overdue_now),
                   'win_rate', case when sum(won) + sum(lost) >= 5 then round(100.0 * sum(won) / (sum(won) + sum(lost))) end) from per),
      'stage_time', (select coalesce(jsonb_agg(to_jsonb(stage_time)), '[]') from stage_time),
      'by_source', (select coalesce(jsonb_agg(jsonb_build_object('source', s.name, 'won', x.won, 'quotes', x.quotes, 'active', x.active) order by x.active desc), '[]') from (
                    select pj.source_id, count(*) filter (where o.stage = 'won' and o.closed_at >= d_from and o.closed_at < d_to) won,
                      count(*) filter (where o.quote_status is not null) quotes,
                      count(*) filter (where o.stage in ('claimed','contacted','qualified','quote_needed','quote_sent','follow_up')) active
                    from opp o join public.projects pj on pj.id = o.project_id group by 1) x join public.sources s on s.id = x.source_id),
      'quotes_attention', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'ref', o.ref, 'title', o.title, 'owner', u.full_name, 'quote_status', o.quote_status,
                   'requested', o.quote_requested_at, 'sent', o.quote_sent_at, 'amount', o.quote_amount, 'decision', o.quote_decision_date, 'due', o.next_action_due)
                   order by coalesce(o.quote_sent_at, o.quote_requested_at)), '[]')
                 from opp o left join public.profiles u on u.id = o.owner_id
                 where (o.quote_status = 'requested' and o.quote_requested_at < current_date - 2)
                    or (o.quote_status in ('sent','no_response') and o.stage not in ('won','lost','disqualified','archived')
                        and coalesce(o.next_action_due, o.quote_sent_at + 7) <= current_date))));
end $$;

-- ---------------------------------------------------------------- missed-opportunity checker (managers)
create table if not exists public.missed_checks (
  id bigint generated always as identity primary key,
  input text not null,
  found_project uuid references public.projects(id) on delete set null,
  source_id text references public.sources(id),
  cause text,
  detail text,
  probe jsonb,
  resolution text check (resolution in ('imported','sent_to_review','not_relevant','already_in_pipeline')),
  checked_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.missed_checks enable row level security;
revoke all on public.missed_checks from anon, authenticated;

create or replace function public.check_missed(p_input text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; v_in text := trim(coalesce(p_input, '')); host text; tokens text[]; src public.sources; r public.refresh_runs;
        matches jsonb; cause text; detail text; v_id bigint; sam_id text;
begin
  me := private.require_manager();
  if length(v_in) < 4 then raise exception 'too_short' using errcode = '22023', hint = 'Paste a link, a solicitation or contract number, or a project name.'; end if;
  host := lower(substring(v_in from '^https?://(?:www\.)?([^/:?#]+)'));
  sam_id := lower(substring(v_in from '([0-9a-fA-F]{32})'));
  tokens := array(select distinct upper(m[1]) from regexp_matches(v_in, '([A-Za-z0-9][A-Za-z0-9-]{3,}[0-9][A-Za-z0-9-]*)', 'g') m);
  select coalesce(jsonb_agg(jsonb_build_object('project_id', p.id, 'title', p.title, 'source_name', p.source_name, 'stage', p.stage, 'relevance', p.relevance,
           'opps', (select jsonb_agg(jsonb_build_object('id', o.id, 'ref', o.ref, 'stage', o.stage, 'needs_review', o.needs_review, 'owner', u.full_name))
                    from public.opportunities o left join public.profiles u on u.id = o.owner_id where o.project_id = p.id))), '[]')
    into matches
    from (select distinct p.* from public.projects p
           where (host is not null and p.source_url is not null and lower(p.source_url) like '%' || lower(regexp_replace(v_in, '^https?://(www\.)?', '')) || '%')
              or (sam_id is not null and (p.external_key = 'sam:' || sam_id or ('sam:' || sam_id) = any(p.alt_keys)))
              or (p.sol_key is not null and p.sol_key = any(array(select private.norm_sol(t) from unnest(tokens) t)))
              or exists (select 1 from unnest(tokens) t where upper(p.external_key) like '%:' || t or exists (select 1 from unnest(p.alt_keys) k where upper(k) like '%:' || t))
              or (host is null and length(v_in) >= 12 and extensions.similarity(lower(p.title), lower(v_in)) > 0.45)
           limit 10) p;
  if jsonb_array_length(matches) > 0 then
    cause := 'already_in_pipeline';
    detail := 'Already in the pipeline. If you cannot see it, it may be waiting for review, archived, or owned by someone else.';
  else
    select * into src from public.sources s where s.id = case
      when host like '%sam.gov' then 'sam_gov'
      when host like '%usaspending.gov' then 'usaspending_awards'
      when host like 'bidletting.fdot.gov' then 'fdot_lettings'
      when host like '%fdot.gov' or host like '%dot.state.fl.us' then 'fdot_bid_notices'
      when host like 'data.cityoforlando.net' or host like '%orlando.gov' then 'orlando_permits'
      when host like '%myfloridamarketplace.com' or host like '%myflorida.com' then 'mfmp_vip'
      when host ~ '(demandstar|bonfirehub|opengov|planetbids|ionwave|bidnetdirect|periscope|bidsync|vendorlink|negometrix)' then 'local_portals'
      when host ~ '(constructconnect|construction\.com|dodge|buildingconnected|thebluebook|isqft|planhub)' then 'paid_platforms'
      else null end;
    if host is null then
      cause := 'not_found'; detail := 'No project in the pipeline matches that number or name. Paste the source link to see which source should have found it.';
    elsif src.id is null then
      cause := 'source_not_monitored'; detail := host || ' is not one of the monitored sources. Add the project by hand, and consider it for a new source.';
    elsif src.kind = 'paid' then
      cause := 'access_restricted'; detail := src.name || ' needs a paid subscription; nothing is collected from it automatically.';
    elsif src.kind in ('manual','needs_credentials') then
      cause := case when src.kind = 'needs_credentials' or src.id = 'local_portals' then 'access_restricted' else 'source_not_monitored' end;
      detail := src.name || ': not collected automatically. ' || coalesce(src.access_notes, '');
    else
      select * into r from public.refresh_runs where source_id = src.id order by started_at desc limit 1;
      if r.id is null then cause := 'source_not_refreshed'; detail := src.name || ' has not run yet.';
      elsif r.status = 'failed' then cause := 'collector_failed'; detail := src.name || ' failed on its last run: ' || coalesce(r.error, 'see the log');
      elsif r.started_at < now() - interval '30 hours' then cause := 'source_not_refreshed'; detail := src.name || ' last ran ' || to_char(r.started_at at time zone 'America/New_York', 'Mon DD HH12:MI AM') || ' ET.';
      else
        cause := 'filtered_or_not_reached';
        detail := src.name || ' ran successfully, so the record was either outside its search (dates, place, page or new-item limits) or judged not relevant. Use "Check the record" to see how it classifies.';
      end if;
    end if;
  end if;
  insert into public.missed_checks (input, found_project, source_id, cause, detail, checked_by)
  values (v_in, (matches->0->>'project_id')::uuid, src.id, cause, detail, me.id) returning id into v_id;
  return jsonb_build_object('id', v_id, 'matches', matches, 'cause', cause, 'detail', detail, 'source_id', src.id, 'source_name', src.name,
    'probe_supported', src.id in ('sam_gov','usaspending_awards','orlando_permits') and (sam_id is not null or host not like '%sam.gov'));
end $$;

create or replace function public.resolve_missed_check(p_id bigint, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := private.require_manager();
  update public.missed_checks set resolution = coalesce(nullif(p->>'resolution', ''), resolution), probe = coalesce(p->'probe', probe),
    cause = coalesce(nullif(p->>'cause', ''), cause), found_project = coalesce(nullif(p->>'project_id', '')::uuid, found_project)
  where id = p_id;
  return jsonb_build_object('ok', found);
end $$;

create or replace function public.missed_checks_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := private.require_manager();
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'input', m.input, 'cause', m.cause, 'detail', m.detail, 'resolution', m.resolution,
            'source_name', s.name, 'by', u.full_name, 'at', m.created_at, 'probe', m.probe) order by m.created_at desc)
          from (select * from public.missed_checks order by created_at desc limit 50) m left join public.sources s on s.id = m.source_id
          left join public.profiles u on u.id = m.checked_by), '[]');
end $$;

-- ---------------------------------------------------------------- settings: schedule is validated server-side
create or replace function public.update_setting(p_key text, p_value jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; k text; t text; mins int[] := '{}';
begin
  me := private.require_manager();
  if p_key = 'stale_days' and ((p_value #>> '{}')::int not between 3 and 90) then raise exception 'bad_value' using errcode = '22023', hint = 'Pick 3 to 90 days.'; end if;
  if p_key = 'max_open_claims' and ((p_value #>> '{}')::int not between 5 and 500) then raise exception 'bad_value' using errcode = '22023', hint = 'Pick 5 to 500.'; end if;
  if p_key = 'refresh_schedule' then
    if jsonb_typeof(p_value) <> 'object' then raise exception 'bad_value' using errcode = '22023'; end if;
    foreach k in array array['morning','verify','snapshot','alert','midday','afternoon'] loop
      t := p_value->>k;
      if t is null or t !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
        raise exception 'bad_value' using errcode = '22023', hint = 'Times must look like 04:15 (24-hour).';
      end if;
      if k in ('morning','verify','snapshot','alert') then mins := mins || (split_part(t, ':', 1)::int * 60 + split_part(t, ':', 2)::int); end if;
    end loop;
    if not (mins[1] < mins[2] and mins[2] < mins[3] and mins[3] < mins[4]) then
      raise exception 'bad_value' using errcode = '22023', hint = 'Keep the morning steps in order: collection, check, snapshot, alert.';
    end if;
    -- keep the source lists the scheduler relies on even if a client leaves them out
    p_value := (select value from public.settings where key = 'refresh_schedule') || p_value;
  end if;
  update public.settings set value = p_value, updated_at = now(), updated_by = me.id where key = p_key;
  if not found then raise exception 'bad_key' using errcode = '22023'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- updated: call outcomes and quotes, board, lead detail, profile
create or replace function public.log_activity(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me public.profiles; o public.opportunities; n public.opportunities;
  v_kind text := coalesce(nullif(p->>'kind', ''), 'note');
  v_outcome text := nullif(p->>'outcome', '');
  v_body text := nullif(trim(coalesce(p->>'body', '')), '');
  v_stage text := nullif(p->>'stage', '');
  v_contact uuid := nullif(p->>'contact_id', '')::uuid;
  changes jsonb := '{}';
  summary text;
  contact_kinds text[] := array['call','email','text','visit','meeting'];
  reached text[] := array['reached','spoke','requested_info','interested','not_interested','quote_requested','call_back','meeting_set','sent_info'];
begin
  me := private.require_active();
  select * into o from public.opportunities where id = p_id for update;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_kind not in ('call','email','text','visit','meeting','note','follow_up','quote') then
    raise exception 'bad_kind' using errcode = '22023', hint = 'Unknown activity type.';
  end if;
  if o.owner_id is null then
    if me.role <> 'manager' then
      raise exception 'claim_first' using errcode = '42501', hint = 'Claim this opportunity before logging work on it.';
    elsif v_kind <> 'note' or v_stage is not null then
      raise exception 'claim_first' using errcode = '42501', hint = 'Assign this opportunity before logging calls or changing its stage.';
    end if;
  elsif o.owner_id <> me.id and me.role <> 'manager' then
    raise exception 'not_owner' using errcode = '42501', hint = 'Only the owner or a manager can log work on this opportunity.';
  end if;
  if v_outcome is not null and v_outcome not in ('no_answer','voicemail','spoke','requested_info','interested','not_interested','quote_requested','call_back',
       'wrong_contact','reached','wrong_number','sent_info','meeting_set') then
    raise exception 'bad_outcome' using errcode = '22023', hint = 'Unknown call outcome.';
  end if;
  if v_outcome = 'quote_requested' and v_stage is null and o.stage in ('claimed','contacted','qualified','follow_up') then v_stage := 'quote_needed'; end if;
  if length(coalesce(v_body, '')) > 5000 then raise exception 'too_long' using errcode = '22001', hint = 'Notes are limited to 5,000 characters.'; end if;

  if v_stage is not null then
    if not exists (select 1 from public.stages where key = v_stage) then raise exception 'bad_stage' using errcode = '22023'; end if;
    if v_stage = 'available' then raise exception 'use_release' using errcode = '22023', hint = 'Use Release to put a lead back in the pool.'; end if;
    if v_stage in ('won','lost','disqualified') and nullif(trim(coalesce(p->>'outcome_reason', '')), '') is null then
      raise exception 'reason_required' using errcode = '22023', hint = 'Add the outcome reason (why it was won, lost or disqualified).';
    end if;
    if v_stage = 'follow_up' and nullif(p->>'next_action_due', '') is null and o.next_action_due is null then
      raise exception 'follow_up_date_required' using errcode = '22023', hint = 'Set a follow-up date.';
    end if;
  elsif o.stage = 'claimed' and (v_outcome = any(reached) or v_kind in ('visit','meeting')) then
    v_stage := 'contacted';   -- reaching someone on a claimed lead moves it to Contacted; no answer or a voicemail does not
  end if;
  if v_stage = o.stage then v_stage := null; end if;

  if v_contact is not null and not exists (select 1 from public.contacts where id = v_contact and company_id is not distinct from o.company_id) then
    raise exception 'bad_contact' using errcode = '22023', hint = 'That contact does not belong to this company.';
  end if;

  -- apply field changes, keeping a record of each old value
  n := o;
  if v_stage is not null then
    n.stage := v_stage; changes := changes || jsonb_build_object('stage', jsonb_build_array(o.stage, v_stage));
    n.closed_at := case when v_stage in ('won','lost','disqualified','archived') then now() else null end;
  end if;
  if p ? 'next_action' and coalesce(p->>'next_action', '') is distinct from coalesce(o.next_action, '') then
    n.next_action := nullif(trim(p->>'next_action'), ''); changes := changes || jsonb_build_object('next_action', jsonb_build_array(o.next_action, n.next_action));
  end if;
  if p ? 'next_action_due' and (nullif(p->>'next_action_due', '')::date) is distinct from o.next_action_due then
    n.next_action_due := nullif(p->>'next_action_due', '')::date; changes := changes || jsonb_build_object('next_action_due', jsonb_build_array(o.next_action_due, n.next_action_due));
  end if;
  if p ? 'services_confirmed' then
    n.services_confirmed := coalesce((select array_agg(x) from jsonb_array_elements_text(p->'services_confirmed') x), '{}');
    if n.services_confirmed is distinct from o.services_confirmed then
      changes := changes || jsonb_build_object('services_confirmed', jsonb_build_array(o.services_confirmed, n.services_confirmed));
    end if;
  end if;
  if p ? 'scope_confirmed_note' and coalesce(p->>'scope_confirmed_note', '') is distinct from coalesce(o.scope_confirmed_note, '') then
    n.scope_confirmed_note := nullif(trim(p->>'scope_confirmed_note'), ''); changes := changes || jsonb_build_object('scope_confirmed_note', jsonb_build_array(o.scope_confirmed_note, n.scope_confirmed_note));
  end if;
  if p ? 'quote_amount' and (nullif(p->>'quote_amount', '')::numeric) is distinct from o.quote_amount then
    if (nullif(p->>'quote_amount', '')::numeric) < 0 then raise exception 'bad_amount' using errcode = '22023'; end if;
    n.quote_amount := nullif(p->>'quote_amount', '')::numeric; changes := changes || jsonb_build_object('quote_amount', jsonb_build_array(o.quote_amount, n.quote_amount));
  end if;
  if p ? 'quote_sent_at' and (nullif(p->>'quote_sent_at', '')::date) is distinct from o.quote_sent_at then
    n.quote_sent_at := nullif(p->>'quote_sent_at', '')::date; changes := changes || jsonb_build_object('quote_sent_at', jsonb_build_array(o.quote_sent_at, n.quote_sent_at));
  elsif v_stage = 'quote_sent' and o.quote_sent_at is null then
    n.quote_sent_at := current_date; changes := changes || jsonb_build_object('quote_sent_at', jsonb_build_array(null, n.quote_sent_at));
  end if;
  -- quote tracking: explicit values win, stage moves fill in the obvious ones
  n.quote_status := coalesce(nullif(p->>'quote_status', ''), case
      when v_stage = 'quote_needed' and coalesce(o.quote_status, 'declined') in ('declined','accepted') then 'requested'
      when v_stage = 'quote_sent' then 'sent'
      when v_stage = 'won' and o.quote_status in ('requested','in_progress','sent','no_response') then 'accepted'
      when v_stage = 'lost' and o.quote_status in ('sent','no_response') then 'declined' end, o.quote_status);
  if n.quote_status is not null and n.quote_status not in ('requested','in_progress','sent','accepted','declined','no_response') then raise exception 'bad_quote_status' using errcode = '22023'; end if;
  if n.quote_status is distinct from o.quote_status then changes := changes || jsonb_build_object('quote_status', jsonb_build_array(o.quote_status, n.quote_status)); end if;
  n.quote_requested_at := coalesce(nullif(p->>'quote_requested_at', '')::date, case when n.quote_status = 'requested' and o.quote_status is distinct from 'requested' then current_date end, o.quote_requested_at);
  if n.quote_requested_at is distinct from o.quote_requested_at then changes := changes || jsonb_build_object('quote_requested_at', jsonb_build_array(o.quote_requested_at, n.quote_requested_at)); end if;
  if p ? 'quote_decision_date' then n.quote_decision_date := nullif(p->>'quote_decision_date', '')::date;
    if n.quote_decision_date is distinct from o.quote_decision_date then changes := changes || jsonb_build_object('quote_decision_date', jsonb_build_array(o.quote_decision_date, n.quote_decision_date)); end if; end if;
  if p ? 'quote_service' then n.quote_service := nullif(trim(p->>'quote_service'), '');
    if n.quote_service is distinct from o.quote_service then changes := changes || jsonb_build_object('quote_service', jsonb_build_array(o.quote_service, n.quote_service)); end if; end if;
  if p ? 'expected_work_date' and (nullif(p->>'expected_work_date', '')::date) is distinct from o.expected_work_date then
    n.expected_work_date := nullif(p->>'expected_work_date', '')::date; changes := changes || jsonb_build_object('expected_work_date', jsonb_build_array(o.expected_work_date, n.expected_work_date));
  end if;
  if p ? 'outcome_reason' and coalesce(p->>'outcome_reason', '') is distinct from coalesce(o.outcome_reason, '') then
    n.outcome_reason := nullif(trim(p->>'outcome_reason'), ''); changes := changes || jsonb_build_object('outcome_reason', jsonb_build_array(o.outcome_reason, n.outcome_reason));
  end if;

  if v_body is null and v_outcome is null and changes = '{}'::jsonb and v_kind not in ('call','email','text','visit','meeting') then
    return jsonb_build_object('ok', false, 'reason', 'empty', 'message', 'Nothing to save.');
  end if;

  summary := concat_ws(': ', initcap(replace(v_kind, '_', ' ')), case v_outcome when 'reached' then 'spoke with them' when 'spoke' then 'spoke with them'
    when 'wrong_number' then 'wrong contact' else replace(v_outcome, '_', ' ') end);
  update public.opportunities set
    stage = n.stage, closed_at = n.closed_at, next_action = n.next_action, next_action_due = n.next_action_due,
    services_confirmed = n.services_confirmed, scope_confirmed_note = n.scope_confirmed_note,
    quote_amount = n.quote_amount, quote_sent_at = n.quote_sent_at, expected_work_date = n.expected_work_date,
    outcome_reason = n.outcome_reason, quote_status = n.quote_status, quote_requested_at = n.quote_requested_at,
    quote_decision_date = n.quote_decision_date, quote_service = n.quote_service,
    last_activity_at = now(), last_activity_by = me.id, last_activity_summary = summary,
    needs_review = case when review_kind = 'stale' then false else needs_review end,
    review_kind = case when review_kind = 'stale' then null else review_kind end,
    review_reason = case when review_kind = 'stale' then null else review_reason end,
    updated_at = now()
  where id = p_id;

  insert into public.activities (opportunity_id, company_id, contact_id, user_id, kind, outcome, body, from_stage, to_stage, data)
  values (p_id, o.company_id, v_contact, me.id, v_kind, v_outcome, v_body,
          case when v_stage is not null then o.stage end, v_stage, jsonb_build_object('changes', changes));

  if v_stage = 'quote_needed' then
    perform private.notify_managers(p_id, 'quote_requested', format('Quote requested: %s', o.ref),
      format('%s needs pricing for "%s"%s', me.full_name, o.title, coalesce(': ' || v_body, '')), null, me.id);
  elsif v_stage = 'won' then
    perform private.notify_managers(p_id, 'won', format('Won: %s', o.ref), format('%s booked "%s"', me.full_name, o.title), null, me.id);
  end if;
  if o.owner_id is not null and o.owner_id <> me.id then
    perform private.notify(o.owner_id, p_id, 'manager_update', format('%s updated %s', me.full_name, o.ref), coalesce(v_body, summary));
  end if;
  if changes ? 'services_confirmed' then perform private.rescore(p_id); end if;
  return jsonb_build_object('ok', true, 'stage', n.stage, 'auto_stage', (v_stage = 'contacted' and nullif(p->>'stage', '') is null));
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
        p.category, p.relevance,
        case when o.owner_id = me.id or mgr then o.quote_status end as quote_status, case when o.owner_id = me.id or mgr then o.quote_requested_at end as quote_requested_at,
        case when o.owner_id = me.id or mgr then o.quote_sent_at end as quote_sent_at, case when o.owner_id = me.id or mgr then o.quote_decision_date end as quote_decision_date,
        (select count(*) from jsonb_array_elements(p.evidence) e where e->>'confidence' = 'documented') as documented_terms,
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
    'quote_status', case when full_access then o.quote_status end, 'quote_requested_at', case when full_access then o.quote_requested_at end,
    'quote_decision_date', case when full_access then o.quote_decision_date end, 'quote_service', case when full_access then o.quote_service end,
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
      'watching', exists (select 1 from public.watches w where w.user_id = me.id and w.project_id = p.id),
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

create or replace function public.me() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  if p.id is null then return null; end if;
  if p.active then update public.profiles set last_seen_at = now() where id = p.id; end if;
  return jsonb_build_object('id', p.id, 'email', p.email, 'full_name', p.full_name, 'phone', p.phone,
    'role', p.role, 'active', p.active, 'prefs', p.prefs,
    'settings', (select jsonb_object_agg(key, value) from public.settings),
    'stages', (select jsonb_agg(to_jsonb(s) order by s.sort) from public.stages s),
    'unread', (select count(*) from public.notifications where user_id = p.id and read_at is null));
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
  public.daily_maintenance(), public.list_users(), public.discovery_overview(), public.service_terms_list(), public.save_service_term(jsonb),
  public.update_my_prefs(jsonb), public.my_saved_searches(), public.save_search(text, text, jsonb), public.delete_search(bigint),
  public.toggle_watch(uuid, uuid), public.get_company(uuid), public.data_freshness(), public.my_briefing(), public.team_report(jsonb),
  public.check_missed(text), public.resolve_missed_check(bigint, jsonb), public.missed_checks_list()
to authenticated;
grant execute on function public.discovery_terms() to service_role;
