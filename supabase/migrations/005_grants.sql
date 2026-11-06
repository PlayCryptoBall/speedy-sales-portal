-- Speedy Sales Portal: who may call what.

create or replace function public.list_users() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := private.require_manager();
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'full_name', p.full_name, 'phone', p.phone, 'role', p.role,
            'active', p.active, 'invited_at', p.invited_at, 'deactivated_at', p.deactivated_at, 'last_seen_at', p.last_seen_at,
            'invited_by_name', (select full_name from public.profiles i where i.id = p.invited_by),
            'open', (select count(*) from public.opportunities o where o.owner_id = p.id and o.stage = any(private.active_stages())))
          order by p.active desc, p.full_name) from public.profiles p), '[]');
end $$;

-- Everything in public starts closed.
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
revoke usage on schema private from anon, authenticated;

-- Signed-in app calls (each one checks the caller's active profile and role itself).
grant execute on function
  public.me(), public.update_my_profile(text, text), public.get_board(), public.get_opportunity(uuid),
  public.claim_opportunity(uuid, boolean), public.release_opportunity(uuid, text), public.assign_opportunity(uuid, uuid, text),
  public.log_activity(uuid, jsonb), public.save_contact(jsonb), public.get_notifications(), public.mark_notifications_read(bigint[]),
  public.team_overview(), public.resolve_review(uuid, text, text), public.update_setting(text, jsonb), public.add_lead(jsonb),
  public.sources_status(), public.export_rows(text), public.import_preview(jsonb), public.import_apply(jsonb, text),
  public.daily_maintenance(), public.list_users()
to authenticated;

-- Server-side refresh job only.
grant execute on function
  public.refresh_start_run(text, text, uuid, int), public.refresh_upsert_project(bigint, jsonb), public.refresh_mark_missing(bigint, text[], text),
  public.refresh_mark_failed(text[]), public.refresh_finish_run(bigint, text, jsonb, jsonb, text), public.refresh_tracked_keys(text),
  public.daily_maintenance(), public.me(), public.list_users()
to service_role;

alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
