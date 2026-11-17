-- Miami-Dade County building permits (county ArcGIS open data) for the Fort Lauderdale office, and the coverage registry
-- updated with what was found for Tampa, Hillsborough, City of Miami and unincorporated Orange County.

insert into public.sources (id, name, url, kind, category, method, geography, project_types, counties, coverage, schedule_note, access_notes, config) values
 ('miamidade_permits', 'Miami-Dade County building permits', 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0', 'automated',
  'Private construction', 'County open data API (ArcGIS)', 'Miami-Dade County (county-issued permits)',
  'Commercial new buildings, additions, interior and exterior alterations, structural and concrete repairs, shells and demolitions, with owner, contractor, phone and architect',
  array['Miami-Dade'],
  'Commercial building permits applied for in the last 30 days, valued at $250,000 and up ($50,000 for demolition). Trade sub-permits (roofing, windows, pools) are joined to their master permit, and the builder comes from the master.',
  'Daily at 4:15 AM Eastern.', 'Miami-Dade County open data, public, no login. The feed updates a few times a week. Values are the permit valuation, not a contract amount.',
  '{"lookback_days": 30, "min_value": 250000, "min_demo_value": 50000, "max_new_per_run": 40, "expect_new_days": 7}')
on conflict (id) do update set name = excluded.name, url = excluded.url, method = excluded.method, geography = excluded.geography,
  project_types = excluded.project_types, counties = excluded.counties, coverage = excluded.coverage, access_notes = excluded.access_notes,
  config = public.sources.config || excluded.config;

update public.coverage_registry set source_id = 'miamidade_permits',
  url = 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0', method = 'County open data API (ArcGIS)',
  scope_note = 'Commercial building permits with owner, contractor, phone, architect and folio', status = null, restrictions = 'County-issued permits only; cities that run their own building departments (Miami, Miami Beach, Hialeah, Coral Gables) are not in this feed',
  business_value = 0, checked_at = '2026-11-16'
where county = 'Miami-Dade' and jurisdiction = 'Miami-Dade County' and data_type = 'permits';

update public.coverage_registry set jurisdiction = 'Hillsborough County', method = 'County ArcGIS service (PermitsPlus)',
  url = 'https://maps.hillsboroughcounty.org/arcgis/rest/services/PermitsPlus/ResidentialCommericalIssuedPermitsCertOccMapService/MapServer/0',
  scope_note = 'Issued permits and certificates of occupancy',
  restrictions = 'Public layer has no contractor or phone, and its dates are unreliable (issued dates as late as 2063); not usable for leads as it stands',
  status = 'Not yet integrated', business_value = 85, checked_at = '2026-11-16'
where county = 'Hillsborough' and data_type = 'permits' and jurisdiction = 'Hillsborough County and City of Tampa';

insert into public.coverage_registry (county, jurisdiction, data_type, source_id, url, method, scope_note, restrictions, status, business_value, checked_at) values
 ('Hillsborough', 'City of Tampa', 'permits', null, 'https://www.civicdata.com/dataset/tampa-building-permits', 'CivicData (Accela) open data',
  'Building permits 2023 to present', 'The published dataset stopped updating on 2026-07-01 and its data API returns "not found"; the Accela citizen portal has no bulk export',
  'Stale', 85, '2026-11-16'),
 ('Miami-Dade', 'City of Miami', 'permits', null, 'https://gis.miami.gov/gis/rest/services/Maps/iBuildPermits/MapServer/0', 'City ArcGIS service (iBuild)',
  'City of Miami permits with scope of work and project name', 'No contractor, owner or valuation in the public layer; usable later as a signal source only',
  'Not yet integrated', 60, '2026-11-16')
on conflict (county, jurisdiction, data_type) do update set url = excluded.url, method = excluded.method, scope_note = excluded.scope_note,
  restrictions = excluded.restrictions, status = excluded.status, business_value = excluded.business_value, checked_at = excluded.checked_at;

update public.coverage_registry set restrictions = 'Fast Track is an interactive web application with no open-data feed or export; county open data has no permit layer. Needs a records request or a county data agreement',
  method = 'Fast Track online services (interactive only)', status = 'Requires manual acquisition', checked_at = '2026-11-16'
where county = 'Orange' and jurisdiction = 'Orange County' and data_type = 'permits';
