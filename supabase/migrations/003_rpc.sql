-- Speedy Sales Portal: functions the web app calls.
-- All are SECURITY DEFINER and check the caller first. Direct table access is revoked.

-- ---------------------------------------------------------------- session
create or replace function public.me() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  if p.id is null then return null; end if;
  if p.active then update public.profiles set last_seen_at = now() where id = p.id; end if;
  return jsonb_build_object('id', p.id, 'email', p.email, 'full_name', p.full_name, 'phone', p.phone,
    'role', p.role, 'active', p.active,
    'settings', (select jsonb_object_agg(key, value) from public.settings),
    'stages', (select jsonb_agg(to_jsonb(s) order by s.sort) from public.stages s),
    'unread', (select count(*) from public.notifications where user_id = p.id and read_at is null));
end $$;

create or replace function public.update_my_profile(p_full_name text, p_phone text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := private.require_active();
  update public.profiles set full_name = left(trim(coalesce(p_full_name, full_name)), 120), phone = nullif(trim(coalesce(p_phone, '')), '')
  where id = me.id;
  return public.me();
end $$;

-- ---------------------------------------------------------------- board (all lists)
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
        o.project_id, p.title as project_title, p.short_title, p.city, p.county, p.region, p.stage as project_stage,
        p.status_text, p.deadline, p.deadline_is_date, p.level, p.owner_name as project_owner,
        p.project_value, p.value_label, p.source_id, s.name as source_name, p.source_url, p.published_at,
        p.discovered_at, p.last_verified_at, p.verify_status, p.winner_name, p.winner_status, p.solicitation_no,
        (select jsonb_agg(jsonb_build_object('name', ow.full_name, 'count', ow.n))
           from (select pp.full_name, count(*) n from public.opportunities x join public.profiles pp on pp.id = x.owner_id
                 where o.company_id is not null and x.company_id = o.company_id and x.id <> o.id
                   and x.stage = any(private.active_stages()) and x.owner_id is distinct from me.id
                 group by pp.full_name) ow) as company_owners,
        (select count(*) from public.contacts ct where ct.company_id = o.company_id and not ct.archived and (ct.phone is not null or ct.email is not null)) as contact_count,
        lower(concat_ws(' ', o.ref, o.title, c.name, p.title, p.city, p.county, p.owner_name, p.solicitation_no, p.winner_name,
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

-- ---------------------------------------------------------------- one lead, full detail
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
    'expected_work_date', case when full_access then o.expected_work_date end,
    'outcome_reason', case when full_access then o.outcome_reason end,
    'priority', o.priority, 'fit_score', o.fit_score, 'urgency_score', o.urgency_score, 'priority_reasons', o.priority_reasons,
    'needs_review', case when full_access then o.needs_review end,
    'review_reason', case when full_access then o.review_reason end,
    'legacy_priority', o.legacy_priority, 'legacy', o.legacy, 'created_at', o.created_at, 'updated_at', o.updated_at,
    'superseded_by', (select jsonb_build_object('id', s.id, 'ref', s.ref, 'title', s.title) from public.opportunities s where s.id = o.superseded_by),
    'project', case when p.id is null then null else jsonb_build_object(
      'id', p.id, 'title', p.title, 'short_title', p.short_title, 'owner_name', p.owner_name, 'level', p.level,
      'location_text', p.location_text, 'city', p.city, 'county', p.county, 'region', p.region,
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

-- ---------------------------------------------------------------- ownership
create or replace function public.claim_opportunity(p_id uuid, p_ack_company boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; o public.opportunities; cur record; n int; lim int; others jsonb; v_company uuid;
begin
  me := private.require_active();
  lim := private.setting_int('max_open_claims', 60);
  select count(*) into n from public.opportunities where owner_id = me.id and stage = any(private.active_stages());
  if n >= lim then
    return jsonb_build_object('ok', false, 'reason', 'limit',
      'message', format('You already have %s open opportunities (limit %s). Release or close some first.', n, lim));
  end if;

  select company_id into v_company from public.opportunities where id = p_id;
  if not p_ack_company and v_company is not null then
    select jsonb_agg(jsonb_build_object('name', pp.full_name, 'ref', x.ref, 'title', x.title, 'stage', x.stage, 'last_activity_at', x.last_activity_at))
      into others
      from public.opportunities x join public.profiles pp on pp.id = x.owner_id
     where x.company_id = v_company and x.id <> p_id and x.owner_id <> me.id and x.stage = any(private.active_stages());
    if others is not null then
      return jsonb_build_object('ok', false, 'reason', 'company_conflict', 'owners', others,
        'message', 'Someone else is already working this company on another opportunity. Coordinate before you call.');
    end if;
  end if;

  -- The WHERE clause is the lock: only one caller can move a row from unowned to owned.
  update public.opportunities
     set owner_id = me.id, stage = 'claimed', claimed_at = now(), updated_at = now()
   where id = p_id and owner_id is null and stage = 'available' and (not needs_review or me.role = 'manager')
  returning * into o;

  if o.id is null then
    select x.owner_id, x.stage, x.claimed_at, x.needs_review, pp.full_name into cur
      from public.opportunities x left join public.profiles pp on pp.id = x.owner_id where x.id = p_id;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found', 'message', 'This opportunity no longer exists.'); end if;
    if cur.owner_id = me.id then return jsonb_build_object('ok', true, 'already_yours', true); end if;
    if cur.owner_id is not null then
      return jsonb_build_object('ok', false, 'reason', 'already_claimed', 'owner_name', cur.full_name, 'claimed_at', cur.claimed_at,
        'message', format('%s claimed this first.', coalesce(nullif(cur.full_name, ''), 'Another salesperson')));
    end if;
    return jsonb_build_object('ok', false, 'reason', 'not_available', 'stage', cur.stage,
      'message', format('This opportunity is %s, not available to claim.', lower(private.stage_label(cur.stage))));
  end if;

  insert into public.ownership_history (opportunity_id, action, to_user, by_user) values (o.id, 'claim', me.id, me.id);
  insert into public.activities (opportunity_id, company_id, user_id, kind, from_stage, to_stage, body)
  values (o.id, o.company_id, me.id, 'claim', 'available', 'claimed', case when p_ack_company then 'Claimed after seeing that a teammate also works this company.' end);
  return jsonb_build_object('ok', true, 'id', o.id, 'ref', o.ref);
end $$;

create or replace function public.release_opportunity(p_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; o public.opportunities;
begin
  me := private.require_active();
  select * into o from public.opportunities where id = p_id for update;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if o.owner_id is null then return jsonb_build_object('ok', false, 'reason', 'not_owned', 'message', 'Nobody owns this opportunity.'); end if;
  if me.role <> 'manager' and o.owner_id <> me.id then
    raise exception 'not_owner' using errcode = '42501', hint = 'Only the owner or a manager can release this opportunity.';
  end if;
  if me.role <> 'manager' and not (o.stage = any(private.active_stages()) or o.stage = 'nurture') then
    raise exception 'manager_only' using errcode = '42501', hint = 'Ask a manager to reopen a closed opportunity.';
  end if;
  update public.opportunities set owner_id = null, stage = 'available', claimed_at = null, next_action_due = null,
    closed_at = null, updated_at = now() where id = p_id;
  insert into public.ownership_history (opportunity_id, action, from_user, by_user, reason) values (p_id, 'release', o.owner_id, me.id, nullif(trim(p_reason), ''));
  insert into public.activities (opportunity_id, company_id, user_id, kind, from_stage, to_stage, body)
  values (p_id, o.company_id, me.id, 'release', o.stage, 'available', nullif(trim(p_reason), ''));
  if o.owner_id <> me.id then
    perform private.notify(o.owner_id, p_id, 'released', format('%s was released to the pool', o.ref),
      format('%s released "%s"%s', me.full_name, o.title, coalesce(': ' || nullif(trim(p_reason), ''), '')));
  end if;
  perform private.rescore(p_id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.assign_opportunity(p_id uuid, p_user uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; o public.opportunities; target public.profiles; new_stage text; act text;
begin
  me := private.require_manager();
  select * into o from public.opportunities where id = p_id for update;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_user is null then return public.release_opportunity(p_id, p_reason); end if;
  select * into target from public.profiles where id = p_user;
  if target.id is null or not target.active then
    return jsonb_build_object('ok', false, 'reason', 'inactive_user', 'message', 'Pick an active team member.');
  end if;
  if o.owner_id = p_user then return jsonb_build_object('ok', true, 'unchanged', true); end if;
  new_stage := case when o.stage = 'available' then 'claimed' else o.stage end;
  act := case when o.owner_id is null then 'assign' else 'reassign' end;
  update public.opportunities set owner_id = p_user, stage = new_stage, needs_review = case when o.stage = 'available' then false else needs_review end,
    claimed_at = case when o.owner_id is null then now() else claimed_at end, updated_at = now() where id = p_id;
  insert into public.ownership_history (opportunity_id, action, from_user, to_user, by_user, reason)
  values (p_id, act, o.owner_id, p_user, me.id, nullif(trim(p_reason), ''));
  insert into public.activities (opportunity_id, company_id, user_id, kind, from_stage, to_stage, body, data)
  values (p_id, o.company_id, me.id, 'assign', o.stage, new_stage,
          format('Assigned to %s%s', target.full_name, coalesce('. ' || nullif(trim(p_reason), ''), '')),
          jsonb_build_object('from_user', o.owner_id, 'to_user', p_user));
  perform private.notify(p_user, p_id, 'assigned', format('%s assigned to you', o.ref),
    format('%s assigned "%s" to you%s', me.full_name, o.title, coalesce(': ' || nullif(trim(p_reason), ''), '')));
  if o.owner_id is not null and o.owner_id <> me.id then
    perform private.notify(o.owner_id, p_id, 'reassigned', format('%s moved to %s', o.ref, target.full_name),
      format('%s reassigned "%s" to %s', me.full_name, o.title, target.full_name));
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- logging work
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
  elsif v_kind = any(contact_kinds) and o.stage = 'claimed' then
    v_stage := 'contacted';   -- first call/email on a claimed lead moves it to Contacted
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
  if p ? 'expected_work_date' and (nullif(p->>'expected_work_date', '')::date) is distinct from o.expected_work_date then
    n.expected_work_date := nullif(p->>'expected_work_date', '')::date; changes := changes || jsonb_build_object('expected_work_date', jsonb_build_array(o.expected_work_date, n.expected_work_date));
  end if;
  if p ? 'outcome_reason' and coalesce(p->>'outcome_reason', '') is distinct from coalesce(o.outcome_reason, '') then
    n.outcome_reason := nullif(trim(p->>'outcome_reason'), ''); changes := changes || jsonb_build_object('outcome_reason', jsonb_build_array(o.outcome_reason, n.outcome_reason));
  end if;

  if v_body is null and v_outcome is null and changes = '{}'::jsonb and v_kind not in ('call','email','text','visit','meeting') then
    return jsonb_build_object('ok', false, 'reason', 'empty', 'message', 'Nothing to save.');
  end if;

  summary := concat_ws(': ', initcap(v_kind), replace(v_outcome, '_', ' '));
  update public.opportunities set
    stage = n.stage, closed_at = n.closed_at, next_action = n.next_action, next_action_due = n.next_action_due,
    services_confirmed = n.services_confirmed, scope_confirmed_note = n.scope_confirmed_note,
    quote_amount = n.quote_amount, quote_sent_at = n.quote_sent_at, expected_work_date = n.expected_work_date,
    outcome_reason = n.outcome_reason,
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

-- add or correct a contact; old values are kept in the activity timeline
create or replace function public.save_contact(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; v_opp public.opportunities; v_id uuid := nullif(p->>'id', '')::uuid; old public.contacts; v_company uuid;
        v_verified boolean := coalesce((p->>'verified')::boolean, false); newc public.contacts;
begin
  me := private.require_active();
  select * into v_opp from public.opportunities where id = nullif(p->>'opportunity_id', '')::uuid;
  if v_opp.id is null then raise exception 'not_found' using errcode = 'P0002', hint = 'Open the lead first.'; end if;
  if me.role <> 'manager' and v_opp.owner_id is distinct from me.id then
    raise exception 'not_owner' using errcode = '42501', hint = 'Claim this opportunity before editing its contacts.';
  end if;
  v_company := v_opp.company_id;
  if v_company is null then raise exception 'no_company' using errcode = '22023', hint = 'This opportunity has no company to attach a contact to.'; end if;
  if coalesce(nullif(trim(p->>'name'), ''), nullif(trim(p->>'phone'), ''), nullif(trim(p->>'email'), '')) is null and not coalesce((p->>'archived')::boolean, false) then
    raise exception 'empty_contact' using errcode = '22023', hint = 'Enter at least a name, phone or email.';
  end if;
  if v_id is null then
    insert into public.contacts (company_id, name, title, phone, email, notes, verified, verified_at, verified_by, source, created_by)
    values (v_company, nullif(trim(p->>'name'), ''), nullif(trim(p->>'title'), ''), nullif(trim(p->>'phone'), ''), nullif(lower(trim(p->>'email')), ''),
            nullif(trim(p->>'notes'), ''), v_verified, case when v_verified then now() end, case when v_verified then me.id end, 'salesperson', me.id)
    returning * into newc;
    insert into public.activities (opportunity_id, company_id, contact_id, user_id, kind, body, data)
    values (v_opp.id, v_company, newc.id, me.id, 'contact', format('Added contact %s%s', coalesce(newc.name, newc.phone, newc.email), case when v_verified then ' (verified)' else '' end),
            jsonb_build_object('new', to_jsonb(newc) - 'created_at' - 'updated_at'));
  else
    select * into old from public.contacts where id = v_id and company_id = v_company for update;
    if old.id is null then raise exception 'bad_contact' using errcode = '22023'; end if;
    update public.contacts set
      name = case when p ? 'name' then nullif(trim(p->>'name'), '') else name end,
      title = case when p ? 'title' then nullif(trim(p->>'title'), '') else title end,
      phone = case when p ? 'phone' then nullif(trim(p->>'phone'), '') else phone end,
      email = case when p ? 'email' then nullif(lower(trim(p->>'email')), '') else email end,
      notes = case when p ? 'notes' then nullif(trim(p->>'notes'), '') else notes end,
      archived = coalesce((p->>'archived')::boolean, archived),
      verified = case when p ? 'verified' then v_verified else verified end,
      verified_at = case when p ? 'verified' and v_verified then now() when p ? 'verified' then null else verified_at end,
      verified_by = case when p ? 'verified' and v_verified then me.id when p ? 'verified' then null else verified_by end,
      updated_at = now()
    where id = v_id returning * into newc;
    insert into public.activities (opportunity_id, company_id, contact_id, user_id, kind, body, data)
    values (v_opp.id, v_company, v_id, me.id, 'contact',
            case when newc.archived and not old.archived then format('Removed contact %s', coalesce(old.name, old.phone, old.email))
                 when newc.verified and not old.verified then format('Verified contact %s', coalesce(newc.name, newc.phone, newc.email))
                 else format('Updated contact %s', coalesce(newc.name, newc.phone, newc.email)) end,
            jsonb_build_object('old', to_jsonb(old) - 'created_at' - 'updated_at', 'new', to_jsonb(newc) - 'created_at' - 'updated_at'));
  end if;
  perform private.rescore(o.id) from public.opportunities o where o.company_id = v_company;
  return jsonb_build_object('ok', true, 'id', newc.id);
end $$;

-- ---------------------------------------------------------------- notifications
create or replace function public.get_notifications() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := private.require_active();
  return coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'title', n.title, 'body', n.body, 'at', n.created_at,
            'read', n.read_at is not null, 'opportunity_id', n.opportunity_id) order by n.created_at desc)
          from (select * from public.notifications where user_id = me.id order by created_at desc limit 60) n), '[]');
end $$;

create or replace function public.mark_notifications_read(p_ids bigint[] default null) returns int
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; c int;
begin
  me := private.require_active();
  update public.notifications set read_at = now() where user_id = me.id and read_at is null and (p_ids is null or id = any(p_ids));
  get diagnostics c = row_count;
  return c;
end $$;

-- ---------------------------------------------------------------- manager: team, review queue, settings
create or replace function public.team_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles; stale int;
begin
  me := private.require_manager();
  stale := private.setting_int('stale_days', 14);
  return jsonb_build_object(
    'stale_days', stale,
    'people', (select coalesce(jsonb_agg(x order by x->>'name'), '[]') from (
      select jsonb_build_object('id', p.id, 'name', p.full_name, 'email', p.email, 'role', p.role, 'active', p.active, 'last_seen_at', p.last_seen_at,
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
    'pipeline', (select coalesce(jsonb_object_agg(stage, n), '{}') from (select stage, count(*) n from public.opportunities group by stage) s),
    'recent', (select coalesce(jsonb_agg(jsonb_build_object('at', a.created_at, 'kind', a.kind, 'outcome', a.outcome, 'body', left(a.body, 240),
        'to_stage', a.to_stage, 'user_name', (select full_name from public.profiles where id = a.user_id),
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

create or replace function public.resolve_review(p_id uuid, p_action text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; o public.opportunities;
begin
  me := private.require_manager();
  select * into o from public.opportunities where id = p_id for update;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_action = 'publish' then
    update public.opportunities set needs_review = false, review_kind = null, review_reason = null, updated_at = now() where id = p_id;
  elsif p_action = 'archive' then
    update public.opportunities set needs_review = false, review_kind = null, review_reason = null, stage = 'archived',
      outcome_reason = coalesce(nullif(trim(p_note), ''), 'Archived during review'), closed_at = now(), updated_at = now() where id = p_id;
  elsif p_action = 'keep' then
    update public.opportunities set needs_review = false, review_kind = null, review_reason = null, updated_at = now() where id = p_id;
  else
    raise exception 'bad_action' using errcode = '22023';
  end if;
  insert into public.activities (opportunity_id, company_id, user_id, kind, body, from_stage, to_stage, data)
  values (p_id, o.company_id, me.id, 'review', concat_ws(': ', case p_action when 'publish' then 'Reviewed and published to the pool'
            when 'archive' then 'Reviewed and archived' else 'Reviewed, no change' end, nullif(trim(p_note), '')),
          case when p_action = 'archive' then o.stage end, case when p_action = 'archive' then 'archived' end,
          jsonb_build_object('review_reason', o.review_reason));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.update_setting(p_key text, p_value jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := private.require_manager();
  if p_key = 'stale_days' and ((p_value #>> '{}')::int not between 3 and 90) then raise exception 'bad_value' using errcode = '22023', hint = 'Pick 3 to 90 days.'; end if;
  if p_key = 'max_open_claims' and ((p_value #>> '{}')::int not between 5 and 500) then raise exception 'bad_value' using errcode = '22023', hint = 'Pick 5 to 500.'; end if;
  update public.settings set value = p_value, updated_at = now(), updated_by = me.id where key = p_key;
  if not found then raise exception 'bad_key' using errcode = '22023'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- manual lead entry (news, local bid boards, referrals)
create or replace function public.add_lead(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; v_proj uuid; v_comp uuid; v_opp public.opportunities; dupes jsonb; v_src text := coalesce(nullif(p->>'source_id', ''), 'portal_manual');
        v_title text := nullif(trim(p->>'project_title'), ''); v_company text := nullif(trim(p->>'company_name'), ''); v_url text := nullif(trim(p->>'source_url'), '');
begin
  me := private.require_manager();
  if v_title is null or v_url is null then
    raise exception 'missing_fields' using errcode = '22023', hint = 'Project title and source link are required.';
  end if;
  if not exists (select 1 from public.sources where id = v_src) then v_src := 'portal_manual'; end if;
  if not coalesce((p->>'force')::boolean, false) then
    select jsonb_agg(jsonb_build_object('project_id', pj.id, 'title', pj.title, 'source_url', pj.source_url,
             'opps', (select jsonb_agg(jsonb_build_object('id', x.id, 'ref', x.ref, 'title', x.title)) from public.opportunities x where x.project_id = pj.id)))
      into dupes from public.projects pj
     where pj.source_url = v_url or private.norm_key(pj.title) = private.norm_key(v_title)
        or (private.norm_sol(p->>'solicitation_no') is not null and pj.sol_key = private.norm_sol(p->>'solicitation_no'));
    if dupes is not null then
      return jsonb_build_object('ok', false, 'reason', 'possible_duplicate', 'matches', dupes,
        'message', 'A project with the same link, title or solicitation number already exists.');
    end if;
  end if;
  if v_company is not null then
    insert into public.companies (name, name_key, kind, website, phone)
    values (v_company, private.norm_key(v_company), coalesce(nullif(p->>'company_kind', ''), 'contractor'), nullif(trim(p->>'company_website'), ''), nullif(trim(p->>'company_phone'), ''))
    on conflict (name_key) do update set updated_at = now() returning id into v_comp;
  end if;
  insert into public.projects (external_key, source_id, title, owner_name, level, location_text, city, county, region, stage, status_text,
     project_value, value_label, solicitation_no, sol_key, deadline, deadline_is_date, published_at, discovered_at, source_url, source_name,
     source_summary, scope_evidence, services_likely, last_verified_at, verify_status)
  values ('manual:' || gen_random_uuid(), v_src, v_title, nullif(trim(p->>'owner_name'), ''), coalesce(nullif(p->>'level', ''), 'Private'),
     nullif(trim(p->>'location_text'), ''), nullif(trim(p->>'city'), ''), nullif(trim(p->>'county'), ''), coalesce(nullif(p->>'region', ''), 'Unknown'),
     coalesce(nullif(p->>'project_stage', ''), 'unknown'), nullif(trim(p->>'status_text'), ''), nullif(p->>'project_value', '')::numeric,
     nullif(trim(p->>'value_label'), ''), nullif(trim(p->>'solicitation_no'), ''), private.norm_sol(p->>'solicitation_no'),
     nullif(p->>'deadline', '')::timestamptz, false, nullif(p->>'published_at', '')::date, now(), v_url, nullif(trim(p->>'source_name'), ''),
     nullif(trim(p->>'source_summary'), ''), private.scope_evidence(concat_ws(' ', v_title, p->>'source_summary')),
     coalesce((select array_agg(x) from jsonb_array_elements_text(p->'services') x), '{}'), now(), 'ok')
  returning id into v_proj;
  if nullif(trim(coalesce(p->>'contact_name', '') || coalesce(p->>'contact_phone', '') || coalesce(p->>'contact_email', '')), '') is not null and v_comp is not null then
    insert into public.contacts (company_id, name, title, phone, email, source, created_by)
    values (v_comp, nullif(trim(p->>'contact_name'), ''), nullif(trim(p->>'contact_title'), ''), nullif(trim(p->>'contact_phone'), ''),
            nullif(lower(trim(p->>'contact_email')), ''), 'research', me.id);
  end if;
  insert into public.opportunities (project_id, company_id, kind, approach, title, next_action, services, speedy_scope, created_by)
  values (v_proj, v_comp, coalesce(nullif(p->>'kind', ''), 'contractor_outreach'), coalesce(nullif(p->>'approach', ''), 'approach_prime'),
          coalesce(v_company || ' — ' || v_title, v_title), nullif(trim(p->>'next_action'), ''),
          coalesce((select array_agg(x) from jsonb_array_elements_text(p->'services') x), '{}'), nullif(trim(p->>'speedy_scope'), ''), me.id)
  returning * into v_opp;
  insert into public.activities (opportunity_id, company_id, user_id, kind, body) values (v_opp.id, v_comp, me.id, 'system', 'Added to the portal by hand');
  perform private.rescore(v_opp.id);
  return jsonb_build_object('ok', true, 'id', v_opp.id, 'ref', v_opp.ref);
end $$;

create or replace function public.sources_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := private.require_manager();
  return jsonb_build_object(
    'sources', (select jsonb_agg(to_jsonb(s) - 'config' order by s.kind, s.name) from public.sources s),
    'runs', (select coalesce(jsonb_agg(to_jsonb(r) order by r.started_at desc), '[]') from (select * from public.refresh_runs order by started_at desc limit 40) r),
    'changes', (select coalesce(jsonb_agg(jsonb_build_object('at', c.created_at, 'field', c.field, 'old', c.old_value, 'new', c.new_value,
                  'material', c.material, 'project_id', c.project_id, 'project_title', p.title,
                  'opps', (select jsonb_agg(jsonb_build_object('id', o.id, 'ref', o.ref, 'owner_name', (select full_name from public.profiles where id = o.owner_id)))
                           from public.opportunities o where o.project_id = c.project_id)) order by c.created_at desc), '[]')
                from (select * from public.refresh_changes order by created_at desc limit 60) c join public.projects p on p.id = c.project_id),
    'review', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'ref', o.ref, 'title', o.title, 'stage', o.stage, 'review_kind', o.review_kind,
                  'review_reason', o.review_reason, 'owner_name', (select full_name from public.profiles where id = o.owner_id),
                  'source_url', p.source_url, 'priority', o.priority, 'created_at', o.created_at) order by o.created_at desc), '[]')
               from public.opportunities o left join public.projects p on p.id = o.project_id where o.needs_review),
    'freshness', (select jsonb_build_object(
        'verified_7d', count(*) filter (where last_verified_at > now() - interval '7 days'),
        'verified_30d', count(*) filter (where last_verified_at <= now() - interval '7 days' and last_verified_at > now() - interval '30 days'),
        'older', count(*) filter (where last_verified_at <= now() - interval '30 days'),
        'never', count(*) filter (where last_verified_at is null),
        'failed', count(*) filter (where verify_status in ('failed','missing')))
      from public.projects p where exists (select 1 from public.opportunities o where o.project_id = p.id and o.stage not in ('archived','won','lost','disqualified'))),
    'settings', (select jsonb_object_agg(key, jsonb_build_object('value', value, 'description', description)) from public.settings));
end $$;

-- ---------------------------------------------------------------- exports
-- scope 'mine' = caller's own opportunities (anyone). 'team' = everything open (managers only).
create or replace function public.export_rows(p_scope text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; rows jsonb; n int;
begin
  me := private.require_active();
  if p_scope not in ('mine','team') then raise exception 'bad_scope' using errcode = '22023'; end if;
  if p_scope = 'team' and me.role <> 'manager' then
    raise exception 'manager_only' using errcode = '42501', hint = 'Team exports are for managers. You can export your own pipeline.';
  end if;
  select coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(x)) order by x.priority_rank, x.region_rank, x.deadline nulls last), '[]'), count(*) into rows, n from (
    select o.id, o.ref, o.title, o.kind, o.approach, o.approach_note, o.stage, private.stage_label(o.stage) as stage_label,
      own.full_name as owner_name, o.next_action, o.next_action_due, o.last_activity_at, o.last_activity_summary,
      o.services, o.services_confirmed, o.speedy_scope, o.quote_amount, o.quote_sent_at, o.expected_work_date, o.outcome_reason,
      o.priority, o.fit_score, o.urgency_score, o.priority_reasons->>'summary' as priority_summary,
      case o.priority when 'Hot' then 0 when 'Warm' then 1 else 2 end as priority_rank,
      array_position(array['Central FL','Tampa Bay','North FL','Southwest FL','South FL','Panhandle'], p.region) as region_rank,
      c.name as company_name, c.hq as company_hq, c.website as company_website,
      p.title as project_title, p.short_title, p.owner_name as project_owner, p.level, p.location_text, p.city, p.county, p.region,
      p.stage as project_stage, p.status_text, p.project_value, p.value_label, p.size_note, p.solicitation_no, p.set_aside,
      p.deadline, p.deadline_is_date, p.deadline_note, p.published_at, p.discovered_at, p.last_verified_at, p.verify_status,
      p.source_url, s.name as source_name, p.source_summary, p.winner_name, p.winner_status, p.winner_amount, p.pocs,
      (select jsonb_agg(jsonb_build_object('name', ct.name, 'title', ct.title, 'phone', ct.phone, 'email', ct.email, 'web', ct.web, 'verified', ct.verified)
                        order by ct.verified desc, ct.created_at)
         from public.contacts ct where ct.company_id = o.company_id and not ct.archived) as contacts,
      (select string_agg(to_char(a.created_at at time zone 'America/New_York', 'Mon DD') || ' ' || coalesce(pp.full_name, '') || ': ' ||
                         concat_ws(' - ', initcap(a.kind) || coalesce(' (' || replace(a.outcome, '_', ' ') || ')', ''), a.body), E'\n' order by a.created_at desc)
         from (select * from public.activities a2 where a2.opportunity_id = o.id and a2.kind in ('call','email','text','visit','meeting','note','quote','import') and coalesce(a2.dedupe_key, '') not like 'legacy:%'
               order by a2.created_at desc limit 3) a left join public.profiles pp on pp.id = a.user_id) as recent_notes
    from public.opportunities o
    left join public.projects p on p.id = o.project_id
    left join public.companies c on c.id = o.company_id
    left join public.sources s on s.id = p.source_id
    left join public.profiles own on own.id = o.owner_id
    where (p_scope = 'mine' and o.owner_id = me.id)
       or (p_scope = 'team' and o.stage not in ('archived') and not (o.stage = 'available' and o.needs_review))
  ) x;
  insert into public.exports_log (user_id, scope, row_count) values (me.id, p_scope, n);
  return jsonb_build_object('generated_at', now(), 'scope', p_scope, 'generated_by', me.full_name, 'rows', rows);
end $$;
