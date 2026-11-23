# Estimate request intake (integration contract)

Status: **built and tested with fixtures; not connected to any app.** The estimate request app is not in a repository this
project can see, so nothing here assumes how it works today. To connect it, create a key in the portal, give the key to the app
and point it at the endpoint below.

## Endpoint

`POST https://<project>.supabase.co/functions/v1/estimate-intake`

| Header | Value |
|---|---|
| `x-integration-key` | `erk_` + 48 hex characters. Created by a workspace owner or manager (`create_integration`); shown once, stored only as a SHA-256 hash. |
| `content-type` | `application/json` |

The key decides the workspace. Browser calls must come from an origin listed on the integration (`set_integration_origins`);
calls with no `Origin` header are treated as server-to-server. **A key placed in a public web page is visible to anyone**, so for a
public contractor form prefer a small server-side relay (for example a Netlify function) that holds the key; the origin list,
rate limit (30 accepted or rejected requests an hour by default) and idempotency are the protections when the key is in the browser.

## Body

```json
{
  "idempotency_key": "app-generated unique id per submission (required; resubmitting returns the first result)",
  "is_fixture": false,
  "company": { "name": "required" },
  "contact": { "name": "", "title": "", "phone": "", "email": "" },
  "job": { "address": "", "city": "", "county": "Orange", "requested_date": "YYYY-MM-DD", "requested_date_flexible": true,
           "site_contact": { "name": "", "phone": "" } },
  "conditions": { "working_hours": "normal|nights|weekends|any|unknown", "access": "", "work_area": "",
                  "power": "yes|no|unknown", "water": "yes|no|unknown", "removal": "yes|no|unknown", "disposal": "" },
  "items": [ { "service": "<service key>", "answers": { "<field key>": { "value": 12, "unit": "ea" } }, "notes": "" } ],
  "notes": "",
  "attachments": [ { "filename": "slab.jpg", "mime": "image/jpeg", "base64": "..." } ]
}
```

- **Services and fields** come from the workspace's catalog (`services_catalog`): each service lists its fields with a
  `dimension` and the `units` it accepts. Only that service's fields are asked, so a coring request never asks for trench width.
- **Units are required** on every measured answer. A bare number, or a unit the field does not allow (`"ft"` for a core
  diameter), is refused with `unit_required` or `bad_unit`. Values are stored as given and also converted to base units
  (inches, square feet, cubic yards, each) beside the original.
- **Files**: up to 5, 8 MB each; PDF, images (JPEG, PNG, HEIC, WebP, TIFF), Word, Excel, CSV, text and DWG. Stored in the
  private `documents` bucket under the workspace's folder.

## Response

`201` new, `200` duplicate (same `idempotency_key`):

```json
{ "ok": true, "duplicate": false, "ref": "ER-1004", "status": "missing_info|ready",
  "missing": [ { "scope": "Core drilling", "field": "core_depth", "label": "Depth (thickness drilled)" } ],
  "files": [ { "filename": "slab.jpg", "ok": true } ] }
```

Errors: `401 unauthorized` (bad or turned-off key), `403 origin_not_allowed`, `429 rate_limited`, `400 invalid` with
`reason`/`detail` (for example `unit_required: Hole diameter needs a value and a unit`), `413 too_large`.
The app learns nothing about other records.

## What happens on submit

1. The company is matched by normalized name (created if new); the contact is matched by email or phone within that company
   (created as **unverified**, details marked "given by the requester").
2. The request is stored with every item, the raw payload (as data only) and a list of what is missing before pricing.
3. A project and an inbound lead are created and assigned to the workspace's intake owner (or its first owner/manager); an
   **estimating task** lists the missing items.
4. Attached files are stored and confirmed; the "photos or drawings" item clears when they arrive.

A request is what the customer asked for. It is **not** an approved estimate, a confirmed booking or an engineering assessment;
the portal shows that on every request, and quotes built from it flag the customer's quantities until someone verifies them.

## Testing without the app

`tests/fixtures/estimate_request_core.json` is a labelled fixture (`is_fixture: true`). Fixture requests are hidden from the
normal request list. `tests/workflows.test.mjs` covers validation, idempotency, key handling, rate limiting and file
registration against it.
