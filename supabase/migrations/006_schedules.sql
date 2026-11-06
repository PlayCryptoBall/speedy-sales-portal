-- Speedy Sales Portal: server-side schedules (Supabase only; not part of the local test database).
-- Before running: replace __FUNCTIONS_URL__ with https://<project-ref>.supabase.co/functions/v1
-- and __CRON_SECRET__ with the same random value saved as the CRON_SECRET edge function secret.
create extension if not exists pg_cron;
create extension if not exists pg_net;

insert into private.app_config (key, value) values ('functions_url', '__FUNCTIONS_URL__')
on conflict (key) do update set value = excluded.value;
select vault.create_secret('__CRON_SECRET__', 'speedy_cron_secret', 'Shared secret the scheduler sends to the refresh function');

create or replace function private.call_refresh(p_source text) returns bigint
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := (select value from private.app_config where key = 'functions_url') || '/refresh',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'speedy_cron_secret')),
    body := jsonb_build_object('source', p_source, 'trigger', 'schedule'),
    timeout_milliseconds := 10000)
$$;
revoke execute on function private.call_refresh(text) from public, anon, authenticated;

-- Times are UTC. Florida is UTC-4 in summer and UTC-5 in winter.
select cron.schedule('speedy-upkeep',      '5 10 * * *',   $$select public.daily_maintenance()$$);                 -- 5-6 AM ET: close past-deadline bids, stale-claim and follow-up notices, re-rank
select cron.schedule('speedy-sam',         '15 10 * * *',  $$select private.call_refresh('sam_gov')$$);           -- 5-6 AM ET daily
select cron.schedule('speedy-fdot-midday', '40 16 * * 1-5', $$select private.call_refresh('fdot_lettings')$$);    -- noon ET weekdays (lettings open mid-morning)
select cron.schedule('speedy-fdot-late',   '40 21 * * 1-5', $$select private.call_refresh('fdot_lettings')$$);    -- 5 PM ET weekdays
select cron.schedule('speedy-retry',       '25 * * * *',   $$select private.call_refresh('retry_failed')$$);      -- hourly: re-run a failed source (up to 3 tries)
