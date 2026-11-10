// Prints the SQL seed for public.fl_counties and public.service_terms from the refresh job's own tables,
// so the database and the collector start from the same vocabulary.
// usage: node --experimental-strip-types scripts/gen_discovery_seed.mjs [--terms-upsert] > out/seed.sql
//   --terms-upsert: only the search terms, updating built-in terms that no manager has edited (for a later migration)
import { REGIONS } from '../supabase/functions/refresh/lib.ts';
import { DEFAULT_TERMS } from '../supabase/functions/refresh/terms.ts';

const DISTRICT = {
  1: 'Charlotte,Collier,DeSoto,Glades,Hardee,Hendry,Highlands,Lee,Manatee,Okeechobee,Polk,Sarasota',
  2: 'Alachua,Baker,Bradford,Clay,Columbia,Dixie,Duval,Gilchrist,Hamilton,Lafayette,Levy,Madison,Nassau,Putnam,St. Johns,Suwannee,Taylor,Union',
  3: 'Bay,Calhoun,Escambia,Franklin,Gadsden,Gulf,Holmes,Jackson,Jefferson,Leon,Liberty,Okaloosa,Santa Rosa,Wakulla,Walton,Washington',
  4: 'Broward,Indian River,Martin,Palm Beach,St. Lucie',
  5: 'Brevard,Flagler,Lake,Marion,Orange,Osceola,Seminole,Sumter,Volusia',
  6: 'Miami-Dade,Monroe',
  7: 'Citrus,Hernando,Hillsborough,Pasco,Pinellas',
};
const district = {};
for (const [d, list] of Object.entries(DISTRICT)) for (const c of list.split(',')) district[c] = Number(d);
const q = (s) => s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`;
const upsert = process.argv.includes('--terms-upsert');
const rows = [];
for (const [region, counties] of Object.entries(REGIONS)) for (const c of counties) {
  if (!district[c]) throw new Error('no FDOT district for ' + c);
  rows.push(`(${q(c)}, ${q(region)}, ${district[c]})`);
}
if (rows.length !== 67 || Object.keys(district).length !== 67) throw new Error(`expected 67 counties, got ${rows.length}/${Object.keys(district).length}`);
if (!upsert) console.log(`insert into public.fl_counties (name, region, fdot_district) values\n ${rows.join(',\n ')}\non conflict (name) do update set region = excluded.region, fdot_district = excluded.fdot_district;\n`);
const t = DEFAULT_TERMS.map(x => `(${q(x.label)}, ${q(x.pattern)}, ${q(x.kind)}, ${x.weight}, ${x.services.length ? `array[${x.services.map(q).join(',')}]` : `'{}'::text[]`}, ${q(x.category ?? null)})`);
console.log(`insert into public.service_terms (label, pattern, kind, weight, services, category) values\n ${t.join(',\n ')}\n` + (upsert
  ? `on conflict (label) do update set pattern = excluded.pattern, kind = excluded.kind, weight = excluded.weight, services = excluded.services,\n  category = excluded.category, updated_at = now()\nwhere public.service_terms.updated_by is null;   -- terms a manager edited are left alone`
  : 'on conflict (label) do nothing;'));
