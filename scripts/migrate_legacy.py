"""Turn the backed-up Speedy Florida Pipeline (artifact db export) into portal SQL.

usage: python3 migrate_legacy.py <backup db dir> <snapshots root> <out.sql> <report.json> <links.json>

Idempotent: every insert is keyed (company name key, project external_key, opportunity legacy_id,
activity dedupe_key), so running the output twice adds nothing the second time.
Nothing is invented: fields missing in the source stay NULL and show as unknown in the portal.
"""
import glob, json, os, re, sys
from datetime import datetime, timezone

SRC, SNAPROOT, OUT, REPORT, LINKS_FILE = sys.argv[1:6]

def load(d, c):
    return {os.path.basename(p)[:-5]: json.load(open(p)) for p in glob.glob(f"{d}/{c}/*.json")}

leads, bids = load(SRC, "gcs"), load(SRC, "opps")

# ------------------------------------------------------------------ discovery dates from earlier exports
snaps = []
for d in sorted(glob.glob(f"{SNAPROOT}/db*")):
    if os.path.isdir(f"{d}/gcs"):
        snaps.append((os.path.getmtime(d), d))
snaps.sort()
first_seen = {}
for t, d in snaps:
    for c in ("gcs", "opps"):
        for p in glob.glob(f"{d}/{c}/*.json"):
            k = f"{c}/{os.path.basename(p)[:-5]}"
            first_seen.setdefault(k, t)
earliest_snapshot = snaps[0][0] if snaps else None

# ------------------------------------------------------------------ helpers
def q(v):
    if v is None: return "NULL"
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, (int, float)): return repr(v)
    return "'" + str(v).replace("'", "''") + "'"
def qa(lst):
    lst = [x for x in (lst or []) if x]
    return "ARRAY[" + ",".join(q(x) for x in lst) + "]::text[]" if lst else "'{}'::text[]"
def qj(v):
    return q(json.dumps(v)) + "::jsonb"
def ts(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat() if t else None

REGION = {"Orlando": "Central FL", "Tampa": "Tampa Bay", "Jacksonville": "North FL", "Fort Myers": "Southwest FL",
          "Fort Lauderdale": "South FL", "Panhandle": "Panhandle"}

# place -> (city, county). More specific names first.
PLACES = [
    ("West Palm Beach", "West Palm Beach", "Palm Beach"), ("Jacksonville Beach", "Jacksonville Beach", "Duval"),
    ("Atlantic Beach", "Atlantic Beach", "Duval"), ("NAS Jacksonville", "Jacksonville", "Duval"), ("Mayport", "Jacksonville", "Duval"),
    ("LaVilla", "Jacksonville", "Duval"), ("Jacksonville", "Jacksonville", "Duval"), ("Lake Nona", "Orlando", "Orange"),
    ("South Orange County", None, "Orange"), ("Orlando", "Orlando", "Orange"), ("Kennedy Space Center", "Kennedy Space Center", "Brevard"),
    ("KSC", "Kennedy Space Center", "Brevard"), ("Cape Canaveral", "Cape Canaveral", "Brevard"), ("Patrick SFB", "Patrick SFB", "Brevard"),
    ("Merritt Island", "Merritt Island", "Brevard"), ("Palm Bay", "Palm Bay", "Brevard"), ("Coleman", "Coleman", "Sumter"),
    ("Haines City", "Haines City", "Polk"), ("Fort Meade", "Fort Meade", "Polk"), ("Ormond Beach", "Ormond Beach", "Volusia"),
    ("Dade City", "Dade City", "Pasco"), ("Davis Islands", "Tampa", "Hillsborough"), ("Tampa International Airport", "Tampa", "Hillsborough"),
    ("MacDill", "Tampa", "Hillsborough"), ("Tampa", "Tampa", "Hillsborough"), ("Bay Pines", "Bay Pines", "Pinellas"),
    ("St. Pete Beach", "St. Pete Beach", "Pinellas"), ("Gainesville", "Gainesville", "Alachua"), ("Lake Butler", "Lake Butler", "Union"),
    ("Southwest Florida International Airport", "Fort Myers", "Lee"), ("Fort Myers", "Fort Myers", "Lee"),
    ("Fort Lauderdale", "Fort Lauderdale", "Broward"), ("Lauderhill", "Lauderhill", "Broward"), ("Sunrise", "Sunrise", "Broward"),
    ("Homestead", "Homestead", "Miami-Dade"), ("Perrine", "Miami", "Miami-Dade"), ("Doral", "Doral", "Miami-Dade"), ("Miami", "Miami", "Miami-Dade"),
    ("Jupiter", "Jupiter", "Palm Beach"), ("Northlake Blvd", "Palm Beach Gardens", "Palm Beach"), ("Fort Pierce", "Fort Pierce", "St. Lucie"),
    ("Key West", "Key West", "Monroe"), ("Eglin", "Eglin AFB", "Okaloosa"), ("Tyndall", "Tyndall AFB", "Bay"),
    ("Pensacola", "Pensacola", "Escambia"), ("Tallahassee", "Tallahassee", "Leon"), ("Riverside", "Jacksonville", "Duval"),
]
COUNTIES = ["Miami-Dade", "Broward", "Palm Beach", "Orange", "Osceola", "Seminole", "Brevard", "Volusia", "Lake", "Polk", "Hillsborough",
            "Pinellas", "Pasco", "Sarasota", "Manatee", "Lee", "Collier", "Charlotte", "Hendry", "Highlands", "Hardee", "Duval", "St. Johns",
            "Clay", "Putnam", "Alachua", "Columbia", "Union", "Jackson", "Bay", "Santa Rosa", "Escambia", "Okaloosa", "Gadsden", "Leon",
            "St. Lucie", "Martin", "Monroe", "Sumter", "Marion"]

def place(text):
    t = text or ""
    for key, city, county in PLACES:
        if key.lower() in t.lower():
            return city, county
    for c in COUNTIES:
        if re.search(r"\b" + re.escape(c) + r"\b", t):
            return None, c
    return None, None

MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec"
def first_date(text):
    m = re.search(rf"\b({MONTHS})[a-z]*\.? (\d{{1,2}}),? (\d{{4}})", text or "")
    if not m: return None
    return datetime.strptime(f"{m.group(1)} {m.group(2)} {m.group(3)}", "%b %d %Y").date().isoformat()

def short_firm(f):
    return (f or "").split(" (")[0].strip()

def source_name(url):
    u = (url or "").lower()
    for k, v in [("sam.gov", "SAM.gov"), ("bidletting.fdot.gov", "FDOT letting results"), ("fdot.gov", "FDOT"), ("usaspending", "USAspending.gov"),
                 ("demandstar", "DemandStar"), ("bonfire", "Bonfire"), ("orlandoairports", "GOAA (MCO)"), ("hillsboroughcounty", "Hillsborough County"),
                 ("connectcre", "ConnectCRE"), ("bizjournals", "Business Journal"), ("jaxdailyrecord", "Jax Daily Record"),
                 ("tampabay.com", "Tampa Bay Times"), ("orlandosentinel", "Orlando Sentinel"), ("nasa.gov", "NASA"), ("fldoe", "FL Dept. of Education")]:
        if k in u: return v
    m = re.match(r"https?://(www\.)?([^/]+)", url or "")
    return m.group(2) if m else None

def norm_contacts(lst):
    lst = lst if isinstance(lst, list) else ([lst] if lst else [])
    return [{k: (c.get(k) or None) for k in ("name", "title", "phone", "email", "web")} for c in lst if isinstance(c, dict)]

# ------------------------------------------------------------------ links decided during the Nov 6 review
# Kept in a separate file outside this public repository because the record ids name target contractors.
LINKS = json.load(open(LINKS_FILE))
FOLD = LINKS["fold"]                    # gov record whose follow-up is already the winner's contractor lead
LEAD_PRIMARY = LINKS["lead_primary"]    # lead -> its main gov record
LEAD_ALSO = LINKS["lead_also"]          # lead -> other gov records it also covers
SHARED_PROJECT = {k: key for k in leads for pre, key in LINKS["shared_prefix"].items() if k.startswith(pre)}
STAGE_OVERRIDE = LINKS["stage_override"]
REVIEW = LINKS["review"]

def lead_stage(k, g):
    if k in STAGE_OVERRIDE: return STAGE_OVERRIDE[k], None
    dl, dt = (g.get("dateLabel") or ""), (g.get("dateText") or "").lower()
    if dl == "Low bidder": return "low_bidder", "low_bidder"
    if dl in ("Intent to award", "Selected"): return "intent_to_award", "intended"
    if dl in ("Awarded", "Contract approved") or g.get("awardDate"): return "awarded", "awarded"
    if "bidding trade work" in dt: return "preconstruction", None
    if any(w in dt for w in ("builder not named", "proposed", "planned", "development deal")): return "planning", None
    if any(w in dt for w in ("permit issued", "starts this month", "work starts")): return "preconstruction", None
    if any(w in dt for w in ("under construction", "started", "foundations", "building now", "broke ground", "topped out", "in progress",
                             "enabling work", "finishing", "underway")): return "under_construction", None
    return "unknown", None

def gov_approach(o):
    r, cat = (o.get("role") or "").lower(), o.get("category")
    if r.startswith(("speedy can bid", "bid directly", "direct grinding")): return "bid_direct"
    if cat == "closed": return "track_award"
    if any(w in r for w in ("winner", "selected", "shortlisted", "design-builder later", "award winner", "low bidder")): return "watch"
    if (o.get("level") == "FDOT") and cat == "due": return "plan_holders"
    return "quote_bidders"

def gov_stage(o):
    if o.get("winner"): return "low_bidder" if "apparent low" in o["winner"].lower() else "awarded"
    return {"due": "bidding", "closed": "bid_closed", "upcoming": "upcoming"}.get(o.get("category"), "unknown")

def parse_winner(w):
    if not w: return None
    m = re.match(r"(.+?),\s*\$([\d,\.]+)", w)
    name, amt = (m.group(1), float(m.group(2).replace(",", ""))) if m else (w.split(",")[0], None)
    return {"name": name.strip(), "amount": amt, "status": "low_bidder" if "apparent low" in w.lower() else "awarded"}

def alt_keys(o):
    keys = []
    m = re.search(r"sam\.gov/(?:workspace/contract/)?opp/([0-9a-f]{32})", o.get("url") or "")
    if m: keys.append("sam:" + m.group(1))
    if o.get("level") == "FDOT" and o.get("sol"):
        keys.append("fdot:" + re.sub(r"-R0$", "", o["sol"].upper()))
    return keys

# ------------------------------------------------------------------ build SQL
sql = ["-- generated by migrate_legacy.py on " + datetime.now(timezone.utc).isoformat(), "begin;"]
report = {"leads_in": len(leads), "bids_in": len(bids), "companies": {}, "folded": [], "shared_projects": {}, "review": [], "company_merges": []}

# companies (one row per normalized name; the SQL normalizer decides)
companies = {}
for k, g in leads.items():
    nm = short_firm(g["firm"])
    companies.setdefault(nm, {"kind": "developer" if "(developer" in g["firm"].lower() else "contractor", "hq": g.get("hq"), "web": None, "leads": []})
    companies[nm]["leads"].append(k)
    for c in norm_contacts(g.get("contact")):
        if c.get("web") and not companies[nm]["web"]: companies[nm]["web"] = c["web"]
for nm, c in companies.items():
    sql.append(f"insert into public.companies (name, name_key, kind, hq, website) values ({q(nm)}, private.norm_key({q(nm)}), {q(c['kind'])}, {q(c['hq'])}, {q(c['web'])}) on conflict (name_key) do nothing;")
report["companies"] = {nm: c["leads"] for nm, c in companies.items() if len(c["leads"]) > 1}

# contacts (research contacts, not verified)
for k, g in leads.items():
    nm = short_firm(g["firm"])
    for c in norm_contacts(g.get("contact")):
        if not (c.get("name") or c.get("phone") or c.get("email")): continue
        sql.append(
            "insert into public.contacts (company_id, name, title, phone, email, web, source, source_url) "
            f"select co.id, {q(c.get('name'))}, {q(c.get('title'))}, {q(c.get('phone'))}, {q((c.get('email') or '').lower() or None)}, {q(c.get('web'))}, 'research', {q(g.get('url'))} "
            f"from public.companies co where co.name_key = private.norm_key({q(nm)}) and not exists (select 1 from public.contacts x where x.company_id = co.id "
            f"and coalesce(x.name,'') = {q(c.get('name') or '')} and coalesce(x.phone,'') = {q(c.get('phone') or '')} and coalesce(x.email,'') = {q((c.get('email') or '').lower())});")

def project_insert(key, f):
    cols = ", ".join(f.keys())
    vals = ", ".join(f.values())
    return f"insert into public.projects (external_key, {cols}) values ({q(key)}, {vals}) on conflict (external_key) do nothing;"

def disc(k):
    t = first_seen.get(k)
    if not t: return None, None
    when = datetime.fromtimestamp(t, timezone.utc)
    if t == earliest_snapshot:
        note = f"In the first saved pipeline export ({when.strftime('%b %-d, %Y')}); researched on or before that date."
    else:
        note = f"First appeared in the pipeline export of {when.strftime('%b %-d, %Y')}."
    return ts(t), note

# government projects
for k, o in bids.items():
    when, note = disc("opps/" + k)
    city, county = place(o.get("base"))
    w = parse_winner(o.get("winner"))
    dl = o.get("deadline")
    date_only = bool(o.get("dateOnly")) or bool(dl and dl[11:16] == "23:59")
    f = {
        "alt_keys": qa(alt_keys(o)), "source_id": q("legacy_import"), "title": q(o["title"]), "short_title": q(o.get("short")),
        "owner_name": q(o.get("agency")), "level": q(o.get("level")), "location_text": q(o.get("base")), "city": q(city), "county": q(county),
        "region": q(REGION.get(o.get("office"), "Unknown")), "stage": q(gov_stage(o)),
        "status_text": q(o.get("deadlineNote")), "size_note": q(o.get("magnitude")), "solicitation_no": q(o.get("sol") or None),
        "sol_key": f"private.norm_sol({q(o.get('sol') or None)})", "set_aside": q(o.get("setAside")),
        "deadline": q(dl) + "::timestamptz" if dl else "NULL", "deadline_is_date": q(date_only), "deadline_note": q(o.get("deadlineNote")),
        "discovered_at": q(when) + "::timestamptz" if when else "NULL", "discovered_note": q(note), "imported_at": "now()",
        "source_url": q(o.get("url")), "source_name": q(source_name(o.get("url"))),
        "scope_evidence": f"private.scope_evidence({q(o['title'])})", "services_likely": qa(o.get("services")),
        "pocs": qj(norm_contacts(o.get("poc"))), "legacy": qj({"id": "opps/" + k, **o}),
    }
    if w:
        f.update({"winner_name": q(w["name"]), "winner_amount": q(w["amount"]), "winner_status": q(w["status"]),
                  "winner_as_of": q(dl[:10]) + "::date" if dl else "NULL", "winner_source_url": q(o.get("url"))})
    sql.append(project_insert("legacy:opps/" + k, f))

# lead projects (shared or own)
made_shared = set()
for k, g in leads.items():
    if k in LEAD_PRIMARY: continue
    key = SHARED_PROJECT.get(k, "legacy:gcs/" + k)
    if key in made_shared: continue
    made_shared.add(key)
    when, note = disc("gcs/" + k)
    if key in SHARED_PROJECT.values():
        members = sorted(x for x in SHARED_PROJECT if SHARED_PROJECT[x] == key)
        times = [first_seen.get("gcs/" + m) for m in members if first_seen.get("gcs/" + m)]
        if times: when, note = disc("gcs/" + members[[first_seen.get("gcs/" + m) for m in members].index(min(times))])
        report["shared_projects"][key] = members
    city, county = place(g.get("base"))
    stage, wstatus = lead_stage(k, g)
    status = g.get("dateText") or (("Awarded " + datetime.fromisoformat(g["awardDate"]).strftime("%b %-d, %Y")) if g.get("awardDate") else None)
    amount = g.get("amount") or None
    f = {
        "source_id": q("legacy_import"), "title": q(g["project"]), "owner_name": q(g.get("owner")),
        "level": q({"Private": "Private", "State/local": "State/local", "Federal": "Federal"}.get(g.get("type"), g.get("type"))),
        "location_text": q(g.get("base")), "city": q(city), "county": q(county), "region": q(REGION.get(g.get("office"), "Unknown")),
        "stage": q(stage), "status_text": q(status), "project_value": q(amount), "value_label": q(g.get("amountLabel") or ("Not public" if not amount else None)),
        "discovered_at": q(when) + "::timestamptz" if when else "NULL", "discovered_note": q(note), "imported_at": "now()",
        "source_url": q(g.get("url")), "source_name": q(source_name(g.get("url"))),
        "scope_evidence": f"private.scope_evidence({q(g['project'] + ' ' + (g.get('dateText') or ''))})", "services_likely": qa(g.get("services")),
        "legacy": qj({"id": "gcs/" + k, **g}),
    }
    if key in SHARED_PROJECT.values():
        f["title"] = q("NASA KSC Small Task Order Construction Contract II (multiple-award, 7 holders)")
        f["legacy"] = qj({"ids": ["gcs/" + m for m in report["shared_projects"][key]], "note": "Seven award holders share this contract."})
    if wstatus and key not in SHARED_PROJECT.values():
        f.update({"winner_name": q(short_firm(g["firm"])), "winner_status": q(wstatus),
                  "winner_as_of": q(g.get("awardDate") or first_date(g.get("dateText"))) + "::date" if (g.get("awardDate") or first_date(g.get("dateText"))) else "NULL",
                  "winner_source_url": q(g.get("url")),
                  "winner_company_id": f"(select id from public.companies where name_key = private.norm_key({q(short_firm(g['firm']))}))"})
    elif key in SHARED_PROJECT.values():
        f.update({"winner_status": q("awarded"), "winner_name": q("7 award holders (see linked leads)"),
                  "winner_as_of": q(g.get("awardDate")) + "::date" if g.get("awardDate") else "NULL", "winner_source_url": q(g.get("url"))})
    sql.append(project_insert(key, f))

# opportunities: leads
PRI = {"Hot": 0, "Warm": 1, "Later": 2}
for k, g in sorted(leads.items(), key=lambda kv: (PRI.get(kv[1].get("priority"), 3), list(REGION).index(kv[1]["office"]) if kv[1].get("office") in REGION else 9, kv[0])):
    firm = short_firm(g["firm"])
    pkey = "legacy:opps/" + LEAD_PRIMARY[k] if k in LEAD_PRIMARY else SHARED_PROJECT.get(k, "legacy:gcs/" + k)
    developer = "(developer" in g["firm"].lower() or "builder not named" in (g.get("dateText") or "").lower()
    kind = "private_project" if developer else "contractor_outreach"
    approach = "approach_developer" if developer else "approach_prime"
    title = f"{firm} — {g['project']}"
    nxt = ("Ask the developer who the builder is and get on the bid list." if developer
           else "Call and ask for the estimator or project manager. Offer cutting, coring, GPR and removal.")
    review = REVIEW.get(k)
    sql.append(
        "insert into public.opportunities (legacy_id, legacy_priority, project_id, company_id, kind, approach, title, next_action, services, speedy_scope, "
        "needs_review, review_kind, review_reason, legacy) "
        f"values ({q('gcs/' + k)}, {q(g.get('priority'))}, (select id from public.projects where external_key = {q(pkey)}), "
        f"(select id from public.companies where name_key = private.norm_key({q(firm)})), {q(kind)}, {q(approach)}, {q(title)}, {q(nxt)}, "
        f"{qa(g.get('services'))}, {q(g.get('pitch'))}, {q(bool(review))}, {q('legacy' if review else None)}, {q(review)}, {qj({'id': 'gcs/' + k, **g})}) "
        "on conflict (legacy_id) do nothing;")
    for extra in LEAD_ALSO.get(k, []):
        sql.append("insert into public.opportunity_projects (opportunity_id, project_id, relation) "
                   f"select o.id, p.id, 'also covers' from public.opportunities o, public.projects p where o.legacy_id = {q('gcs/' + k)} "
                   f"and p.external_key = {q('legacy:opps/' + extra)} on conflict do nothing;")
    if review: report["review"].append({"legacy_id": "gcs/" + k, "reason": review})

# opportunities: government bids (folded ones become the project of the matching lead)
for k, o in sorted(bids.items(), key=lambda kv: (kv[1].get("deadline") or "9999", kv[0])):
    if k in FOLD:
        report["folded"].append({"bid": "opps/" + k, "into_lead": "gcs/" + FOLD[k], "why": "Winner known; the contractor lead is the follow-up for the same job"})
        continue
    approach = gov_approach(o)
    nxt = (o.get("nextAction") or "").replace("(Sales Leads)", "(see the linked outreach lead)").replace("(Sales Leads tab)", "(see the linked outreach lead)")
    note = "; ".join(x for x in [o.get("role"), o.get("setAside")] if x)
    sql.append(
        "insert into public.opportunities (legacy_id, project_id, kind, approach, approach_note, title, next_action, services, speedy_scope, legacy) "
        f"values ({q('opps/' + k)}, (select id from public.projects where external_key = {q('legacy:opps/' + k)}), 'gov_bid', {q(approach)}, {q(note)}, "
        f"{q(o.get('short') or o['title'])}, {q(nxt or None)}, {qa(o.get('services'))}, {q(o.get('fit'))}, {qj({'id': 'opps/' + k, **o})}) "
        "on conflict (legacy_id) do nothing;")

# one timeline entry per imported record, plus any notes that existed
for k, g in leads.items():
    sql.append("insert into public.activities (opportunity_id, company_id, kind, body, data, dedupe_key) "
               f"select id, company_id, 'import', {q('Imported from the Speedy Florida Pipeline (record gcs/' + k + '). Original priority: ' + (g.get('priority') or 'none') + '. Stage then: ' + (g.get('stage') or 'none') + '.')}, "
               f"{qj({'legacy_id': 'gcs/' + k})}, {q('legacy:gcs/' + k)} from public.opportunities where legacy_id = {q('gcs/' + k)} on conflict (dedupe_key) do nothing;")
    if (g.get("notes") or "").strip():
        sql.append("insert into public.activities (opportunity_id, company_id, kind, body, dedupe_key) "
                   f"select id, company_id, 'note', {q('Note from the original pipeline: ' + g['notes'].strip())}, {q('legacy-note:gcs/' + k)} "
                   f"from public.opportunities where legacy_id = {q('gcs/' + k)} on conflict (dedupe_key) do nothing;")
for k, o in bids.items():
    target = "gcs/" + FOLD[k] if k in FOLD else "opps/" + k
    body = (f"Government record opps/{k} ({o.get('sol') or 'no solicitation #'}) merged here: the winner is this contractor."
            if k in FOLD else f"Imported from the Speedy Florida Pipeline (record opps/{k}). Stage then: {o.get('stage') or 'none'}.")
    sql.append("insert into public.activities (opportunity_id, company_id, kind, body, data, dedupe_key) "
               f"select id, company_id, 'import', {q(body)}, {qj({'legacy_id': 'opps/' + k})}, {q('legacy:opps/' + k)} "
               f"from public.opportunities where legacy_id = {q(target)} on conflict (dedupe_key) do nothing;")
    if (o.get("notes") or "").strip():
        sql.append("insert into public.activities (opportunity_id, kind, body, dedupe_key) "
                   f"select id, 'note', {q('Note from the original pipeline: ' + o['notes'].strip())}, {q('legacy-note:opps/' + k)} "
                   f"from public.opportunities where legacy_id = {q(target)} on conflict (dedupe_key) do nothing;")

sql.append("update public.sources set last_run_at = now(), last_success_at = now(), last_status = 'success' where id = 'legacy_import';")
sql.append("select private.rescore();")
sql.append("select private.snapshot_pool();")
sql.append("commit;")
open(OUT, "w").write("\n".join(sql) + "\n")
report["expected"] = {"opportunities": len(leads) + len(bids) - len(FOLD),
                      "projects": len(bids) + len([1 for k in leads if k not in LEAD_PRIMARY and k not in SHARED_PROJECT]) + len(set(SHARED_PROJECT.values()))}
json.dump(report, open(REPORT, "w"), indent=1)
print(json.dumps(report["expected"]), "statements:", len(sql))
