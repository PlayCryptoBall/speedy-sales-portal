// Estimate request intake for the separate contractor-facing estimate app.
// POST JSON with header `x-integration-key: erk_...` (created in the portal under Workspace settings > Integrations).
// The key decides the workspace. The database checks the key (stored hashed), rate limit, idempotency_key, services and
// units; this function adds size limits, the browser-origin check and file storage. Everything received is treated as
// data: it is stored and validated, never followed as instructions, rendered as HTML or used to trigger other actions.
// Contract: docs/ESTIMATE_INTAKE.md. Not connected to any app until someone creates a key and configures that app.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const MAX_BODY = 40 * 1024 * 1024;          // JSON with base64 files
const MAX_FILES = 5, MAX_FILE = 8 * 1024 * 1024;

const headersFor = (origin: string | null, allowed: boolean) => ({
  'Content-Type': 'application/json',
  ...(origin && allowed ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'content-type, x-integration-key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS' } : {}),
});

async function sha256Hex(b: Uint8Array) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b));
  return [...d].map(x => x.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const key = req.headers.get('x-integration-key') || '';
  // preflight: the key is not sent on OPTIONS, so allow the headers; the POST itself is checked
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Headers': 'content-type, x-integration-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' } });
  if (req.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: 'post_only' }), { status: 405, headers: headersFor(null, false) });
  if (!/^erk_[0-9a-f]{48}$/.test(key)) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: headersFor(null, false) });
  const { data: originOk } = await db.rpc('intake_check_origin', { p_key: key, p_origin: origin });
  const h = headersFor(origin, !!originOk);
  if (!originOk) return new Response(JSON.stringify({ ok: false, error: origin ? 'origin_not_allowed' : 'unauthorized' }), { status: 403, headers: h });
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BODY) return new Response(JSON.stringify({ ok: false, error: 'too_large' }), { status: 413, headers: h });
  let body: any;
  try { body = JSON.parse(await req.text()); } catch { return new Response(JSON.stringify({ ok: false, error: 'bad_json' }), { status: 400, headers: h }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return new Response(JSON.stringify({ ok: false, error: 'bad_json' }), { status: 400, headers: h });

  const files: any[] = Array.isArray(body.attachments) ? body.attachments : [];
  if (files.length > MAX_FILES) return new Response(JSON.stringify({ ok: false, error: 'too_many_files', max: MAX_FILES }), { status: 400, headers: h });
  // the request record carries only file names and sizes, never the file content
  const decoded: { name: string; mime: string; bytes: Uint8Array }[] = [];
  for (const f of files) {
    try {
      const bytes = Uint8Array.from(atob(String(f.base64 || '')), c => c.charCodeAt(0));
      if (!bytes.length || bytes.length > MAX_FILE) return new Response(JSON.stringify({ ok: false, error: 'file_too_large', max_bytes: MAX_FILE }), { status: 400, headers: h });
      decoded.push({ name: String(f.filename || 'file').slice(0, 120), mime: String(f.mime || ''), bytes });
    } catch { return new Response(JSON.stringify({ ok: false, error: 'bad_file' }), { status: 400, headers: h }); }
  }
  // files are counted as received only once stored and confirmed, so the request starts with "photos or drawings" missing
  const payload = { ...body, attachments: [], attachment_names: decoded.map(d => ({ filename: d.name, mime: d.mime, bytes: d.bytes.length })) };
  const { data: res, error } = await db.rpc('intake_estimate_request', { p_key: key, p: payload });
  if (error) return new Response(JSON.stringify({ ok: false, error: 'server_error' }), { status: 500, headers: h });
  if (!res?.ok) return new Response(JSON.stringify(res), { status: res?.error === 'rate_limited' ? 429 : res?.error === 'unauthorized' ? 401 : 400, headers: h });

  // files: register the path, store it with the service role, confirm it (size checked by the database)
  const stored: any[] = [];
  if (!res.duplicate) {
    for (const d of decoded) {
      const { data: reg } = await db.rpc('intake_register_file', { p_key: key, p_ref: res.ref, p: { filename: d.name, mime: d.mime, bytes: d.bytes.length, sha256: await sha256Hex(d.bytes) } });
      if (!reg?.ok) { stored.push({ filename: d.name, ok: false, error: reg?.error || 'not_registered' }); continue; }
      const up = await db.storage.from('documents').upload(reg.path, d.bytes, { contentType: d.mime, upsert: false });
      if (up.error) { stored.push({ filename: d.name, ok: false, error: 'upload_failed' }); continue; }
      const { data: conf } = await db.rpc('intake_confirm_file', { p_key: key, p_revision: reg.revision_id });
      stored.push({ filename: d.name, ok: !!conf?.ok });
    }
  }
  if (stored.length && stored.every(x => x.ok)) {
    res.missing = (res.missing || []).filter((m: any) => m.field !== 'attachments');
    if (res.status === 'missing_info' && !res.missing.length) res.status = 'ready';
  }
  return new Response(JSON.stringify({ ...res, files: stored }), { status: res.duplicate ? 200 : 201, headers: h });
});
