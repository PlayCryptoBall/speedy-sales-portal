-- A source re-check that finds no stated scope (relevance 'review') must not drop an imported lead below the credit its
-- original research earned; it stays Needs Review (check the scope) instead of Low Fit.
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
  elsif p.relevance = 'review' and p.source_id = 'legacy_import' and cardinality(svc) > 0 then
    ev := round(we * 0.33); evt := 'Services suggested by the original research; the source was re-checked' || coalesce(' ' || to_char(p.last_verified_at at time zone 'America/New_York', 'Mon DD'), '') || ' and does not state the cutting scope';
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

select private.rescore();
