-- Speedy Sales Portal: every source refreshes daily at 4 AM Eastern, then daily upkeep re-ranks the pool (Supabase only).
-- pg_cron runs in UTC; 4 AM Eastern is 08:00 UTC in summer and 09:00 UTC in winter, so each job fires at both
-- and only does anything during the 4 AM Eastern hour. FDOT's midday and late weekday checks and the hourly retry stay.
create or replace function private.at_et_hour(p_hour int) returns boolean
language sql stable set search_path = '' as $$
  select extract(hour from now() at time zone 'America/New_York')::int = p_hour
$$;
select cron.schedule('speedy-sam',         '0 8,9 * * *',  $$select private.call_refresh('sam_gov') where private.at_et_hour(4)$$);
select cron.schedule('speedy-fdot-early',  '5 8,9 * * *',  $$select private.call_refresh('fdot_lettings') where private.at_et_hour(4)$$);
select cron.schedule('speedy-usaspending', '10 8,9 * * *', $$select private.call_refresh('usaspending_awards') where private.at_et_hour(4)$$);
select cron.schedule('speedy-permits',     '15 8,9 * * *', $$select private.call_refresh('orlando_permits') where private.at_et_hour(4)$$);
select cron.schedule('speedy-upkeep',      '40 8,9 * * *', $$select public.daily_maintenance() where private.at_et_hour(4)$$);
