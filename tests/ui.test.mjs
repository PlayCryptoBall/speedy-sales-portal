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
const pageErrors = [];

const mk = async (email, name, role) => {
  await db.query(`delete from auth.users where email=$1`, [email]);
  const id = (await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1,$2) returning id`, [email, { full_name: name }])).rows[0].id;
  await db.query(`update profiles set full_name=$2, role=$3, active=true where id=$1`, [id, name, role]);
  return { id, email, name };
};
const M = await mk('mgr@ui.test', 'Johan Valerio', 'manager');
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
  const c = await browser.newContext({ ...(device ? devices[device] : { viewport: { width: 1440, height: 900 } }), acceptDownloads: true });
  // this sandbox cannot reach the CDN; serve the same pinned library versions from npm
  await c.route('https://cdn.jsdelivr.net/npm/**', (route) => {
    const x = route.request().url();
    const f = x.includes('supabase-js@2.45.4') ? 'node_modules/@supabase/supabase-js/dist/umd/supabase.js' : x.includes('exceljs@4.4.0') ? 'node_modules/exceljs/dist/exceljs.min.js' : null;
    return f ? route.fulfill({ path: f, contentType: 'text/javascript' }) : route.abort();
  });
  if (u) await c.addInitScript(([k, v]) => { if (!sessionStorage.getItem('init')) { localStorage.setItem(k, v); sessionStorage.setItem('init', '1'); } }, ['speedy-portal-auth', JSON.stringify(session(u))]);
  const p = await c.newPage();
  p.on('pageerror', e => { pageErrors.push(`${u?.name || 'anon'}: ${e.message}`); console.log('   [page error]', u?.name, e.message); });
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) { pageErrors.push(`${u?.name || 'anon'} console: ${m.text()}`); console.log('   [console error]', m.text()); } });
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
const drawer = (p) => p.locator('#drawer.on');
const openLead = async (p, id) => { await p.goto(BASE + '#/lead/' + id); await drawer(p).locator('#dw_title').waitFor({ timeout: 15000 }); await p.waitForTimeout(250); };
const leadTab = async (p, name) => { await drawer(p).getByRole('tab', { name: new RegExp('^' + name) }).click(); };
const noSideScroll = async (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const unnamedControls = async (p, scope = 'body') => p.evaluate((s) => [...document.querySelectorAll(`${s} button, ${s} a[href], ${s} input:not([type=hidden]), ${s} select`)]
  .filter(el => el.offsetParent !== null)
  .filter(el => !(el.getAttribute('aria-label') || el.textContent.trim() || el.title || (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label') || el.placeholder))
  .map(el => el.outerHTML.slice(0, 80)), scope);

let leadId, total;
await t('Phone: Available list loads 30 at a time, searches, and pages', async () => {
  await flip.goto(BASE + '#/pool');
  await flip.locator('.li').first().waitFor({ timeout: 15000 });
  total = Number((await flip.locator('#lv-bar').textContent()).match(/(\d+) leads/)[1]);
  assert.ok(total > 100, 'pool has the imported leads: ' + total);
  assert.equal(await flip.locator('.li').count(), 30, 'first page of 30');
  const nav = Number(await flip.locator('[data-count="pool"]').first().textContent().catch(() => '0')) || total;
  assert.equal(nav, total, 'nav count matches the list');
  assert.ok(await noSideScroll(flip), 'no sideways scrolling on a phone');
  await shot(flip, '01-phone-available');
  await flip.getByRole('button', { name: /^Show 30 more/ }).click();
  assert.equal(await flip.locator('.li').count(), 60);
  await flip.fill('[data-lf="q"]', 'bridge');
  await flip.waitForTimeout(400);
  const m = await flip.locator('.li').count();
  assert.ok(m >= 1 && m < total, 'search narrows the list: ' + m);
  assert.match(await flip.locator('#lv-bar').textContent(), /of \d+ match/);
  await flip.fill('[data-lf="q"]', '');
  await flip.waitForTimeout(300);
});

await t('Phone: filters open as a sheet and show as removable chips', async () => {
  await flip.locator('#lv-fbtn').click();
  await flip.locator('.pop.sheet [data-f="priority"]').selectOption('Hot');
  await flip.getByRole('button', { name: 'Done' }).click();
  await flip.locator('.fchip').first().waitFor();
  assert.match(await flip.locator('#lv-chips').textContent(), /Priority: Hot/);
  const hot = await flip.locator('.li').count();
  assert.ok(hot > 0 && hot <= 30);
  assert.equal(await flip.locator('.li .badge.warm').count(), 0, 'only Hot leads remain');
  await flip.locator('.fchip').first().click();
  await flip.locator('#lv-chips.hidden').waitFor({ state: 'attached' });
});

await t('Phone: open a Hot lead, claim it, log a call with a follow-up', async () => {
  const hot = (await db.query(`select o.id from opportunities o join projects p on p.id=o.project_id where o.stage='available' and o.priority='Hot' and not o.needs_review and o.company_id is not null
     and exists (select 1 from contacts c where c.company_id=o.company_id and c.phone is not null) order by o.fit_score desc limit 1`)).rows[0];
  leadId = hot.id;
  await openLead(flip, leadId);
  await drawer(flip).getByRole('button', { name: 'Claim this lead' }).waitFor();
  await shot(flip, '02-phone-lead-available');
  await leadTab(flip, 'Contacts');
  assert.ok(await drawer(flip).locator('a[href^="tel:"]').count() > 0, 'tap-to-call button present');
  await drawer(flip).getByRole('button', { name: 'Claim this lead' }).click();
  assert.match(await toast(flip, /Claimed/), /Claimed/);
  await drawer(flip).locator('.ownbar', { hasText: 'Yours' }).waitFor();
  await drawer(flip).getByRole('button', { name: 'Log activity' }).click();
  await drawer(flip).getByRole('button', { name: 'Spoke with contractor', exact: true }).click();
  await flip.fill('#lg_body', 'Spoke with the estimator. They need 30 cores through a 10 in. deck and GPR first.');
  await drawer(flip).getByRole('button', { name: 'Next week', exact: true }).click();
  await flip.fill('#lg_next', 'Send core and GPR pricing');
  await flip.click('#lg_save');
  assert.match(await toast(flip, /Saved/), /Contacted/);
  await drawer(flip).locator('.timeline li.contact-kind').first().waitFor();
  assert.match(await drawer(flip).locator('.timeline').textContent(), /30 cores/);
  assert.equal(await flip.inputValue('#dw_stage'), 'contacted');
  await shot(flip, '03-phone-lead-after-call');
});

await t('Phone: request a quote from the lead menu notifies managers', async () => {
  await drawer(flip).getByRole('button', { name: 'More actions' }).click();
  await flip.getByRole('menuitem', { name: 'Request a quote' }).click();
  await flip.fill('dialog [name=body]', '30 x 4 in. cores, 10 in. PT deck, GPR scan first. Work in early December.');
  await flip.getByRole('button', { name: 'Request quote' }).click();
  assert.match(await toast(flip, /Quote requested/), /Quote requested/);
  const n = (await db.query(`select count(*)::int n from notifications where user_id=$1 and kind='quote_requested'`, [M.id])).rows[0].n;
  assert.equal(n, 1);
  await flip.waitForFunction(() => document.querySelector('#dw_stage')?.value === 'quote_needed');
});

await t('Phone: Back and Escape close the panel and keep the list underneath', async () => {
  await flip.goto(BASE + '#/pool');
  await flip.locator('.li').first().waitFor();
  await flip.locator('.li').nth(2).click();
  await drawer(flip).locator('#dw_title').waitFor();
  assert.match(flip.url(), /#\/pool\?lead=/);
  await flip.goBack();
  await flip.waitForFunction(() => !document.querySelector('#drawer.on'));
  assert.match(flip.url(), /#\/pool$/);
  await flip.locator('.li').nth(1).click();
  await drawer(flip).locator('#dw_title').waitFor();
  await flip.keyboard.press('Escape');
  await flip.waitForFunction(() => !document.querySelector('#drawer.on'));
  assert.equal(await flip.locator('.li').count(), 30, 'list still there');
});

await t('Second rep sees who owns it before calling; notes stay private', async () => {
  await openLead(rep, leadId);
  assert.match(await drawer(rep).locator('.ownbar').textContent(), /Flip owns this/);
  assert.equal(await drawer(rep).getByRole('button', { name: 'Claim this lead' }).count(), 0);
  await leadTab(rep, 'Activity');
  assert.doesNotMatch(await drawer(rep).locator('#lp_body').textContent(), /30 cores/);
  assert.equal(await rep.locator('#logbox').count(), 0, 'no logging form on someone else\'s lead');
  await shot(rep, '04-desktop-lead-owned-by-flip');
});

await t('Claim race in the browser: both press Claim, one wins, the other is told who has it', async () => {
  const o = (await db.query(`select id from opportunities where stage='available' and not needs_review order by fit_score desc offset 3 limit 1`)).rows[0];
  const flip2 = await ctx(A);
  await Promise.all([openLead(flip2, o.id), openLead(rep, o.id)]);
  const clickClaim = async (p) => {
    await drawer(p).getByRole('button', { name: 'Claim this lead' }).click();
    const dlg = p.locator('dialog[open]');
    await p.waitForTimeout(300);
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

await t('Salesperson cannot open manager pages or see manager links', async () => {
  await rep.goto(BASE + '#/team');
  await rep.getByText('Managers only').waitFor();
  await rep.goto(BASE + '#/sources');
  await rep.getByText('Managers only').waitFor();
  await rep.goto(BASE + '#/all');
  await rep.getByText('Managers only').waitFor();
  for (const h of ['#/team', '#/sources', '#/users', '#/all']) assert.equal(await rep.locator(`.sidebar a[href="${h}"]`).count(), 0, 'no link to ' + h);
});

let boardLead;
await t('Desktop: claim from the list, then move it across the board with the stage rules enforced', async () => {
  const flipDesk = await ctx(A);
  await flipDesk.goto(BASE + '#/pool');
  await flipDesk.locator('.li').first().waitFor({ timeout: 15000 });
  boardLead = await flipDesk.locator('.li').first().getAttribute('data-lead');
  await flipDesk.locator('.li').first().getByRole('button', { name: /^Claim / }).click();
  const dlg = flipDesk.locator('dialog[open]');
  await flipDesk.waitForTimeout(300);
  if (await dlg.count()) await dlg.getByRole('button', { name: 'Claim anyway' }).click();
  assert.match(await toast(flipDesk, /Claimed/), /Claimed/);
  await flipDesk.waitForFunction((id) => !document.querySelector(`.li[data-lead="${id}"]`), boardLead);
  await flipDesk.goto(BASE + '#/mine');
  await flipDesk.locator('[data-act="setView"][data-v="board"]').click();
  const card = flipDesk.locator(`.bcard[data-lead="${boardLead}"]`);
  await card.waitFor();
  assert.equal(await card.getAttribute('data-stage'), 'claimed');
  await shot(flipDesk, '05-desktop-board');
  await card.getByRole('button', { name: /^Move / }).click();
  await flipDesk.getByRole('menuitem', { name: 'Qualified', exact: true }).click();
  assert.match(await toast(flipDesk, /Moved to Qualified/), /Moved to Qualified/);
  assert.equal((await db.query('select stage from opportunities where id=$1', [boardLead])).rows[0].stage, 'qualified');
  await flipDesk.locator(`[data-drop="qualified"] .bcard[data-lead="${boardLead}"]`).waitFor();
  // Lost needs a reason: the dialog will not save without one
  await flipDesk.locator(`.bcard[data-lead="${boardLead}"]`).getByRole('button', { name: /^Move / }).click();
  await flipDesk.getByRole('menuitem', { name: 'Lost', exact: true }).click();
  await flipDesk.getByRole('button', { name: 'Mark lost' }).click();
  await flipDesk.locator('dialog .alert.error:not(.hidden)').waitFor();
  assert.equal((await db.query('select stage from opportunities where id=$1', [boardLead])).rows[0].stage, 'qualified');
  await flipDesk.fill('dialog [name=reason]', 'Went to a cutter already on site');
  await flipDesk.getByRole('button', { name: 'Mark lost' }).click();
  assert.match(await toast(flipDesk, /Moved to Lost/), /Moved to Lost/);
  const row = (await db.query('select stage, outcome_reason from opportunities where id=$1', [boardLead])).rows[0];
  assert.deepEqual([row.stage, row.outcome_reason], ['lost', 'Went to a cutter already on site']);
  await flipDesk.locator('[data-act="setView"][data-v="list"]').click();
  await flipDesk.context().close();
});

await t('Saved work shows on another device; Today shows priorities, deadlines and hot leads', async () => {
  const flipDesk = await ctx(A);
  await openLead(flipDesk, leadId);
  await leadTab(flipDesk, 'Activity');
  assert.match(await drawer(flipDesk).locator('.timeline').textContent(), /30 cores/);
  assert.equal(await flipDesk.inputValue('#lg_next'), 'Send core and GPR pricing');
  await shot(flipDesk, '06-desktop-lead-mine');
  await flipDesk.keyboard.press('Escape');
  await flipDesk.waitForFunction(() => !document.querySelector('#scrim.on'));
  await flipDesk.goto(BASE + '#/today');
  await flipDesk.waitForTimeout(300);
  await flipDesk.getByRole('heading', { name: /Hot leads/ }).first().waitFor();
  const kpi = Number(await flipDesk.locator('a.kpi[href="#/mine"] .val').textContent());
  const nav = Number(await flipDesk.locator('.sidebar [data-count="mine"]').textContent());
  assert.equal(kpi, nav, 'active-lead card matches the nav count');
  assert.equal(await flipDesk.locator(`#sec-calls [data-lead="${leadId}"]`).count(), 0, 'a follow-up due next week is not on today\'s call list');
  await db.query(`update opportunities set next_action_due = (now() at time zone 'America/New_York')::date - 1 where id = $1`, [leadId]);
  await flipDesk.reload(); await flipDesk.locator('#q-overdue').waitFor({ timeout: 15000 });
  assert.ok(await flipDesk.locator(`#q-overdue [data-lead="${leadId}"]`).count() >= 1, 'once overdue it leads the call list');
  await shot(flipDesk, '07-desktop-today');
  await flipDesk.context().close();
});

await t('Manager: Team numbers match the lists they describe', async () => {
  await mgr.goto(BASE + '#/team');
  await mgr.getByRole('heading', { name: /Pipeline by stage/ }).waitFor({ timeout: 15000 });
  const bar = mgr.locator('.hbar', { hasText: 'Available to claim' }).first();
  const teamAvail = Number(await bar.locator('.v').textContent());
  const navAvail = Number(await mgr.locator('.sidebar [data-count="pool"]').textContent());
  assert.equal(teamAvail, navAvail, `Team "Available to claim" (${teamAvail}) = Available list (${navAvail})`);
  const review = (await db.query(`select count(*)::int n from opportunities where stage='available' and needs_review`)).rows[0].n;
  await mgr.getByText(/Closed, parked and review/).click();
  assert.equal(Number(await mgr.locator('.hbar', { hasText: 'Waiting for review' }).locator('.v').textContent()), review);
  await shot(mgr, '08-manager-team');
});

await t('Manager: person panel, accountability, activity', async () => {
  await mgr.getByRole('tab', { name: 'People' }).click();
  await mgr.locator('tr[data-person]', { hasText: 'Flip' }).click();
  await drawer(mgr).getByRole('heading', { name: 'Numbers' }).waitFor({ timeout: 15000 });
  assert.match(mgr.url(), /#\/team\?person=/);
  assert.match(await drawer(mgr).textContent(), /Active leads/);
  assert.ok(await drawer(mgr).locator('.feed').count() >= 2, 'their logged work is listed');
  await shot(mgr, '09-manager-person');
  await mgr.keyboard.press('Escape');
  await mgr.waitForFunction(() => !document.querySelector('#drawer.on'));
  await mgr.getByRole('tab', { name: /^Accountability/ }).click();
  await mgr.getByRole('heading', { name: /Claims to review/ }).waitFor();
  await mgr.getByRole('tab', { name: 'Activity' }).click();
  assert.match(await mgr.locator('main').textContent(), /Flip/);
});

await t('Manager: sources tabs, review queue, refresh start, people and invite', async () => {
  await mgr.goto(BASE + '#/sources');
  await mgr.getByRole('heading', { name: 'Sources', exact: true }).waitFor({ timeout: 15000 });
  assert.match(await mgr.locator('main').textContent(), /SAM\.gov/);
  await shot(mgr, '10-manager-sources');
  await mgr.getByRole('tab', { name: /^Review queue/ }).click();
  await mgr.getByRole('heading', { name: /Waiting for review/ }).waitFor();
  await mgr.getByRole('tab', { name: 'Refresh runs' }).click();
  await mgr.getByRole('button', { name: 'Refresh all now' }).click();
  assert.match(await toast(mgr, /Refresh started/), /Refresh started/);
  await mgr.goto(BASE + '#/users');
  await mgr.getByRole('button', { name: 'Invite someone' }).click();
  await mgr.fill('[name=full_name]', 'New Rep'); await mgr.fill('[name=email]', 'newrep@ui.test');
  await mgr.getByRole('button', { name: 'Create invite link' }).click();
  await mgr.locator('#lnk').waitFor();
  assert.match(await mgr.inputValue('#lnk'), /#\/welcome\?type=invite&token_hash=/);
  await shot(mgr, '11-manager-invite-link');
  await mgr.getByRole('button', { name: 'Done' }).click();
});

await t('Discovery: coverage tab, documented evidence in the lead panel, search terms editor', async () => {
  const run = (await db.query(`select public.refresh_start_run('sam_gov', 'test') r`)).rows[0].r;
  const up = (await db.query(`select public.refresh_upsert_project($1, $2) r`, [run, {
    external_key: 'sam:ui-evidence', source_id: 'sam_gov', title: 'Concrete coring and saw cutting, Hangar 4, Patrick SFB', level: 'Federal', city: 'Patrick SFB', county: 'Brevard', zip: '32925',
    region: 'Central FL', stage: 'bidding', deadline: '2099-03-01T14:00:00-05:00', relevance: 'high', relevance_score: 6, category: 'Institutional & government',
    evidence: [{ term: 'core drilling', kind: 'direct', confidence: 'documented', field: 'description', doc: 'SAM.gov Solicitation description', snippet: '…Contractor shall core drill 14 penetrations through the existing hangar slab…', services: ['Core drilling'] },
               { term: 'renovation / alteration', kind: 'indicator', confidence: 'inferred', field: 'title', snippet: 'Hangar 4 renovation', services: ['GPR scanning'] }],
    opportunity: { kind: 'gov_bid', approach: 'bid_direct', title: 'Concrete coring and saw cutting, Hangar 4', next_action: 'Bid it' } }])).rows[0].r;
  const oid = (await db.query(`select id from opportunities where project_id = $1`, [up.project_id])).rows[0].id;
  await flip.goto(BASE + `#/available?lead=${oid}`);
  await flip.getByText('Documented in the source').waitFor({ timeout: 15000 });
  const panel = await flip.locator('.drawer').textContent();
  assert.match(panel, /core drill 14 penetrations/); assert.match(panel, /Inferred from the project type/); assert.match(panel, /Brevard County · 32925 · Central FL/);
  await flip.waitForTimeout(500);
  await shot(flip, '22-lead-evidence');
  await flip.keyboard.press('Escape');
  await mgr.goto(BASE + '#/sources');
  await mgr.getByRole('tab', { name: 'Coverage' }).click();
  await mgr.getByRole('heading', { name: 'Counties' }).waitFor();
  assert.equal(await mgr.locator('section:has(h2:text-is("Counties")) tbody tr').count(), 67);
  assert.match(await mgr.locator('main').textContent(), /USAspending\.gov federal construction awards/);
  await mgr.selectOption('select[data-act-change="covRegion"]', 'Central FL');
  assert.equal(await mgr.locator('section:has(h2:text-is("Counties")) tbody tr').count(), 10);
  await shot(mgr, '23-manager-coverage');
  await mgr.getByRole('tab', { name: 'Settings' }).click();
  await mgr.getByRole('heading', { name: 'Search terms' }).waitFor();
  await mgr.getByRole('button', { name: 'Add a term' }).click();
  await mgr.fill('[name=label]', 'helipad'); await mgr.fill('[name=pattern]', 'helipads?'); await mgr.fill('[name=services]', 'Slab sawing');
  await mgr.getByRole('button', { name: 'Save', exact: true }).click();
  await toast(mgr, /Search term saved/);
  assert.equal((await db.query(`select count(*)::int n from service_terms where label = 'helipad' and enabled`)).rows[0].n, 1);
  await mgr.locator('tr:has-text("helipad") button:has-text("Turn off")').click();
  await toast(mgr, /turned off/);
  assert.equal((await db.query(`select enabled from service_terms where label = 'helipad'`)).rows[0].enabled, false);
  await shot(mgr, '24-manager-search-terms');
});

await t('Manager reassigns with history from the lead panel; All leads table and columns work', async () => {
  await openLead(mgr, leadId);
  await drawer(mgr).getByRole('button', { name: 'More actions' }).click();
  await mgr.getByRole('menuitem', { name: 'Reassign' }).click();
  await mgr.selectOption('[name=user]', B.id);
  await mgr.fill('[name=reason]', 'Dana knows this GC');
  await mgr.getByRole('button', { name: 'Save', exact: true }).click();
  assert.match(await toast(mgr, /Ownership/), /Ownership updated/);
  await drawer(mgr).locator('.ownbar', { hasText: 'Dana Rep owns this' }).waitFor();
  await leadTab(mgr, 'Source and history');
  assert.match(await drawer(mgr).textContent(), /Dana knows this GC/);
  await mgr.goto(BASE + '#/all');
  await mgr.locator('table.tbl tbody tr').first().waitFor();
  await mgr.getByRole('button', { name: 'Choose columns' }).click();
  await mgr.locator('[data-col="source"]').check();
  await mgr.keyboard.press('Escape');
  assert.ok(await mgr.locator('table.tbl th', { hasText: 'Source' }).count() === 1, 'added column appears');
  await mgr.goto(BASE + '#/all?owner=' + B.id + '&tab=all');
  await mgr.locator('#lv-chips .fchip', { hasText: 'Assignee' }).waitFor();
  assert.ok(await mgr.locator('table.tbl tbody tr').count() >= 1);
  assert.doesNotMatch(mgr.url(), /owner=/, 'start-up filters are taken out of the address once applied');
});

let xlsxPath;
await t('Excel export: team workbook downloads in the workbook format', async () => {
  await mgr.goto(BASE + '#/files');
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
  await shot(mgr, '12-manager-import-preview');
  await mgr.getByRole('button', { name: 'Save these changes' }).click();
  await mgr.locator('#imp_out .alert.ok').waitFor();
  assert.match(await mgr.locator('#imp_out').textContent(), /1 notes added, 0 statuses changed/);
  await mgr.setInputFiles('#imp_file', edited);
  await mgr.locator('#imp_out table').first().waitFor();
  assert.match(await mgr.locator('#imp_out').textContent(), /Already in the timeline/);
  const st = (await db.query(`select stage from opportunities where id=$1`, [leadId])).rows[0].stage;
  assert.equal(st, 'quote_needed');
});

await t('Phone PDF view renders (team snapshot on a phone)', async () => {
  const p = await ctx(M, 'iPhone 13');
  await p.goto(BASE + '#/print/team');
  await p.locator('.print').waitFor({ timeout: 15000 });
  assert.match(await p.locator('.print').textContent(), /Snapshot from the Speedy Sales Portal/);
  await shot(p, '13-phone-pdf-view');
  await p.emulateMedia({ media: 'print' });
  await p.pdf({ path: `${SHOTS}/team-pipeline.pdf`, format: 'Letter' });
  await p.context().close();
});

await t('Company profile, team report and missed-opportunity check', async () => {
  await openLead(mgr, leadId);
  await drawer(mgr).locator('a.co-link').click();
  await drawer(mgr).getByRole('heading', { name: 'Contacts' }).waitFor({ timeout: 15000 });
  await shot(mgr, '15-desktop-company');
  await mgr.keyboard.press('Escape');
  await mgr.goto(BASE + '#/reports');
  await mgr.getByRole('heading', { name: 'By person' }).waitFor({ timeout: 15000 });
  assert.ok(await mgr.locator('tr[data-person]').count() >= 1);
  await shot(mgr, '16-desktop-report');
  await mgr.goto(BASE + '#/sources');
  await mgr.getByRole('tab', { name: 'Missed check' }).click();
  await mgr.fill('[data-form=missed] input[name=q]', 'https://www.examplecountybids.gov/bid/12345');
  await mgr.locator('[data-form=missed] button[type=submit]').click();
  await mgr.getByText('Source not monitored').first().waitFor();
  await mgr.getByRole('button', { name: 'Not relevant' }).click();
  assert.match(await toast(mgr, /not relevant/), /not relevant/);
  await mgr.getByRole('heading', { name: 'Recent checks' }).waitFor();
  await shot(mgr, '17-desktop-missed');
});

await t('Empty, signed-out and turned-off states', async () => {
  const fresh = await mk('empty@ui.test', 'New Person', 'sales');
  const p = await ctx(fresh, 'iPhone 13');
  await p.goto(BASE + '#/mine');
  await p.getByText('No leads here yet').waitFor({ timeout: 15000 });
  await p.goto(BASE + '#/today');
  await p.getByText('Claim a lead from Available to start your call list.').waitFor();
  await p.goto(BASE + '#/print/mine');
  await p.getByText('You have no claimed leads yet').waitFor();
  await db.query(`update profiles set active=false where id=$1`, [fresh.id]);
  await p.goto(BASE + '#/today'); await p.reload();
  await p.getByText('Your account is not active').waitFor();
  await p.context().close();
  const out = await ctx(null);
  await out.goto(BASE);
  await out.getByRole('heading', { name: 'Sign in' }).waitFor();
  assert.ok(await out.locator('.auth-brand img').evaluate(i => i.complete && i.naturalWidth > 0), 'logo loads');
  await shot(out, '14-desktop-sign-in');
  await out.context().close();
});

await t('Accessibility basics: every visible control has a name; panel traps focus', async () => {
  await mgr.goto(BASE + '#/pool');
  await mgr.locator('.li').first().waitFor();
  assert.deepEqual(await unnamedControls(mgr), []);
  await mgr.locator('.li a.li-co').first().focus();
  await mgr.keyboard.press('Enter');
  await drawer(mgr).locator('#dw_title').waitFor();
  await mgr.waitForFunction(() => document.getElementById('drawer').contains(document.activeElement));
  assert.deepEqual(await unnamedControls(mgr, '#drawer'), []);
  for (let i = 0; i < 40; i++) await mgr.keyboard.press('Tab');
  assert.ok(await mgr.evaluate(() => document.getElementById('drawer').contains(document.activeElement)), 'Tab stays inside the open panel');
  await mgr.keyboard.press('Escape');
  for (const route of ['today', 'mine', 'gov', 'more']) {
    await flip.goto(BASE + '#/' + route);
    await flip.waitForTimeout(700);
    assert.ok(await noSideScroll(flip), 'no sideways scrolling on ' + route);
  }
});

await t('No script errors in any session', async () => {
  assert.deepEqual(pageErrors, []);
});

console.log(JSON.stringify({ xlsxPath }));
await browser.close(); await db.end();
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
