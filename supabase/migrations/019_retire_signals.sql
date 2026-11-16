-- 019: a collector can retire early signals its tightened filters now reject. The record stays (history), but leaves
-- the Early signals list; a lead made from it is archived only if it is unclaimed and nobody has logged any work on it.
create or replace function public.refresh_retire_signals(p_keys text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n_proj int := 0; n_opp int := 0; ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into ids from public.projects
   where signal_type is not null and (external_key = any(p_keys) or alt_keys && p_keys);
  if cardinality(ids) = 0 then return jsonb_build_object('retired', 0, 'archived_leads', 0); end if;
  update public.projects set signal_type = null, relevance = 'low',
    match_note = coalesce(match_note || ' ', '') || 'Left Early signals on ' || to_char(now() at time zone 'America/New_York', 'Mon DD') || ': homeowner or small work under the current filters.'
   where id = any(ids);
  get diagnostics n_proj = row_count;
  with gone as (
    update public.opportunities o set stage = 'archived', needs_review = false, updated_at = now()
     where o.project_id = any(ids) and o.stage = 'available' and o.owner_id is null
       and not exists (select 1 from public.activities a where a.opportunity_id = o.id and a.user_id is not null)
    returning o.id)
  insert into public.activities (opportunity_id, kind, body)
  select id, 'system', 'Archived automatically: the source record is homeowner or small work, not a Speedy lead' from gone;
  get diagnostics n_opp = row_count;
  return jsonb_build_object('retired', n_proj, 'archived_leads', n_opp);
end $$;
revoke all on function public.refresh_retire_signals(text[]) from public, anon, authenticated;
grant execute on function public.refresh_retire_signals(text[]) to service_role;
