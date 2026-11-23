-- Estimate intake endpoint support: allowed browser origins per integration, and attaching files to a request the
-- same integration submitted. Service role only (the estimate-intake edge function), keyed by the integration key.

alter table public.integrations add column if not exists allowed_origins text[] not null default '{}';  -- empty = server-to-server only

create or replace function private.integration_by_key(p_key text) returns public.integrations language sql stable security definer set search_path = '' as $$
  select * from public.integrations where key_hash = encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex') and active $$;

-- may this integration accept a call from this browser origin? (no origin = a server calling)
create or replace function public.intake_check_origin(p_key text, p_origin text) returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select p_origin is null or p_origin = any(i.allowed_origins) from private.integration_by_key(p_key) i), false) $$;

create or replace function public.intake_register_file(p_key text, p_ref text, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare i public.integrations := private.integration_by_key(p_key); r public.estimate_requests; d uuid; v_name text; v_path text; v_rev uuid;
begin
  if i.id is null then return jsonb_build_object('ok', false, 'error', 'unauthorized'); end if;
  select * into r from public.estimate_requests where ref = p_ref and workspace_id = i.workspace_id
    and id in (select request_id from public.integration_events where integration_id = i.id and request_id is not null);
  if r.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_request'); end if;
  if (select count(*) from public.documents where estimate_request_id = r.id) >= 10 then return jsonb_build_object('ok', false, 'error', 'too_many_files'); end if;
  if not private.allowed_mime(coalesce(p->>'mime', '')) then return jsonb_build_object('ok', false, 'error', 'file_type_not_allowed'); end if;
  if coalesce((p->>'bytes')::bigint, 0) <= 0 or (p->>'bytes')::bigint > 26214400 then return jsonb_build_object('ok', false, 'error', 'file_too_large'); end if;
  v_name := left(regexp_replace(coalesce(nullif(trim(p->>'filename'), ''), 'file'), '[^A-Za-z0-9._-]+', '_', 'g'), 120);
  insert into public.documents (workspace_id, estimate_request_id, kind, title)
  values (i.workspace_id, r.id, case when p->>'mime' like 'image/%' then 'photo' when p->>'kind' = 'drawing' then 'drawing' else 'other' end, v_name)
  returning id into d;
  v_path := i.workspace_id || '/' || d || '/1-' || v_name;
  insert into public.document_revisions (document_id, rev_no, storage_path, filename, mime, bytes, sha256, note)
  values (d, 1, v_path, v_name, p->>'mime', (p->>'bytes')::bigint, nullif(p->>'sha256', ''), 'Sent with the estimate request') returning id into v_rev;
  return jsonb_build_object('ok', true, 'revision_id', v_rev, 'path', v_path);
end $$;

create or replace function public.intake_confirm_file(p_key text, p_revision uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare i public.integrations := private.integration_by_key(p_key); r public.document_revisions; v_req uuid; v_size bigint;
begin
  if i.id is null then return jsonb_build_object('ok', false, 'error', 'unauthorized'); end if;
  select dr.* into r from public.document_revisions dr join public.documents d on d.id = dr.document_id where dr.id = p_revision and d.workspace_id = i.workspace_id;
  if r.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'storage' and c.relname = 'objects') then
    execute $q$select (metadata->>'size')::bigint from storage.objects where bucket_id = 'documents' and name = $1$q$ into v_size using r.storage_path;
    if v_size is distinct from r.bytes then return jsonb_build_object('ok', false, 'error', 'upload_missing'); end if;
  end if;
  update public.document_revisions set status = 'stored' where id = r.id;
  select estimate_request_id into v_req from public.documents where id = r.document_id;
  -- photos or drawings arrived: that missing item is resolved
  update public.estimate_requests set missing = (select coalesce(jsonb_agg(m), '[]') from jsonb_array_elements(missing) m where m->>'field' <> 'attachments'),
    status = case when status = 'missing_info' and jsonb_array_length((select coalesce(jsonb_agg(m), '[]') from jsonb_array_elements(missing) m where m->>'field' <> 'attachments')) = 0
                  then 'ready' else status end, updated_at = now()
   where id = v_req;
  update public.tasks t set notes = nullif((select string_agg(m->>'label', '; ') from public.estimate_requests er, jsonb_array_elements(er.missing) m where er.id = v_req), '')
   where t.id = (select task_id from public.estimate_requests where id = v_req) and t.status = 'open';
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.set_integration_origins(p_id uuid, p_origins text[]) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active();
  if not exists (select 1 from public.integrations where id = p_id and private.is_member(workspace_id, array['owner', 'manager'])) then raise exception 'not_found' using errcode = 'P0002'; end if;
  if exists (select 1 from unnest(p_origins) o where o !~ '^https://[a-z0-9.-]+(:[0-9]+)?$') then
    raise exception 'bad_origin' using errcode = '22023', hint = 'Origins look like https://estimates.example.com (https, no path).'; end if;
  update public.integrations set allowed_origins = coalesce(p_origins, '{}') where id = p_id;
  return public.list_integrations();
end $$;

revoke all on function public.intake_check_origin(text, text), public.intake_register_file(text, text, jsonb), public.intake_confirm_file(text, uuid) from public, anon, authenticated;
grant execute on function public.intake_check_origin(text, text), public.intake_register_file(text, text, jsonb), public.intake_confirm_file(text, uuid) to service_role;
revoke all on function public.set_integration_origins(uuid, text[]) from public, anon;
grant execute on function public.set_integration_origins(uuid, text[]) to authenticated;
