-- Test-only: the real private.call_refresh (006) posts to the edge function through pg_net and Vault.
-- Here it records the call so scheduler tests can see what would have run.
create table if not exists private.test_refresh_calls (id bigserial primary key, source text, at timestamptz default clock_timestamp());
create or replace function private.call_refresh(p_source text) returns bigint
language sql security definer set search_path = '' as $$
  insert into private.test_refresh_calls (source) values (p_source) returning id
$$;
