// Test harness: serves web/ and stands in for Supabase's REST API (/rest/v1/rpc/*) on the local Postgres.
// Each request runs as the `authenticated` role with the caller's user id, the same way PostgREST does,
// so database permissions are exercised for real. Auth itself is faked: tokens are unsigned test tokens.
// usage: node tests/server.mjs <database> <port>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const DB = process.argv[2] || 't3', PORT = Number(process.argv[3] || 8787);
const WEB = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../web');
const pool = new pg.Pool({ host: 'localhost', port: 54329, user: 'postgres', password: 'pw', database: DB, max: 20 });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };

function claims(req) {
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()); } catch { return null; }
}
const body = (req) => new Promise(r => { let s = ''; req.on('data', d => s += d); req.on('end', () => { try { r(s ? JSON.parse(s) : {}); } catch { r({}); } }); });
const send = (res, status, obj) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  try {
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = url.pathname.split('/').pop().replace(/[^a-z_]/g, '');
      const args = await body(req), c = claims(req);
      const keys = Object.keys(args);
      const vals = keys.map(k => args[k] !== null && typeof args[k] === 'object' && !['p_keys', 'p_ids'].includes(k) ? JSON.stringify(args[k]) : args[k]);
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`set local role ${c?.sub ? 'authenticated' : 'anon'}`);
        if (c?.sub) await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: c.sub, role: 'authenticated' })]);
        const r = await client.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, vals);
        await client.query('commit');
        return send(res, 200, r.rows[0].r);
      } catch (e) {
        await client.query('rollback').catch(() => {});
        return send(res, e.code === '42501' ? 403 : 400, { code: e.code, message: e.message, hint: e.hint || null, details: e.detail || null });
      } finally { client.release(); }
    }
    if (url.pathname.startsWith('/functions/v1/')) {
      const name = url.pathname.split('/').pop(), b = await body(req), c = claims(req);
      const me = c?.sub ? (await pool.query('select * from profiles where id=$1', [c.sub])).rows[0] : null;
      if (!me?.active || me.role !== 'manager') return send(res, 403, { error: 'Only managers can do this.' });
      if (name === 'refresh') return send(res, 202, { started: b.source });
      if (name === 'admin-users' && b.action === 'invite') {
        const u = (await pool.query(`insert into auth.users (email, raw_user_meta_data) values ($1,$2) returning id`, [b.email, { full_name: b.full_name }])).rows[0];
        await pool.query(`update profiles set full_name=$2, role=$3, active=true, invited_by=$4, invited_at=now(), phone=$5 where id=$1`, [u.id, b.full_name, b.role, me.id, b.phone || null]);
        return send(res, 200, { ok: true, link: `${b.portal_url}#/welcome?type=invite&token_hash=test-${u.id}` });
      }
      if (name === 'admin-users' && b.action === 'reset_link') return send(res, 200, { ok: true, link: `${b.portal_url}#/welcome?type=recovery&token_hash=test-${b.user_id}` });
      if (name === 'admin-users' && ['deactivate', 'reactivate', 'set_role'].includes(b.action)) {
        if (b.action === 'set_role') await pool.query('update profiles set role=$2 where id=$1', [b.user_id, b.role]);
        else await pool.query('update profiles set active=$2 where id=$1', [b.user_id, b.action === 'reactivate']);
        return send(res, 200, { ok: true });
      }
      return send(res, 400, { error: 'Unknown action.' });
    }
    if (url.pathname.startsWith('/auth/v1/')) return send(res, 204);
    let f = path.join(WEB, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    if (!f.startsWith(WEB)) return send(res, 403, {});
    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(`window.SPEEDY_CONFIG = { supabaseUrl: 'http://localhost:${PORT}', supabaseKey: 'test-publishable-key', selfServiceReset: false };`);
    }
    if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { send(res, 500, { message: e.message }); }
}).listen(PORT, () => console.log('test server on', PORT, 'db', DB));
