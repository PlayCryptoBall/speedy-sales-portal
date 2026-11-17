-- 024: a missing contractor name normalizes to an empty key; treat it as no contractor (023 matched blanks as 'same contractor').
create or replace function private.duplicate_pairs() returns table (a uuid, b uuid, reason text, strength int)
language sql stable security definer set search_path = '' as $$
  with live as (
    select p.*, nullif(private.norm_key(p.winner_name), '') wk, coalesce(p.winner_as_of, p.published_at, p.created_at::date) d
      from public.projects p
     where p.merged_into is null and exists (select 1 from public.opportunities o where o.project_id = p.id and o.stage <> 'archived'))
  select x.id, y.id,
    case when x.sol_key is not null and x.sol_key = y.sol_key then 'Same solicitation number'
         when x.wk is not null and x.wk = y.wk then 'Same contractor (' || x.winner_name || ') and a similar description within 6 months, from two sources'
         else 'Nearly the same title' || coalesce(' in ' || coalesce(x.county, y.county) || ' County', '') || ', from two sources' end,
    case when x.sol_key is not null and x.sol_key = y.sol_key then 3 when x.wk is not null and x.wk = y.wk then 2 else 1 end
  from live x join live y on x.id < y.id
  where not exists (select 1 from public.duplicate_decisions dd where (dd.a = x.id and dd.b = y.id) or (dd.a = y.id and dd.b = x.id))
    and ((x.sol_key is not null and x.sol_key = y.sol_key)
      or (coalesce(x.source_id, '') <> coalesce(y.source_id, '')
          and coalesce(x.parcel_id, '') = coalesce(y.parcel_id, '')
          and ((x.wk is not null and x.wk = y.wk and extensions.similarity(x.title, y.title) >= 0.3 and abs(x.d - y.d) <= 183)
            or (extensions.similarity(x.title, y.title) >= 0.6 and (x.county = y.county or x.county is null or y.county is null)))))
$$;
