-- Speedy Sales Portal: helpers and lead scoring

-- ---------------------------------------------------------------- small helpers
create or replace function private.norm_key(t text) returns text
language plpgsql immutable set search_path = '' as $$
declare s text;
begin
  s := lower(coalesce(split_part(t, '(', 1), ''));
  s := replace(s, '&', ' and ');
  s := regexp_replace(s, '[^a-z0-9]+', ' ', 'g');
  s := ' ' || s || ' ';
  s := regexp_replace(s, ' (inc|incorporated|llc|l l c|co|corp|corporation|company|jv|j v|ltd|lp|llp|pllc|the|of florida|fl) ', ' ', 'g');
  s := regexp_replace(s, ' (inc|incorporated|llc|l l c|co|corp|corporation|company|jv|j v|ltd|lp|llp|pllc|the|of florida|fl) ', ' ', 'g');
  return trim(regexp_replace(s, '\s+', ' ', 'g'));
end $$;

create or replace function private.norm_sol(t text) returns text
language sql immutable set search_path = '' as $$
  select nullif(regexp_replace(regexp_replace(upper(coalesce(t, '')), '[^A-Z0-9-]', '', 'g'), '-R0$', ''), '')
$$;

create or replace function private.setting_int(k text, dflt int) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce((select (value #>> '{}')::int from public.settings where key = k), dflt)
$$;

create or replace function private.active_stages() returns text[]
language sql immutable set search_path = '' as $$
  select array['claimed','contacted','qualified','quote_needed','quote_sent','follow_up']
$$;

create or replace function private.stage_label(k text) returns text
language sql stable set search_path = '' as $$
  select coalesce((select label from public.stages where key = k), k)
$$;

create or replace function private.require_active() returns public.profiles
language plpgsql stable security definer set search_path = '' as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  if p.id is null or not p.active then
    raise exception 'not_authorized' using errcode = '42501', hint = 'This account is not active in the Speedy portal. Ask your manager.';
  end if;
  return p;
end $$;

create or replace function private.require_manager() returns public.profiles
language plpgsql stable security definer set search_path = '' as $$
declare p public.profiles;
begin
  p := private.require_active();
  if p.role <> 'manager' then
    raise exception 'manager_only' using errcode = '42501', hint = 'Only a manager can do this.';
  end if;
  return p;
end $$;

create or replace function private.notify(p_user uuid, p_opp uuid, p_kind text, p_title text, p_body text, p_dedupe text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null then return; end if;
  insert into public.notifications (user_id, opportunity_id, kind, title, body, dedupe_key)
  values (p_user, p_opp, p_kind, p_title, p_body, p_dedupe)
  on conflict (dedupe_key) do nothing;
end $$;

create or replace function private.notify_managers(p_opp uuid, p_kind text, p_title text, p_body text, p_dedupe text default null, p_except uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare m record;
begin
  for m in select id from public.profiles where role = 'manager' and active and id is distinct from p_except loop
    perform private.notify(m.id, p_opp, p_kind, p_title, p_body, case when p_dedupe is null then null else p_dedupe || ':' || m.id end);
  end loop;
end $$;

-- Services Speedy sells. "Core" ones get full fit points.
create or replace function private.core_services() returns text[]
language sql immutable set search_path = '' as $$
  select array['GPR scanning','Core drilling','Wall sawing','Slab sawing','Wire sawing','Chain sawing','Curb sawing','Flat sawing','Breaking & removal','Selective demolition']
$$;

-- Words in a source description that point to work Speedy does.
create or replace function private.scope_evidence(t text) returns text[]
language plpgsql immutable set search_path = '' as $$
declare
  pats text[][] := array[
    array['demolition','demoli'], array['concrete removal','concrete (removal|remov)|remove (existing )?concrete|removal (and|&) replacement of concrete'],
    array['concrete cutting','concrete cutting|saw ?cut|sawcut|saw cutting|wall saw|wire saw|slab saw'],
    array['core drilling','core drill|coring'], array['GPR / scanning','gpr|ground penetrating|concrete scanning'],
    array['concrete repair','concrete repair|spall'], array['sidewalk / curb','sidewalk|curb'],
    array['bridge work','bridge|deck|barrier wall'], array['pavement replacement','rigid pavement|concrete pavement|pavement (removal|replacement|reconstruction)|apron|taxiway|taxilane'],
    array['renovation / alteration','renovat|alteration|tie-in|retrofit'], array['grinding','grinding|grind']];
  out text[] := '{}';
  i int;
  s text := lower(coalesce(t, ''));
begin
  for i in 1 .. array_length(pats, 1) loop
    if s ~ pats[i][2] then out := out || pats[i][1]; end if;
  end loop;
  return out;
end $$;

-- ---------------------------------------------------------------- scoring
-- Fit (0-100) = is this our kind of work, from a source we trust, near us, with someone to call.
-- Urgency (0-100) = how soon it needs a call. Kept separate on purpose.
create or replace function private.score(p_opp uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o public.opportunities;
  p public.projects;
  svc text[];
  ncore int := 0; ngrind int := 0;
  fit int := 0; urg int := 0;
  pts int; txt text;
  f jsonb := '[]'; u jsonb := '[]';
  days numeric;
  cq int := 0; ctxt text := 'No phone or email on file yet';
  c record;
  prio text;
  stage text;
begin
  select * into o from public.opportunities where id = p_opp;
  if o.id is null then return null; end if;
  select * into p from public.projects where id = o.project_id;

  svc := case when cardinality(o.services_confirmed) > 0 then o.services_confirmed
              when cardinality(o.services) > 0 then o.services
              else coalesce(p.services_likely, '{}') end;
  select count(*) filter (where s = any(private.core_services())), count(*) filter (where s ilike '%grind%')
    into ncore, ngrind from unnest(svc) s;

  -- 1. service fit (20): does the likely work match what Speedy sells
  pts := case when ncore >= 3 then 20 when ncore = 2 then 16 when ncore = 1 then 11 when ngrind > 0 then 7 else 0 end;
  txt := case when ncore > 0 then 'Likely Speedy work: ' || array_to_string(svc[1:4], ', ')
              when ngrind > 0 then 'Grinding only'
              else 'No cutting, coring, GPR or removal identified' end;
  fit := fit + pts; f := f || jsonb_build_object('factor','Service fit','points',pts,'max',20,'text',txt);

  -- 2. evidence of scope (25): confirmed by a contact > described in the source > inferred by us
  if cardinality(o.services_confirmed) > 0 then
    pts := 25; txt := 'Confirmed by the contact: ' || array_to_string(o.services_confirmed, ', ');
  elsif coalesce(p.scope_evidence, '{}') && array['demolition','concrete removal','concrete cutting','core drilling','GPR / scanning'] then
    pts := 20; txt := 'Source describes ' || array_to_string(p.scope_evidence[1:4], ', ') || ' (not a confirmed request for pricing)';
  elsif cardinality(coalesce(p.scope_evidence, '{}')) > 0 then
    pts := 12; txt := 'Source describes related work: ' || array_to_string(p.scope_evidence[1:4], ', ') || ' (our services inferred)';
  else
    pts := 5; txt := 'Scope inferred from the project type; not stated in the source';
  end if;
  fit := fit + pts; f := f || jsonb_build_object('factor','Scope evidence','points',pts,'max',25,'text',txt);

  -- 3. project stage (20)
  stage := coalesce(p.stage, case when o.kind = 'relationship' then 'completed' else 'unknown' end);
  if stage = 'bidding' and p.deadline is not null and p.deadline < now() then stage := 'bid_closed'; end if;
  pts := case stage
    when 'low_bidder' then 18 when 'intent_to_award' then 19 when 'awarded' then 20 when 'preconstruction' then 20
    when 'under_construction' then 16 when 'bidding' then 15 when 'bid_closed' then 11 when 'upcoming' then 9
    when 'planning' then 5 when 'completed' then 4 when 'cancelled' then 0 else 6 end;
  txt := case stage
    when 'low_bidder' then 'Apparent low bidder known (award not final)'
    when 'intent_to_award' then 'Intended awardee known'
    when 'awarded' then 'Contractor awarded'
    when 'preconstruction' then 'Builder picked, work about to start'
    when 'under_construction' then 'Under construction'
    when 'bidding' then 'Open for bids'
    when 'bid_closed' then 'Bids closed, award not posted yet'
    when 'upcoming' then 'Procurement announced, not open yet'
    when 'planning' then 'Early planning, builder may not be picked'
    when 'completed' then 'Past project (relationship follow-up)'
    when 'cancelled' then 'Cancelled'
    else 'Project stage unknown' end;
  if o.kind = 'relationship' then pts := 10; txt := 'Existing relationship, no new project confirmed'; end if;
  fit := fit + pts; f := f || jsonb_build_object('factor','Project stage','points',pts,'max',20,'text',txt);

  -- 4. location (20): Orlando office first, the rest of Florida still counts
  pts := case coalesce(p.region, 'Unknown') when 'Central FL' then 20 when 'Tampa Bay' then 16 when 'North FL' then 14
    when 'Southwest FL' then 13 when 'South FL' then 13 when 'Panhandle' then 9 else 10 end;
  txt := coalesce(p.region, 'Region unknown') || coalesce(' (' || coalesce(p.city, p.county) || ')', '');
  fit := fit + pts; f := f || jsonb_build_object('factor','Location','points',pts,'max',20,'text',txt);

  -- 5. contact quality (15)
  for c in select * from public.contacts where company_id = o.company_id and not archived loop
    if c.verified and (c.phone is not null or c.email is not null) then
      if cq < 15 then cq := 15; ctxt := 'Verified contact: ' || coalesce(c.name, c.phone, c.email); end if;
    elsif c.name is not null and (c.phone is not null or c.email is not null) then
      if cq < 11 then cq := 11; ctxt := 'Named contact from research (not yet verified)'; end if;
    elsif c.phone is not null or c.email is not null then
      if cq < 7 then cq := 7; ctxt := 'Main phone or email only'; end if;
    elsif c.web is not null then
      if cq < 2 then cq := 2; ctxt := 'Website only'; end if;
    end if;
  end loop;
  if cq < 10 and p.pocs is not null and jsonb_array_length(p.pocs) > 0 then
    if exists (select 1 from jsonb_array_elements(p.pocs) e where coalesce(e->>'email', e->>'phone') is not null and e->>'name' is not null) then
      cq := 10; ctxt := 'Named agency contact in the notice';
    elsif cq < 4 then cq := 4; ctxt := 'Agency office or web page only';
    end if;
  end if;
  fit := fit + cq; f := f || jsonb_build_object('factor','Contact quality','points',cq,'max',15,'text',ctxt);

  -- urgency (timing only)
  if stage = 'cancelled' then
    urg := 0; u := u || jsonb_build_object('text','Project cancelled');
  elsif stage in ('bidding','upcoming') and p.deadline is not null and p.deadline >= now() then
    days := extract(epoch from (p.deadline - now())) / 86400.0;
    urg := case when days <= 3 then 95 when days <= 7 then 85 when days <= 14 then 70 when days <= 30 then 50 else 30 end;
    u := u || jsonb_build_object('text', format('%s due in %s day%s', case when stage = 'upcoming' then 'Response' else 'Bids' end,
            greatest(ceil(days), 0)::int, case when ceil(days) = 1 then '' else 's' end));
  elsif stage = 'bid_closed' then
    urg := 45; u := u || jsonb_build_object('text','Bids closed; find out who won, then call them');
  elsif stage in ('low_bidder','intent_to_award','awarded') then
    if p.winner_as_of is not null then
      days := current_date - p.winner_as_of;
      urg := case when days <= 21 then 90 when days <= 60 then 70 when days <= 180 then 50 else 35 end;
      u := u || jsonb_build_object('text', case when days <= 21 then format('Builder picked %s days ago: subs are being lined up now', days::int)
                                                when days <= 60 then format('Builder picked %s days ago', days::int)
                                                when days <= 180 then format('Picked about %s months ago; work likely underway', round(days / 30.0)::int)
                                                else 'Picked over 6 months ago; check what work remains' end);
    else
      urg := 55; u := u || jsonb_build_object('text','Builder known; award date not recorded');
    end if;
  elsif stage = 'preconstruction' then
    urg := 70; u := u || jsonb_build_object('text','Starting soon: trade packages being bought out');
  elsif stage = 'under_construction' then
    urg := 60; u := u || jsonb_build_object('text','Under construction: cutting, coring and tie-in work comes up throughout');
  elsif stage = 'upcoming' then
    urg := 25; u := u || jsonb_build_object('text','Procurement expected; no date yet');
  elsif stage = 'planning' then
    urg := 20; u := u || jsonb_build_object('text','Early stage');
  else
    urg := 20; u := u || jsonb_build_object('text','No timing information');
  end if;

  prio := case when fit >= 68 and urg >= 60 then 'Hot'
               when fit >= 55 or (fit >= 45 and urg >= 70) then 'Warm'
               else 'Later' end;
  return jsonb_build_object('fit', fit, 'urgency', urg, 'priority', prio,
    'reasons', jsonb_build_object('fit', f, 'urgency', u,
      'summary', case prio when 'Hot' then 'Hot: strong fit (' || fit || '/100) and it needs a call soon (' || urg || '/100)'
                           when 'Warm' then 'Warm: fit ' || fit || '/100, urgency ' || urg || '/100'
                           else 'Later: fit ' || fit || '/100, urgency ' || urg || '/100' end));
end $$;

create or replace function private.rescore(p_opp uuid default null) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; s jsonb; n int := 0;
begin
  for r in select id from public.opportunities where (p_opp is null or id = p_opp) loop
    s := private.score(r.id);
    update public.opportunities set fit_score = (s->>'fit')::int, urgency_score = (s->>'urgency')::int,
      priority = s->>'priority', priority_reasons = s->'reasons', scored_at = now()
    where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;
