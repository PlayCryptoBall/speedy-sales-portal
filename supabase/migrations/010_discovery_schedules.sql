-- Speedy Sales Portal: schedules for the sources added in 009 (Supabase only: needs pg_cron and pg_net).
-- The existing SAM.gov, FDOT, upkeep and retry schedules from 006 are unchanged.
-- Times are UTC. Florida is UTC-4 in summer and UTC-5 in winter.
select cron.schedule('speedy-usaspending', '35 10 * * *',   $$select private.call_refresh('usaspending_awards')$$);  -- 5:35-6:35 AM ET daily
select cron.schedule('speedy-permits',     '50 10 * * 1-6', $$select private.call_refresh('orlando_permits')$$);     -- 5:50-6:50 AM ET, Monday to Saturday
