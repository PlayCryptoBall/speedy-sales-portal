-- FDOT bid tabulations: reads the pay items and quantities of tracked FDOT contracts once the district or Central Office
-- posts the tabulation (about one to three weeks after the letting). Updates existing FDOT projects only; never creates leads.
insert into public.sources (id, name, url, kind, category, method, geography, project_types, counties, coverage, schedule_note, access_notes, config) values
 ('fdot_bidtabs', 'FDOT bid tabulations (pay items)', 'https://www.fdot.gov/contracts/Lettings/Letting-Project-Info.shtm', 'automated',
  'State transportation', 'FDOT district and Central Office letting pages (PDF bid tabulations)', 'Statewide (all 7 districts and Central Office)',
  'Pay items with quantities: bridge and structure removal, concrete removal, saw cutting, coring, concrete pavement grinding, slab and spall repair, expansion joints',
  null,
  'For FDOT contracts already in the portal from the last 150 days. A pay item that names removal, sawing, coring or grinding is recorded as documented Speedy scope with its quantity.',
  'Daily at 4:15 AM Eastern, after the letting results.', 'Public FDOT PDFs. Tabulations post one to three weeks after the letting; contracts without one are checked again on later runs.',
  '{"lookback_days": 150, "max_pdfs_per_run": 25, "expect_new_days": 30, "done": []}')
on conflict (id) do update set name = excluded.name, url = excluded.url, method = excluded.method, geography = excluded.geography,
  project_types = excluded.project_types, coverage = excluded.coverage, access_notes = excluded.access_notes,
  config = excluded.config || public.sources.config;

insert into public.coverage_registry (county, jurisdiction, data_type, source_id, url, method, scope_note, restrictions, status, business_value, checked_at)
select null, 'FDOT bid tabulations', 'roads', 'fdot_bidtabs', 'https://www.fdot.gov/contracts/Lettings/Letting-Project-Info.shtm', 'PDF bid tabulations from district and Central Office pages',
  'Pay items and quantities for tracked FDOT contracts', 'Posted one to three weeks after the letting', null, 0, '2026-11-16'
where not exists (select 1 from public.coverage_registry where jurisdiction = 'FDOT bid tabulations');
