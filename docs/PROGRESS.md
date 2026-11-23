# Progress log

Read this first when resuming. Plan: `docs/PLAN.md`.

## Checkpoints
- Code before the CRM work: commit `3049058` on `main` (tag push is refused by the git proxy, so the commit id is the checkpoint).
- Database before the CRM work: schema `backup_20261122` in the live project (full copy of every public table, row counts verified 2026-11-22).

## How to apply a migration live (no CLI in this environment)
1. Commit and push. 2. In SQL: `select net.http_get('https://raw.githubusercontent.com/PlayCryptoBall/speedy-sales-portal/<sha>/supabase/migrations/<file>')`.
3. Run it in a DO block that checks `md5(content)` against local `md5sum`, `execute`s it and inserts into `supabase_migrations.schema_migrations`.
Edge function deploys import the file pinned to a commit sha (see the refresh function).

## Rules that later work must follow
- User-facing SQL reads and writes pursuit rows through `private.v_opportunities`, `private.v_activities`, `private.v_contacts`, `private.v_tasks`, `private.v_company_accounts` (and the views added later). Base tables are only for jobs and refresh functions.
- After adding a column to a table behind a view, `create or replace view` it (views freeze `select *` at creation) and re-set the `workspace_id` default on the view.
- New pursuit tables get `workspace_id ... default private.current_ws()`, a `private.v_*` view, RLS on, and no grants.
- Stage lists: use `private.active_stages()`; do not hardcode.
- Tests: `tests/run_all.sh` (resets t1–t3, loads the private legacy import, runs workflows, parsers and the browser suite). Fixtures use example names only.

## Done
| Date | Migration / change | Notes |
|---|---|---|
| 11-22 | Assessment, plan, checkpoint | |
| 11-22 | 029 workspaces | Shared "Speedy Concrete Cutting" workspace (all 313 leads, both users); private workspace per person created at sign-in; 39 functions routed through views; branding per workspace; switcher in sidebar and phone title bar. Live. |
| 11-22 | 030 domain core | Services catalog (15, unit-typed estimate fields), units table, company_accounts (vendor status, relationship, DNC), contact provenance + buying role + DNC + guessed-email flag, project_participants (908 live rows from bidders, winners, owners, stakeholders; kept in step by trigger), tasks (next step mirrored, 9 AM ET due), stages Research → Awarded + Cancelled with relabels; ownership rule fixed for Research. Live. |

## Next
- 031 estimating and money: estimate requests (+ items, idempotency, missing-info), quotes/versions/lines, pricing rules (empty by default), change requests, stage requirements (Quote sent needs a sent version; Awarded needs an award record), awards, jobs + handoff, invoices, payments, attribution, commission agreements + traceable calculation.
- 032 documents: private storage bucket, revisions, signed downloads.
- 033 outreach briefs (grounded drafts, never sent).
- Estimate intake edge function (`estimate-intake`) with per-integration key + idempotency; fixtures only.
- UI: tasks on Today, lead page sections (participants, tasks, quotes, estimate requests, award/job/money), estimate request inbox, quote builder, commission view, workspace settings (branding, services, pricing rules).
- Final report.
