-- 016: scheduler fallbacks found in the live test on 2026-11-10.
-- * If the 4:15 step never ran, the 5:15 check starts the full collection itself.
-- * The snapshot waits up to 20 minutes for sources still running from a late or retried start.
-- * With no morning cycle at all, the snapshot judges the day's runs since midnight ET (no false "not run").
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
      if snap.day is null then
        -- the morning step was missed: start the full collection now instead of only reporting it later
        insert into public.morning_snapshots (day, started_at, status, verify_at) values (d, p_now, 'collecting', p_now);
        insert into private.scheduler_steps (day, step, detail) values (d, 'morning', jsonb_build_object('late_start', p_now)) on conflict do nothing;
        for s in select id from public.sources where kind = 'automated' and enabled order by id loop perform private.call_refresh(s.id); end loop;
      else
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
  if m >= private.hhmm(cfg->>'snapshot') and m < private.hhmm(cfg->>'snapshot') + 120
     -- a collection started in the last 20 minutes (late start) gets time to finish; the next tick takes the snapshot
     and not exists (select 1 from public.morning_snapshots x where x.day = d and x.status in ('collecting','verifying')
                     and greatest(x.started_at, coalesce(x.verify_at, x.started_at)) > p_now - interval '20 minutes'
                     and exists (select 1 from jsonb_array_elements(private.cycle_sources(x.started_at)) c where c->>'status' in ('running','not_run'))) then
    insert into private.scheduler_steps (day, step) values (d, 'snapshot') on conflict do nothing;
    if found then
      perform public.daily_maintenance();
      insert into public.morning_snapshots (day, started_at, status) values (d, (d::timestamp at time zone 'America/New_York'), 'failed') on conflict (day) do nothing;
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
          case when snap.day is null or not exists (select 1 from private.scheduler_steps where day = d and step = 'morning') then 'Morning refresh did not start on schedule' else 'Morning refresh incomplete: ' || coalesce(snap.summary->>'sources_ok', '0') || ' of ' || coalesce(snap.summary->>'sources_total', '?') || ' sources' end,
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
