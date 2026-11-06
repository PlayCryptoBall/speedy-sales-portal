// Scheduled and manual source refreshes. Runs on Supabase's servers (pg_cron calls it; managers can also start it).
// It updates project FACTS only through the refresh_* database functions, which never touch sales work.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import {
  FDOT_BASE, FDOT_DISTRICTS, fdotPayload, groupNotices, normalizeOfficial, normalizeSgs, parseFdotList, parseFdotReport,
  relevance, SAM_SEARCH, samFacts, samPayload, type SamNotice,
} from './lib.ts';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET') || '';
const SAM_API_KEY = Deno.env.get('SAM_API_KEY') || '';
const UA = 'SpeedyConcreteCuttingSalesPortal/1.0 (+https://speedycon.com)';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' };
const db = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

class Run {
  log: string[] = []; counts = { fetched: 0, discovered: 0, updated: 0, merged: 0, flagged: 0, unchanged: 0, errors: 0 };
  requests = 0; last = 0;
  constructor(public id: number, public gapMs: number, public maxRequests: number) {}
  note(s: string) { this.log.push(`${new Date().toISOString().slice(11, 19)} ${s}`); if (this.log.length > 400) this.log.splice(1, 1); }
  // polite fetch: spacing between requests, a per-run cap, 3 tries with backoff on network errors, 429 and 5xx
  async get(url: string, accept = 'text/html') {
    if (this.requests >= this.maxRequests) throw new Error(`request cap of ${this.maxRequests} reached for this run`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now(); this.requests++;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, signal: AbortSignal.timeout(25000) });
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
  const minAmt = cfg.untracked_min_amount ?? 1_000_000;
  const regions: string[] = cfg.untracked_regions ?? ['Central FL', 'Tampa Bay'];
  const since = new Date(Date.now() - lookback * 86400000).toISOString().slice(0, 10);
  const mine = await tracked('fdot_lettings');
  const keys = new Set<string>();
  for (const t of mine) { keys.add(t.external_key); (t.alt_keys || []).forEach(k => keys.add(k)); }
  let reports = 0, skippedUntracked = 0;
  for (const d of FDOT_DISTRICTS) {
    let list;
    try { list = parseFdotList(await run.get(`${FDOT_BASE}/LettingResults?districtID=${d}`)); }
    catch (e) { run.counts.errors++; run.note(`district ${d} list failed: ${(e as Error).message}`); continue; }
    const recent = list.filter(l => l.iso >= since);
    run.note(`district ${d}: ${list.length} lettings listed, ${recent.length} since ${since}`);
    for (const l of recent) {
      let rep;
      try { rep = parseFdotReport(await run.get(l.url)); reports++; }
      catch (e) { run.counts.errors++; run.note(`report ${l.id} failed: ${(e as Error).message}`); continue; }
      if (!rep.complete) { run.note(`report ${l.id} (${l.date}): "${rep.status || 'no status'}", skipped until results post`); continue; }
      for (const c of rep.contracts) {
        const key = `fdot:${c.contract.replace(/-R0$/, '')}`;
        const isTracked = keys.has(key);
        if (!isTracked) {
          const low = c.bidders[0]?.amount ?? 0;
          const p = fdotPayload(c, l, d, false);
          if (low < minAmt || !regions.includes(String(p.region))) { skippedUntracked++; continue; }
          await run.upsert(p);
        } else {
          await run.upsert(fdotPayload(c, l, d, true));
        }
      }
    }
  }
  run.note(`${reports} reports read; ${skippedUntracked} untracked contracts skipped (under $${minAmt.toLocaleString()} or outside ${regions.join(', ')})`);
}

// ---------------------------------------------------------------- SAM.gov
async function samSearch(run: Run, params: Record<string, string>): Promise<SamNotice[]> {
  if (SAM_API_KEY) {
    // official API (free key from a SAM.gov account)
    const to = new Date(), from = new Date(Date.now() - 30 * 86400000);
    const f = (x: Date) => `${String(x.getMonth() + 1).padStart(2, '0')}/${String(x.getDate()).padStart(2, '0')}/${x.getFullYear()}`;
    const qs = new URLSearchParams({ api_key: SAM_API_KEY, postedFrom: f(from), postedTo: f(to), limit: '100', state: 'FL',
      ...(params.q ? { title: params.q.replace(/"/g, '') } : {}), ...(params.sol ? { solnum: params.sol } : {}) });
    const j = await run.get(`https://api.sam.gov/opportunities/v2/search?${qs}`, 'application/json');
    return (j.opportunitiesData || []).map(normalizeOfficial);
  }
  const qs = new URLSearchParams({ index: 'opp', page: '0', size: params.size || '50', mode: 'search', sort: '-modifiedDate', ...params });
  qs.delete('sol');
  const j = await run.get(`${SAM_SEARCH}?${qs}`, 'application/hal+json');
  return ((j?._embedded?.results) || []).map(normalizeSgs);
}

async function samDetails(run: Run, id: string) {
  if (SAM_API_KEY) return null;
  try { return await run.get(`https://sam.gov/api/prod/opps/v2/opportunities/${id}`, 'application/hal+json'); }
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
    if (checked >= (cfg.max_tracked_checks ?? 40)) { run.note(`tracked check cap reached; ${trackedSols.size - checked} left for the next run`); break; }
    checked++;
    let notices: SamNotice[];
    try { notices = await samSearch(run, { q: `"${sol}"`, size: '10', sol }); }
    catch (e) { run.counts.errors++; failedKeys.push(t.external_key); run.note(`check ${sol} failed: ${(e as Error).message}`); continue; }
    notices = notices.filter(n => [n.sol, n.originalSol].some(s => (s || '').toUpperCase().replace(/[^A-Z0-9-]/g, '') === sol));
    if (!notices.length) { run.note(`${sol}: no SAM.gov notices found by solicitation number`); failedKeys.push(t.external_key); continue; }
    const g = groupNotices(notices);
    const group = [...g.values()].flat().sort((a, b) => String(b.published).localeCompare(String(a.published)));
    const facts = samFacts(group, null);
    const p = samPayload(sol, group, facts, true);
    p.external_key = t.external_key;               // keep the existing record's key; new notice ids go in alt_keys
    await run.upsert(p);
  }
  if (failedKeys.length) await db.rpc('refresh_mark_failed', { p_keys: failedKeys });
  // 2. discover new Florida construction work
  const queries: string[] = cfg.queries ?? ['construction', 'demolition', 'concrete', 'renovation', 'repair', 'paving', 'design-build'];
  const seen = new Map<string, SamNotice>();
  for (const q of queries) {
    try {
      const list = await samSearch(run, { q, is_active: 'true', pop_state: 'FL', size: '50' });
      list.forEach(n => seen.set(n.id, n));
      run.note(`search "${q}": ${list.length} active Florida notices`);
    } catch (e) { run.counts.errors++; run.note(`search "${q}" failed: ${(e as Error).message}`); }
  }
  const groups = groupNotices([...seen.values()]);
  let newOnes = 0, skipped = 0;
  const maxNew = cfg.max_new_per_run ?? 25;
  for (const [key, notices] of groups) {
    if (trackedSols.has(key)) continue;          // already handled above
    const text = notices.map(n => `${n.title} ${n.snippet}`).join(' ');
    if (relevance(text) === 'skip') { skipped++; continue; }
    if (newOnes >= maxNew) { run.note(`new-item cap of ${maxNew} reached; the rest wait for the next run`); break; }
    newOnes++;
    const details = await samDetails(run, notices[0].id);
    const facts = samFacts(notices, details);
    await run.upsert(samPayload(key, notices, facts, false));
  }
  run.note(`${groups.size} procurements seen; ${skipped} not construction-related; ${newOnes} new or updated`);
}

// ---------------------------------------------------------------- orchestration
async function runSource(source: string, trigger: string, user: string | null, attempt = 1) {
  const { data: src } = await db.from('sources').select('*').eq('id', source).single();
  if (!src || !src.enabled) return { source, skipped: 'disabled or unknown' };
  const { data: runId, error } = await db.rpc('refresh_start_run', { p_source: source, p_trigger: trigger, p_user: user, p_attempt: attempt });
  if (error) throw new Error(error.message);
  const cfg = src.config || {};
  const run = new Run(runId, source === 'fdot_lettings' ? (cfg.gap_ms ?? 1500) : (cfg.gap_ms ?? 1200), cfg.max_requests ?? 120);
  run.note(`start ${source} (${trigger}, attempt ${attempt})`);
  let status = 'success', err: string | null = null;
  try {
    if (source === 'fdot_lettings') await runFdot(run, cfg);
    else if (source === 'sam_gov') await runSam(run, cfg);
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
    .in('id', ['sam_gov', 'fdot_lettings']).eq('last_status', 'failed').lt('consecutive_failures', 4);
  const out = [];
  for (const s of data || []) {
    if (s.last_run_at && Date.now() - new Date(s.last_run_at).getTime() < 45 * 60000) continue;
    out.push(await runSource(s.id, 'retry', null, s.consecutive_failures + 1));
  }
  return out;
}

async function authorize(req: Request): Promise<{ ok: boolean; user: string | null; why?: string }> {
  const secret = req.headers.get('x-cron-secret');
  if (CRON_SECRET && secret && secret === CRON_SECRET) return { ok: true, user: null };
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, user: null, why: 'Sign in as a manager to run a refresh.' };
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return { ok: false, user: null, why: 'Session expired. Sign in again.' };
  const { data: p } = await db.from('profiles').select('role, active').eq('id', user.id).single();
  if (!p?.active || p.role !== 'manager') return { ok: false, user: null, why: 'Only managers can run refreshes.' };
  return { ok: true, user: user.id };
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
  const work = (async () => {
    if (source === 'retry_failed') return retryFailed();
    if (source === 'maintenance') return db.rpc('daily_maintenance');
    const list = source === 'all' ? ['fdot_lettings', 'sam_gov'] : [source];
    const out = [];
    for (const s of list) out.push(await runSource(s, trigger, auth.user));
    return out;
  })();
  // Answer right away; the run keeps going in the background and its progress shows in Sources and refreshes.
  // @ts-ignore EdgeRuntime is provided by Supabase
  if (typeof EdgeRuntime !== 'undefined' && !body.wait) { EdgeRuntime.waitUntil(work); return json({ started: source }, 202); }
  return json(await work);
});
