# Speedy Sales Portal

Private lead portal for Speedy Concrete Cutting's Orlando sales team. Each salesperson signs in with their own account, claims leads from a shared Florida pool, logs calls, sets follow-ups and moves work toward a quote or a booked job. Managers see the whole team, assign work, manage access and watch the automated refreshes.

## How it is built

| Piece | What it does | Where it runs |
|---|---|---|
| `web/` | The app (plain HTML, CSS, JavaScript; no build step). Logo, icons and the IBM Plex Sans font are in `web/assets/` | GitHub Pages |
| `supabase/migrations/` | Database tables, permission rules, every action the app can take | Supabase Postgres |
| `supabase/functions/admin-users` | Invites, reset links, role changes, turning accounts off | Supabase Edge Functions |
| `supabase/functions/refresh` | Discovery: SAM.gov, FDOT/Turnpike letting results, USAspending.gov awards and City of Orlando permits, classified against Speedy's services (`terms.ts`) | Supabase Edge Functions + pg_cron |
| `scripts/migrate_legacy.py` | One-time import of the original pipeline (84 leads, 51 bids) | Run once by the installer |
| `tests/` | Database workflow tests, parser tests, browser tests | Local Postgres 17 + Playwright |

Security model: the browser holds only the project URL and the publishable key (both public by design). Every table has row-level security on and no direct grants; the app can only call database functions, and each one checks the caller's own active profile and role before reading or changing anything. The service-role key exists only inside the two edge functions. Lead data is never stored in this repository.

## Setup (one time)

1. **Supabase**: create the organization and a project (Free plan is enough to start). Region `us-east-1`.
2. **Database**: run `supabase/migrations/001` to `005`, then the generated legacy import (kept outside the repo), then `007_secrets.sql`, then `006_schedules.sql` with the functions URL filled in, then `008_team_metrics.sql`, `009_discovery.sql`, `010_discovery_schedules.sql` and `011_terms_update.sql`.
3. **Edge functions**: deploy `admin-users` and `refresh` (both with JWT verification off; they check callers themselves). The scheduler secret and first-manager setup code live in the database, so no function secrets are required. Optional: `SAM_API_KEY`.
4. **Auth settings** (Supabase dashboard, Authentication): turn off "Allow new users to sign up". Optional: raise "Email OTP expiration" so invite links last longer than 1 hour (max 24 h).
5. **Web**: put the project URL and publishable key in `web/config.js`. GitHub: Settings, Pages, Source "GitHub Actions". The workflow in `.github/workflows/pages.yml` publishes `web/`.
6. **First manager**: open `<portal>#/setup`, enter the setup code, name and email, then set a password. After that, setup is closed and everyone else is invited from People and access.

## Running costs

| Service | Plan | Cost |
|---|---|---|
| Supabase | Free (500 MB database, 50,000 monthly users, 500,000 function calls) | $0. Free projects pause after about a week with no use; daily use keeps it awake. Pro is $25/month per organization (no pausing, daily backups). |
| GitHub Pages | Free with a public repository | $0. The code is public; the data is not. |
| SAM.gov API key | Free with a SAM.gov account | $0 |
| Email for self-service password resets | Optional custom SMTP (for example Resend's free tier) | $0 to start; needs DNS records on a Speedy domain. Without it, managers send reset links themselves. |

## Tests

```
tests/reset_db.sh t1 && psql ... -d t1 -f <import.sql>     # same for t2 and t3
node tests/workflows.test.mjs t1          # 31 database workflows: claim races, permissions, refresh safety, import, exports, team counts, discovery routing and matching
node --experimental-strip-types tests/parsers.test.mjs t2   # 22: FDOT, SAM.gov, USAspending and permit parsers, classification scenarios, real missed records
node tests/server.mjs t3 8787 & node tests/ui.test.mjs t3 8787 ./shots   # 21 browser tests, phone and desktop
```

## Interface notes

- **Layout**: grouped sidebar on desktop (collapsible; collapsed by default on tablets), top bar and bottom tabs on phones. Lead and person details open in a side panel over the page you were on; Back or Escape closes it, and its address can be shared (`#/pool?lead=<id>`).
- **Leads**: Available, My pipeline, All leads and Gov contracts share one list: search, filters (shown as removable chips), sorting, and list, card, table (choose columns) or board views. The board moves leads between stages and asks for whatever the stage requires (a reason for won, lost or disqualified; a date for Follow up).
- **Counts**: every number says what it counts. The Team page's "Available to claim" is the same pool salespeople see; new finds waiting for a manager's review are counted separately as "Waiting for review".
- **Colour**: blue is for things you can act on; orange and amber mark priority and dates that matter; red only marks failures.

## Discovery

Every record a refresh reads is checked against Speedy's service vocabulary (`public.service_terms`, seeded from `supabase/functions/refresh/terms.ts`; managers edit it in Sources and refreshes > Settings):

| Class | Meaning | Where it goes |
|---|---|---|
| High priority | The source text names Speedy work (coring, sawcutting, scanning, removal...). Stored as *documented* evidence with the snippet, field and document. | Available pool; managers get one alert |
| Potential | The project type usually needs Speedy (bridge replacement, lift station, renovation of an existing building...). Stored as *inferred* evidence. | Available pool, marked inferred |
| Needs review | Weak signal, or a big job with no scope described. | Review queue |
| Low relevance | Nothing relevant, or not construction (roofing, HVAC equipment, design services, janitorial). | Not added; counted in the run |

Matching across sources, in order: the record's own key, a shared award or FDOT project number, the solicitation number, then a similar title in the same county or city. Clear matches merge (the original source keeps its text; the new one only fills blanks and adds the winner). Unclear ones are saved separately and sent to review as possible duplicates.

Regions: Central FL, Tampa Bay, Northeast FL, Southwest FL, Southeast FL, Panhandle (all 67 counties in `public.fl_counties`, with FDOT districts). Sources and refreshes > Coverage shows what each source covers, what the last run examined, and which counties have records or a local source.

Not automated (and why) is listed in the same place: FDOT bid solicitation notices (PDFs), county and city bid boards (vendor logins and terms), MyFloridaMarketPlace (no public feed), paid plan rooms (subscription), other cities' permit portals (separate adapters needed).
