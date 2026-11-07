// Manager-only account administration. Uses the service role key, which exists only here on the server.
// Invite and reset links are one-time links the manager copies and sends (text or email) to the salesperson.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SETUP_CODE = Deno.env.get('SETUP_CODE') || '';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (msg: string, status = 400) => json({ error: msg }, status);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function portalBase(u: unknown): string | null {
  try {
    const x = new URL(String(u));
    if (x.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(x.hostname)) return null;
    return x.origin + x.pathname;
  } catch { return null; }
}
const linkFor = (base: string, type: string, hash: string) => `${base}#/welcome?type=${type}&token_hash=${encodeURIComponent(hash)}`;

async function makeLink(email: string, type: 'invite' | 'recovery', base: string, name?: string) {
  const { data, error } = await admin.auth.admin.generateLink({ type, email, options: type === 'invite' ? { data: { full_name: name || '' } } : undefined });
  if (error) throw new Error(error.message);
  return { user: data.user, link: linkFor(base, type, data.properties.hashed_token) };
}

async function activeManagers() {
  const { count } = await admin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'manager').eq('active', true);
  return count || 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('POST only', 405);
  let body: any;
  try { body = await req.json(); } catch { return fail('Bad request'); }
  const action = String(body.action || '');
  const base = portalBase(body.portal_url);

  try {
    // ---- one-time first manager setup (only while no active manager exists)
    if (action === 'bootstrap') {
      if ((await activeManagers()) > 0) return fail('Setup is already done. Ask a manager for an invite.', 403);
      const email = String(body.email || '').trim().toLowerCase(), name = String(body.full_name || '').trim();
      if (!EMAIL.test(email) || !name || !base) return fail('Enter your name and email.');
      // one-time code: stored hashed in the database (or optionally the SETUP_CODE env var); used up on success
      const code = String(body.setup_code || '').trim();
      const ok = (SETUP_CODE && code === SETUP_CODE) || (!!code && (await admin.rpc('use_setup_code', { p_code: code })).data === true);
      if (!ok) return fail('That setup code is not right or was already used.', 403);
      const { data: existing } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
      const r = existing ? await makeLink(email, 'recovery', base) : await makeLink(email, 'invite', base, name);
      await admin.from('profiles').upsert({ id: r.user.id, email, full_name: name, role: 'manager', active: true, invited_at: new Date().toISOString() });
      return json({ ok: true, link: r.link });
    }

    // ---- everything else: signed-in active manager
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return fail('Your session expired. Sign in again.', 401);
    const { data: me } = await admin.from('profiles').select('*').eq('id', user.id).single();
    if (!me?.active || me.role !== 'manager') return fail('Only managers can manage accounts.', 403);
    const target = body.user_id ? (await admin.from('profiles').select('*').eq('id', body.user_id).single()).data : null;
    if (body.user_id && !target) return fail('No such user.', 404);

    switch (action) {
      case 'invite': {
        const email = String(body.email || '').trim().toLowerCase(), name = String(body.full_name || '').trim();
        const role = body.role === 'manager' ? 'manager' : 'sales';
        if (!EMAIL.test(email)) return fail('Enter a valid email address.');
        if (!name) return fail('Enter their name.');
        if (!base) return fail('Portal address missing.');
        const { data: existing } = await admin.from('profiles').select('id, active').eq('email', email).maybeSingle();
        if (existing) return fail(existing.active ? 'That person already has an account. Use "Reset link" instead.' : 'That person has an account that is turned off. Use "Turn on" instead.', 409);
        const r = await makeLink(email, 'invite', base, name);
        await admin.from('profiles').upsert({ id: r.user.id, email, full_name: name, phone: body.phone || null, role, active: true,
          invited_by: me.id, invited_at: new Date().toISOString() });
        return json({ ok: true, link: r.link, user_id: r.user.id });
      }
      case 'reset_link': {
        if (!base) return fail('Portal address missing.');
        if (!target.active) return fail('Turn this account on first.');
        const r = await makeLink(target.email, 'recovery', base);
        return json({ ok: true, link: r.link });
      }
      case 'set_role': {
        const role = body.role === 'manager' ? 'manager' : 'sales';
        if (target.id === me.id && role !== 'manager' && (await activeManagers()) <= 1) return fail('You are the only manager. Make someone else a manager first.');
        await admin.from('profiles').update({ role }).eq('id', target.id);
        return json({ ok: true });
      }
      case 'deactivate': {
        if (target.id === me.id) return fail('You cannot turn off your own account.');
        const { error } = await admin.auth.admin.updateUserById(target.id, { ban_duration: '876000h' });
        if (error) throw new Error(error.message);
        await admin.from('profiles').update({ active: false, deactivated_at: new Date().toISOString() }).eq('id', target.id);
        return json({ ok: true, note: 'Signed out everywhere. Their open opportunities stay assigned until you reassign or release them.' });
      }
      case 'reactivate': {
        const { error } = await admin.auth.admin.updateUserById(target.id, { ban_duration: 'none' });
        if (error) throw new Error(error.message);
        await admin.from('profiles').update({ active: true, deactivated_at: null }).eq('id', target.id);
        return json({ ok: true });
      }
      case 'update_profile': {
        const patch: Record<string, unknown> = {};
        if (typeof body.full_name === 'string' && body.full_name.trim()) patch.full_name = body.full_name.trim();
        if (typeof body.phone === 'string') patch.phone = body.phone.trim() || null;
        await admin.from('profiles').update(patch).eq('id', target.id);
        return json({ ok: true });
      }
      default:
        return fail('Unknown action.');
    }
  } catch (e) {
    return fail((e as Error).message || 'Something went wrong.', 500);
  }
});
