// Scheduled and manual source refreshes. Runs on Supabase's servers (pg_cron calls it; managers can also start it).
// It updates project FACTS only through the refresh_* database functions, which never touch sales work.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import {
  classify, FDOT_BASE, FDOT_DISTRICTS, fdotPayload, groupNotices, isNoticeId, morePages, normalizeDetails, normalizeOfficial, normalizeOrlandoPermit,
  normalizeSgs, normalizeUsa, groupPermits, parseFdotList, parseFdotReport, permitPayload, permitSections, SAM_SEARCH, samFacts, samPayload, type SamNotice,
  USA_NAICS, usaPayload, usaSearchBody,
} from './lib.ts';
import { DEFAULT_TERMS, type Term } from './terms.ts';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET') || '';
const SAM_API_KEY = Deno.env.get('SAM_API_KEY') || '';
const UA = 'SpeedyConcreteCuttingSalesPortal/1.0 (+https://speedycon.com)';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' };
const db = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

class Run {
  log: string[] = []; counts = { fetched: 0, discovered: 0, updated: 0, merged: 0, flagged: 0, unchanged: 0, errors: 0, examined: 0, relevant: 0, low: 0 };
  terms: Term[] = DEFAULT_TERMS;
  requests = 0; last = 0; started = Date.now();
  constructor(public id: number, public gapMs: number, public maxRequests: number, public budgetMs = 110000) {}
  // Edge functions stop after about 150 s, so each run stops taking new work after its time budget and leaves the rest for the next run.
  timeUp() { return Date.now() - this.started > this.budgetMs; }
  note(s: string) { this.log.push(`${new Date().toISOString().slice(11, 19)} ${s}`); if (this.log.length > 400) this.log.splice(1, 1); }
  // polite fetch: spacing between requests, a per-run cap, 3 tries with backoff on network errors, 429 and 5xx
  async get(url: string, accept = 'text/html', body?: unknown) {
    if (this.requests >= this.maxRequests) throw new Error(`request cap of ${this.maxRequests} reached for this run`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now(); this.requests++;
      try {
        const res = await fetch(url, body === undefined
          ? { headers: { 'User-Agent': UA, Accept: accept }, signal: AbortSignal.timeout(25000) }
          : { method: 'POST', headers: { 'User-Agent': UA, Accept: accept, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) { const e = new Error(`HTTP ${res.status}`); (e as any).fatal = true; throw e; }
        return accept.includes('json') ? await res.json() : await res.text();
      } catch (e) {
        const msg = (e as Error).message;
        this.note(`GET ${url.slice(0, 140)} failed (try ${attempt}/3): ${msg}`);
        if ((e as any).fatal || attempt === 3) throw e;
        await sleep(attempt * 4000);
      }
    }
  }
  async upsert(p: Record<string, unknown>) {
    const { data, error } = await db.rpc('refresh_upsert_project', { p_run: this.id, p });
    if (error) { this.counts.errors++; this.note(`save ${p.external_key} failed: ${error.message}`); return null; }
    this.counts.fetched++;
    if (data.action === 'discovered') this.counts.discovered++;
    else if (data.action === 'updated') this.counts.updated++;
    else this.counts.unchanged++;
    if (data.merged) this.counts.merged++;
    if (data.duplicate_of) this.note(`${p.external_key}: possible duplicate of an existing project, sent to review`);
    this.counts.flagged += data.flagged || 0;
    if (data.material?.length) this.note(`${p.external_key}: ${data.material.join('; ')}`);
    return data;
  }
}

async function tracked(source: string) {
  const { data, error } = await db.rpc('refresh_tracked_keys', { p_source: source });
  if (error) throw new Error('could not load tracked projects: ' + error.message);
  return data as { external_key: string; alt_keys: string[]; solicitation_no: string | null; stage: string; level: string }[];
}

// ---------------------------------------------------------------- FDOT and Turnpike preliminary letting results
async function runFdot(run: Run, cfg: any) {
  const lookback = cfg.lookback_days ?? 30;
  // Statewide: the home regions use a lower bar; the rest of Florida needs a bigger job to be worth a review.
  const minAmt = cfg.untracked_min_amount ?? 1_000_000;
  const regions: string[] = cfg.untracked_regions ?? ['Central FL', 'Tampa Bay'];
  const statewideMin = cfg.statewide_min_amount ?? 3_000_000;
  const since = new Date(Date.now() - lookback * 86400000).toISOString().slice(0, 10);
  const mine = await tracked('fdot_lettings');
  const keys = new Set<string>();
  for (const t of mine) { keys.add(t.external_key); (t.alt_keys || []).forEach(k => keys.add(k)); }
  let reports = 0, skippedUntracked = 0;
  for (const d of FDOT_DISTRICTS) {
    if (run.timeUp()) { run.note(`time budget reached at district ${d}`); break; }
    let list;
    try { list = parseFdotList(await run.get(`${FDOT_BASE}/LettingResults?districtID=${d}`)); }
    catch (e) { run.counts.errors++; run.note(`district ${d} list failed: ${(e as Error).message}`); continue; }
    const recent = list.filter(l => l.iso >= since);
    run.note(`district ${d}: ${list.length} lettings listed, ${recent.length} since ${since}`);
    for (const l of recent) {
      let rep;
      try { rep = parseFdotReport(await run.get(l.url)); reports++; }
      catch (e) { run.counts.errors++; run.note(`report ${l.id} failed: ${(e as Error).message}`); continue; }
      if (!rep.complete) { run.note(`report ${l.id} (${l.date}): ${rep.contracts.length ? 'letting in progress or no bids posted' : 'no contracts listed'}, skipped until results post`); continue; }
      for (const c of rep.contracts) {
        run.counts.examined++;
        const key = `fdot:${c.contract.replace(/-R0$/, '')}`;
        const isTracked = keys.has(key);
        if (!isTracked) {
          const low = c.bidders[0]?.amount ?? 0;
          const p = fdotPayload(c, l, d, false);
          if (low < (regions.includes(String(p.region)) ? minAmt : statewideMin)) { skippedUntracked++; run.counts.low++; continue; }
          run.counts.relevant++;
          await run.upsert(p);
        } else {
          await run.upsert(fdotPayload(c, l, d, true));
        }
      }
    }
  }
  run.note(`${reports} reports read; ${skippedUntracked} untracked contracts skipped (low bid under $${minAmt.toLocaleString()} in ${regions.join(', ')}, or under $${statewideMin.toLocaleString()} elsewhere)`);
}

// ---------------------------------------------------------------- SAM.gov
async function samSearch(run: Run, params: Record<string, string>, maxPages = 1): Promise<SamNotice[]> {
  const out: SamNotice[] = [];
  if (SAM_API_KEY) {
    // official API (free key from a SAM.gov account)
    const to = new Date(), from = new Date(Date.now() - 30 * 86400000);
    const f = (x: Date) => `${String(x.getMonth() + 1).padStart(2, '0')}/${String(x.getDate()).padStart(2, '0')}/${x.getFullYear()}`;
    for (let page = 0; ; page++) {
      const qs = new URLSearchParams({ api_key: SAM_API_KEY, postedFrom: f(from), postedTo: f(to), limit: '100', offset: String(page * 100), state: 'FL',
        ...(params.q ? { title: params.q.replace(/"/g, '') } : {}), ...(params.sol ? { solnum: params.sol } : {}) });
      const j = await run.get(`https://api.sam.gov/opportunities/v2/search?${qs}`, 'application/json');
      const got = (j.opportunitiesData || []).map(normalizeOfficial);
      out.push(...got);
      if (!morePages(got.length, 100, page, maxPages, j.totalRecords)) break;
    }
    return out;
  }
  const size = Number(params.size || '50');
  for (let page = 0; ; page++) {
    const qs = new URLSearchParams({ index: 'opp', page: String(page), size: String(size), mode: 'search', sort: '-modifiedDate', ...params });
    qs.delete('sol'); qs.set('page', String(page));
    const j = await run.get(`${SAM_SEARCH}?${qs}`, 'application/hal+json');
    const got = ((j?._embedded?.results) || []).map(normalizeSgs);
    out.push(...got);
    if (!morePages(got.length, size, page, maxPages, j?.page?.totalElements)) break;
  }
  return out;
}

async function samDetails(run: Run, id: string) {
  if (SAM_API_KEY) return null;
  try { return await run.get(`https://sam.gov/api/prod/opps/v2/opportunities/${id.toLowerCase()}`, 'application/hal+json'); }
  catch (e) { run.note(`details ${id} unavailable: ${(e as Error).message}`); return null; }
}

async function runSam(run: Run, cfg: any) {
  const mine = await tracked('sam_gov');
  const trackedSols = new Map<string, typeof mine[number]>();
  for (const t of mine) if (t.solicitation_no) trackedSols.set(t.solicitation_no.toUpperCase().replace(/[^A-Z0-9-]/g, ''), t);
  // 1. re-check every tracked solicitation (deadline changes, cancellations, awards)
  let checked = 0;
  const failedKeys: string[] = [];
  for (const [sol, t] of trackedSols) {
    if (checked >= (cfg.max_tracked_checks ?? 40) || run.timeUp()) { run.note(`tracked check cap reached; ${trackedSols.size - checked} left for the next run`); break; }
    checked++;
    let notices: SamNotice[];
    if (isNoticeId(sol)) {
      // no solicitation number on this notice: read it by its notice id instead of searching
      const det = await samDetails(run, sol);
      const one = normalizeDetails(det);
      if (!one) { failedKeys.push(t.external_key); run.note(`${sol}: notice could not be read by id`); continue; }
      notices = [one];
      const facts = samFacts(notices, det);
      const p = samPayload(sol, notices, facts, true, run.terms);
      p.external_key = t.external_key;
      await run.upsert(p);
      continue;
    }
    try { notices = await samSearch(run, { q: `"${sol}"`, size: '10', sol }); }
    catch (e) { run.counts.errors++; failedKeys.push(t.external_key); run.note(`check ${sol} failed: ${(e as Error).message}`); continue; }
    notices = notices.filter(n => [n.sol, n.originalSol].some(s => (s || '').toUpperCase().replace(/[^A-Z0-9-]/g, '') === sol));
    if (!notices.length) { run.note(`${sol}: no SAM.gov notices found by solicitation number`); failedKeys.push(t.external_key); continue; }
    const g = groupNotices(notices);
    const group = [...g.values()].flat().sort((a, b) => String(b.published).localeCompare(String(a.published)));
    const facts = samFacts(group, null);
    const p = samPayload(sol, group, facts, true, run.terms);
    p.external_key = t.external_key;               // keep the existing record's key; new notice ids go in alt_keys
    await run.upsert(p);
  }
  if (failedKeys.length) await db.rpc('refresh_mark_failed', { p_keys: failedKeys });
  // 2. discover new Florida construction work (every page, up to the page cap)
  const queries: string[] = cfg.queries ?? ['construction', 'demolition', 'concrete', 'renovation', 'repair', 'paving', 'design-build',
    'bridge', 'pavement', 'runway', 'seawall', 'lift station', 'saw cut', 'core drilling'];
  const maxPages = cfg.max_pages ?? 4;
  const seen = new Map<string, SamNotice>();
  for (const q of queries) {
    if (run.timeUp()) { run.note('time budget reached before all searches ran'); break; }
    try {
      const list = await samSearch(run, { q, is_active: 'true', pop_state: 'FL', size: '50' }, maxPages);
      list.forEach(n => seen.set(n.id, n));
      run.note(`search "${q}": ${list.length} active Florida notices`);
    } catch (e) { run.counts.errors++; run.note(`search "${q}" failed: ${(e as Error).message}`); }
  }
  const groups = groupNotices([...seen.values()]);
  let newOnes = 0, low = 0;
  const maxNew = cfg.max_new_per_run ?? 25;
  for (const [key, notices] of groups) {
    if (trackedSols.has(key)) continue;          // already handled above
    run.counts.examined++;
    const quick = classify([{ field: 'title', text: notices.map(n => n.title).join(' | ') }, { field: 'description', text: notices.map(n => n.snippet).join(' ') }], run.terms);
    if (quick.relevance === 'low') { low++; run.counts.low++; continue; }
    if (run.timeUp()) { run.note('time budget reached; remaining procurements wait for the next run'); break; }
    if (newOnes >= maxNew) { run.note(`new-item cap of ${maxNew} reached; the rest wait for the next run`); break; }
    const details = await samDetails(run, notices[0].id);
    const facts = samFacts(notices, details);
    const p = samPayload(key, notices, facts, false, run.terms);
    if (p.relevance === 'low') { low++; run.counts.low++; continue; }
    newOnes++; run.counts.relevant++;
    await run.upsert(p);
  }
  run.note(`${groups.size} procurements seen; ${low} not relevant to Speedy's services; ${newOnes} new or updated`);
}

// ---------------------------------------------------------------- USAspending.gov: new federal construction awards in Florida
async function runUsaspending(run: Run, cfg: any) {
  const days = cfg.lookback_days ?? 60;
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const minAmount = cfg.min_amount ?? 250_000;
  const maxNew = cfg.max_new_per_run ?? 30;
  const known = new Set<string>();
  for (const t of await tracked('usaspending_awards')) { known.add(t.external_key); (t.alt_keys || []).forEach(k => known.add(k)); }
  let newOnes = 0;
  for (let page = 1; page <= (cfg.max_pages ?? 3); page++) {
    const j = await run.get('https://api.usaspending.gov/api/v2/search/spending_by_award/', 'application/json',
      usaSearchBody(from, to, cfg.naics ?? USA_NAICS, page));
    const rows = (j?.results || []).map(normalizeUsa);
    run.note(`page ${page}: ${rows.length} new Florida construction awards since ${from}`);
    for (const a of rows) {
      if (run.timeUp()) { run.note('time budget reached; remaining awards wait for the next run'); break; }
      run.counts.examined++;
      if ((a.amount ?? 0) < minAmount) { run.counts.low++; continue; }
      const cls = classify([{ field: 'award description', text: a.description, doc: `USAspending award ${a.piid}`, url: `https://www.usaspending.gov/award/${a.id}` }],
        run.terms, { value: a.amount });
      if (cls.relevance === 'low') { run.counts.low++; continue; }
      run.counts.relevant++;
      if (known.has(`usaspending:${a.id}`)) { await run.upsert(usaPayload(a, null, cls, true)); continue; }
      if (newOnes >= maxNew) { run.note(`new-item cap of ${maxNew} reached; the rest wait for the next run`); continue; }
      let detail = null;
      try { detail = await run.get(`https://api.usaspending.gov/api/v2/awards/${encodeURIComponent(a.id)}/`, 'application/json'); }
      catch (e) { run.note(`award ${a.piid} details unavailable: ${(e as Error).message}`); }
      newOnes++;
      await run.upsert(usaPayload(a, detail, cls));
    }
    if (!j?.page_metadata?.hasNext) break;
  }
  run.note(`${newOnes} new awards saved (minimum $${minAmount.toLocaleString()})`);
}

// ---------------------------------------------------------------- City building permits (Socrata open data)
async function runPermits(run: Run, cfg: any, sourceId: string) {
  const days = cfg.lookback_days ?? 45;
  const min = cfg.min_value ?? 500_000;
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const base = cfg.dataset ?? 'https://data.cityoforlando.net/resource/ryhf-m453.json';
  const where = `plan_review_type like 'Commercial%' AND application_type='Building Permit' AND estimated_cost >= ${Number(min)} ` +
    `AND processed_date > '${since}' AND worktype in ('Alteration','Addition','Repair','Demolition','Demo','New')`;
  // Built by hand: the city's firewall rejects the same query when spaces are sent as "+" (URLSearchParams style).
  const qs = `$where=${encodeURIComponent(where)}&$order=${encodeURIComponent('processed_date DESC')}&$limit=${Number(cfg.limit ?? 300)}`;
  const rows = (await run.get(`${base}?${qs}`, 'application/json')) as any[];
  run.note(`${rows.length} commercial permits over $${Number(min).toLocaleString()} since ${since}`);
  const maxNew = cfg.max_new_per_run ?? 40;
  const dataset = cfg.public_url ?? 'https://data.cityoforlando.net/resource/ryhf-m453.json';
  const permits = rows.map(normalizeOrlandoPermit).filter(x => x.number);
  run.counts.examined += permits.length;
  let newOnes = 0;
  for (const group of groupPermits(permits)) {
    const x = [...group].sort((a, b) => (b.value || 0) - (a.value || 0))[0];
    const sections = group.flatMap(g => permitSections(g, `${dataset}?permit_number=${encodeURIComponent(g.number)}`));
    const cls = classify(sections, run.terms, { value: group.reduce((t, g) => t + (g.value || 0), 0) });
    if (cls.relevance === 'low') { run.counts.low += group.length; continue; }
    run.counts.relevant += group.length;
    if (newOnes >= maxNew) { run.note(`new-item cap of ${maxNew} reached; the rest wait for the next run`); break; }
    newOnes++;
    const first = group[0];
    const p = permitPayload({ ...x, number: first.number }, cls, { city: cfg.city ?? 'Orlando', county: cfg.county ?? 'Orange', source_id: sourceId,
      key_prefix: sourceId.split('_')[0], dataset_url: dataset }, group);
    if (group.length > 1) run.note(`${group.length} permits grouped as one lead: ${group.map(g => g.number).join(', ')}`);
    await run.upsert(p);
  }
}

async function loadTerms(run: Run) {
  const { data, error } = await db.rpc('discovery_terms');
  if (error || !Array.isArray(data) || !data.length) { run.note(`using built-in search terms (${error?.message || 'none saved'})`); return; }
  run.terms = data as Term[];
}

// ---------------------------------------------------------------- orchestration
async function runSource(source: string, trigger: string, user: string | null, attempt = 1) {
  const { data: src } = await db.from('sources').select('*').eq('id', source).single();
  if (!src || !src.enabled) return { source, skipped: 'disabled or unknown' };
  const { data: runId, error } = await db.rpc('refresh_start_run', { p_source: source, p_trigger: trigger, p_user: user, p_attempt: attempt });
  if (error) throw new Error(error.message);
  const cfg = src.config || {};
  const run = new Run(runId, source === 'fdot_lettings' ? (cfg.gap_ms ?? 1500) : (cfg.gap_ms ?? 900), cfg.max_requests ?? 160, cfg.time_budget_ms ?? 110000);
  run.note(`start ${source} (${trigger}, attempt ${attempt})`);
  await loadTerms(run);
  let status = 'success', err: string | null = null;
  try {
    if (source === 'fdot_lettings') await runFdot(run, cfg);
    else if (source === 'sam_gov') await runSam(run, cfg);
    else if (source === 'usaspending_awards') await runUsaspending(run, cfg);
    else if (source.endsWith('_permits')) await runPermits(run, cfg, source);
    else throw new Error('no automated job for this source');
    if (run.counts.errors > 0) status = run.counts.fetched > 0 ? 'partial' : 'failed';
    if (status === 'failed') err = run.log.filter(l => /failed/.test(l)).slice(-1)[0] || 'every request failed';
  } catch (e) {
    status = 'failed'; err = (e as Error).message; run.note(`stopped: ${err}`);
  }
  run.note(`done: ${status} ${JSON.stringify(run.counts)}`);
  await db.rpc('refresh_finish_run', { p_run: runId, p_status: status, p_counts: run.counts, p_log: run.log, p_error: err });
  return { source, run_id: runId, status, counts: run.counts, error: err };
}

async function retryFailed() {
  const { data } = await db.from('sources').select('id, consecutive_failures, last_run_at, last_status')
    .eq('kind', 'automated').eq('enabled', true).eq('last_status', 'failed').lt('consecutive_failures', 4);
  const out = [];
  for (const s of data || []) {
    if (s.last_run_at && Date.now() - new Date(s.last_run_at).getTime() < 45 * 60000) continue;
    out.push(await runSource(s.id, 'retry', null, s.consecutive_failures + 1));
  }
  return out;
}

async function authorize(req: Request): Promise<{ ok: boolean; user: string | null; why?: string }> {
  const secret = req.headers.get('x-cron-secret');
  if (secret) {
    // the scheduler's secret lives in the database vault (or optionally in the CRON_SECRET env var)
    if (CRON_SECRET && secret === CRON_SECRET) return { ok: true, user: null };
    const { data } = await db.rpc('check_cron_secret', { p_secret: secret });
    return data === true ? { ok: true, user: null } : { ok: false, user: null, why: 'Scheduler secret not accepted.' };
  }
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, user: null, why: 'Sign in as a manager to run a refresh.' };
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return { ok: false, user: null, why: 'Session expired. Sign in again.' };
  const { data: p } = await db.from('profiles').select('role, active').eq('id', user.id).single();
  if (!p?.active || p.role !== 'manager') return { ok: false, user: null, why: 'Only managers can run refreshes.' };
  return { ok: true, user: user.id };
}

// ---------------------------------------------------------------- missed-opportunity check: read one record and classify it
// Managers paste a SAM.gov notice, a USAspending award or an Orlando permit. Nothing is saved unless they choose Import.
async function probe(input: string, doImport: boolean, user: string) {
  const run = new Run(0, 300, 12, 60000);
  await loadTerms(run);
  const skip: string[] = [];
  let source = '', p: Record<string, unknown> | null = null;
  const sam = input.match(/sam\.gov\/.*?([0-9a-f]{32})/i) || (/^[0-9a-f]{32}$/i.test(input.trim()) ? [input, input.trim()] : null);
  const usa = input.match(/usaspending\.gov\/award\/([^/?#\s]+)/i);
  const permit = input.match(/\b([A-Z]{3}\d{4}-\d{3,6})\b/i);
  if (sam) {
    source = 'sam_gov';
    const det = await run.get(`https://sam.gov/api/prod/opps/v2/opportunities/${sam[1].toLowerCase()}`, 'application/hal+json');
    const n = normalizeDetails(det);
    if (!n) throw new Error('SAM.gov did not return that notice');
    const facts = samFacts([n], det);
    p = samPayload(n.sol || sam[1], [n], facts, false, run.terms);
    const st = det?.data2?.placeOfPerformance?.state?.code;
    if (st && st !== 'FL') skip.push(`Place of performance is ${st}, not Florida; the search only asks for Florida work`);
    if (!n.active) skip.push('The notice is archived; the search only asks for active notices');
  } else if (usa) {
    source = 'usaspending_awards';
    const d = await run.get(`https://api.usaspending.gov/api/v2/awards/${encodeURIComponent(decodeURIComponent(usa[1]))}/`, 'application/json');
    const a = { id: d.generated_unique_award_id || usa[1], piid: d.piid || '', recipient: d.recipient?.recipient_name || '', amount: d.total_obligation ?? null,
      description: d.description || '', start: d.date_signed || null, agency: d.awarding_agency?.toptier_agency?.name || '', subAgency: d.awarding_agency?.subtier_agency?.name || '',
      zip: d.place_of_performance?.zip5 || null, naics: d.latest_transaction_contract_data?.naics || null };
    const cls = classify([{ field: 'award description', text: a.description, doc: `USAspending award ${a.piid}`, url: input }], run.terms, { value: a.amount });
    p = usaPayload(a, d, cls);
    if (d.place_of_performance?.state_code && d.place_of_performance.state_code !== 'FL') skip.push(`Performed in ${d.place_of_performance.state_code}, not Florida`);
    if (a.naics && !USA_NAICS.includes(String(a.naics))) skip.push(`NAICS ${a.naics} is not one of the construction codes searched`);
    if ((a.amount ?? 0) < 250000) skip.push('Below the $250,000 minimum');
    if (a.start && Date.parse(a.start) < Date.now() - 60 * 86400000) skip.push('Signed more than 60 days before the search window');
  } else if (permit) {
    source = 'orlando_permits';
    const rows = await run.get(`https://data.cityoforlando.net/resource/ryhf-m453.json?permit_number=${encodeURIComponent(permit[1].toUpperCase())}`, 'application/json');
    if (!rows?.length) throw new Error('The City of Orlando dataset has no permit with that number');
    const x = normalizeOrlandoPermit(rows[0]);
    const cls = classify(permitSections(x, ''), run.terms, { value: x.value });
    p = permitPayload(x, cls, { city: 'Orlando', county: 'Orange', source_id: source, key_prefix: 'orlando', dataset_url: 'https://data.cityoforlando.net/resource/ryhf-m453.json' });
    if (!/^Commercial/i.test(String(rows[0].plan_review_type || ''))) skip.push('Not a commercial permit');
    if ((x.value ?? 0) < 500000) skip.push('Valuation under the $500,000 minimum');
    if (!/^(Alteration|Addition|Repair|Demo|Demolition|New)/i.test(x.worktype)) skip.push(`Work type "${x.worktype}" is not searched`);
  } else {
    throw new Error('Paste a SAM.gov notice link, a USAspending award link, or an Orlando permit number (like BLD2026-12345)');
  }
  if (p.relevance === 'low') skip.push('Classified as not relevant: ' + p.review_reason);
  const out: Record<string, unknown> = { ok: true, source, title: p.title || p.status_text, relevance: p.relevance, reason: p.review_reason,
    evidence: p.evidence, services: p.services_likely, region: p.region, county: p.county, would_skip: skip };
  if (doImport) {
    if (p.relevance === 'low' || skip.length) { p.relevance = 'review'; }
    p.review_reason = 'Added from a missed-opportunity check' + (skip.length ? ` (the collector skipped it: ${skip.join('; ')})` : '');
    const { data: runId, error } = await db.rpc('refresh_start_run', { p_source: source, p_trigger: 'manual', p_user: user, p_attempt: 1 });
    if (error) throw new Error(error.message);
    const r = new Run(runId as number, 300, 5);
    await r.upsert(p);
    await db.rpc('refresh_finish_run', { p_run: runId, p_status: 'success', p_counts: r.counts, p_log: ['imported from a missed-opportunity check: ' + input] });
    out.imported = true; out.project_key = p.external_key;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  const auth = await authorize(req);
  if (!auth.ok) return json({ error: auth.why }, 403);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const source = String(body.source || 'all');
  const trigger = auth.user ? 'manual' : (body.trigger === 'retry' ? 'retry' : 'schedule');
  if (source === 'probe') {
    if (!auth.user) return json({ error: 'manager_only' }, 403);
    try { return json(await probe(String(body.url || ''), !!body.import, auth.user)); }
    catch (e) { return json({ ok: false, error: (e as Error).message }); }
  }
  const work = (async () => {
    if (source === 'retry_failed') return retryFailed();
    if (source === 'maintenance') return db.rpc('daily_maintenance');
    const list = source === 'all' ? ['fdot_lettings', 'sam_gov', 'usaspending_awards', 'orlando_permits'] : [source];
    const out = [];
    for (const s of list) out.push(await runSource(s, trigger, auth.user));
    return out;
  })();
  // Answer right away; the run keeps going in the background and its progress shows in Sources and refreshes.
  // @ts-ignore EdgeRuntime is provided by Supabase
  if (typeof EdgeRuntime !== 'undefined' && !body.wait) { EdgeRuntime.waitUntil(work); return json({ started: source }, 202); }
  return json(await work);
});
