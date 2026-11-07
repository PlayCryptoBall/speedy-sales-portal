# Speedy Sales Portal

Private lead portal for Speedy Concrete Cutting's Orlando sales team. Each salesperson signs in with their own account, claims leads from a shared Florida pool, logs calls, sets follow-ups and moves work toward a quote or a booked job. Managers see the whole team, assign work, manage access and watch the automated refreshes.

## How it is built

| Piece | What it does | Where it runs |
|---|---|---|
| `web/` | The app (plain HTML, CSS, JavaScript; no build step) | GitHub Pages |
| `supabase/migrations/` | Database tables, permission rules, every action the app can take | Supabase Postgres |
| `supabase/functions/admin-users` | Invites, reset links, role changes, turning accounts off | Supabase Edge Functions |
| `supabase/functions/refresh` | Reads SAM.gov and FDOT/Turnpike letting results on a schedule | Supabase Edge Functions + pg_cron |
| `scripts/migrate_legacy.py` | One-time import of the original pipeline (84 leads, 51 bids) | Run once by the installer |
| `tests/` | Database workflow tests, parser tests, browser tests | Local Postgres 17 + Playwright |

Security model: the browser holds only the project URL and the publishable key (both public by design). Every table has row-level security on and no direct grants; the app can only call database functions, and each one checks the caller's own active profile and role before reading or changing anything. The service-role key exists only inside the two edge functions. Lead data is never stored in this repository.

## Setup (one time)

1. **Supabase**: create the organization and a project (Free plan is enough to start). Region `us-east-1`.
2. **Database**: run `supabase/migrations/001` to `005`, then the generated legacy import (kept outside the repo), then `007_secrets.sql`, then `006_schedules.sql` with the functions URL filled in.
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
tests/reset_db.sh t1 && psql ... -f <import.sql>
node tests/workflows.test.mjs t1          # 25 database workflows: claim races, permissions, refresh safety, import, exports
node --experimental-strip-types tests/parsers.test.mjs t2   # FDOT and SAM.gov parsers on saved real responses
node tests/server.mjs t3 8787 & node tests/ui.test.mjs t3 8787 ./shots   # 13 browser tests, phone and desktop
```
