-- Speedy Sales Portal: core schema
-- Every table has RLS on. The browser never reads tables directly: all reads and
-- writes go through the SECURITY DEFINER functions in 002_rpc.sql, which check
-- the caller's profile (active + role) before returning or changing anything.

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------- reference
create table public.stages (
  key text primary key,
  label text not null,
  sort int not null,
  phase text not null check (phase in ('pool','active','won','lost','parked')),
  description text not null default ''
);
insert into public.stages (key, label, sort, phase, description) values
 ('available','Available',10,'pool','In the shared pool. Anyone can claim it.'),
 ('claimed','Claimed',20,'active','Owned, nobody contacted yet.'),
 ('contacted','Contacted',30,'active','Call, email or visit made (reached or attempted).'),
 ('qualified','Qualified',40,'active','Real need confirmed with a contact.'),
 ('quote_needed','Quote needed',50,'active','Contact asked for pricing. Estimating has been asked.'),
 ('quote_sent','Quote sent',60,'active','Quote delivered to the contact.'),
 ('follow_up','Follow up',70,'active','Waiting on a decision. Follow-up date set.'),
 ('won','Won',80,'won','Job booked.'),
 ('lost','Lost',90,'lost','Went to someone else or did not happen.'),
 ('nurture','Nurture',100,'parked','Not now. Keep the relationship warm.'),
 ('disqualified','Disqualified',110,'parked','Not a fit for Speedy.'),
 ('archived','Archived',120,'parked','Closed out. Kept for history.');

create table public.settings (
  key text primary key,
  value jsonb not null,
  description text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.settings (key, value, description) values
 ('stale_days', '14', 'Claimed leads with no logged activity for this many days are suggested for review. Nothing is released automatically.'),
 ('max_open_claims', '60', 'Most open (claimed through follow-up) opportunities one salesperson can hold.'),
 ('home_region', '"Central FL"', 'Region ranked closest to the office.');

-- ---------------------------------------------------------------- people
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  phone text,
  role text not null default 'sales' check (role in ('manager','sales')),
  active boolean not null default false,
  invited_by uuid references public.profiles(id),
  invited_at timestamptz,
  deactivated_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

-- New auth users (invites, or anyone who signs up if public sign-ups are left on)
-- get an INACTIVE sales profile. Only a manager can activate it.
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, active)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data->>'full_name', ''), false)
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------- companies & contacts
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text not null unique,
  kind text not null default 'contractor' check (kind in ('contractor','owner','agency','developer','other')),
  hq text,
  website text,
  phone text,
  notes text,
  aliases text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  name text,
  title text,
  phone text,
  email text,
  web text,
  notes text,
  verified boolean not null default false,
  verified_at timestamptz,
  verified_by uuid references public.profiles(id),
  source text not null default 'research' check (source in ('research','source_document','salesperson','import','refresh')),
  source_url text,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
create index on public.contacts (company_id);

-- ---------------------------------------------------------------- sources
create table public.sources (
  id text primary key,
  name text not null,
  url text,
  kind text not null check (kind in ('automated','manual','needs_credentials','paid','legacy')),
  coverage text not null default '',
  schedule_note text not null default '',
  access_notes text not null default '',
  enabled boolean not null default true,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_status text,
  last_error text,
  consecutive_failures int not null default 0,
  config jsonb not null default '{}'
);

insert into public.sources (id, name, url, kind, coverage, schedule_note, access_notes) values
 ('sam_gov','SAM.gov federal opportunities','https://sam.gov/search/?index=opp','automated',
  'Federal solicitations, notices and awards with place of performance in Florida (construction, demolition, repair).',
  'Daily, early morning. Retries hourly up to 3 times after a failure.',
  'Uses the official SAM.gov Opportunities API when a free SAM API key is saved as SAM_API_KEY; otherwise tries the public search endpoint, which SAM.gov may block for servers.'),
 ('fdot_lettings','FDOT and Florida''s Turnpike letting results','https://bidletting.fdot.gov/LettingResults','automated',
  'Central Office, Districts 1-7 and Turnpike preliminary letting results: every bidder and the apparent low bidder.',
  'Weekdays, morning and late afternoon. Retries hourly up to 3 times after a failure.',
  'Public pages, no login. Results are preliminary: the low bidder is not the awarded contractor until FDOT posts the award.'),
 ('fdot_bid_notices','FDOT district and Turnpike bid notices (upcoming lettings)','https://www.fdot.gov/contracts/district-offices','manual',
  'Upcoming state road and bridge lettings before bid day.',
  'Weekly manual review.',
  'Notices are PDFs that change format by district; reviewed by hand and added from the portal.'),
 ('local_portals','Counties, cities, airports, utilities, school districts and universities','','needs_credentials',
  'Orange, Osceola, Seminole, Brevard, Volusia, Lake, Polk, Hillsborough and other agency bid boards; GOAA (MCO), OUC, UCF, school districts.',
  'Weekly manual review.',
  'Many boards (DemandStar, Bonfire, OpenGov, BidNet) need a free vendor login or a paid subscription to see plan holders. Add finds from the portal.'),
 ('private_news','Private construction announcements','','manual',
  'Hospitals, towers, data centers, hotels and other private projects from permits, construction news and owner announcements.',
  'Weekly manual review.',
  'Some news sites are paywalled. Leads are added from the portal with the article link.'),
 ('legacy_import','Speedy Florida Pipeline (Oct-Nov 2026)','','legacy',
  'The 84 sales leads and 51 government jobs researched for the original pipeline tracker and workbook.',
  'One-time import on Nov 6, 2026.',
  'Each record keeps its original source link. Facts were checked when first researched; the portal shows them as not re-verified until a refresh confirms them.'),
 ('portal_manual','Added in the portal','','manual','Leads added by a manager in the portal.','As needed.','');

-- ---------------------------------------------------------------- projects
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  external_key text not null unique,
  alt_keys text[] not null default '{}',
  source_id text not null references public.sources(id),
  title text not null,
  short_title text,
  owner_name text,
  level text,
  location_text text,
  city text,
  county text,
  region text not null default 'Unknown',
  stage text not null default 'unknown' check (stage in ('planning','upcoming','bidding','bid_closed','low_bidder','intent_to_award','awarded','preconstruction','under_construction','completed','cancelled','unknown')),
  status_text text,
  project_value numeric check (project_value is null or project_value >= 0),
  value_label text,
  size_note text,
  solicitation_no text,
  sol_key text,
  set_aside text,
  deadline timestamptz,
  deadline_is_date boolean not null default false,
  deadline_note text,
  published_at date,
  discovered_at timestamptz,
  discovered_note text,
  imported_at timestamptz,
  last_verified_at timestamptz,
  last_checked_at timestamptz,
  verify_status text not null default 'not_checked' check (verify_status in ('ok','failed','missing','not_checked')),
  source_url text,
  source_name text,
  source_summary text,
  scope_evidence text[] not null default '{}',
  services_likely text[] not null default '{}',
  pocs jsonb not null default '[]',
  winner_company_id uuid references public.companies(id),
  winner_name text,
  winner_amount numeric,
  winner_status text check (winner_status in ('low_bidder','intended','awarded')),
  winner_as_of date,
  winner_source_url text,
  bidders jsonb not null default '[]',
  legacy jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.projects (sol_key);
create index on public.projects using gin (alt_keys);

-- ---------------------------------------------------------------- opportunities
create sequence public.opp_ref_seq start 1001;

create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default ('OPP-' || nextval('public.opp_ref_seq')),
  project_id uuid references public.projects(id),
  company_id uuid references public.companies(id),
  kind text not null check (kind in ('gov_bid','contractor_outreach','private_project','relationship')),
  approach text not null check (approach in ('bid_direct','plan_holders','quote_bidders','approach_prime','approach_developer','track_award','watch','relationship')),
  approach_note text,
  title text not null,
  stage text not null default 'available' references public.stages(key),
  owner_id uuid references public.profiles(id),
  claimed_at timestamptz,
  next_action text,
  next_action_due date,
  last_activity_at timestamptz,
  last_activity_by uuid references public.profiles(id),
  last_activity_summary text,
  services text[] not null default '{}',
  speedy_scope text,
  services_confirmed text[] not null default '{}',
  scope_confirmed_note text,
  quote_amount numeric check (quote_amount is null or quote_amount >= 0),
  quote_sent_at date,
  expected_work_date date,
  outcome_reason text,
  closed_at timestamptz,
  fit_score int,
  urgency_score int,
  priority text check (priority in ('Hot','Warm','Later')),
  priority_reasons jsonb not null default '{}',
  scored_at timestamptz,
  needs_review boolean not null default false,
  review_kind text,
  review_reason text,
  legacy_id text unique,
  legacy_priority text,
  legacy jsonb,
  superseded_by uuid references public.opportunities(id),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_required check (project_id is not null or kind = 'relationship'),
  constraint owner_matches_stage check (
    (stage = 'available' and owner_id is null)
    or (stage in ('claimed','contacted','qualified','quote_needed','quote_sent','follow_up') and owner_id is not null)
    or stage in ('won','lost','nurture','disqualified','archived'))
);
create index on public.opportunities (owner_id);
create index on public.opportunities (project_id);
create index on public.opportunities (company_id);
create index on public.opportunities (stage);

-- extra project links (one lead covering several contracts)
create table public.opportunity_projects (
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  relation text not null default 'also covers',
  primary key (opportunity_id, project_id)
);

-- ---------------------------------------------------------------- activity & history (append-only)
create table public.activities (
  id bigint generated always as identity primary key,
  opportunity_id uuid references public.opportunities(id) on delete cascade,
  company_id uuid references public.companies(id),
  contact_id uuid references public.contacts(id),
  user_id uuid references public.profiles(id),
  kind text not null check (kind in ('call','email','text','visit','meeting','note','stage','claim','release','assign','quote','follow_up','contact','system','refresh','import','review')),
  outcome text,
  body text,
  from_stage text,
  to_stage text,
  data jsonb not null default '{}',
  dedupe_key text unique,
  created_at timestamptz not null default now()
);
create index on public.activities (opportunity_id, created_at desc);
create index on public.activities (company_id, created_at desc);

create table public.ownership_history (
  id bigint generated always as identity primary key,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  action text not null check (action in ('claim','release','assign','reassign','unassign')),
  from_user uuid references public.profiles(id),
  to_user uuid references public.profiles(id),
  by_user uuid references public.profiles(id),
  reason text,
  created_at timestamptz not null default now()
);
create index on public.ownership_history (opportunity_id);

-- ---------------------------------------------------------------- refresh bookkeeping
create table public.refresh_runs (
  id bigint generated always as identity primary key,
  source_id text not null references public.sources(id),
  trigger text not null default 'schedule' check (trigger in ('schedule','manual','retry','test')),
  triggered_by uuid references public.profiles(id),
  attempt int not null default 1,
  status text not null default 'running' check (status in ('running','success','partial','failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  fetched int not null default 0,
  discovered int not null default 0,
  updated int not null default 0,
  merged int not null default 0,
  flagged int not null default 0,
  unchanged int not null default 0,
  errors int not null default 0,
  log jsonb not null default '[]',
  error text
);
create index on public.refresh_runs (source_id, started_at desc);

create table public.refresh_changes (
  id bigint generated always as identity primary key,
  run_id bigint references public.refresh_runs(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  field text not null,
  old_value text,
  new_value text,
  material boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.refresh_changes (project_id);

create table public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  opportunity_id uuid references public.opportunities(id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  dedupe_key text unique,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.notifications (user_id, created_at desc);

create table public.pool_snapshots (
  day date primary key,
  available int not null,
  available_hot int not null,
  claimed_open int not null,
  review_queue int not null,
  by_region jsonb not null default '{}',
  by_source jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.exports_log (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id),
  scope text not null,
  row_count int not null,
  created_at timestamptz not null default now()
);

create table public.import_batches (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id),
  file_name text,
  applied boolean not null default false,
  summary jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- private config (never exposed through the API)
create table private.app_config (
  key text primary key,
  value text not null
);

-- ---------------------------------------------------------------- lock everything down
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke all on all sequences in schema public from anon, authenticated;
alter table private.app_config enable row level security;
