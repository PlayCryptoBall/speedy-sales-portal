-- 021: lead intelligence. Explainable 0-100 score with gates (Hot / Warm / Early Signal / Needs Review / Low Fit / Expired),
-- stale and expired handling, claim expiry, duplicate review with merge and separate, project timeline, company directory,
-- outcomes report, Researching stage, early-signal archive. Existing data is kept; every lead is rescored at the end.
-- ---------------------------------------------------------------- 1. explainable lead score (0-100) with gates and classes
alter table public.opportunities add column if not exists lead_score int, add column if not exists lead_class text
  check (lead_class in ('Hot','Warm','Early Signal','Needs Review','Low Fit','Expired'));
create index if not exists opportunities_class_idx on public.opportunities (lead_class, lead_score desc) where stage = 'available';
insert into public.settings (key, value, description) values
 ('score_weights', '{"evidence":30,"contact":20,"timing":20,"territory":10,"value":10,"freshness":10}', 'Maximum points per lead-score factor. Tune against won and lost outcomes.'),
 ('claim_release_days', '21', 'Claimed leads still in New or Researching with no logged activity for this many days go back to Available (0 turns this off). The owner is warned 3 days before.')
on conflict (key) do nothing;

-- Speedy offices and the regions they cover (statewide work goes to the closest office, not always Orlando)
create or replace function private.office_for(p_region text) returns text
language sql immutable set search_path = '' as $$
  select case p_region when 'Central FL' then 'Orlando' when 'Tampa Bay' then 'Tampa' when 'Southwest FL' then 'Tampa'
    when 'Southeast FL' then 'Fort Lauderdale' when 'Northeast FL' then 'Jacksonville' when 'Panhandle' then 'Jacksonville' else null end
$$;

create or replace function private.score(p_opp uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o public.opportunities; p public.projects; c record;
  w jsonb := coalesce((select value from public.settings where key = 'score_weights'), '{}');
  we int := coalesce((w->>'evidence')::int, 30); wc int := coalesce((w->>'contact')::int, 20); wt int := coalesce((w->>'timing')::int, 20);
  wr int := coalesce((w->>'territory')::int, 10); wv int := coalesce((w->>'value')::int, 10); wf int := coalesce((w->>'freshness')::int, 10);
  ev int := 0; ct int := 0; tm int := 0; tr int := 0; va int := 0; fr int := 0;
  evt text; ctt text; tmt text; trt text; vat text; frt text; research text;
  stage text; days numeric; score int; v_today date := (now() at time zone 'America/New_York')::date; cls text; act text; expired_why text; office text; svc text[]; direct_bid boolean;
  f jsonb;
begin
  select * into o from public.opportunities where id = p_opp;
  if o.id is null then return null; end if;
  select * into p from public.projects where id = o.project_id;
  stage := coalesce(p.stage, case when o.kind = 'relationship' then 'completed' else 'unknown' end);
  if stage in ('bidding','upcoming') and p.deadline is not null and p.deadline < now() then stage := 'bid_closed'; end if;
  direct_bid := o.kind = 'gov_bid' and coalesce(o.approach, '') not in ('track_award');
  svc := case when cardinality(o.services_confirmed) > 0 then o.services_confirmed when cardinality(o.services) > 0 then o.services else coalesce(p.services_likely, '{}') end;

  -- evidence of Speedy work (direct beats inferred; nothing is "confirmed" until a contact says so)
  if cardinality(o.services_confirmed) > 0 then
    ev := we; evt := 'Contact confirmed the need for ' || array_to_string(o.services_confirmed, ', ');
  elsif exists (select 1 from jsonb_array_elements(coalesce(p.evidence, '[]')) e where e->>'confidence' = 'documented') then
    ev := round(we * 0.87); evt := 'Source documents ' || (select string_agg(distinct e->>'term', ', ') from (select e from jsonb_array_elements(p.evidence) e where e->>'confidence' = 'documented' limit 4) x);
  elsif coalesce(p.scope_evidence, '{}') && array['demolition','concrete removal','concrete cutting','core drilling','GPR / scanning'] then
    ev := round(we * 0.73); evt := 'Source describes ' || array_to_string(p.scope_evidence[1:3], ', ');
  elsif p.relevance = 'high' then
    ev := round(we * 0.73); evt := 'Source names Speedy-type work: ' || coalesce((select string_agg(distinct e->>'term', ', ') from (select e from jsonb_array_elements(p.evidence) e limit 3) x), array_to_string(svc[1:3], ', '));
  elsif o.speedy_scope ~* '(saw ?cut|sawcut|wire saw|wall saw|slab saw|core drill|coring|demoli|concrete removal|break(ing)? (and|&) remov|gpr|scan)' then
    ev := round(we * 0.6); evt := 'Earlier research notes: ' || left(o.speedy_scope, 120) || ' (not re-checked against the source)';
  elsif p.relevance = 'potential' or jsonb_array_length(coalesce(p.evidence, '[]')) > 0 or cardinality(coalesce(p.scope_evidence, '{}')) > 0 then
    ev := round(we * 0.47); evt := 'Inferred from the project type (' || coalesce(nullif((select string_agg(distinct e->>'term', ', ') from (select e from jsonb_array_elements(p.evidence) e limit 3) x), ''),
      nullif(array_to_string(p.scope_evidence[1:3], ', '), ''), array_to_string(svc[1:3], ', ')) || '); no cutting scope stated';
  elsif p.relevance is null and cardinality(svc) > 0 then
    ev := round(we * 0.33); evt := 'Services suggested by the original research, not checked against a source document';
  elsif p.relevance = 'review' then
    ev := round(we * 0.2); evt := 'Weak signal: scope unclear';
  else
    ev := 0; evt := 'No credible cutting, coring, demolition or scanning scope';
  end if;

  -- a company or person to call
  ctt := null;
  for c in select * from public.contacts where company_id = o.company_id and not archived order by verified desc, (name is not null) desc loop
    if c.verified and (c.phone is not null or c.email is not null) then
      if ct < wc then ct := wc; ctt := 'Verified contact ' || coalesce(c.name || coalesce(' (' || c.title || ')', ''), c.phone, c.email) || coalesce(', checked ' || to_char(c.verified_at at time zone 'America/New_York', 'Mon DD'), ''); end if;
    elsif c.name is not null and (c.phone is not null or c.email is not null) then
      if ct < round(wc * 0.75) then ct := round(wc * 0.75); ctt := 'Named contact ' || c.name || ' (not yet verified)'; end if;
    elsif c.phone is not null or c.email is not null then
      if ct < round(wc * 0.55) then ct := round(wc * 0.55); ctt := 'Main office phone or email only'; end if;
    end if;
  end loop;
  if ct < round(wc * 0.7) and direct_bid and exists (select 1 from jsonb_array_elements(coalesce(p.pocs, '[]')) e where coalesce(e->>'email', e->>'phone') is not null) then
    ct := round(wc * 0.7); ctt := 'Agency contracting officer named in the notice';
  end if;
  if ct < round(wc * 0.5) and exists (select 1 from jsonb_array_elements(coalesce(p.stakeholders, '[]')) s where s->>'phone' is not null or s->>'email' is not null) then
    ct := round(wc * 0.5); ctt := 'Phone or email on the public record (' || (select s->>'name' from jsonb_array_elements(p.stakeholders) s where s->>'phone' is not null or s->>'email' is not null limit 1) || ')';
  end if;
  if ct = 0 and o.company_id is not null then
    ct := round(wc * 0.25); ctt := 'Company known, no phone or email yet';
    research := 'Find the estimator or project manager at ' || coalesce((select name from public.companies where id = o.company_id), 'the company') || ': company website, Sunbiz, FDOT prequalification list, or call the main line.';
  elsif ct = 0 then
    ctt := 'No company to call yet';
    research := case when stage in ('bid_closed','bidding','upcoming') then 'Find the bidders or awardee: bid tabulation, award notice or plan-holder list.'
                     when stage in ('permitting','design','planning','land') then 'Find the owner or general contractor: the permit, the property record, or the case file.'
                     else 'Identify the general contractor from the award or permit record.' end;
  end if;
  if ctt is null then ctt := 'No phone or email yet'; end if;

  -- timing: is now the moment to call
  if stage = 'cancelled' then tm := 0; tmt := 'Cancelled';
  elsif stage = 'completed' then tm := round(wt * 0.1); tmt := 'Completed project (relationship only)';
  elsif stage in ('bidding','upcoming') and p.deadline is not null then
    days := extract(epoch from (p.deadline - now())) / 86400.0;
    tm := case when days <= 21 then wt else round(wt * 0.75) end;
    tmt := format('%s due in %s day%s', case when stage = 'upcoming' then 'Response' else 'Bids' end, greatest(ceil(days), 0)::int, case when ceil(days) = 1 then '' else 's' end);
  elsif stage = 'bid_closed' then tm := round(wt * 0.45); tmt := 'Bids closed, award not posted';
  elsif stage in ('low_bidder','intent_to_award','awarded') then
    if p.winner_as_of is not null then
      days := greatest(v_today - p.winner_as_of, 0);
      tm := case when days <= 21 then wt when days <= 60 then round(wt * 0.8) when days <= 180 then round(wt * 0.5) when days <= 540 then round(wt * 0.25) else 0 end;
      tmt := case stage when 'low_bidder' then 'Apparent low bidder' when 'intent_to_award' then 'Intent to award' else 'Awarded' end
             || case when days = 0 then ' today' when days = 1 then ' yesterday' else format(' %s days ago', days::int) end;
    else tm := round(wt * 0.5); tmt := 'Builder known; award date not recorded'; end if;
  elsif stage = 'permitting' then
    days := greatest(v_today - coalesce(p.published_at, (p.created_at at time zone 'America/New_York')::date), 0);
    tm := case when days <= 30 then round(wt * 0.9) when days <= 90 then round(wt * 0.65) when days <= 365 then round(wt * 0.3) else 0 end;
    tmt := case when days = 0 then 'Permit filed today' else format('Permit filed %s days ago', days::int) end;
  elsif stage = 'preconstruction' then tm := round(wt * 0.85); tmt := 'Starting soon';
  elsif stage = 'under_construction' then tm := round(wt * 0.6); tmt := 'Under construction';
  elsif stage = 'upcoming' then tm := round(wt * 0.3); tmt := 'Procurement expected, no date yet';
  elsif stage = 'design' then tm := round(wt * 0.25); tmt := 'In design';
  elsif stage = 'planning' then tm := round(wt * 0.15); tmt := 'Planning or zoning';
  elsif stage = 'land' then tm := round(wt * 0.1); tmt := 'Land just bought';
  else tm := round(wt * 0.2); tmt := 'Stage unknown'; end if;

  -- territory: which office serves it
  office := private.office_for(p.region);
  tr := case p.region when 'Central FL' then wr when 'Tampa Bay' then round(wr * 0.8) when 'Southeast FL' then round(wr * 0.8) when 'Northeast FL' then round(wr * 0.8)
        when 'Southwest FL' then round(wr * 0.6) when 'Panhandle' then round(wr * 0.3) else round(wr * 0.4) end;
  trt := coalesce(office || ' office', 'Office unclear') || coalesce(' (' || coalesce(p.city, p.county || ' County') || ')', '');

  -- project size (not Speedy's share of it)
  va := case when p.project_value >= 10000000 then wv when p.project_value >= 2000000 then round(wv * 0.8) when p.project_value >= 500000 then round(wv * 0.6)
             when p.project_value > 0 then round(wv * 0.4) when p.size_note is not null then round(wv * 0.4) else round(wv * 0.3) end;
  vat := case when p.project_value > 0 then 'Project value $' || to_char(p.project_value, 'FM999,999,999,999') else coalesce(p.size_note, 'Project size unknown') end;

  -- source freshness and verification
  days := extract(epoch from (now() - p.last_verified_at)) / 86400.0;
  fr := case when p.last_verified_at is null then round(wf * 0.1) when days <= 2 then wf when days <= 7 then round(wf * 0.8) when days <= 30 then round(wf * 0.5) else round(wf * 0.2) end;
  frt := case when p.last_verified_at is null then 'Never re-checked against the source' else 'Source checked ' || to_char(p.last_verified_at at time zone 'America/New_York', 'Mon DD') end;

  score := least(100, ev + ct + tm + tr + va + fr);

  -- gates: a big project never becomes Hot on size alone
  expired_why := case
    when stage = 'cancelled' then 'Cancelled'
    when stage = 'completed' and o.kind <> 'relationship' then 'Completed'
    when direct_bid and stage = 'bid_closed' then 'Bid deadline passed'
    when stage in ('low_bidder','intent_to_award','awarded') and p.winner_as_of < v_today - 540 then 'Awarded over 18 months ago'
    when stage = 'permitting' and coalesce(p.published_at, p.created_at::date) < v_today - 365 then 'Permit filed over a year ago'
    else null end;
  cls := case
    when expired_why is not null then 'Expired'
    when o.needs_review then 'Needs Review'
    when ev <= round(we * 0.2) then 'Low Fit'
    when stage in ('land','planning','design') or (stage = 'upcoming' and p.deadline is null) then 'Early Signal'
    when score >= 75 and ev >= round(we * 0.73) and tm >= round(wt * 0.65) and ct >= round(wc * 0.5) then 'Hot'
    when ev >= round(we * 0.47) and tm >= round(wt * 0.45) then 'Warm'
    when ev >= round(we * 0.47) then 'Early Signal'
    else 'Needs Review' end;   -- some evidence, too thin to call: check the source before anyone calls
  act := case cls
    when 'Hot' then 'Call today.'
    when 'Warm' then case when ct < round(wc * 0.5) then 'Find the right contact, then call this week.' else 'Call this week.' end
    when 'Early Signal' then 'Monitor; call when it reaches permitting, bidding or award.'
    when 'Needs Review' then case when o.needs_review then 'A manager should check the source first.' else 'Check the source record before calling.' end
    when 'Low Fit' then 'No outreach unless new scope appears.'
    else 'No longer actionable: ' || lower(expired_why) || '.' end;
  f := jsonb_build_array(
    jsonb_build_object('factor','Speedy work evidence','points',ev,'max',we,'text',evt),
    jsonb_build_object('factor','Someone to call','points',ct,'max',wc,'text',ctt),
    jsonb_build_object('factor','Timing','points',tm,'max',wt,'text',tmt),
    jsonb_build_object('factor','Territory','points',tr,'max',wr,'text',trt),
    jsonb_build_object('factor','Project size','points',va,'max',wv,'text',vat),
    jsonb_build_object('factor','Freshness','points',fr,'max',wf,'text',frt));
  return jsonb_build_object('fit', score, 'urgency', round(tm * 100.0 / greatest(wt, 1)), 'score', score, 'class', cls,
    'priority', case cls when 'Hot' then 'Hot' when 'Warm' then 'Warm' else 'Later' end,
    'reasons', jsonb_build_object('fit', f, 'urgency', jsonb_build_array(jsonb_build_object('text', tmt)), 'research', research, 'office', office,
      'summary', score || '/100. ' || evt || '. ' || tmt || '. ' || ctt || '. ' || act, 'action', act, 'expired', expired_why));
end $$;

-- rescore keeps the old columns in step, and warns the owner when a promising lead stops being actionable
create or replace function private.rescore(p_opp uuid default null) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; s jsonb; n int := 0;
begin
  for r in select id, owner_id, ref, lead_class from public.opportunities where (p_opp is null or id = p_opp) and stage not in ('won','lost','archived') loop
    s := private.score(r.id);
    update public.opportunities set fit_score = (s->>'fit')::int, urgency_score = (s->>'urgency')::int, priority = s->>'priority',
      priority_reasons = s->'reasons', lead_score = (s->>'score')::int, lead_class = s->>'class', scored_at = now()
    where id = r.id;
    if r.lead_class in ('Hot','Warm') and s->>'class' in ('Expired','Low Fit') and r.owner_id is not null then
      perform private.notify(r.owner_id, r.id, 'deadline_passed', r.ref || ' is no longer actionable',
        coalesce(s->'reasons'->>'expired', 'Its evidence or timing changed') || '. Close it out or note what you learned.', 'inactive:' || r.id || ':' || current_date);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------- 2. pipeline stages the team uses
insert into public.stages (key, label, sort, phase, description) values
 ('researching','Researching',25,'active','Owned; finding the right contact and scope before the first call.')
on conflict (key) do update set label = excluded.label, sort = excluded.sort, phase = excluded.phase, description = excluded.description;
update public.stages set label = 'New' where key = 'claimed';
update public.stages set label = 'Estimating', description = 'Contact asked for pricing; estimating is working on it.' where key = 'quote_needed';
update public.stages set label = 'Follow-up' where key = 'follow_up';
create or replace function private.active_stages() returns text[]
language sql immutable set search_path = '' as $$
  select array['claimed','researching','contacted','qualified','quote_needed','quote_sent','follow_up']
$$;

-- ---------------------------------------------------------------- 3. one project, many records: duplicate review, merge, separate
create table if not exists public.duplicate_decisions (
  a uuid not null references public.projects(id) on delete cascade,
  b uuid not null references public.projects(id) on delete cascade,
  decision text not null check (decision in ('merged','separate')),
  by_user uuid references public.profiles(id), note text, created_at timestamptz not null default now(),
  primary key (a, b));
alter table public.duplicate_decisions enable row level security;
revoke all on public.duplicate_decisions from anon, authenticated;
alter table public.projects add column if not exists merged_into uuid references public.projects(id);

-- Candidate pairs need more than a similar title: the same solicitation or permit number, or the same awardee with a
-- similar title within 6 months, or a near-identical title in the same county. Managers decide; nothing merges on its own.
create or replace function private.duplicate_pairs() returns table (a uuid, b uuid, reason text, strength int)
language sql stable security definer set search_path = '' as $$
  with live as (
    select p.*, private.norm_key(p.winner_name) wk, coalesce(p.winner_as_of, p.published_at, p.created_at::date) d
      from public.projects p
     where p.merged_into is null and exists (select 1 from public.opportunities o where o.project_id = p.id and o.stage <> 'archived'))
  select x.id, y.id,
    case when x.sol_key is not null and x.sol_key = y.sol_key then 'Same solicitation number'
         when x.wk is not null and x.wk = y.wk then 'Same contractor (' || x.winner_name || ') and a similar description within 6 months'
         else 'Nearly the same title in ' || coalesce(x.county, 'the same place') || ' County' end,
    case when x.sol_key is not null and x.sol_key = y.sol_key then 3 when x.wk is not null and x.wk = y.wk then 2 else 1 end
  from live x join live y on x.id < y.id
  where not exists (select 1 from public.duplicate_decisions dd where (dd.a = x.id and dd.b = y.id) or (dd.a = y.id and dd.b = x.id))
    and ((x.sol_key is not null and x.sol_key = y.sol_key)
      or (x.wk is not null and x.wk = y.wk and extensions.similarity(x.title, y.title) >= 0.3 and abs(x.d - y.d) <= 183)
      or (extensions.similarity(x.title, y.title) >= 0.7 and coalesce(x.county, '') = coalesce(y.county, '')
          and coalesce(x.solicitation_no, '') = coalesce(y.solicitation_no, '') and coalesce(x.parcel_id, '') = coalesce(y.parcel_id, '')))
$$;

create or replace function public.duplicate_candidates() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := private.require_manager();
  return coalesce((select jsonb_agg(jsonb_build_object('reason', d.reason, 'strength', d.strength,
      'a', private.dup_side(d.a), 'b', private.dup_side(d.b)) order by d.strength desc) from private.duplicate_pairs() d), '[]');
end $$;
create or replace function private.dup_side(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'title', p.title, 'source_name', coalesce(s.name, p.source_name), 'source_url', p.source_url, 'stage', p.stage,
    'solicitation_no', p.solicitation_no, 'winner_name', p.winner_name, 'date', coalesce(p.winner_as_of, p.published_at), 'county', p.county,
    'opps', (select jsonb_agg(jsonb_build_object('id', o.id, 'ref', o.ref, 'stage', o.stage, 'owner', pr.full_name)) from public.opportunities o
             left join public.profiles pr on pr.id = o.owner_id where o.project_id = p.id and o.stage <> 'archived'))
  from public.projects p left join public.sources s on s.id = p.source_id where p.id = p_id
$$;

-- Merge B into A: A keeps its record and gains B's identifiers, facts A lacks, and B's history; B's lead is closed
-- as superseded unless someone is working it (then that lead is kept and A's unworked lead is closed instead).
create or replace function public.merge_projects(p_keep uuid, p_drop uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; k public.projects; d public.projects; ko public.opportunities; dop public.opportunities; keep_opp uuid;
begin
  me := private.require_manager();
  select * into k from public.projects where id = p_keep; select * into d from public.projects where id = p_drop;
  if k.id is null or d.id is null or k.id = d.id then raise exception 'not_found' using errcode = 'P0002'; end if;
  update public.projects set
    alt_keys = (select array_agg(distinct x) from unnest(coalesce(k.alt_keys, '{}') || coalesce(d.alt_keys, '{}') || d.external_key) x where x is not null),
    solicitation_no = coalesce(k.solicitation_no, d.solicitation_no), sol_key = coalesce(k.sol_key, d.sol_key),
    deadline = coalesce(k.deadline, d.deadline), project_value = coalesce(k.project_value, d.project_value),
    winner_name = coalesce(k.winner_name, d.winner_name), winner_company_id = coalesce(k.winner_company_id, d.winner_company_id),
    winner_amount = coalesce(k.winner_amount, d.winner_amount), winner_as_of = coalesce(k.winner_as_of, d.winner_as_of),
    winner_status = coalesce(k.winner_status, d.winner_status), winner_source_url = coalesce(k.winner_source_url, d.winner_source_url),
    stage = case when private.project_stage_rank(d.stage) > private.project_stage_rank(k.stage) then d.stage else k.stage end,
    evidence = coalesce(k.evidence, '[]') || coalesce((select jsonb_agg(e) from jsonb_array_elements(d.evidence) e where not (coalesce(k.evidence, '[]') @> jsonb_build_array(e))), '[]'),
    pocs = coalesce(k.pocs, '[]') || coalesce((select jsonb_agg(e) from jsonb_array_elements(d.pocs) e where not (coalesce(k.pocs, '[]') @> jsonb_build_array(e))), '[]'),
    stakeholders = coalesce(k.stakeholders, '[]') || coalesce((select jsonb_agg(e) from jsonb_array_elements(d.stakeholders) e where not (coalesce(k.stakeholders, '[]') @> jsonb_build_array(e))), '[]'),
    last_verified_at = greatest(k.last_verified_at, d.last_verified_at), updated_at = now()
  where id = k.id;
  update public.projects set merged_into = k.id, possible_duplicate_of = k.id,
    match_note = coalesce(match_note || ' ', '') || 'Merged into ' || k.title || ' by ' || me.full_name || '.' where id = d.id;
  update public.refresh_changes set project_id = k.id where project_id = d.id;
  insert into public.refresh_changes (project_id, field, old_value, new_value, material)
  values (k.id, 'merged', d.title, coalesce(d.source_name, d.source_id) || ': ' || coalesce(d.solicitation_no, d.external_key), true);
  insert into public.duplicate_decisions (a, b, decision, by_user, note) values (k.id, d.id, 'merged', me.id, p_note) on conflict (a, b) do update set decision = 'merged';
  -- leads: keep the one someone is working; otherwise keep A's
  select * into ko from public.opportunities where project_id = k.id and stage <> 'archived' order by (owner_id is not null) desc, created_at limit 1;
  for dop in select * from public.opportunities where project_id = d.id and stage <> 'archived' loop
    if ko.id is null then
      update public.opportunities set project_id = k.id where id = dop.id; ko := dop;
    elsif dop.owner_id is not null and ko.owner_id is null then
      update public.opportunities set project_id = k.id where id = dop.id;
      update public.opportunities set stage = 'archived', superseded_by = dop.id, owner_id = null where id = ko.id;
      insert into public.activities (opportunity_id, user_id, kind, body) values (ko.id, me.id, 'system', 'Duplicate of ' || dop.ref || '; history kept there.');
      ko := dop;
    else
      update public.opportunities set stage = 'archived', superseded_by = ko.id where id = dop.id;
      insert into public.activities (opportunity_id, user_id, kind, body) values (dop.id, me.id, 'system', 'Duplicate of ' || ko.ref || ' (same project from another source).');
      if dop.owner_id is not null and dop.owner_id <> coalesce(ko.owner_id, '00000000-0000-0000-0000-000000000000') then
        perform private.notify(dop.owner_id, ko.id, 'assignment', dop.ref || ' merged into ' || ko.ref, 'Same project from another source. Your notes stay on ' || dop.ref || '.', 'merge:' || dop.id);
      end if;
    end if;
  end loop;
  if ko.id is not null then
    insert into public.activities (opportunity_id, user_id, kind, body) values (ko.id, me.id, 'system', 'Merged with ' || coalesce(d.source_name, 'another record') || ': ' || d.title);
    perform private.rescore(ko.id);
  end if;
  return jsonb_build_object('ok', true, 'kept', k.id, 'lead', ko.id);
end $$;

create or replace function public.separate_projects(p_a uuid, p_b uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := private.require_manager();
  insert into public.duplicate_decisions (a, b, decision, by_user, note) values (least(p_a, p_b), greatest(p_a, p_b), 'separate', me.id, p_note)
  on conflict (a, b) do update set decision = 'separate', by_user = me.id, note = excluded.note;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- 4. project timeline: every record and change, oldest first
create or replace function public.project_timeline(p_project uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; pj public.projects;
begin
  me := private.require_active();
  select * into pj from public.projects where id = p_project;
  if pj.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  return coalesce((select jsonb_agg(e order by (e->>'at')::timestamptz) from (
    select jsonb_build_object('at', coalesce(x.published_at::timestamptz, x.created_at), 'kind', 'record',
        'text', 'Found in ' || coalesce(s.name, x.source_name, x.source_id) || coalesce(': ' || x.status_text, ''), 'url', x.source_url, 'estimated', x.published_at is null) e
      from public.projects x left join public.sources s on s.id = x.source_id where x.id = pj.id or x.merged_into = pj.id
    union all
    select jsonb_build_object('at', ch.created_at, 'kind', ch.field, 'text',
        case ch.field when 'stage' then 'Stage: ' || replace(coalesce(ch.old_value, '?'), '_', ' ') || ' → ' || replace(coalesce(ch.new_value, '?'), '_', ' ')
          when 'winner' then 'Contractor: ' || coalesce(ch.new_value, 'removed')
          when 'merged' then 'Linked record: ' || coalesce(ch.new_value, '') || ' (' || coalesce(ch.old_value, '') || ')'
          when 'deadline' then 'Deadline changed to ' || coalesce(ch.new_value, '')
          else initcap(replace(ch.field, '_', ' ')) || ' changed' || coalesce(' to ' || left(ch.new_value, 80), '') end, 'material', ch.material)
      from public.refresh_changes ch where ch.project_id = pj.id and (ch.material or ch.field in ('stage','winner','deadline','merged'))
    union all
    select jsonb_build_object('at', coalesce(x.published_at::timestamptz, x.created_at), 'kind', 'parcel',
        'text', 'Same property: ' || x.title, 'url', x.source_url)
      from public.projects x where pj.parcel_id is not null and x.parcel_id = pj.parcel_id and x.id <> pj.id and x.merged_into is null
    union all
    select jsonb_build_object('at', pj.winner_as_of::timestamptz, 'kind', 'award', 'text',
        case pj.winner_status when 'low_bidder' then 'Apparent low bidder: ' else 'Awarded to ' end || pj.winner_name || coalesce(' ($' || to_char(pj.winner_amount, 'FM999,999,999') || ')', ''), 'url', pj.winner_source_url)
      where pj.winner_as_of is not null and pj.winner_name is not null
    union all
    select jsonb_build_object('at', pj.deadline, 'kind', 'deadline', 'text', 'Bid or response deadline', 'future', pj.deadline > now()) where pj.deadline is not null
  ) t(e)), '[]');
end $$;

-- ---------------------------------------------------------------- 5. claims expire: unworked New/Researching leads go back to Available
create or replace function private.expire_claims() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int := private.setting_int('claim_release_days', 21); r record; released int := 0; warned int := 0;
begin
  if n <= 0 then return jsonb_build_object('released', 0, 'warned', 0, 'off', true); end if;
  for r in select o.* from public.opportunities o where o.owner_id is not null and o.stage in ('claimed','researching')
           and coalesce(o.last_activity_at, o.claimed_at) < now() - make_interval(days => n) loop
    update public.opportunities set owner_id = null, stage = 'available', claimed_at = null, updated_at = now() where id = r.id;
    insert into public.ownership_history (opportunity_id, action, from_user, reason) values (r.id, 'release', r.owner_id, format('Automatic: no activity logged in %s days', n));
    insert into public.activities (opportunity_id, company_id, kind, body) values (r.id, r.company_id, 'system', format('Released to Available: no activity in %s days after claiming.', n));
    perform private.notify(r.owner_id, r.id, 'assignment', r.ref || ' went back to Available', format('No activity was logged in %s days.', n), 'released:' || r.id);
    released := released + 1;
  end loop;
  for r in select o.* from public.opportunities o where o.owner_id is not null and o.stage in ('claimed','researching')
           and coalesce(o.last_activity_at, o.claimed_at) between now() - make_interval(days => n) and now() - make_interval(days => greatest(n - 3, 1)) loop
    perform private.notify(r.owner_id, r.id, 'stale', r.ref || ' goes back to Available soon', 'Log a call or a note to keep it.', 'release-warn:' || r.id || ':' || to_char(coalesce(r.last_activity_at, r.claimed_at), 'YYYYMMDD'));
    warned := warned + 1;
  end loop;
  return jsonb_build_object('released', released, 'warned', warned);
end $$;

-- ---------------------------------------------------------------- 6. company directory
create or replace function public.company_directory(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; v_q text := nullif(trim(p->>'q'), ''); v_kind text := nullif(p->>'kind', '');
begin
  me := private.require_active();
  return coalesce((select jsonb_agg(r order by (r->>'active')::int desc, (r->>'projects')::int desc, r->>'name') from (
    select jsonb_build_object('id', c.id, 'name', c.name, 'kind', c.kind, 'aliases', c.aliases,
      'projects', (select count(distinct x.project_id) from public.opportunities x where x.company_id = c.id) +
                  (select count(*) from public.projects pj where pj.winner_company_id = c.id and not exists (select 1 from public.opportunities x where x.project_id = pj.id and x.company_id = c.id)),
      'awards', (select count(*) from public.projects pj where pj.winner_company_id = c.id),
      'active', (select count(*) from public.opportunities x where x.company_id = c.id and x.stage = any(private.active_stages())),
      'won', (select count(*) from public.opportunities x where x.company_id = c.id and x.stage = 'won'),
      'counties', (select array_agg(distinct pj.county) from public.opportunities x join public.projects pj on pj.id = x.project_id where x.company_id = c.id and pj.county is not null),
      'contacts', (select count(*) from public.contacts ct where ct.company_id = c.id and not ct.archived and (ct.phone is not null or ct.email is not null)),
      'verified_contacts', (select count(*) from public.contacts ct where ct.company_id = c.id and not ct.archived and ct.verified),
      'last_contact', (select max(a.created_at) from public.activities a where a.company_id = c.id and a.user_id is not null and a.kind in ('call','email','visit','meeting')),
      'working', (select jsonb_agg(distinct pr.full_name) from public.opportunities x join public.profiles pr on pr.id = x.owner_id where x.company_id = c.id and x.stage = any(private.active_stages()))) r
    from public.companies c
    where (v_q is null or c.name ilike '%' || v_q || '%' or array_to_string(c.aliases, ' ') ilike '%' || v_q || '%')
      and (v_kind is null or c.kind = v_kind)
      and (exists (select 1 from public.opportunities x where x.company_id = c.id) or exists (select 1 from public.projects pj where pj.winner_company_id = c.id))
    limit 500) s), '[]');
end $$;

-- ---------------------------------------------------------------- 7. outcomes report: does this system make money
create or replace function public.outcome_report(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; v_from date := coalesce((p->>'from')::date, current_date - 90); v_to date := coalesce((p->>'to')::date, current_date);
begin
  me := private.require_manager();
  return jsonb_build_object('from', v_from, 'to', v_to,
    'discovered', (select count(*) from public.opportunities o where o.created_at::date between v_from and v_to and o.kind <> 'relationship'),
    'qualified_discovered', (select count(*) from public.opportunities o where o.created_at::date between v_from and v_to and o.lead_class in ('Hot','Warm')),
    'per_day', round((select count(*) from public.opportunities o where o.created_at::date between v_from and v_to and o.lead_class in ('Hot','Warm'))::numeric / greatest(v_to - v_from + 1, 1), 1),
    'contacted', (select count(distinct a.opportunity_id) from public.activities a where a.user_id is not null and a.kind in ('call','email','visit','meeting') and a.created_at::date between v_from and v_to),
    'median_hours_to_first_contact', (select round(percentile_cont(0.5) within group (order by h)::numeric, 1) from (
        select extract(epoch from (min(a.created_at) - o.created_at)) / 3600 h from public.opportunities o join public.activities a on a.opportunity_id = o.id
         where a.user_id is not null and a.kind in ('call','email','visit','meeting') and o.created_at::date between v_from and v_to group by o.id, o.created_at) t),
    'quotes_requested', (select count(*) from public.opportunities o where o.quote_requested_at between v_from and v_to),
    'quotes_sent', (select count(*) from public.opportunities o where o.quote_sent_at between v_from and v_to),
    'quoted_value', (select sum(o.quote_amount) from public.opportunities o where o.quote_sent_at between v_from and v_to),
    'won', (select count(*) from public.opportunities o where o.stage = 'won' and o.closed_at::date between v_from and v_to),
    'won_value', (select sum(o.quote_amount) from public.opportunities o where o.stage = 'won' and o.closed_at::date between v_from and v_to),
    'lost', (select count(*) from public.opportunities o where o.stage = 'lost' and o.closed_at::date between v_from and v_to),
    'stale_before_contact', (select count(*) from public.opportunities o where o.created_at::date between v_from and v_to and o.lead_class = 'Expired'
        and not exists (select 1 from public.activities a where a.opportunity_id = o.id and a.user_id is not null)),
    'by_source', coalesce((select jsonb_agg(jsonb_build_object('source', s, 'leads', n, 'qualified', q, 'contacted', c, 'quotes', qs, 'won', w) order by w desc, qs desc, c desc, n desc) from (
        select coalesce(src.name, pj.source_id, 'Added by hand') s, count(*) n, count(*) filter (where o.lead_class in ('Hot','Warm')) q,
          count(*) filter (where exists (select 1 from public.activities a where a.opportunity_id = o.id and a.user_id is not null and a.kind in ('call','email','visit','meeting'))) c,
          count(*) filter (where o.quote_sent_at is not null) qs, count(*) filter (where o.stage = 'won') w
        from public.opportunities o left join public.projects pj on pj.id = o.project_id left join public.sources src on src.id = pj.source_id
        where o.created_at::date between v_from and v_to group by 1) t), '[]'),
    'by_county', coalesce((select jsonb_agg(jsonb_build_object('county', cty, 'leads', n, 'qualified', q, 'won', w) order by q desc, n desc) from (
        select coalesce(pj.county, 'Unknown') cty, count(*) n, count(*) filter (where o.lead_class in ('Hot','Warm')) q, count(*) filter (where o.stage = 'won') w
        from public.opportunities o left join public.projects pj on pj.id = o.project_id where o.created_at::date between v_from and v_to group by 1) t), '[]'),
    'top_contractors', coalesce((select jsonb_agg(jsonb_build_object('company', nm, 'leads', n, 'quotes', qs, 'won', w) order by w desc, qs desc, n desc) from (
        select c.name nm, count(*) n, count(*) filter (where o.quote_sent_at is not null) qs, count(*) filter (where o.stage = 'won') w
        from public.opportunities o join public.companies c on c.id = o.company_id where o.created_at::date between v_from and v_to group by 1 order by 4 desc, 3 desc, 2 desc limit 10) t), '[]'),
    'note', 'Quoted and won values are what salespeople entered on leads, not project budgets.');
end $$;

revoke all on function public.duplicate_candidates(), public.merge_projects(uuid, uuid, text), public.separate_projects(uuid, uuid, text), public.project_timeline(uuid),
  public.company_directory(jsonb), public.outcome_report(jsonb) from public, anon;
grant execute on function public.duplicate_candidates(), public.merge_projects(uuid, uuid, text), public.separate_projects(uuid, uuid, text), public.project_timeline(uuid),
  public.company_directory(jsonb), public.outcome_report(jsonb) to authenticated;

-- ---------------------------------------------------------------- 8. updated: daily upkeep, board, early signals
create or replace function public.daily_maintenance() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; o record; stale int := private.setting_int('stale_days', 14); closed int := 0; n_stale int := 0; n_due int := 0; n_soon int := 0; n_review int := 0; n_hot int := 0; v_claims jsonb;
begin
  if auth.uid() is not null then perform private.require_manager(); end if;
  -- 1. bids whose deadline passed: mark closed and point unowned trackers at the award
  for r in select * from public.projects where stage in ('bidding','upcoming') and deadline < now() loop
    update public.projects set stage = 'bid_closed', updated_at = now() where id = r.id;
    insert into public.refresh_changes (project_id, field, old_value, new_value, material) values (r.id, 'stage', r.stage, 'bid_closed', true);
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
  -- 5. managers: one daily note about new finds waiting for review, and unclaimed Hot bids closing within 5 days
  select count(*) into n_review from public.opportunities where needs_review and stage = 'available';
  if n_review > 0 then
    perform private.notify_managers(null, 'review_digest', n_review || ' new find' || case when n_review = 1 then '' else 's' end || ' waiting for review',
      'Sources and refreshes > Review queue. Publish the ones with real concrete work; archive the rest.', 'digest:' || current_date);
  end if;
  for o in select x.*, p.deadline as dl from public.opportunities x join public.projects p on p.id = x.project_id
           where x.owner_id is null and x.stage = 'available' and not x.needs_review and x.lead_class = 'Hot'
             and p.stage = 'bidding' and p.deadline between now() and now() + interval '5 days' loop
    perform private.notify_managers(o.id, 'deadline_soon', 'Unclaimed Hot bid closes ' || to_char(o.dl at time zone 'America/New_York', 'Mon DD'),
      o.title || '. Assign it or let it go.', 'hotdl:' || o.id);
    n_hot := n_hot + 1;
  end loop;
  v_claims := private.expire_claims();
  begin perform private.source_health_alerts(); exception when undefined_function then null; end;
  perform private.rescore();
  perform private.snapshot_pool();
  return jsonb_build_object('bids_closed', closed, 'stale', n_stale, 'due', n_due, 'deadline_soon', n_soon, 'review_queue', n_review, 'unclaimed_hot_deadlines', n_hot, 'claims', v_claims);
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
        o.lead_score, o.lead_class, o.priority_reasons->>'action' as score_action, o.priority_reasons->>'office' as office,
        case when o.owner_id is null or o.owner_id = me.id or mgr then o.priority_reasons->>'research' end as research_task,
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

create or replace function public.early_signals(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; v_days int := least(greatest(coalesce((p->>'days')::int, 90), 1), 730);
  v_type text := nullif(p->>'type', ''); v_q text := nullif(trim(p->>'q'), ''); v_region text := nullif(p->>'region', '');
  v_tracked text := coalesce(nullif(p->>'tracked', ''), 'all'); v_limit int := least(coalesce((p->>'limit')::int, 200), 500);
  v_archive boolean := coalesce((p->>'archive')::boolean, false);
begin
  me := private.require_active();
  return jsonb_build_object(
    'counts', (select jsonb_object_agg(t, n) from (select signal_type t, count(*) n from public.projects
                where signal_type is not null and stage in ('land','planning','design') and created_at > now() - make_interval(days => v_days)
                and v_archive = (coalesce(published_at, created_at::date) < current_date - 365) group by 1) c),
    'items', coalesce((select jsonb_agg(row order by sort_at desc) from (
      select jsonb_build_object('id', pj.id, 'title', pj.title, 'stage', pj.stage, 'signal_type', pj.signal_type, 'city', pj.city, 'county', pj.county,
          'region', pj.region, 'location_text', pj.location_text, 'size_note', pj.size_note, 'value_label', pj.value_label, 'status_text', pj.status_text,
          'summary', left(pj.source_summary, 280), 'source_name', pj.source_name, 'source_url', pj.source_url, 'parcel_id', pj.parcel_id, 'acreage', pj.acreage,
          'relevance', pj.relevance, 'services', pj.services_likely, 'stakeholders', pj.stakeholders, 'found_at', pj.created_at, 'published_at', pj.published_at,
          'opportunity', (select jsonb_build_object('id', o.id, 'ref', o.ref, 'stage', o.stage, 'mine', o.owner_id = me.id,
                             'owner', case when o.owner_id is null then null else (select full_name from public.profiles where id = o.owner_id) end)
                            from public.opportunities o where o.project_id = pj.id and o.stage <> 'archived' order by o.created_at limit 1),
          'same_parcel', (select count(*) from public.projects x where pj.parcel_id is not null and x.parcel_id = pj.parcel_id and x.id <> pj.id)) as row,
        coalesce(pj.published_at::timestamptz, pj.created_at) sort_at
      from public.projects pj
      where pj.merged_into is null and pj.signal_type is not null and pj.stage in ('land','planning','design')
        and pj.created_at > now() - make_interval(days => v_days)
        and (v_archive = (coalesce(pj.published_at, pj.created_at::date) < current_date - 365))
        and (v_type is null or pj.signal_type = v_type)
        and (v_region is null or pj.region = v_region)
        and (v_q is null or pj.title ilike '%' || v_q || '%' or pj.source_summary ilike '%' || v_q || '%' or pj.stakeholders::text ilike '%' || v_q || '%')
        and (v_tracked = 'all'
             or (v_tracked = 'untracked' and not exists (select 1 from public.opportunities o where o.project_id = pj.id and o.stage <> 'archived'))
             or (v_tracked = 'tracked' and exists (select 1 from public.opportunities o where o.project_id = pj.id and o.stage <> 'archived')))
      order by sort_at desc limit v_limit) s), '[]'));
end $$;

-- ---------------------------------------------------------------- 9. Researching counts as active work everywhere
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
  if v_outcome = 'quote_requested' and v_stage is null and o.stage in ('claimed','researching','contacted','qualified','follow_up') then v_stage := 'quote_needed'; end if;
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
  elsif o.stage in ('claimed','researching') and (v_outcome = any(reached) or v_kind in ('visit','meeting')) then
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
                 and stage in ('claimed','researching','contacted','qualified','quote_needed','quote_sent','follow_up','won','nurture') and project_id <> p.id) x loop
      perform private.notify(w.user_id, null, 'watch', 'A contractor you work with has a new award',
        txt || ' — ' || coalesce(p.short_title, p.title) || coalesce(' (' || p.region || ')', ''), 'cowin:' || p.id || ':' || p.winner_company_id || ':' || w.user_id);
    end loop;
  end if;
  return new;
end $$;
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
        'open', count(*) filter (where o.stage in ('available','claimed','researching','contacted','qualified','quote_needed','quote_sent','follow_up','nurture')),
        'won', count(*) filter (where o.stage = 'won'), 'lost', count(*) filter (where o.stage = 'lost'),
        'quotes', count(*) filter (where o.quote_status is not null),
        'owners', (select coalesce(jsonb_agg(distinct u.full_name), '[]') from public.opportunities x join public.profiles u on u.id = x.owner_id
                   where x.company_id = c.id and x.stage in ('claimed','researching','contacted','qualified','quote_needed','quote_sent','follow_up','nurture')),
        'last_contact_at', (select max(a.created_at) from public.activities a left join public.opportunities y on y.id = a.opportunity_id
                            where (a.company_id = c.id or y.company_id = c.id) and a.kind in ('call','email','text','visit','meeting')),
        'next_follow_up', (select min(x.next_action_due) from public.opportunities x where x.company_id = c.id and (mgr or x.owner_id = me.id)
                           and x.stage in ('claimed','researching','contacted','qualified','quote_needed','quote_sent','follow_up','nurture')))
      from public.opportunities o where o.company_id = c.id)
  );
end $$;
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
                where o.owner_id = me.id and o.stage in ('claimed','researching','contacted','qualified','quote_needed','quote_sent','follow_up')
                  and p.deadline between now() and now() + interval '7 days'),
    'my_overdue', (select count(*) from public.opportunities where owner_id = me.id and next_action_due < current_date
                and stage in ('claimed','researching','contacted','qualified','quote_needed','quote_sent','follow_up','nurture')),
    'my_due_today', (select count(*) from public.opportunities where owner_id = me.id and next_action_due = current_date
                and stage in ('claimed','researching','contacted','qualified','quote_needed','quote_sent','follow_up','nurture')),
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
                        and stage in ('claimed','researching','contacted','qualified','quote_needed','quote_sent','follow_up','nurture') group by 1) x
                      join public.profiles u on u.id = x.owner_id),
      'failed_sources', (select coalesce(jsonb_agg(x->>'name'), '[]') from jsonb_array_elements(coalesce(s.sources, '[]')) x where x->>'status' <> 'success')));
  end if;
  return out;
end $$;
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
        (select count(*) from opp o where o.owner_id = u.id and o.stage in ('claimed','researching','contacted','qualified','quote_needed','quote_sent','follow_up')) as active_now,
        (select count(*) from opp o where o.owner_id = u.id and o.stage in ('claimed','researching','contacted','qualified','quote_needed','quote_sent','follow_up')
           and coalesce(o.last_activity_at, o.claimed_at) < now() - make_interval(days => stale)) as inactive_now,
        (select count(*) from opp o where o.owner_id = u.id and o.next_action_due < current_date
           and o.stage in ('claimed','researching','contacted','qualified','quote_needed','quote_sent','follow_up','nurture')) as overdue_now
      from public.profiles u left join act a on a.user_id = u.id
      where u.active and (f_user is null or u.id = f_user)
      group by u.id, u.full_name),
    moves as (
      select a.opportunity_id, a.from_stage, a.created_at, lag(a.created_at) over (partition by a.opportunity_id order by a.created_at) prev
        from public.activities a join opp o on o.id = a.opportunity_id where a.to_stage is not null),
    stage_time as (
      select from_stage stage, round(avg(extract(epoch from (created_at - prev)) / 86400)::numeric, 1) days, count(*) n
        from moves where prev is not null and created_at >= d_from and created_at < d_to
         and from_stage in ('claimed','researching','contacted','qualified','quote_needed','quote_sent','follow_up') group by 1)
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
                      count(*) filter (where o.stage in ('claimed','researching','contacted','qualified','quote_needed','quote_sent','follow_up')) active
                    from opp o join public.projects pj on pj.id = o.project_id group by 1) x join public.sources s on s.id = x.source_id),
      'quotes_attention', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'ref', o.ref, 'title', o.title, 'owner', u.full_name, 'quote_status', o.quote_status,
                   'requested', o.quote_requested_at, 'sent', o.quote_sent_at, 'amount', o.quote_amount, 'decision', o.quote_decision_date, 'due', o.next_action_due)
                   order by coalesce(o.quote_sent_at, o.quote_requested_at)), '[]')
                 from opp o left join public.profiles u on u.id = o.owner_id
                 where (o.quote_status = 'requested' and o.quote_requested_at < current_date - 2)
                    or (o.quote_status in ('sent','no_response') and o.stage not in ('won','lost','disqualified','archived')
                        and coalesce(o.next_action_due, o.quote_sent_at + 7) <= current_date))));
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
    'priority', o.priority, 'fit_score', o.fit_score, 'urgency_score', o.urgency_score, 'priority_reasons', coalesce(o.priority_reasons, '{}') || jsonb_build_object('lead_score', o.lead_score, 'lead_class', o.lead_class),
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

create or replace function public.track_signal(p_project uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; pj public.projects; o public.opportunities; v_comp uuid; who text; r jsonb;
begin
  me := private.require_active();
  select * into pj from public.projects where id = p_project;
  if pj.id is null or pj.signal_type is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into o from public.opportunities where project_id = pj.id and stage <> 'archived' order by created_at limit 1;
  if o.id is not null then return jsonb_build_object('ok', true, 'id', o.id, 'existing', true); end if;
  select x->>'name' into who from jsonb_array_elements(pj.stakeholders) x
   where x->>'role' in ('buyer','developer','owner') order by case x->>'role' when 'developer' then 1 when 'buyer' then 2 else 3 end limit 1;
  who := coalesce(who, pj.owner_name);
  if who is not null then v_comp := private.upsert_company(who, 'developer'); end if;
  insert into public.opportunities (project_id, company_id, kind, approach, title, next_action, services, needs_review)
  values (pj.id, v_comp, 'private_project', 'approach_developer', left(coalesce(who || ' — ', '') || coalesce(pj.short_title, pj.title), 200),
          case pj.stage when 'land' then 'Find out what ' || coalesce(who, 'the buyer') || ' plans to build or renovate here, and who their general contractor will be.'
            when 'planning' then 'Introduce Speedy to ' || coalesce(who, 'the applicant') || ' and ask who will build it; check back when site plans are filed.'
            else 'Ask ' || coalesce(who, 'the applicant') || ' for the general contractor and civil engineer, and offer scanning, coring and cutting.' end,
          pj.services_likely, false)
  returning * into o;
  insert into public.activities (opportunity_id, company_id, user_id, kind, body)
  values (o.id, v_comp, me.id, 'system', 'Tracked from Early signals (' || replace(pj.signal_type, '_', ' ') || ')');
  perform private.rescore(o.id);
  r := public.claim_opportunity(o.id, true);
  return jsonb_build_object('ok', true, 'id', o.id, 'claimed', coalesce((r->>'ok')::boolean, false), 'message', r->>'message');
end $$;

select private.rescore();
