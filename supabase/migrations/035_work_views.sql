-- Read models for the interface: everything being worked on one lead, and the daily "needs attention" queue.
-- Every item says why it is shown.

create or replace function public.opportunity_work(p_opportunity uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); o public.opportunities; v_full boolean;
begin
  select * into o from private.v_opportunities where id = p_opportunity;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  v_full := o.owner_id is null or o.owner_id = me.id or me.role = 'manager';
  return jsonb_build_object(
    'full_access', v_full,
    'can_work', o.owner_id = me.id or me.role = 'manager',
    'tasks', case when v_full then public.task_list(jsonb_build_object('opportunity_id', o.id, 'scope', case when me.role = 'manager' then 'team' else 'mine' end)) else '[]' end,
    'quotes', case when v_full then (select coalesce(jsonb_agg(private.quote_json(q.id) order by q.created_at desc), '[]') from private.v_quotes q where q.opportunity_id = o.id) else '[]' end,
    'requests', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'ref', r.ref, 'status', r.status, 'missing_count', jsonb_array_length(r.missing)) order by r.received_at desc), '[]')
                 from private.v_estimate_requests r where r.opportunity_id = o.id),
    'money', case when v_full and o.owner_id is not null then public.money_summary(o.id) end,
    'participants', case when o.project_id is not null then public.project_participants(o.project_id) else '[]' end,
    'documents', case when v_full then public.list_documents(jsonb_build_object('opportunity_id', o.id)) else '[]' end,
    'members', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name) order by p.full_name), '[]')
                from public.workspace_members m join public.profiles p on p.id = m.user_id and p.active where m.workspace_id = o.workspace_id));
end $$;

create or replace function public.work_queue() returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); v_ws uuid := private.current_ws(); v_mgr boolean := private.is_member(private.current_ws(), array['owner', 'manager']) or me.role = 'manager';
  v_now timestamptz := now(); v_today date := (now() at time zone 'America/New_York')::date; items jsonb := '[]';
begin
  -- estimate requests: new or ready to price, or waiting on missing details for more than two days
  items := items || coalesce((select jsonb_agg(jsonb_build_object('kind', 'request', 'id', r.id, 'opportunity_id', r.opportunity_id, 'title', r.ref || ' · ' || r.company_name,
      'sub', coalesce(r.job_address, 'No address') || ' · ' || coalesce((select string_agg(service_name, ', ' order by sort) from public.estimate_request_items where request_id = r.id), ''),
      'why', case r.status when 'ready' then 'Has what is needed to price it.' when 'new' then 'New request.' else jsonb_array_length(r.missing) || ' detail(s) still missing; asked ' ||
             (v_today - (r.received_at at time zone 'America/New_York')::date) || ' day(s) ago.' end,
      'action', case r.status when 'missing_info' then 'Get the missing details' else 'Start the quote' end, 'at', r.received_at) order by r.received_at)
    from private.v_estimate_requests r
    where not r.is_fixture and (r.status in ('new', 'ready') or (r.status = 'missing_info' and r.received_at < v_now - interval '2 days'))
      and exists (select 1 from public.opportunities o where o.id = r.opportunity_id and (o.owner_id = me.id or (v_mgr and o.owner_id is null)))), '[]');
  -- quotes: drafts sitting, approved but not sent, sent with no answer after a week
  items := items || coalesce((select jsonb_agg(x order by x->>'at') from (
      select jsonb_build_object('kind', 'quote', 'id', q.id, 'opportunity_id', q.opportunity_id, 'title', q.ref || ' v' || v.version_no || ' · ' || q.title,
        'sub', to_char(private.version_total(v.id), 'FM$999,999,990'),
        'why', case v.status when 'draft' then 'Draft for ' || (v_today - (v.created_at at time zone 'America/New_York')::date) || ' days.'
                             when 'approved' then 'Approved but not sent.'
                             else 'Sent ' || (v_today - (v.sent_at at time zone 'America/New_York')::date) || ' days ago with no answer.' end,
        'action', case v.status when 'draft' then 'Finish and approve' when 'approved' then 'Send it' else 'Follow up on the quote' end, 'at', coalesce(v.sent_at, v.created_at)) x
      from private.v_quotes q join public.quote_versions v on v.quote_id = q.id join public.opportunities o on o.id = q.opportunity_id
      where (o.owner_id = me.id or v_mgr) and o.stage = any(private.active_stages() || array['won'])
        and ((v.status = 'draft' and v.created_at < v_now - interval '2 days') or v.status = 'approved' or (v.status = 'sent' and v.sent_at < v_now - interval '7 days'))
        and v.version_no = (select max(version_no) from public.quote_versions where quote_id = q.id)) s), '[]');
  -- awarded work waiting on the handoff or on scheduling
  items := items || coalesce((select jsonb_agg(jsonb_build_object('kind', 'job', 'id', j.id, 'opportunity_id', j.opportunity_id, 'title', j.ref || ' · ' || j.title,
      'sub', coalesce(to_char(j.amount, 'FM$999,999,990'), 'No amount'),
      'why', case when j.handoff_reviewed_at is null then 'Awarded; the handoff has not been reviewed.' else 'Handoff reviewed; not scheduled yet.' end,
      'action', case when j.handoff_reviewed_at is null then 'Review the handoff' else 'Get a date from dispatch' end, 'at', j.created_at) order by j.created_at)
    from private.v_jobs j join public.opportunities o on o.id = j.opportunity_id
    where j.status = 'ready_for_scheduling' and (o.owner_id = me.id or v_mgr)), '[]');
  -- active leads with nothing scheduled and no reason why
  items := items || coalesce((select jsonb_agg(jsonb_build_object('kind', 'no_next_step', 'id', o.id, 'opportunity_id', o.id, 'title', o.ref || ' · ' || o.title,
      'sub', (select label from public.stages where key = o.stage), 'why', 'Active, with no next step and no reason given.', 'action', 'Set the next step', 'at', o.last_activity_at) order by o.last_activity_at nulls first)
    from private.v_opportunities o where o.owner_id = me.id and o.stage = any(private.active_stages()) and o.next_action is null and o.next_action_due is null and o.no_action_reason is null), '[]');
  -- data problems that affect what the person sees (managers): sources failing or stale
  if v_mgr then
    items := items || coalesce((select jsonb_agg(jsonb_build_object('kind', 'source', 'id', s.id, 'title', s.name, 'sub', h->>'why',
        'why', 'Source is ' || lower(h->>'status') || ': leads from it may be missing or out of date.', 'action', 'Check the source', 'at', h->>'last_success'))
      from public.sources s, lateral (select private.source_health(s.id) h) x
      where s.kind = 'automated' and s.enabled and h->>'status' in ('Failed', 'Stale', 'Degraded')), '[]');
  end if;
  return jsonb_build_object('items', items, 'counts', (select jsonb_object_agg(k, n) from (select i->>'kind' k, count(*) n from jsonb_array_elements(items) i group by 1) c));
end $$;

revoke all on function public.opportunity_work(uuid), public.work_queue() from public, anon;
grant execute on function public.opportunity_work(uuid), public.work_queue() to authenticated;
