-- Supabase only (pg_cron). Replaces the fixed-hour jobs from 010/012 with one 5-minute scheduler tick that reads
-- the refresh_schedule setting (America/New_York, daylight saving handled by private.scheduler_tick).
-- speedy-retry stays as a safety net for sources that fail outside the morning window.
do $$
declare j text;
begin
  foreach j in array array['speedy-sam','speedy-fdot-early','speedy-usaspending','speedy-permits','speedy-upkeep','speedy-fdot-midday','speedy-fdot-late'] loop
    if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
  end loop;
end $$;
select cron.schedule('speedy-scheduler', '*/5 * * * *', $$select private.scheduler_tick()$$);
