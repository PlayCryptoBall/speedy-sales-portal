-- Documents (private storage, revisions, authorized downloads) and outreach drafts grounded in the record.
-- Drafts are never sent from here: there is no sending path. Copying a draft is recorded; sending is the person's own act.

-- ---------------------------------------------------------------- documents
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default private.current_ws() references public.workspaces(id) on delete cascade,
  opportunity_id uuid references public.opportunities(id) on delete cascade,
  estimate_request_id uuid references public.estimate_requests(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete cascade,
  kind text not null default 'other' check (kind in ('drawing', 'specification', 'photo', 'addendum', 'bid_form', 'quote', 'purchase_order', 'subcontract', 'insurance', 'w9', 'other')),
  title text not null check (length(title) between 1 and 200),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint document_has_parent check (num_nonnulls(opportunity_id, estimate_request_id, job_id) >= 1)
);
alter table public.documents enable row level security;
create view private.v_documents as select * from public.documents where private.ws_ok(workspace_id);
alter view private.v_documents alter column workspace_id set default private.current_ws();

create table public.document_revisions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  rev_no int not null,
  storage_path text not null unique,          -- <workspace>/<document>/<rev>-<safe filename>; the bucket's access rule checks the workspace segment
  filename text not null,
  mime text not null,
  bytes bigint not null check (bytes > 0 and bytes <= 26214400),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'stored')),   -- pending until the upload is confirmed
  note text,
  uploaded_by uuid references public.profiles(id),
  uploaded_at timestamptz not null default now(),
  unique (document_id, rev_no)
);
alter table public.document_revisions enable row level security;

-- what may be uploaded: drawings, photos, office documents. No executables, no HTML (stored content is never rendered as a page).
create or replace function private.allowed_mime(m text) returns boolean language sql immutable as $$
  select m in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'image/tiff',
               'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
               'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'text/plain', 'text/csv',
               'image/vnd.dwg', 'application/acad', 'application/x-dwg') $$;

-- used by the storage access rule: may the signed-in person reach files of this workspace?
create or replace function public.can_access_workspace(p_ws text) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members m join public.profiles p on p.id = m.user_id and p.active
                 where m.user_id = auth.uid() and m.workspace_id::text = p_ws) $$;
grant execute on function public.can_access_workspace(text) to authenticated;

-- an upload is accepted only at a path registered by add_document_revision and not yet stored
create or replace function public.registered_upload(p_path text) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.document_revisions r join public.documents d on d.id = r.document_id
                 where r.storage_path = p_path and r.status = 'pending' and r.uploaded_by = auth.uid() and r.uploaded_at > now() - interval '1 hour') $$;
grant execute on function public.registered_upload(text) to authenticated;

do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'storage' and c.relname = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('documents', 'documents', false, 26214400, array['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'image/tiff',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword', 'text/plain', 'text/csv', 'image/vnd.dwg', 'application/acad', 'application/x-dwg'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
    -- read and add only within your workspace's folder, and only at a path the app registered first; nothing is updated or deleted from the browser
    execute $p$drop policy if exists "documents read own workspace" on storage.objects$p$;
    execute $p$drop policy if exists "documents upload registered path" on storage.objects$p$;
    execute $p$create policy "documents read own workspace" on storage.objects for select to authenticated
      using (bucket_id = 'documents' and public.can_access_workspace((storage.foldername(name))[1]))$p$;
    execute $p$create policy "documents upload registered path" on storage.objects for insert to authenticated
      with check (bucket_id = 'documents' and public.can_access_workspace((storage.foldername(name))[1])
                  and public.registered_upload(name))$p$;
  end if;
end $$;

create or replace function private.doc_for_me(p_doc uuid) returns public.documents language plpgsql security definer set search_path = '' as $$
declare d public.documents; me public.profiles := private.require_active(); o public.opportunities;
begin
  select * into d from private.v_documents where id = p_doc;
  if d.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  -- lead documents follow the lead's privacy (owner and managers); request and job files are for the workspace
  if d.opportunity_id is not null then
    select * into o from public.opportunities where id = d.opportunity_id;
    if o.owner_id is not null and o.owner_id <> me.id and me.role <> 'manager' and not private.is_member(d.workspace_id, array['owner', 'manager']) then
      raise exception 'not_owner' using errcode = '42501'; end if;
  end if;
  return d;
end $$;

create or replace function public.add_document_revision(p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); d public.documents; v_rev int; v_path text; v_name text; v_id uuid;
begin
  if not private.allowed_mime(coalesce(p->>'mime', '')) then raise exception 'file_type_not_allowed' using errcode = '22023',
    hint = 'PDF, images, Word, Excel, CSV, text and DWG files only.'; end if;
  if coalesce((p->>'bytes')::bigint, 0) <= 0 or (p->>'bytes')::bigint > 26214400 then raise exception 'file_too_large' using errcode = '22023', hint = 'Files up to 25 MB.'; end if;
  v_name := left(regexp_replace(coalesce(nullif(trim(p->>'filename'), ''), 'file'), '[^A-Za-z0-9._-]+', '_', 'g'), 120);
  if p->>'document_id' is not null then
    d := private.doc_for_me((p->>'document_id')::uuid);
  else
    if p->>'opportunity_id' is not null and not exists (select 1 from private.v_opportunities where id = (p->>'opportunity_id')::uuid) then raise exception 'not_found' using errcode = 'P0002'; end if;
    if p->>'estimate_request_id' is not null and not exists (select 1 from private.v_estimate_requests where id = (p->>'estimate_request_id')::uuid) then raise exception 'not_found' using errcode = 'P0002'; end if;
    if p->>'job_id' is not null and not exists (select 1 from private.v_jobs where id = (p->>'job_id')::uuid) then raise exception 'not_found' using errcode = 'P0002'; end if;
    insert into private.v_documents (opportunity_id, estimate_request_id, job_id, kind, title, created_by)
    values (nullif(p->>'opportunity_id', '')::uuid, nullif(p->>'estimate_request_id', '')::uuid, nullif(p->>'job_id', '')::uuid,
            coalesce(nullif(p->>'kind', ''), 'other'), coalesce(nullif(trim(p->>'title'), ''), v_name), me.id)
    returning * into d;
  end if;
  if p->>'sha256' is not null and exists (select 1 from public.document_revisions where document_id = d.id and sha256 = p->>'sha256' and status = 'stored') then
    return jsonb_build_object('ok', true, 'duplicate', true, 'document_id', d.id);
  end if;
  select coalesce(max(rev_no), 0) + 1 into v_rev from public.document_revisions where document_id = d.id;
  v_path := d.workspace_id || '/' || d.id || '/' || v_rev || '-' || v_name;
  insert into public.document_revisions (document_id, rev_no, storage_path, filename, mime, bytes, sha256, note, uploaded_by)
  values (d.id, v_rev, v_path, v_name, p->>'mime', (p->>'bytes')::bigint, nullif(p->>'sha256', ''), nullif(p->>'note', ''), me.id) returning id into v_id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'document_id', d.id, 'revision_id', v_id, 'rev_no', v_rev, 'bucket', 'documents', 'path', v_path);
end $$;

-- after the browser uploads, the revision is marked stored only if the object is really there with the declared size
create or replace function public.confirm_document_revision(p_revision uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.document_revisions; v_size bigint; v_has_storage boolean;
begin
  perform private.require_active();
  select * into r from public.document_revisions where id = p_revision and uploaded_by = auth.uid();
  if r.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.doc_for_me(r.document_id);
  v_has_storage := exists (select 1 from pg_class where relname = 'objects' and relnamespace = (select oid from pg_namespace where nspname = 'storage'));
  if v_has_storage then
    execute $q$select (metadata->>'size')::bigint from storage.objects where bucket_id = 'documents' and name = $1$q$ into v_size using r.storage_path;
    if v_size is null then raise exception 'upload_missing' using errcode = '22023', hint = 'The file did not arrive. Try the upload again.'; end if;
    if v_size <> r.bytes then raise exception 'upload_size_mismatch' using errcode = '22023'; end if;
  end if;
  update public.document_revisions set status = 'stored' where id = r.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.list_documents(p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active();
begin
  if p->>'opportunity_id' is not null then
    perform 1 from private.v_opportunities o where o.id = (p->>'opportunity_id')::uuid and (o.owner_id is null or o.owner_id = me.id or me.role = 'manager');
    if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'kind', d.kind, 'created_at', d.created_at,
      'revisions', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'rev_no', r.rev_no, 'filename', r.filename, 'mime', r.mime, 'bytes', r.bytes,
          'path', r.storage_path, 'uploaded_at', r.uploaded_at, 'note', r.note, 'by', (select full_name from public.profiles where id = r.uploaded_by)) order by r.rev_no desc), '[]')
        from public.document_revisions r where r.document_id = d.id and r.status = 'stored')) order by d.created_at desc)
    from private.v_documents d
    where (p->>'opportunity_id' is null or d.opportunity_id = (p->>'opportunity_id')::uuid)
      and (p->>'estimate_request_id' is null or d.estimate_request_id = (p->>'estimate_request_id')::uuid)
      and (p->>'job_id' is null or d.job_id = (p->>'job_id')::uuid)
      and exists (select 1 from public.document_revisions r where r.document_id = d.id and r.status = 'stored')), '[]');
end $$;

-- ---------------------------------------------------------------- outreach drafts
create table public.outreach_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default private.current_ws() references public.workspaces(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  contact_id uuid references public.contacts(id),
  brief jsonb not null,              -- the generated brief, with the facts it was built from
  status text not null default 'draft' check (status in ('draft', 'copied', 'discarded')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.outreach_drafts enable row level security;
create view private.v_outreach_drafts as select * from public.outreach_drafts where private.ws_ok(workspace_id);
alter view private.v_outreach_drafts alter column workspace_id set default private.current_ws();

-- "a", "a or b", "a, b or c"
create or replace function private.or_list(a text[]) returns text language sql immutable as $$
  select case coalesce(cardinality(a), 0) when 0 then '' when 1 then a[1] else array_to_string(a[1:cardinality(a) - 1], ', ') || ' or ' || a[cardinality(a)] end $$;

create or replace function private.money_text(n numeric) returns text language sql immutable as $$
  select case when n is null then null when n >= 1000000 then '$' || trim(to_char(round(n / 1000000.0, 1), 'FM999990.0')) || 'M'
              when n >= 1000 then '$' || trim(to_char(round(n / 1000.0), 'FM999,990')) || 'K' else '$' || trim(to_char(n, 'FM999,990')) end $$;

-- Builds the brief only from what is on record: the project, the buyer's role on it, the evidence, the contact, past
-- activity. Documented scope is cited (document and page); inferred scope is asked as a question; nothing about prices,
-- crews, certifications, insurance or past jobs is said unless a record shows it.
create or replace function public.generate_outreach_brief(p_opportunity uuid, p jsonb default '{}') returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); o public.opportunities; pr public.projects; co public.companies; k public.contacts; acct public.company_accounts;
  part public.project_participants; brand jsonb; v_company text; v_me text; v_first text; v_role text; v_proj text; v_place text;
  v_doc jsonb; v_inf jsonb; v_services text[]; v_scope_line text; v_opener text; v_ask text; qs jsonb := '[]'; v_email text; v_vm text; v_next text; v_follow text;
  v_last record; v_past record; v_reason text; v_when text; v_id uuid; facts jsonb := '[]'; v_due text;
begin
  select * into o from private.v_opportunities where id = p_opportunity;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if o.owner_id is distinct from me.id and me.role <> 'manager' then raise exception 'not_owner' using errcode = '42501'; end if;
  select * into pr from public.projects where id = o.project_id;
  select * into co from public.companies where id = o.company_id;
  select * into acct from public.company_accounts where workspace_id = o.workspace_id and company_id = o.company_id;
  if acct.do_not_contact then raise exception 'do_not_contact' using errcode = '22023', hint = coalesce('Company marked do not contact: ' || acct.do_not_contact_reason, 'Company marked do not contact.'); end if;

  -- best contact: the one asked for, else a buyer-side role with a usable phone or email, verified first
  if p->>'contact_id' is not null then
    select * into k from private.v_contacts where id = (p->>'contact_id')::uuid and company_id = o.company_id;
    if k.id is null then raise exception 'bad_contact' using errcode = '22023'; end if;
    if k.do_not_contact then raise exception 'do_not_contact' using errcode = '22023', hint = 'This contact asked not to be contacted.'; end if;
    v_reason := 'Chosen by you.';
  else
    select * into k from private.v_contacts c where c.company_id = o.company_id and not c.archived and not c.do_not_contact
      and (c.phone is not null or (c.email is not null and not c.email_is_guess))
      order by case c.buying_role when 'estimator' then 1 when 'purchasing' then 2 when 'project_manager' then 3 when 'superintendent' then 4 else 5 end,
               case c.verification when 'user_confirmed' then 1 when 'published' then 2 else 3 end, c.updated_at desc limit 1;
    v_reason := case when k.id is null then 'No usable contact on record yet: call the main number and ask who buys cutting and coring.'
      else concat_ws(' ', case k.buying_role when 'estimator' then 'Estimators collect sub prices.' when 'purchasing' then 'Purchasing issues sub POs.'
        when 'project_manager' then 'The project manager owns the subcontract list.' when 'superintendent' then 'The superintendent knows the field schedule.' else null end,
        case k.verification when 'user_confirmed' then 'Details confirmed by your team.' when 'published' then 'Details from a public record.'
          else 'Details not verified yet.' end) end;
  end if;

  select * into part from public.project_participants where project_id = pr.id and company_id = o.company_id and current
    order by case role when 'awarded_contractor' then 1 when 'intended_awardee' then 2 when 'low_bidder' then 3 when 'bidder' then 4 else 5 end limit 1;
  brand := (select branding from public.workspaces where id = o.workspace_id);
  v_company := coalesce(brand->>'display_name', 'our company');
  v_me := coalesce(nullif(split_part(me.full_name, ' ', 1), ''), 'there');
  v_first := coalesce(nullif(split_part(k.name, ' ', 1), ''), 'there');
  v_proj := coalesce(pr.short_title, pr.title, o.title);
  v_place := coalesce(nullif(concat_ws(', ', pr.city, case when pr.county is not null then pr.county || ' County' end), ''), pr.location_text);
  v_due := case when pr.deadline is not null and pr.deadline > now() then to_char(pr.deadline at time zone 'America/New_York', 'Mon FMDD') end;

  -- scope: documented evidence names what the source says (with document and page); inferred is a question
  select jsonb_agg(e) into v_doc from jsonb_array_elements(coalesce(pr.evidence, '[]')) e where e->>'confidence' = 'documented';
  select jsonb_agg(e) into v_inf from jsonb_array_elements(coalesce(pr.evidence, '[]')) e where e->>'confidence' = 'inferred';
  v_services := coalesce(nullif(o.services_confirmed, '{}'), nullif(o.services, '{}'), pr.services_likely, '{}');
  if cardinality(o.services_confirmed) > 0 then
    v_scope_line := 'You confirmed the scope: ' || array_to_string(o.services_confirmed, ', ') || coalesce(' (' || o.scope_confirmed_note || ')', '') || '.';
  elsif v_doc is not null then
    v_scope_line := 'The ' || coalesce(v_doc->0->>'doc', 'source') || coalesce(' (page ' || (v_doc->0->>'page') || ')', '') || ' lists ' ||
      lower(regexp_replace(v_doc->0->>'term', '^bid item: ', '')) || coalesce(': "' || left(v_doc->0->>'snippet', 140) || '"', '') || '.';
  elsif cardinality(v_services) > 0 then
    v_scope_line := 'Scope is not confirmed. Projects like this often need ' || lower(private.or_list(v_services[1:3])) || ', so ask rather than assume.';
  else
    v_scope_line := 'No scope on record. Ask what cutting, coring or removal the job needs.';
  end if;

  facts := facts || jsonb_build_array(concat_ws(' ', v_proj, case when v_place is not null then 'in ' || v_place end));
  if pr.status_text is not null then facts := facts || to_jsonb(pr.status_text); end if;
  if part.id is not null then facts := facts || to_jsonb(co.name || ' is listed as ' || replace(part.role, '_', ' ') ||
    coalesce(' at ' || private.money_text(part.amount), '') || coalesce(' (' || part.source_name || coalesce(', ' || to_char(part.as_of, 'Mon FMDD'), '') || ')', '')); end if;
  if pr.value_label is not null then facts := facts || to_jsonb('Project value: ' || pr.value_label || ' (the whole project, not the cutting scope).'); end if;
  if v_due is not null then facts := facts || to_jsonb('Deadline: ' || v_due); end if;

  -- opener and the ask depend on where this company sits on the job
  v_role := coalesce(part.role, case o.kind when 'inbound_request' then 'requester' when 'gov_bid' then 'agency' else null end);
  v_opener := case
    when v_role = 'requester' then format('Hi %s, this is %s with %s. Thanks for sending the request on %s. I want to make sure we price the right scope.', v_first, v_me, v_company, v_proj)
    when v_role in ('awarded_contractor', 'intended_awardee', 'low_bidder') then format('Hi %s, this is %s with %s. I saw %s %s %s. Who is putting together the subcontractor list for it?',
      v_first, v_me, v_company, co.name, case v_role when 'low_bidder' then 'came in low on' else 'was awarded' end, v_proj)
    when v_role = 'bidder' then format('Hi %s, this is %s with %s. Are you taking sub prices on %s%s?', v_first, v_me, v_company, v_proj, coalesce(' before the ' || v_due || ' bid date', ''))
    when v_role in ('owner', 'developer', 'buyer', 'applicant') then format('Hi %s, this is %s with %s. I saw the plans for %s. Has a general contractor been picked yet?', v_first, v_me, v_company, v_proj)
    when v_role = 'agency' then format('Hi %s, this is %s with %s, calling about %s.', v_first, v_me, v_company, v_proj)
    else format('Hi %s, this is %s with %s, calling about %s.', v_first, v_me, v_company, v_proj) end;
  v_ask := case when cardinality(o.services_confirmed) > 0 or v_doc is not null then 'Ask for the drawings or the sheets that show the cuts and cores, and the date you would need a price by.'
    else 'Ask whether the job has any sawing, coring or concrete removal, and if so for the drawings.' end;

  -- qualification questions: inferred scope as questions, then what a price needs (from the service's required fields)
  if cardinality(o.services_confirmed) = 0 and v_doc is null and cardinality(v_services) > 0 then
    qs := qs || to_jsonb('Is there any ' || lower(private.or_list(v_services[1:3])) || ' on this job?');
  end if;
  -- what a price needs: the required measurements of the first two matching services (exact name first)
  qs := qs || (select coalesce(jsonb_agg(q order by srt, fno), '[]') from (
      select 'For ' || lower(s.name) || ': ' || lower(f.v->>'label') || '?' as q, s.sort + case when s.name = any(v_services) then 0 else 1000 end as srt, f.n as fno,
             dense_rank() over (order by case when s.name = any(v_services) then 0 else 1 end, s.sort) as svc_rank
      from public.services s, jsonb_array_elements(s.request_fields) with ordinality f(v, n)
      where s.workspace_id = o.workspace_id and s.active and (f.v->>'required')::boolean and (s.name = any(v_services) or s.discovery_name = any(v_services))) x
    where svc_rank <= 2);
  qs := qs || '["Who handles subcontracts and purchase orders?", "When do you need pricing, and when would the work start?", "Is there a vendor setup or insurance requirement we should send first?"]'::jsonb;

  -- what happened before: a follow-up refers to it, nothing more
  select a.created_at, a.kind, a.outcome, a.body into v_last from public.activities a
   where a.opportunity_id = o.id and a.kind in ('call', 'email', 'text', 'visit', 'meeting') order by a.created_at desc limit 1;
  select count(*) as n, max(aw.confirmed_on) as last_on into v_past from public.awards aw join public.opportunities o2 on o2.id = aw.opportunity_id
   where aw.workspace_id = o.workspace_id and o2.company_id = o.company_id and o2.id <> o.id;
  v_when := case when v_last.created_at is not null then to_char(v_last.created_at at time zone 'America/New_York', 'Mon FMDD') end;

  v_email := concat_ws(E'\n\n',
    'Hi ' || v_first || ',',
    case when v_last.created_at is not null then 'Following up on my ' || replace(v_last.kind, '_', ' ') || ' on ' || v_when || ' about ' || v_proj || '.'
         when v_role = 'requester' then 'Thanks for the request on ' || v_proj || '.'
         else 'I am reaching out about ' || v_proj || coalesce(' in ' || v_place, '') || '.' end,
    case when cardinality(o.services_confirmed) > 0 then 'We can price the ' || lower(array_to_string(o.services_confirmed, ', ')) || '.'
         when v_doc is not null then 'The ' || coalesce(v_doc->0->>'doc', 'documents') || ' show ' || lower(regexp_replace(v_doc->0->>'term', '^bid item: ', '')) || '. We would like to price that work.'
         else 'Does the job include any concrete sawing, coring or removal? If so, could you send the drawings so we can look at it?' end,
    case when v_past.n > 0 then 'Thank you again for the earlier work with us.' end,
    coalesce('If pricing is due by ' || v_due || ', what is the best way to get it to you?', 'When would you need pricing?'),
    'Thanks,' || E'\n' || coalesce(me.full_name, '') || E'\n' || v_company || coalesce(E'\n' || (brand->>'phone'), ''));
  v_vm := format('Hi %s, %s with %s, about %s. %s Call me back at %s. Thanks.', v_first, v_me, v_company, v_proj,
    case when cardinality(o.services_confirmed) > 0 or v_doc is not null then 'We would like to price the cutting and coring on it.' else 'I wanted to ask whether it has any concrete cutting or coring.' end,
    coalesce(nullif(p->>'callback', ''), brand->>'phone', 'this number'));
  v_next := case
    when k.id is null then 'Find the estimator or project manager: call the main number' || coalesce(' (' || co.phone || ')', '') || '.'
    when v_last.created_at is null then 'Call ' || k.name || ' today' || case when v_due is not null then ' (deadline ' || v_due || ')' else '' end || '.'
    when v_last.outcome in ('no_answer', 'voicemail') then 'Try again in two business days, then send the email.'
    else 'Send the email and set a follow-up for three business days.' end;
  v_follow := case when v_last.created_at is not null then format('Hi %s, checking back on %s from my %s on %s. Is there a good time this week to go over the cutting and coring scope?',
    v_first, v_proj, replace(v_last.kind, '_', ' '), v_when) end;

  insert into private.v_outreach_drafts (opportunity_id, contact_id, brief, created_by)
  values (o.id, k.id, jsonb_build_object(
    'contact', case when k.id is not null then jsonb_build_object('id', k.id, 'name', k.name, 'title', k.title, 'role', k.buying_role, 'phone', k.phone,
      'email', case when k.email_is_guess then null else k.email end, 'email_unverified_guess', case when k.email_is_guess then k.email end, 'verification', k.verification) end,
    'why_this_contact', v_reason, 'facts', facts, 'scope', v_scope_line, 'scope_confidence', case when cardinality(o.services_confirmed) > 0 then 'confirmed'
      when v_doc is not null then 'documented' when cardinality(v_services) > 0 then 'inferred' else 'missing' end,
    'evidence', coalesce(v_doc, '[]'), 'opener', v_opener, 'ask', v_ask, 'questions', qs, 'email_subject', left(v_proj || ' — concrete cutting and coring', 120),
    'email', v_email, 'voicemail', v_vm, 'next_step', v_next, 'follow_up', v_follow,
    'note', 'Draft only. Nothing is sent from here. Check the facts before using it.'), me.id)
  returning id into v_id;
  return (select brief || jsonb_build_object('id', id, 'created_at', created_at) from public.outreach_drafts where id = v_id);
end $$;

create or replace function public.mark_outreach_draft(p_id uuid, p_status text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles := private.require_active(); d public.outreach_drafts;
begin
  if p_status not in ('copied', 'discarded') then raise exception 'bad_status' using errcode = '22023'; end if;
  update private.v_outreach_drafts set status = p_status, updated_at = now() where id = p_id and created_by = me.id returning * into d;
  if d.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_status = 'copied' then
    insert into public.activities (opportunity_id, contact_id, user_id, kind, body, data)
    values (d.opportunity_id, d.contact_id, me.id, 'note', 'Copied an outreach draft (sent by you outside the portal, if at all)', jsonb_build_object('draft', d.id));
  end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.add_document_revision(jsonb), public.confirm_document_revision(uuid), public.list_documents(jsonb),
  public.generate_outreach_brief(uuid, jsonb), public.mark_outreach_draft(uuid, text) from public, anon;
grant execute on function public.add_document_revision(jsonb), public.confirm_document_revision(uuid), public.list_documents(jsonb),
  public.generate_outreach_brief(uuid, jsonb), public.mark_outreach_draft(uuid, text) to authenticated;
