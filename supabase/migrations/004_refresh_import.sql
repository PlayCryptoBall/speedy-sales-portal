-- Speedy Sales Portal: refresh jobs, daily maintenance and workbook import.
-- refresh_* functions are called only by the server-side refresh job (service role).
-- They update FACTS about projects and never touch ownership, stages, notes, quotes or follow-ups.

create or replace function private.project_stage_rank(s text) returns int
language sql immutable set search_path = '' as $$
  select case s when 'unknown' then 0 when 'planning' then 1 when 'upcoming' then 2 when 'bidding' then 3 when 'bid_closed' then 4
    when 'low_bidder' then 5 when 'intent_to_award' then 6 when 'awarded' then 7 when 'preconstruction' then 8
    when 'under_construction' then 9 when 'completed' then 10 when 'cancelled' then 11 else 0 end
$$;

create or replace function private.winner_rank(s text) returns int
language sql immutable set search_path = '' as $$
  select case s when 'low_bidder' then 1 when 'intended' then 2 when 'awarded' then 3 else 0 end
$$;

create or replace function private.fmt_ts(t timestamptz) returns text
language sql immutable set search_path = '' as $$
  select to_char(t at time zone 'America/New_York', 'Mon DD, YYYY HH12:MI AM')
$$;

create or replace function private.upsert_company(p_name text, p_kind text default 'contractor') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid; k text := private.norm_key(p_name);
begin
  if k is null or k = '' then return null; end if;
  select id into v from public.companies where name_key = k or k = any(aliases) limit 1;
  if v is null then
    insert into public.companies (name, name_key, kind) values (initcap(lower(trim(split_part(p_name, '(', 1)))), k, p_kind)
    on conflict (name_key) do nothing returning id into v;
    if v is null then select id into v from public.companies where name_key = k; end if;
  end if;
  return v;
end $$;

create or replace function public.refresh_start_run(p_source text, p_trigger text default 'schedule', p_user uuid default null, p_attempt int default 1)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v bigint;
begin
  insert into public.refresh_runs (source_id, trigger, triggered_by, attempt) values (p_source, p_trigger, p_user, p_attempt) returning id into v;
  update public.sources set last_run_at = now() where id = p_source;
  return v;
end $$;

-- Opportunities tied to a project (primary link or "also covers").
create or replace function private.project_opps(p_project uuid) returns setof public.opportunities
language sql stable security definer set search_path = '' as $$
  select o.* from public.opportunities o where o.project_id = p_project
  union
  select o.* from public.opportunities o join public.opportunity_projects l on l.opportunity_id = o.id where l.project_id = p_project
$$;

create or replace function public.refresh_upsert_project(p_run bigint, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.projects; v_new public.projects;
  v_key text := p->>'external_key';
  v_src text := coalesce(p->>'source_id', 'portal_manual');
  v_sol text := private.norm_sol(p->>'solicitation_no');
  action text := 'unchanged';
  nchanges int := 0; material_changes text[] := '{}';
  flagged int := 0; created_opps int := 0; merged boolean := false;
  f text; oldv text; newv text; is_material boolean;
  facts text[] := array['title','short_title','owner_name','level','location_text','city','county','region','status_text','project_value','value_label',
                        'size_note','solicitation_no','set_aside','deadline','deadline_is_date','deadline_note','published_at','source_url','source_name','source_summary'];
  new_stage text := nullif(p->>'stage', '');
  w jsonb := p->'winner';
  w_company uuid; o record; new_opp public.opportunities; tracker record; v_title text;
  notice text;
begin
  if v_key is null then raise exception 'external_key required'; end if;

  select * into v from public.projects where external_key = v_key or v_key = any(alt_keys) limit 1;
  if v.id is null and v_sol is not null then
    select * into v from public.projects where sol_key = v_sol order by (source_id = v_src) desc, created_at limit 1;
    if v.id is not null then merged := true; end if;
  end if;

  if v.id is null then
    -- brand new project
    insert into public.projects (external_key, alt_keys, source_id, title, short_title, owner_name, level, location_text, city, county, region, stage,
      status_text, project_value, value_label, size_note, solicitation_no, sol_key, set_aside, deadline, deadline_is_date, deadline_note,
      published_at, discovered_at, last_verified_at, last_checked_at, verify_status, source_url, source_name, source_summary, scope_evidence,
      services_likely, pocs, bidders)
    values (v_key, coalesce((select array_agg(x) from jsonb_array_elements_text(p->'alt_keys') x), '{}'), v_src, p->>'title', p->>'short_title',
      p->>'owner_name', p->>'level', p->>'location_text', p->>'city', p->>'county', coalesce(p->>'region', 'Unknown'), coalesce(new_stage, 'unknown'),
      p->>'status_text', nullif(p->>'project_value', '')::numeric, p->>'value_label', p->>'size_note', p->>'solicitation_no', v_sol, p->>'set_aside',
      nullif(p->>'deadline', '')::timestamptz, coalesce((p->>'deadline_is_date')::boolean, false), p->>'deadline_note',
      nullif(p->>'published_at', '')::date, now(), now(), now(), 'ok', p->>'source_url', p->>'source_name', p->>'source_summary',
      private.scope_evidence(concat_ws(' ', p->>'title', p->>'source_summary')),
      coalesce((select array_agg(x) from jsonb_array_elements_text(p->'services_likely') x), '{}'),
      coalesce(p->'pocs', '[]'), coalesce(p->'bidders', '[]'))
    returning * into v;
    action := 'discovered';
    if p ? 'opportunity' then
      insert into public.opportunities (project_id, kind, approach, title, next_action, services, speedy_scope, needs_review, review_kind, review_reason)
      values (v.id, coalesce(p#>>'{opportunity,kind}', 'gov_bid'), coalesce(p#>>'{opportunity,approach}', 'quote_bidders'),
              coalesce(p#>>'{opportunity,title}', v.title), p#>>'{opportunity,next_action}',
              coalesce((select array_agg(x) from jsonb_array_elements_text(p#>'{opportunity,services}') x), v.services_likely),
              p#>>'{opportunity,speedy_scope}',
              coalesce(p->>'relevance', 'high') <> 'high', case when coalesce(p->>'relevance', 'high') <> 'high' then 'discovery' end,
              case when coalesce(p->>'relevance', 'high') <> 'high' then 'New from ' || coalesce((select name from public.sources where id = v_src), v_src) || ': check that it involves concrete work before publishing to the pool' end)
      returning * into new_opp;
      insert into public.activities (opportunity_id, kind, body, data)
      values (new_opp.id, 'refresh', 'Found by the ' || coalesce((select name from public.sources where id = v_src), v_src) || ' refresh', jsonb_build_object('run_id', p_run));
      created_opps := 1;
      if new_opp.needs_review then flagged := 1; end if;
    end if;
  else
    -- existing project: compare facts, keep sales work untouched
    if v_key <> v.external_key and not (v_key = any(v.alt_keys)) then
      update public.projects set alt_keys = array_append(alt_keys, v_key) where id = v.id;
      merged := true;
    end if;
    if p ? 'alt_keys' then
      update public.projects set alt_keys = (select coalesce(array_agg(distinct k), '{}') from unnest(alt_keys || coalesce((select array_agg(x) from jsonb_array_elements_text(p->'alt_keys') x), '{}')) k where k <> external_key)
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
      if private.project_stage_rank(new_stage) > private.project_stage_rank(v.stage) or new_stage = 'cancelled'
         or (new_stage = 'bidding' and v.stage in ('bid_closed','cancelled','upcoming') and nullif(p->>'deadline', '')::timestamptz > now()) then
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

    if p ? 'pocs' and jsonb_array_length(coalesce(p->'pocs', '[]')) > 0 and p->'pocs' is distinct from v.pocs then
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
        insert into public.opportunities (project_id, company_id, kind, approach, title, next_action, services, speedy_scope,
                                          stage, owner_id, claimed_at, needs_review, review_kind, review_reason)
        values (v.id, w_company, 'contractor_outreach', 'approach_prime',
                initcap(lower(split_part(w->>'name', '(', 1))) || ' — ' || v_title,
                case w->>'status' when 'low_bidder' then 'Call their estimator or PM now: they are the apparent low bidder (award not final yet) and will line up subs soon. Confirm award status on the call.'
                                 else 'Call their estimator or PM and offer cutting, coring, GPR and removal for this job.' end,
                v_new.services_likely, (select speedy_scope from public.opportunities where id = tracker.id),
                case when tracker.owner_id is not null then 'claimed' else 'available' end, tracker.owner_id,
                case when tracker.owner_id is not null then now() end,
                action = 'discovered' and tracker.owner_id is null, case when action = 'discovered' and tracker.owner_id is null then 'discovery' end,
                case when action = 'discovered' and tracker.owner_id is null then 'New award found by the refresh: confirm the awardee builds (not a design or service firm) and the job has concrete work, then publish' end)
        returning * into new_opp;
        created_opps := created_opps + 1;
        if new_opp.needs_review then flagged := flagged + 1; end if;
        insert into public.activities (opportunity_id, company_id, kind, body, data)
        values (new_opp.id, w_company, 'refresh', 'Created by refresh: ' || material_changes[cardinality(material_changes)] ||
                coalesce('. Follows ' || tracker.ref, ''), jsonb_build_object('run_id', p_run, 'from_opportunity', tracker.id));
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
    'merged', merged, 'flagged', flagged, 'opportunities_created', created_opps);
end $$;

-- A source could not confirm a project it used to list (closed, archived or removed).
create or replace function public.refresh_mark_missing(p_run bigint, p_keys text[], p_reason text) returns int
language plpgsql security definer set search_path = '' as $$
declare v record; n int := 0; o record;
begin
  for v in select * from public.projects where (external_key = any(p_keys) or alt_keys && p_keys) and verify_status <> 'missing' loop
    update public.projects set verify_status = 'missing', last_checked_at = now() where id = v.id;
    insert into public.refresh_changes (run_id, project_id, field, old_value, new_value, material)
    values (p_run, v.id, 'listing', 'listed', p_reason, true);
    for o in select * from private.project_opps(v.id) where stage not in ('won','lost','disqualified','archived') loop
      update public.opportunities set needs_review = true, review_kind = 'missing', review_reason = p_reason where id = o.id and not needs_review;
      if o.owner_id is not null then perform private.notify(o.owner_id, o.id, 'source_change', 'Check ' || o.ref, p_reason, 'missing:' || o.id); end if;
    end loop;
    n := n + 1;
  end loop;
  return n;
end $$;

-- A fetch failed for these keys: record the check, keep last_verified_at as it was.
create or replace function public.refresh_mark_failed(p_keys text[]) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.projects set verify_status = 'failed', last_checked_at = now() where external_key = any(p_keys) or alt_keys && p_keys;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.refresh_finish_run(p_run bigint, p_status text, p_counts jsonb, p_log jsonb, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.refresh_runs;
begin
  update public.refresh_runs set status = p_status, finished_at = now(),
    fetched = coalesce((p_counts->>'fetched')::int, 0), discovered = coalesce((p_counts->>'discovered')::int, 0),
    updated = coalesce((p_counts->>'updated')::int, 0), merged = coalesce((p_counts->>'merged')::int, 0),
    flagged = coalesce((p_counts->>'flagged')::int, 0), unchanged = coalesce((p_counts->>'unchanged')::int, 0),
    errors = coalesce((p_counts->>'errors')::int, 0), log = coalesce(p_log, '[]'), error = p_error
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

create or replace function public.refresh_tracked_keys(p_source text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('external_key', p.external_key, 'alt_keys', p.alt_keys, 'solicitation_no', p.solicitation_no,
           'stage', p.stage, 'deadline', p.deadline, 'source_url', p.source_url, 'level', p.level)), '[]')
  from public.projects p
  where (p.source_id = p_source or exists (select 1 from unnest(p.alt_keys) k where split_part(k, ':', 1) = split_part(p_source, '_', 1)))
    and p.stage not in ('completed','cancelled')
    and exists (select 1 from private.project_opps(p.id) o where o.stage not in ('won','lost','disqualified','archived'))
$$;

-- ---------------------------------------------------------------- daily upkeep
create or replace function private.snapshot_pool() returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.pool_snapshots (day, available, available_hot, claimed_open, review_queue, by_region, by_source)
  select (now() at time zone 'America/New_York')::date,
    count(*) filter (where o.stage = 'available' and not o.needs_review),
    count(*) filter (where o.stage = 'available' and not o.needs_review and o.priority = 'Hot'),
    count(*) filter (where o.stage = any(private.active_stages())),
    count(*) filter (where o.needs_review),
    coalesce((select jsonb_object_agg(region, n) from (select coalesce(p2.region, 'Unknown') region, count(*) n from public.opportunities o2
              left join public.projects p2 on p2.id = o2.project_id where o2.stage = 'available' and not o2.needs_review group by 1) r), '{}'),
    coalesce((select jsonb_object_agg(source_id, n) from (select coalesce(p2.source_id, 'none') source_id, count(*) n from public.opportunities o2
              left join public.projects p2 on p2.id = o2.project_id where o2.stage = 'available' and not o2.needs_review group by 1) s), '{}')
  from public.opportunities o
  on conflict (day) do update set available = excluded.available, available_hot = excluded.available_hot, claimed_open = excluded.claimed_open,
    review_queue = excluded.review_queue, by_region = excluded.by_region, by_source = excluded.by_source, created_at = now();
end $$;

create or replace function public.daily_maintenance() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; o record; stale int := private.setting_int('stale_days', 14); closed int := 0; n_stale int := 0; n_due int := 0; n_soon int := 0;
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
  perform private.rescore(id) from public.opportunities where stage not in ('archived');
  perform private.snapshot_pool();
  return jsonb_build_object('bids_closed', closed, 'stale', n_stale, 'due', n_due, 'deadline_soon', n_soon);
end $$;

-- ---------------------------------------------------------------- workbook import (preview, then apply)
create or replace function private.map_status(s text) returns text
language sql immutable set search_path = '' as $$
  select case lower(trim(coalesce(s, '')))
    when '' then null when 'not contacted' then null when 'watching' then null when 'available' then null when 'claimed' then null
    when 'called' then 'contacted' when 'calling gcs' then 'contacted' when 'contacted' then 'contacted'
    when 'meeting set' then 'qualified' when 'qualified' then 'qualified'
    when 'quoting' then 'quote_needed' when 'quote needed' then 'quote_needed'
    when 'quote sent' then 'quote_sent' when 'follow up' then 'follow_up'
    when 'working together' then 'won' when 'teamed / won' then 'won' when 'won' then 'won'
    when 'lost' then 'lost' when 'nurture' then 'nurture'
    when 'not a fit' then 'disqualified' when 'passed' then 'disqualified' when 'disqualified' then 'disqualified'
    else 'unknown' end
$$;

create or replace function private.import_plan(p_rows jsonb, me public.profiles) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb; o public.opportunities; out jsonb := '[]'; item jsonb; changes jsonb; v_stage text; v_contact date; v_follow date; v_note text;
        v_last date; skip text; match text; i int := 0;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1; o := null; skip := null; match := null; changes := '[]';
    if nullif(r->>'ref', '') is not null then
      select * into o from public.opportunities where ref = upper(trim(r->>'ref')); match := 'Opp ID';
    end if;
    if o.id is null and nullif(r->>'solicitation_no', '') is not null then
      select x.* into o from public.opportunities x join public.projects p on p.id = x.project_id
       where p.sol_key = private.norm_sol(r->>'solicitation_no') and x.kind = 'gov_bid' order by x.created_at limit 1;
      if o.id is not null then match := 'solicitation #'; end if;
    end if;
    if o.id is null and nullif(r->>'company', '') is not null and nullif(r->>'project', '') is not null then
      select x.* into o from public.opportunities x join public.companies c on c.id = x.company_id join public.projects p on p.id = x.project_id
       where c.name_key = private.norm_key(r->>'company') and private.norm_key(p.title) = private.norm_key(r->>'project') order by x.created_at limit 1;
      if o.id is not null then match := 'contractor + project'; end if;
    end if;
    begin v_contact := nullif(r->>'last_contact', '')::date; exception when others then v_contact := null; end;
    begin v_follow := nullif(r->>'next_follow_up', '')::date; exception when others then v_follow := null; end;
    v_note := nullif(trim(coalesce(r->>'notes', '')), '');
    v_stage := private.map_status(r->>'status');
    if o.id is null then skip := 'No matching opportunity (needs an Opp ID, solicitation # or exact contractor + project)';
    elsif me.role <> 'manager' and o.owner_id is distinct from me.id then skip := 'Not in your pipeline';
    elsif o.owner_id is null and (v_stage is not null or v_follow is not null) then skip := 'Unowned: claim or assign it before importing status changes';
    end if;
    if skip is null then
      v_last := (o.last_activity_at at time zone 'America/New_York')::date;
      if v_note is not null then
        if exists (select 1 from public.activities a where a.opportunity_id = o.id and (a.dedupe_key = 'import:' || o.id || ':' || md5(lower(v_note)) or lower(trim(a.body)) = lower(v_note)
                   or lower(trim(a.body)) like '%' || lower(v_note))) then
          changes := changes || jsonb_build_object('field', 'note', 'to', v_note, 'apply', false, 'reason', 'Already in the timeline');
        else
          changes := changes || jsonb_build_object('field', 'note', 'to', v_note, 'apply', true, 'reason', 'New note, added to the timeline (earlier notes stay)');
        end if;
      end if;
      if v_stage = 'unknown' then
        changes := changes || jsonb_build_object('field', 'stage', 'to', r->>'status', 'apply', false, 'reason', 'Status not recognised');
      elsif v_stage is not null and v_stage <> o.stage then
        if v_last is not null and (v_contact is null or v_contact <= v_last) then
          changes := changes || jsonb_build_object('field', 'stage', 'from', private.stage_label(o.stage), 'to', private.stage_label(v_stage), 'apply', false,
            'reason', format('Portal has newer activity (%s) than the sheet%s; not changed', to_char(v_last, 'Mon DD'), coalesce(' (' || to_char(v_contact, 'Mon DD') || ')', '')));
        else
          changes := changes || jsonb_build_object('field', 'stage', 'from', private.stage_label(o.stage), 'to', private.stage_label(v_stage), 'value', v_stage, 'apply', true,
            'reason', 'Sheet is newer');
        end if;
      end if;
      if v_follow is not null and v_follow is distinct from o.next_action_due then
        if v_last is not null and (v_contact is null or v_contact <= v_last) then
          changes := changes || jsonb_build_object('field', 'next_action_due', 'from', o.next_action_due, 'to', v_follow, 'apply', false,
            'reason', format('Portal has newer activity (%s); not changed', to_char(v_last, 'Mon DD')));
        else
          changes := changes || jsonb_build_object('field', 'next_action_due', 'from', o.next_action_due, 'to', v_follow, 'apply', true, 'reason', 'Sheet is newer');
        end if;
      end if;
      if jsonb_array_length(changes) = 0 then skip := 'Nothing new'; end if;
    end if;
    out := out || jsonb_build_object('row', coalesce((r->>'row')::int, i), 'sheet', r->>'sheet', 'match', match, 'opportunity_id', o.id, 'ref', o.ref,
      'title', o.title, 'skip', skip, 'last_contact', v_contact, 'changes', changes);
  end loop;
  return out;
end $$;

create or replace function public.import_preview(p_rows jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := private.require_active();
  if jsonb_array_length(p_rows) > 2000 then raise exception 'too_many_rows' using errcode = '22023'; end if;
  return private.import_plan(p_rows, me);
end $$;

create or replace function public.import_apply(p_rows jsonb, p_file text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; plan jsonb; item jsonb; c jsonb; o public.opportunities; v_batch bigint; notes_added int := 0; stages_changed int := 0; dates_changed int := 0;
        v_stage text; v_due date; v_note text; v_reason text;
begin
  me := private.require_active();
  plan := private.import_plan(p_rows, me);   -- recomputed on the server; the client preview is not trusted
  insert into public.import_batches (user_id, file_name) values (me.id, left(p_file, 200)) returning id into v_batch;
  for item in select * from jsonb_array_elements(plan) where value->>'skip' is null loop
    select * into o from public.opportunities where id = (item->>'opportunity_id')::uuid for update;
    v_stage := null; v_due := null; v_note := null;
    for c in select * from jsonb_array_elements(item->'changes') where (value->>'apply')::boolean loop
      if c->>'field' = 'note' then v_note := c->>'to';
      elsif c->>'field' = 'stage' then v_stage := c->>'value';
      elsif c->>'field' = 'next_action_due' then v_due := (c->>'to')::date;
      end if;
    end loop;
    if v_note is null and v_stage is null and v_due is null then continue; end if;
    v_reason := case when v_stage in ('won','lost','disqualified') then coalesce(o.outcome_reason, 'Marked in the workbook import') end;
    update public.opportunities set stage = coalesce(v_stage, stage), next_action_due = coalesce(v_due, next_action_due),
      outcome_reason = coalesce(v_reason, outcome_reason),
      closed_at = case when v_stage in ('won','lost','disqualified') then now() else closed_at end,
      last_activity_at = now(), last_activity_by = me.id, last_activity_summary = 'Import', updated_at = now()
    where id = o.id;
    insert into public.activities (opportunity_id, company_id, user_id, kind, body, from_stage, to_stage, data, dedupe_key)
    values (o.id, o.company_id, me.id, 'import',
            concat_ws(' ', 'From workbook' || coalesce(' (last contact ' || to_char((item->>'last_contact')::date, 'Mon DD') || ')', '') || ':', v_note),
            case when v_stage is not null then o.stage end, v_stage,
            jsonb_build_object('batch', v_batch, 'file', p_file, 'row', item->'row', 'sheet', item->'sheet', 'next_action_due', v_due),
            case when v_note is not null then 'import:' || o.id || ':' || md5(lower(v_note)) else 'import:' || o.id || ':' || v_batch end)
    on conflict (dedupe_key) do nothing;
    notes_added := notes_added + case when v_note is not null then 1 else 0 end;
    stages_changed := stages_changed + case when v_stage is not null then 1 else 0 end;
    dates_changed := dates_changed + case when v_due is not null then 1 else 0 end;
  end loop;
  update public.import_batches set applied = true,
    summary = jsonb_build_object('notes_added', notes_added, 'stages_changed', stages_changed, 'follow_ups_set', dates_changed,
                                 'skipped', (select count(*) from jsonb_array_elements(plan) where value->>'skip' is not null)) where id = v_batch;
  return (select summary from public.import_batches where id = v_batch);
end $$;
