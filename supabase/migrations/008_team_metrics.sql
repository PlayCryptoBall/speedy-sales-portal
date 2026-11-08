-- Speedy Sales Portal: team page metrics (UI redesign, November 2026).
-- 1. team_overview.pipeline counted every stage = 'available' row, including new finds that are still waiting
--    for a manager's review and are hidden from salespeople. That made "Available" read 146 on the Team page
--    while the Available list showed 132. Unreviewed rows now count under their own key, 'in_review',
--    so each number matches what it is labelled. Nothing else about the counts changes.
-- 2. Each person gets 'last_activity_at' (their newest logged call, email, text, visit, meeting, note or quote).
-- 3. person_activity(): a manager-only feed of one person's recent logged work, for the person detail panel.
-- No tables or stored data change.

create or replace function public.team_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles; stale int;
begin
  me := private.require_manager();
  stale := private.setting_int('stale_days', 14);
  return jsonb_build_object(
    'stale_days', stale,
    'max_open_claims', private.setting_int('max_open_claims', 60),
    'people', (select coalesce(jsonb_agg(x order by x->>'name'), '[]') from (
      select jsonb_build_object('id', p.id, 'name', p.full_name, 'email', p.email, 'role', p.role, 'active', p.active, 'last_seen_at', p.last_seen_at,
        'last_activity_at', (select max(a.created_at) from public.activities a where a.user_id = p.id and a.kind in ('call','email','text','visit','meeting','note','quote')),
        'open', (select count(*) from public.opportunities o where o.owner_id = p.id and o.stage = any(private.active_stages())),
        'by_stage', (select coalesce(jsonb_object_agg(stage, n), '{}') from (select stage, count(*) n from public.opportunities where owner_id = p.id group by stage) s),
        'activities_7d', (select count(*) from public.activities a where a.user_id = p.id and a.kind in ('call','email','text','visit','meeting','note','quote') and a.created_at > now() - interval '7 days'),
        'calls_7d', (select count(*) from public.activities a where a.user_id = p.id and a.kind = 'call' and a.created_at > now() - interval '7 days'),
        'activities_30d', (select count(*) from public.activities a where a.user_id = p.id and a.kind in ('call','email','text','visit','meeting','note','quote') and a.created_at > now() - interval '30 days'),
        'quotes_open', (select count(*) from public.opportunities o where o.owner_id = p.id and o.stage in ('quote_needed','quote_sent')),
        'quoted_value', (select coalesce(sum(quote_amount), 0) from public.opportunities o where o.owner_id = p.id and o.stage in ('quote_sent','follow_up','won')),
        'won', (select count(*) from public.opportunities o where o.owner_id = p.id and o.stage = 'won'),
        'won_value', (select coalesce(sum(quote_amount), 0) from public.opportunities o where o.owner_id = p.id and o.stage = 'won'),
        'lost', (select count(*) from public.opportunities o where o.owner_id = p.id and o.stage = 'lost'),
        'overdue', (select count(*) from public.opportunities o where o.owner_id = p.id and o.stage = any(private.active_stages()) and o.next_action_due < current_date),
        'stale', (select count(*) from public.opportunities o where o.owner_id = p.id and o.stage = any(private.active_stages())
                    and coalesce(o.last_activity_at, o.claimed_at) < now() - make_interval(days => stale))) x
      from public.profiles p where p.active or exists (select 1 from public.opportunities o where o.owner_id = p.id)) t),
    'stale_list', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'ref', o.ref, 'title', o.title, 'stage', o.stage,
        'owner_id', o.owner_id, 'owner_name', p.full_name, 'claimed_at', o.claimed_at, 'last_activity_at', o.last_activity_at,
        'next_action_due', o.next_action_due, 'company_name', (select name from public.companies where id = o.company_id))
        order by coalesce(o.last_activity_at, o.claimed_at)), '[]')
      from public.opportunities o join public.profiles p on p.id = o.owner_id
      where o.stage = any(private.active_stages()) and coalesce(o.last_activity_at, o.claimed_at) < now() - make_interval(days => stale)),
    -- every opportunity counted once, by current stage; unreviewed new finds are 'in_review', not 'available'
    'pipeline', (select coalesce(jsonb_object_agg(k, n), '{}') from (
        select case when stage = 'available' and needs_review then 'in_review' else stage end k, count(*) n
        from public.opportunities group by 1) s),
    'recent', (select coalesce(jsonb_agg(jsonb_build_object('at', a.created_at, 'kind', a.kind, 'outcome', a.outcome, 'body', left(a.body, 240),
        'to_stage', a.to_stage, 'user_id', a.user_id, 'user_name', (select full_name from public.profiles where id = a.user_id),
        'opportunity_id', a.opportunity_id, 'ref', (select ref from public.opportunities where id = a.opportunity_id),
        'title', (select title from public.opportunities where id = a.opportunity_id)) order by a.created_at desc), '[]')
      from (select * from public.activities where user_id is not null and kind not in ('system','refresh') order by created_at desc limit 40) a),
    'pool_trend', (select coalesce(jsonb_agg(to_jsonb(s) order by s.day), '[]') from (select * from public.pool_snapshots order by day desc limit 60) s),
    'source_productivity', (select coalesce(jsonb_agg(x), '[]') from (
      select jsonb_build_object('source_id', s.id, 'name', s.name,
        'total', count(o.id), 'available', count(o.id) filter (where o.stage = 'available' and not o.needs_review),
        'hot_available', count(o.id) filter (where o.stage = 'available' and o.priority = 'Hot' and not o.needs_review),
        'worked', count(o.id) filter (where o.stage not in ('available','archived')),
        'contacted', count(o.id) filter (where o.stage in ('contacted','qualified','quote_needed','quote_sent','follow_up','won','lost','nurture')),
        'quoted', count(o.id) filter (where o.stage in ('quote_needed','quote_sent','follow_up','won')),
        'won', count(o.id) filter (where o.stage = 'won'),
        'added_30d', count(o.id) filter (where o.created_at > now() - interval '30 days')) x
      from public.sources s left join public.projects p on p.source_id = s.id left join public.opportunities o on o.project_id = p.id
      group by s.id, s.name order by count(o.id) desc) t));
end $$;

-- one person's recent logged work (managers only)
create or replace function public.person_activity(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := private.require_manager();
  return coalesce((select jsonb_agg(jsonb_build_object('at', a.created_at, 'kind', a.kind, 'outcome', a.outcome, 'body', left(a.body, 240),
            'from_stage', a.from_stage, 'to_stage', a.to_stage, 'opportunity_id', a.opportunity_id,
            'ref', o.ref, 'title', o.title, 'company_name', c.name) order by a.created_at desc, a.id desc)
          from (select * from public.activities where user_id = p_user order by created_at desc, id desc limit 60) a
          left join public.opportunities o on o.id = a.opportunity_id
          left join public.companies c on c.id = o.company_id), '[]');
end $$;

revoke execute on function public.person_activity(uuid) from public, anon;
grant execute on function public.person_activity(uuid) to authenticated;
