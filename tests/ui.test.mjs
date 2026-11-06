// Browser tests of the real web app against the local database (through tests/server.mjs).
// usage: node tests/ui.test.mjs <database> <port> <screenshot dir>
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const [DB = 't3', PORT = '8787', SHOTS = './shots'] = process.argv.slice(2);
const BASE = `http://localhost:${PORT}/`;
fs.mkdirSync(SHOTS, { recursive: true });
const db = new pg.Client({ host: 'localhost', port: 54329, user: 'postgres', password: 'pw', database: DB }); await db.connect();
const results = [];
const t = async (name, fn) => { try { await fn(); results.push(1); console.log('PASS', name); } catch (e) { results.push(0); console.log('FAIL', name, '\n   ', e.message.split('\n')[0]); } };

const mk = async (email, name, role) => {
  await db.query(`delete from auth.users where email=$1`, [email]);
  const id = (await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1,$2) returning id`, [email, { full_name: name }])).rows[0].id;
  await db.query(`update profiles set full_name=$2, role=$3, active=true where id=$1`, [id, name, role]);
  return { id, email, name };
};
const M = await mk('mgr@ui.test', 'Johan (manager)', 'manager');
const A = await mk('flip@ui.test', 'Flip', 'sales');
const B = await mk('rep@ui.test', 'Dana Rep', 'sales');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const session = (u) => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  return { access_token: `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: u.id, role: 'authenticated', email: u.email, exp })}.sig`,
    token_type: 'bearer', expires_in: 86400, expires_at: exp, refresh_token: 'test', user: { id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated' } };
};
const browser = await chromium.launch();
const ctx = async (u, device) => {
  const c = await browser.newContext({ ...(device ? devices[device] : { viewport: { width: 1360, height: 900 } }), acceptDownloads: true });
  // this sandbox cannot reach the CDN; serve the same pinned library versions from npm
  await c.route('https://cdn.jsdelivr.net/npm/**', (route) => {
    const u = route.request().url();
    const f = u.includes('supabase-js@2.45.4') ? 'node_modules/@supabase/supabase-js/dist/umd/supabase.js' : u.includes('exceljs@4.4.0') ? 'node_modules/exceljs/dist/exceljs.min.js' : null;
    return f ? route.fulfill({ path: f, contentType: 'text/javascript' }) : route.abort();
  });
  await c.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ body: '', contentType: 'text/css' }));
  await c.addInitScript(([k, v]) => { if (!sessionStorage.getItem('init')) { localStorage.setItem(k, v); sessionStorage.setItem('init', '1'); } }, ['speedy-portal-auth', JSON.stringify(session(u))]);
  const p = await c.newPage();
  p.on('pageerror', e => console.log('   [page error]', u.name, e.message));
  return p;
};
const flip = await ctx(A, 'iPhone 13');
const rep = await ctx(B);
const mgr = await ctx(M);
const shot = (p, n) => p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false });
const toast = async (p, re) => {
  const loc = re ? p.locator('.toast', { hasText: re }) : p.locator('.toast');
  await loc.first().waitFor({ timeout: 10000 });
  return (await loc.first().textContent()).trim();
};

let leadId;
await t('Phone: Available list loads with priorities and ownership', async () => {
  await flip.goto(BASE + '#/pool');
  await flip.locator('.mobile-only .lead').first().waitFor({ timeout: 15000 });
  const n = await flip.locator('.mobile-only .lead').count();
  assert.ok(n > 100, 'pool has the imported leads: ' + n);
  await shot(flip, '01-phone-available');
  await flip.fill('[data-filter="q"]', 'bridge');
  await flip.waitForTimeout(400);
  const m = await flip.locator('.mobile-only .lead').count();
  assert.ok(m >= 1 && m < n, 'search narrows the list: ' + m);
  await flip.fill('[data-filter="q"]', '');
  await flip.waitForTimeout(300);
});

await t('Phone: open a Hot lead, claim it, log a call with a follow-up', async () => {
  const hot = (await db.query(`select o.id from opportunities o join projects p on p.id=o.project_id where o.stage='available' and o.priority='Hot' and not o.needs_review and o.company_id is not null
     and exists (select 1 from contacts c where c.company_id=o.company_id and c.phone is not null) order by o.fit_score desc limit 1`)).rows[0];
  leadId = hot.id;
  await flip.goto(BASE + '#/lead/' + leadId);
  await flip.getByRole('button', { name: 'Claim this lead' }).waitFor();
  await shot(flip, '02-phone-lead-available');
  assert.ok(await flip.locator('a.btn.call').count() > 0, 'tap-to-call button present');
  await flip.getByRole('button', { name: 'Claim this lead' }).click();
  assert.match(await toast(flip, /Claimed/), /Claimed/);
  await flip.locator('.owner-band.mine').waitFor();
  await flip.getByRole('button', { name: 'Reached them' }).click();
  await flip.fill('#lg_body', 'Spoke with the estimator. They need 30 cores through a 10 in. deck and GPR first.');
  await flip.getByRole('button', { name: 'Next week' }).click();
  await flip.fill('#lg_next', 'Send core and GPR pricing');
  await flip.click('#lg_save');
  assert.match(await toast(flip, /Saved/), /Contacted/);
  await flip.locator('.timeline li.call').first().waitFor();
  assert.match(await flip.locator('.timeline').textContent(), /30 cores/);
  await shot(flip, '03-phone-lead-after-call');
});

await t('Phone: request a quote notifies managers', async () => {
  await flip.getByRole('button', { name: 'Request a quote' }).click();
  await flip.fill('#lg_body', '30 x 4 in. cores, 10 in. PT deck, GPR scan first. Work in early December.');
  await flip.fill('#lg_work', '2026-12-07');
  await flip.click('#lg_save');
  assert.match(await toast(flip, /Quote requested/), /Quote requested/);
  const n = (await db.query(`select count(*)::int n from notifications where user_id=$1 and kind='quote_requested'`, [M.id])).rows[0].n;
  assert.equal(n, 1);
  assert.match(await flip.locator('.owner-band').textContent(), /Quote needed/);
});

await t('Second rep sees who owns it before calling; notes stay private', async () => {
  await rep.goto(BASE + '#/lead/' + leadId);
  await rep.locator('.owner-band.taken').waitFor({ timeout: 15000 });
  assert.match(await rep.locator('.owner-band').textContent(), /Flip owns this/);
  assert.equal(await rep.getByRole('button', { name: 'Claim this lead' }).count(), 0);
  assert.doesNotMatch(await rep.locator('.timeline').textContent(), /30 cores/);
  assert.equal(await rep.locator('#logbox').count(), 0, 'no logging form on someone else\'s lead');
  await shot(rep, '04-desktop-lead-owned-by-flip');
});

await t('Claim race in the browser: both press Claim, one wins, the other is told who has it', async () => {
  const o = (await db.query(`select id from opportunities where stage='available' and not needs_review order by fit_score desc offset 3 limit 1`)).rows[0];
  const flip2 = await ctx(A);
  await Promise.all([flip2.goto(BASE + '#/lead/' + o.id), rep.goto(BASE + '#/lead/' + o.id)]);
  await Promise.all([flip2.getByRole('button', { name: 'Claim this lead' }).waitFor(), rep.getByRole('button', { name: 'Claim this lead' }).waitFor()]);
  const clickClaim = async (p) => {
    await p.getByRole('button', { name: 'Claim this lead' }).click();
    const dlg = p.locator('dialog[open]');
    if (await dlg.count()) await dlg.getByRole('button', { name: 'Claim anyway' }).click();
  };
  await Promise.all([clickClaim(flip2), clickClaim(rep)]);
  const msgs = await Promise.all([toast(flip2, /Claimed|claimed this first/), toast(rep, /Claimed|claimed this first/)]);
  const wins = msgs.filter(m => /Claimed/.test(m)).length, loses = msgs.filter(m => /claimed this first/.test(m)).length;
  assert.equal(wins, 1, msgs.join(' | ')); assert.equal(loses, 1, msgs.join(' | '));
  const owners = (await db.query(`select count(*)::int n from ownership_history where opportunity_id=$1`, [o.id])).rows[0].n;
  assert.equal(owners, 1);
  await flip2.context().close();
});

await t('Salesperson cannot open manager pages', async () => {
  await rep.goto(BASE + '#/team');
  await rep.getByText('Managers only').waitFor();
  await rep.goto(BASE + '#/sources');
  await rep.getByText('Managers only').waitFor();
  assert.equal(await rep.locator('.rail a[href="#/team"]').count(), 0, 'no manager links in the menu');
});

await t('Saved work shows on another device (desktop session for the same rep)', async () => {
  const flipDesk = await ctx(A);
  await flipDesk.goto(BASE + '#/mine');
  await flipDesk.locator('.desk-only table.data tbody tr').first().waitFor({ timeout: 15000 });
  await flipDesk.goto(BASE + '#/lead/' + leadId);
  await flipDesk.locator('.timeline').waitFor();
  assert.match(await flipDesk.locator('.timeline').textContent(), /30 cores/);
  assert.equal(await flipDesk.inputValue('#lg_next'), 'Send core and GPR pricing');
  await shot(flipDesk, '05-desktop-lead-mine');
  await flipDesk.goto(BASE + '#/today');
  await flipDesk.getByText('Hot leads nobody has claimed').waitFor();
  await shot(flipDesk, '06-desktop-today');
  await flipDesk.context().close();
});

await t('Manager: team, sources and people pages render with real data', async () => {
  await mgr.goto(BASE + '#/team');
  await mgr.getByRole('heading', { name: 'People', exact: true }).waitFor({ timeout: 15000 });
  assert.match(await mgr.locator('main').textContent(), /Flip/);
  await shot(mgr, '07-manager-team');
  await mgr.goto(BASE + '#/sources');
  await mgr.getByRole('heading', { name: 'Sources', exact: true }).waitFor({ timeout: 15000 });
  assert.match(await mgr.locator('main').textContent(), /SAM\.gov/);
  await shot(mgr, '08-manager-sources');
  await mgr.goto(BASE + '#/users');
  await mgr.getByRole('button', { name: 'Invite someone' }).click();
  await mgr.fill('[name=full_name]', 'New Rep'); await mgr.fill('[name=email]', 'newrep@ui.test');
  await mgr.getByRole('button', { name: 'Create invite link' }).click();
  await mgr.locator('#lnk').waitFor();
  assert.match(await mgr.inputValue('#lnk'), /#\/welcome\?type=invite&token_hash=/);
  await shot(mgr, '09-manager-invite-link');
  await mgr.getByRole('button', { name: 'Done' }).click();
});

await t('Manager reassigns with history; review queue is usable', async () => {
  await mgr.goto(BASE + '#/lead/' + leadId);
  await mgr.getByRole('button', { name: 'Reassign' }).first().click();
  await mgr.selectOption('[name=user]', B.id);
  await mgr.fill('[name=reason]', 'Dana knows this GC');
  await mgr.getByRole('button', { name: 'Save', exact: true }).click();
  assert.match(await toast(mgr, /Ownership/), /Ownership updated/);
  assert.match(await mgr.locator('.owner-band').textContent(), /Dana Rep owns this/);
  await mgr.goto(BASE + '#/all?tab=review');
  await mgr.locator('.desk-only table.data tbody tr').first().waitFor();
});

let xlsxPath;
await t('Excel export: team workbook downloads in the workbook format', async () => {
  await mgr.goto(BASE + '#/files');
  mgr.on('console', m => m.type() === 'error' && console.log('   [console]', m.text()));
  const [dl] = await Promise.all([mgr.waitForEvent('download', { timeout: 30000 }), mgr.getByRole('button', { name: 'Download team Excel' }).click()]).catch(async (e) => {
    const tx = await mgr.locator('.toast').first().textContent({ timeout: 2000 }).catch(() => 'no toast'); throw new Error('no download; toast: ' + tx); });
  xlsxPath = `${SHOTS}/team.xlsx`; await dl.saveAs(xlsxPath);
  assert.match(dl.suggestedFilename(), /Speedy Pipeline Team/);
});

await t('Workbook import: preview, save new notes once, never overwrite newer portal work', async () => {
  const { execFileSync } = await import('node:child_process');
  const ref = (await db.query(`select ref from opportunities where id=$1`, [leadId])).rows[0].ref;
  const edited = `${SHOTS}/team-edited.xlsx`;
  execFileSync('python3', ['-c', `
import openpyxl, datetime, sys
wb = openpyxl.load_workbook(sys.argv[1]); ws = wb['Sales Leads']
h = [c.value for c in ws[1]]
for row in ws.iter_rows(min_row=2):
    if row[h.index('Opp ID')].value == sys.argv[3]:
        row[h.index('Notes')].value = 'Called back from the jobsite, sending pricing Friday'
        row[h.index('Status')].value = 'Won'
        row[h.index('Last Contact')].value = datetime.datetime(2026, 10, 30)
wb.save(sys.argv[2])`, xlsxPath, edited, ref]);
  await mgr.goto(BASE + '#/files');
  await mgr.setInputFiles('#imp_file', edited);
  await mgr.getByRole('button', { name: 'Save these changes' }).waitFor({ timeout: 20000 });
  const pv = await mgr.locator('#imp_out').textContent();
  assert.match(pv, /Portal has newer activity/, 'status change from an older sheet is refused');
  await shot(mgr, '11-manager-import-preview');
  await mgr.getByRole('button', { name: 'Save these changes' }).click();
  await mgr.locator('#imp_out .alert.ok').waitFor();
  assert.match(await mgr.locator('#imp_out').textContent(), /1 notes added, 0 statuses changed/);
  await mgr.setInputFiles('#imp_file', edited);
  await mgr.locator('#imp_out table').waitFor();
  assert.match(await mgr.locator('#imp_out').textContent(), /Already in the timeline/);
  const st = (await db.query(`select stage from opportunities where id=$1`, [leadId])).rows[0].stage;
  assert.equal(st, 'quote_needed');
});

await t('Phone PDF view renders (team snapshot on a phone)', async () => {
  const p = await ctx(M, 'iPhone 13');
  await p.goto(BASE + '#/print/team');
  await p.locator('.print').waitFor({ timeout: 15000 });
  assert.match(await p.locator('.print').textContent(), /Snapshot from the Speedy Sales Portal/);
  await shot(p, '10-phone-pdf-view');
  await p.emulateMedia({ media: 'print' });
  await p.pdf({ path: `${SHOTS}/team-pipeline.pdf`, format: 'Letter' });
  await p.context().close();
});

await t('Empty and permission states', async () => {
  const fresh = await mk('empty@ui.test', 'New Person', 'sales');
  const p = await ctx(fresh, 'iPhone 13');
  await p.goto(BASE + '#/mine');
  await p.getByText('Nothing here yet').waitFor({ timeout: 15000 });
  await p.goto(BASE + '#/print/mine');
  await p.getByText('You have no claimed leads yet').waitFor();
  await db.query(`update profiles set active=false where id=$1`, [fresh.id]);
  await p.goto(BASE + '#/today'); await p.reload();
  await p.getByText('Your account is not active').waitFor();
  await p.context().close();
});

console.log(JSON.stringify({ xlsxPath }));
await browser.close(); await db.end();
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
