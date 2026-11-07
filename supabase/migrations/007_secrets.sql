-- Speedy Sales Portal: secrets the server functions check, kept in the database instead of function settings.

-- The scheduler sends this secret to the refresh function; it is generated here and never leaves the database.
create or replace function public.check_cron_secret(p_secret text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_secret, '') <> '' and exists (select 1 from vault.decrypted_secrets where name = 'speedy_cron_secret' and decrypted_secret = p_secret)
$$;
revoke execute on function public.check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;

-- One-time setup codes for creating the first manager (stored hashed, valid 7 days, single use).
create table if not exists private.setup_codes (
  code_hash text primary key,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
alter table private.setup_codes enable row level security;
create or replace function public.use_setup_code(p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update private.setup_codes set used_at = now()
   where code_hash = encode(extensions.digest(upper(trim(p_code)), 'sha256'), 'hex') and used_at is null and created_at > now() - interval '7 days';
  return found;
end $$;
revoke execute on function public.use_setup_code(text) from public, anon, authenticated;
grant execute on function public.use_setup_code(text) to service_role;
