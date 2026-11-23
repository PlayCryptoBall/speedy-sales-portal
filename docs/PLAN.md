# Concrete cutting CRM: assessment and plan

Started 2026-11-22. This file is the plan; `docs/PROGRESS.md` is the running log for picking work back up.

## 1. What exists (inspected 2026-11-22)

| Area | State |
|---|---|
| Stack | Plain HTML/CSS/JS in `web/` (GitHub Pages), Supabase Postgres (RLS deny-all, every action is a SECURITY DEFINER RPC that checks the caller's active profile and role), edge functions `refresh` (discovery) and `admin-users`, pg_cron scheduler. No build step. Keep it. |
| Data | 313 opportunities, 524 projects, 147 companies, 110 contacts, 463 activities, 2 users (manager + one salesperson), 17 sources, 192 refresh runs. |
| Works well | Discovery from SAM.gov, FDOT lettings and bid tabulations (pay-item quantities), USAspending, Orlando and Miami-Dade permits, Orlando planning, Orange development cases and land sales; idempotent upsert with alt keys, change log, cross-source merge; evidence with documented/inferred confidence; explainable 0–100 score with gated classes; source health, coverage registry, retries, failure alerts; claim/release/assign with expiry; activity log; duplicate review; exports. 98 automated tests (48 workflow, 29 parser, 23 browser) all passing. |
| Gaps against the new spec | One employer hardcoded ("Speedy" in UI text, `terms.ts`, scoring copy). No workspaces: every active user sees every lead. Bidders live in a JSON array on the project, the awarded contractor in project columns; there is no participants table. No tasks (only one `next_action` per lead). No documents or storage. No estimate requests, quote versions, line items or pricing rules (only `quote_amount` on the lead). No awards, jobs, invoices or payments. No attribution or commission records. No outreach drafts. Contacts have a single `verified` flag; no do-not-contact. Stages stop at won/lost; job, invoice and payment status do not exist. |
| Estimate app | Not in any connected repository (only this portal, `dank-directory`, and an old `CRM` repo are reachable). Integration is built against labeled fixtures; nothing is presented as connected. |
| Scheduling | pg_cron in Supabase runs the morning discovery at 4:15 AM America/New_York (computed in the database, so DST is handled), independent of any computer. |

## 2. Design decisions

- **Workspaces.** A workspace is a company the user sells for (branding, services, territories, pricing rules). Existing records go into the shared "Speedy Concrete Cutting" workspace (both users are members). The owner also gets a private "Personal prospecting" workspace. Public intelligence (sources, projects, the company directory built from public records) is shared reference data. Everything a person pursues (opportunities, activities, tasks, contacts they add, documents, estimate requests, quotes, awards, jobs, invoices, payments, attribution, commission records, outreach drafts) carries `workspace_id` and is only readable by members. Enforced in the database: existing RPCs read pursuit tables through `private.v_*` views filtered by membership, and new RPCs check membership on every row they touch.
- **Project vs pursuit.** `projects` stays the job identity (one row per real project). `project_participants` records every company on it (owner, bidding GCs, low bidder, awarded GC, subs, architect, engineer) with role, status, source and evidence. Opportunities are the pursuit of one buyer for one scope; project value is never summed across bidder opportunities.
- **Money is layered and never inferred from budgets.** Construction value (project) → scope estimate (only from pricing rules or quantities, assumptions shown) → quote versions → award → jobs → invoices → payments. Commission calculations are scenarios unless an agreement record exists.
- **Stages.** Opportunity pipeline: Research, Contact confirmed, Contacted, Scope discussion, Drawings requested, Site visit, Ready for estimating, Quote preparation, Quote sent, Follow up, Awarded; outcomes Lost, Deferred, Disqualified, Cancelled with reasons. Scheduling → Paid lives on jobs and invoices. Existing stage keys keep working (mapped labels), so no record changes stage silently.
- **Drafts never send.** Outreach drafts are stored and copied; there is no sending path. Any future sender requires explicit configuration, limits and suppression checks.

## 3. Phases

1. **Checkpoint + assessment** (this file, backup schema `backup_20261122`, code checkpoint commit `3049058`).
2. **Workspaces and access** (migration 029): workspaces, members, branding settings, workspace scoping of pursuit tables, cross-workspace denial tests.
3. **Core domain** (030): services catalog, project participants (backfilled from bidders/winner/stakeholders), tasks (backfilled from next actions), contact verification levels and do-not-contact, documents and revisions (private storage), stage requirements.
4. **Estimating and money** (031): estimate requests (service-specific fields with explicit units, idempotency), quotes, versions, line items, pricing rules, change requests, awards, jobs and handoffs, invoices, payments, attribution, commission agreements and calculations.
5. **Outreach briefs** (032): grounded drafts from the record; inferred scope phrased as a question; never sent.
6. **Estimate intake endpoint**: edge function with per-integration key and idempotency, tested with fixtures.
7. **Interface**: daily workspace (why each item is shown), tasks, quote builder, estimate requests, award and job handoff, money and commission views, workspace switcher, branding.
8. **Verification**: end-to-end workflow tests listed in the spec, mobile screenshots, totals reconciliation, timezone checks; final report.
