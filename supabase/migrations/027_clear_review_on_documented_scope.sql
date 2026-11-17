-- When a source document proves the scope (an FDOT pay item for removal, sawing, coring or grinding), a lead that was held
-- only to "check that it involves concrete work" no longer needs that check. Duplicate reviews and anything a manager
-- flagged by hand are left alone. Service role only (called by the refresh job).
create or replace function public.refresh_clear_review(p_key text, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.projects; n int := 0; o record;
begin
  select * into v from public.projects where external_key = p_key or p_key = any(alt_keys) limit 1;
  if v.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if not exists (select 1 from jsonb_array_elements(coalesce(v.evidence, '[]')) e where e->>'confidence' = 'documented') then
    return jsonb_build_object('ok', false, 'reason', 'no_documented_scope');
  end if;
  for o in select id, company_id from public.opportunities
            where project_id = v.id and needs_review and review_kind = 'discovery' and stage <> 'archived' loop
    update public.opportunities set needs_review = false, review_kind = null, review_reason = null where id = o.id;
    insert into public.activities (opportunity_id, company_id, kind, body, data)
    values (o.id, o.company_id, 'review', 'Review cleared automatically: ' || p_note, jsonb_build_object('source', 'refresh', 'project', v.id));
    n := n + 1;
  end loop;
  if n > 0 then perform private.rescore(); end if;
  return jsonb_build_object('ok', true, 'cleared', n);
end $$;
revoke all on function public.refresh_clear_review(text, text) from public, anon, authenticated;
grant execute on function public.refresh_clear_review(text, text) to service_role;
