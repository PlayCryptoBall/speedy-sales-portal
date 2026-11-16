-- 020: retire_signals can also take an unworked lead out of Available while keeping the record on Early signals.
drop function if exists public.refresh_retire_signals(text[]);
-- p_keep_signal: the record still belongs on Early signals, but its lead should not sit in the shared pool
create or replace function public.refresh_retire_signals(p_keys text[], p_keep_signal boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n_proj int := 0; n_opp int := 0; ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into ids from public.projects
   where signal_type is not null and (external_key = any(p_keys) or alt_keys && p_keys);
  if cardinality(ids) = 0 then return jsonb_build_object('retired', 0, 'archived_leads', 0); end if;
  if not p_keep_signal then
  update public.projects set signal_type = null, relevance = 'low',
    match_note = coalesce(match_note || ' ', '') || 'Left Early signals on ' || to_char(now() at time zone 'America/New_York', 'Mon DD') || ': homeowner or small work under the current filters.'
   where id = any(ids);
  get diagnostics n_proj = row_count;
  end if;
  with gone as (
    update public.opportunities o set stage = 'archived', needs_review = false, updated_at = now()
     where o.project_id = any(ids) and o.stage = 'available' and o.owner_id is null
       and not exists (select 1 from public.activities a where a.opportunity_id = o.id and a.user_id is not null)
    returning o.id)
  insert into public.activities (opportunity_id, kind, body)
  select id, 'system', case when p_keep_signal then 'Taken out of Available automatically: an early signal without confirmed commercial scope. Still listed on Early signals.' else 'Archived automatically: the source record is homeowner or small work, not a Speedy lead' end from gone;
  get diagnostics n_opp = row_count;
  return jsonb_build_object('retired', n_proj, 'archived_leads', n_opp);
end $$;
revoke all on function public.refresh_retire_signals(text[], boolean) from public, anon, authenticated;
grant execute on function public.refresh_retire_signals(text[], boolean) to service_role;
