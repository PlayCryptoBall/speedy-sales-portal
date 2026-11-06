/* Manager pages (team, sources, people) plus files and account. */
(function () {
  const { esc } = P;
  const mgrOnly = (view) => { if (P.isMgr()) return false; view.innerHTML = P.empty('Managers only', 'Ask a manager if you need something from this page.', '<br><a class="btn" href="#/today">Go to Today</a>'); return true; };

  // ---------------------------------------------------------------- Team overview
  function spark(points, key, color) {
    if (points.length < 2) return '';
    const w = 280, h = 56, vals = points.map(p => p[key]), max = Math.max(...vals, 1), min = Math.min(...vals, 0);
    const xy = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - 4 - ((v - min) / (max - min || 1)) * (h - 8)}`).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="${esc(key)} trend"><polyline points="${xy}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
  }
  P.views.team = async (view) => {
    P.setTitle('Team');
    if (mgrOnly(view)) return;
    view.innerHTML = P.loading(4);
    const t = await P.rpc('team_overview');
    const trend = t.pool_trend || [];
    const first = trend[0], last = trend[trend.length - 1];
    const delta = first && last && trend.length > 1 ? last.available - first.available : null;
    view.innerHTML = `
      <section class="section"><header><h2>Pipeline by stage</h2></header>
        <div class="chips">${(P.state.me.stages || []).map(s => `<a class="tag" style="font-size:.9rem;padding:6px 10px;text-decoration:none" href="#/all?tab=all">${esc(s.label)} <b>${t.pipeline[s.key] || 0}</b></a>`).join('')}</div></section>
      <section class="section"><header><h2>People</h2><a class="btn small" href="#/users">Manage access</a></header>
        <div class="scroll-x sheet"><table class="data"><thead><tr><th>Name</th><th>Open</th><th>Calls, 7 days</th><th>Activity, 7 / 30 days</th><th>Quotes open</th><th>Quoted</th><th>Won</th><th>Lost</th><th>Overdue</th><th>Stale</th><th>Last seen</th></tr></thead><tbody>
        ${t.people.map(p => `<tr><td><b>${esc(p.name || p.email)}</b><div class="small muted">${p.role === 'manager' ? 'Manager' : 'Sales'}${p.active ? '' : ', turned off'}</div></td><td>${p.open}</td><td>${p.calls_7d}</td><td>${p.activities_7d} / ${p.activities_30d}</td><td>${p.quotes_open}</td><td>${esc(P.money(p.quoted_value) || '$0')}</td><td>${p.won}${p.won_value ? `<div class="small muted">${esc(P.money(p.won_value))}</div>` : ''}</td><td>${p.lost}</td><td>${p.overdue ? `<span class="tag bad">${p.overdue}</span>` : 0}</td><td>${p.stale ? `<span class="tag bad">${p.stale}</span>` : 0}</td><td class="small">${p.last_seen_at ? esc(P.ago(p.last_seen_at)) : 'Never'}</td></tr>`).join('')}
        </tbody></table></div></section>
      <section class="section"><header><h2>Claims to review <span class="muted">${t.stale_list.length}</span></h2></header>
        <p class="muted small">No logged activity for ${t.stale_days}+ days. Nothing is released automatically: check in, reassign, or release.</p>
        ${t.stale_list.length ? `<div class="sheet">${t.stale_list.map(s => `<div class="lead" style="cursor:default"><div class="paint" style="background:var(--red)"></div><div><div class="co"><a href="#/lead/${s.id}">${esc(s.ref)}</a> ${esc(s.company_name || '')}</div><div class="pj">${esc(s.title)}</div>
          <div class="meta"><span>${esc(s.owner_name)}</span><span>${esc(P.stageLabel(s.stage))}</span><span>Claimed ${esc(P.date(s.claimed_at))}</span><span>${s.last_activity_at ? 'Last activity ' + esc(P.ago(s.last_activity_at)) : 'Never worked'}</span></div></div>
          <div class="side"><a class="btn small" href="#/lead/${s.id}">Open</a></div></div>`).join('')}</div>` : '<p class="muted">Every claim has recent activity.</p>'}</section>
      <section class="section"><header><h2>Available pool</h2></header>
        <div class="panel">${trend.length ? `<p>As of ${esc(P.dateTime(last.created_at))}: ${last.available} available (${last.available_hot} Hot), ${last.claimed_open} being worked, ${last.review_queue} waiting for review.
          ${delta === null ? 'The trend line starts after the second daily snapshot.' : delta < 0 ? `<b>Down ${-delta}</b> since ${esc(P.date(first.day))}: claims are outpacing discovery.` : `Up ${delta} since ${esc(P.date(first.day))}.`}</p>
          ${spark(trend, 'available', '#1D5FB4')}<p class="small muted">Discovery depends on what agencies and builders publish. There is no fixed daily number of new leads.</p>` : '<p class="muted">No snapshots yet. The first one is taken at the next refresh or daily upkeep.</p>'}</div></section>
      <section class="section"><header><h2>Where leads come from</h2><a class="btn small" href="#/sources">Sources and refreshes</a></header>
        <div class="scroll-x sheet"><table class="data"><thead><tr><th>Source</th><th>Total</th><th>Available</th><th>Hot available</th><th>Worked</th><th>Contacted</th><th>Quoted</th><th>Won</th><th>Added, 30 days</th></tr></thead><tbody>
        ${t.source_productivity.filter(s => s.total).map(s => `<tr><td>${esc(s.name)}</td><td>${s.total}</td><td>${s.available}</td><td>${s.hot_available}</td><td>${s.worked}</td><td>${s.contacted}</td><td>${s.quoted}</td><td>${s.won}</td><td>${s.added_30d}</td></tr>`).join('')}
        </tbody></table></div></section>
      <section class="section"><header><h2>Recent team activity</h2></header>
        ${t.recent.length ? `<div class="sheet">${t.recent.map(a => `<div class="lead" role="link" tabindex="0" data-href="#/lead/${a.opportunity_id}"><div class="paint"></div><div><div class="small muted">${esc(P.dateTime(a.at))} · ${esc(a.user_name)} · ${esc(a.ref || '')}</div><div><b>${esc(a.kind)}</b>${a.outcome ? ': ' + esc(a.outcome.replace(/_/g, ' ')) : ''}${a.to_stage ? ' to ' + esc(P.stageLabel(a.to_stage)) : ''} ${esc(a.title || '')}</div>${a.body ? `<div class="small">${esc(a.body)}</div>` : ''}</div><div></div></div>`).join('')}</div>` : '<p class="muted">No activity logged yet.</p>'}</section>`;
  };

  // ---------------------------------------------------------------- Sources and refreshes
  let pollTimer;
  P.views.sources = async (view) => {
    P.setTitle('Sources and refreshes');
    if (mgrOnly(view)) return;
    view.innerHTML = P.loading(4);
    const s = await P.rpc('sources_status');
    const running = s.runs.some(r => r.status === 'running');
    clearTimeout(pollTimer);
    if (running) pollTimer = setTimeout(() => P.parseHash().name === 'sources' && P.route(), 10000);
    const health = (x) => x.kind !== 'automated' ? `<span class="tag">${x.kind === 'needs_credentials' ? 'Needs logins or paid access' : x.kind === 'legacy' ? 'One-time import' : 'Manual review'}</span>`
      : x.last_status === 'failed' ? `<span class="tag bad">Failed${x.consecutive_failures > 1 ? ` ${x.consecutive_failures}x` : ''}</span>` : x.last_status === 'partial' ? '<span class="tag taken">Partly worked</span>'
      : x.last_status === 'success' ? '<span class="tag won">Working</span>' : '<span class="tag">Not run yet</span>';
    const fr = s.freshness;
    view.innerHTML = `
      ${running ? '<div class="alert info">A refresh is running. This page updates every 10 seconds.</div>' : ''}
      <section class="section"><header><h2>Freshness of open leads</h2></header>
        <div class="stats"><div class="stat"><b>${fr.verified_7d}</b><span>Verified in the last 7 days</span></div><div class="stat"><b>${fr.verified_30d}</b><span>Verified 8 to 30 days ago</span></div>
          <div class="stat"><b>${fr.never + fr.older}</b><span>Older or never re-verified</span></div><div class="stat ${fr.failed ? 'alarm' : ''}"><b>${fr.failed}</b><span>Last check failed or source missing</span></div></div>
        <p class="small muted">A record counts as verified only when a refresh read it successfully from its source. Failed checks never update this date.</p></section>
      <section class="section"><header><h2>Sources</h2><div class="row"><button class="btn small" data-act="runUpkeep">Run daily upkeep</button><button class="btn small primary" data-act="runRefresh" data-source="all">Refresh all now</button></div></header>
        <div class="sheet">${s.sources.map(x => `<div class="lead" style="cursor:default;grid-template-columns:6px 1fr auto"><div class="paint" style="background:${x.last_status === 'failed' ? 'var(--red)' : x.kind === 'automated' ? 'var(--green)' : 'var(--line)'}"></div>
          <div><div class="co">${esc(x.name)} ${health(x)}</div><div class="small">${esc(x.coverage)}</div>
          <div class="meta"><span>${esc(x.schedule_note)}</span>${x.last_success_at ? `<span>Last success ${esc(P.ago(x.last_success_at))}</span>` : ''}${x.last_run_at ? `<span>Last run ${esc(P.ago(x.last_run_at))}</span>` : ''}</div>
          ${x.access_notes ? `<div class="small muted">${esc(x.access_notes)}</div>` : ''}${x.last_error ? `<div class="small" style="color:var(--red)">Last error: ${esc(x.last_error)}</div>` : ''}</div>
          <div class="side">${x.kind === 'automated' ? `<button class="btn small" data-act="runRefresh" data-source="${x.id}">Run now</button>` : x.kind !== 'legacy' ? '<button class="btn small" data-act="addLead">Add a find</button>' : ''}</div></div>`).join('')}</div></section>
      <section class="section"><header><h2>Waiting for review <span class="muted">${s.review.length}</span></h2></header>
        <p class="small muted">New finds the refresh could not confirm as concrete work, cancellations, and notices that disappeared. Salespeople do not see unreviewed new finds in the pool.</p>
        ${s.review.length ? `<div class="sheet">${s.review.map(r => `<div class="lead" style="cursor:default"><div class="paint ${esc(r.priority)}"></div><div><div class="co"><a href="#/lead/${r.id}">${esc(r.ref)}</a> ${esc(r.title)}</div><div class="small">${esc(r.review_reason || '')}</div>
          <div class="meta"><span>${esc(r.owner_name || 'Unowned')}</span><span>${esc(P.stageLabel(r.stage))}</span>${r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" rel="noopener">Source</a>` : ''}</div></div>
          <div class="side"><button class="btn small" data-act="review" data-id="${r.id}" data-a="publish">${r.review_kind === 'discovery' ? 'Publish' : 'Keep'}</button><button class="btn small danger" data-act="review" data-id="${r.id}" data-a="archive">Archive</button></div></div>`).join('')}</div>` : '<p class="muted">Nothing to review.</p>'}</section>
      <section class="section"><header><h2>Refresh runs</h2></header>
        ${s.runs.length ? `<div class="scroll-x sheet"><table class="data"><thead><tr><th>Started</th><th>Source</th><th>How</th><th>Result</th><th>Read</th><th>New</th><th>Updated</th><th>Merged</th><th>Flagged</th><th>Errors</th><th></th></tr></thead><tbody>
          ${s.runs.map(r => `<tr><td class="small">${esc(P.dateTime(r.started_at))}</td><td>${esc(s.sources.find(x => x.id === r.source_id)?.name || r.source_id)}</td><td class="small">${esc(r.trigger)}${r.attempt > 1 ? ' #' + r.attempt : ''}</td>
            <td>${r.status === 'success' ? '<span class="tag won">Success</span>' : r.status === 'running' ? '<span class="tag info">Running</span>' : r.status === 'partial' ? '<span class="tag taken">Partial</span>' : '<span class="tag bad">Failed</span>'}</td>
            <td>${r.fetched}</td><td>${r.discovered}</td><td>${r.updated}</td><td>${r.merged}</td><td>${r.flagged}</td><td>${r.errors}</td><td><button class="btn small" data-act="runLog" data-id="${r.id}">Log</button></td></tr>`).join('')}
          </tbody></table></div>` : '<p class="muted">No refreshes yet.</p>'}</section>
      <section class="section"><header><h2>Recent source changes</h2></header>
        ${s.changes.length ? `<div class="sheet">${s.changes.filter(c => c.material).slice(0, 30).map(c => `<div class="lead" style="cursor:default"><div class="paint" style="background:var(--orange)"></div><div><div class="small muted">${esc(P.dateTime(c.at))}</div><div><b>${esc(c.project_title)}</b></div><div class="small">${esc(c.field)}: ${c.old ? esc(String(c.old).slice(0, 80)) + ' to ' : ''}${esc(String(c.new).slice(0, 140))}</div>
          <div class="meta">${(c.opps || []).map(o => `<a href="#/lead/${o.id}">${esc(o.ref)}</a> ${esc(o.owner_name || 'unowned')}`).join(' ')}</div></div><div></div></div>`).join('') || '<p class="muted" style="padding:12px">No material changes yet.</p>'}</div>` : '<p class="muted">No changes recorded yet.</p>'}</section>
      <section class="section"><header><h2>Settings</h2></header><div class="panel">
        <div class="grid2"><label class="field"><span>Suggest review of claims with no activity after (days)</span><input type="number" id="st_stale" min="3" max="90" value="${esc(s.settings.stale_days?.value)}"></label>
        <label class="field"><span>Most open leads one person can hold</span><input type="number" id="st_max" min="5" max="500" value="${esc(s.settings.max_open_claims?.value)}"></label></div>
        <button class="btn" data-act="saveSettings">Save settings</button></div></section>`;
    P.state.runs = s.runs;
  };
  P.act.runRefresh = (btn) => P.busy(btn, async () => {
    await P.fn('refresh', { source: btn.dataset.source });
    P.toast('Refresh started. Results show here in a few minutes.');
    setTimeout(() => P.route(), 2500);
  });
  P.act.runUpkeep = (btn) => P.busy(btn, async () => {
    const r = await P.rpc('daily_maintenance');
    P.invalidate(); P.toast(`Upkeep done: ${r.bids_closed} bids closed, ${r.stale} stale claims flagged, ${r.due} follow-ups due.`); P.route();
  });
  P.act.runLog = (el) => {
    const r = P.state.runs.find(x => String(x.id) === el.dataset.id);
    P.dialog({ title: 'Refresh log', body: `${r.error ? `<div class="alert error">${esc(r.error)}</div>` : ''}<pre class="log">${esc((r.log || []).join('\n') || 'No log lines.')}</pre>`, ok: '', cancel: 'Close' });
  };
  P.act.review = (el) => P.busy(el, async () => { await P.rpc('resolve_review', { p_id: el.dataset.id, p_action: el.dataset.a, p_note: null }); P.invalidate(); P.toast(el.dataset.a === 'archive' ? 'Archived.' : 'Done.'); P.route(); });
  P.act.saveSettings = (el) => P.busy(el, async () => {
    await P.rpc('update_setting', { p_key: 'stale_days', p_value: Number(document.getElementById('st_stale').value) });
    await P.rpc('update_setting', { p_key: 'max_open_claims', p_value: Number(document.getElementById('st_max').value) });
    P.toast('Settings saved.');
  });
  P.act.addLead = () => P.dialog({
    title: 'Add a lead you found', ok: 'Add lead',
    body: '<p class="small muted">For a project from the news, a local bid board, a permit or a referral. The source link is required so everyone can check it.</p>',
    fields: [
      { name: 'project_title', label: 'Project', required: true }, { name: 'source_url', label: 'Source link', type: 'url', required: true },
      { name: 'source_id', label: 'Where it came from', type: 'select', options: [['private_news', 'News or owner announcement'], ['local_portals', 'County, city, airport, school or university bid board'], ['fdot_bid_notices', 'FDOT or Turnpike bid notice'], ['portal_manual', 'Other']] },
      { name: 'company_name', label: 'Builder or company to call' }, { name: 'company_kind', label: 'That company is', type: 'select', options: [['contractor', 'The builder or contractor'], ['developer', 'The owner or developer'], ['agency', 'A public agency']] },
      { name: 'contact_name', label: 'Contact name' }, { name: 'contact_phone', label: 'Contact phone', type: 'tel' }, { name: 'contact_email', label: 'Contact email', type: 'email' },
      { name: 'owner_name', label: 'Project owner' }, { name: 'city', label: 'City' },
      { name: 'region', label: 'Region', type: 'select', options: P.REGIONS.map(r => [r, r]), value: 'Central FL' },
      { name: 'project_stage', label: 'Project stage', type: 'select', options: Object.entries(P.PSTAGE) , value: 'unknown' },
      { name: 'source_summary', label: 'What the source says', type: 'textarea', placeholder: 'Paste or summarize the facts. Keep guesses out of this box.' },
      { name: 'speedy_scope', label: 'Why it may need Speedy (your read)', type: 'textarea' },
      { name: 'next_action', label: 'Recommended next action' },
    ],
    onOk: async (v) => {
      const body = { ...v, approach: v.company_kind === 'developer' ? 'approach_developer' : 'approach_prime', kind: v.company_kind === 'developer' ? 'private_project' : 'contractor_outreach' };
      let r = await P.rpc('add_lead', { p: body });
      if (!r.ok && r.reason === 'possible_duplicate') {
        const ok = await P.confirm('This may already be in the portal', r.matches.map(m => `${esc(m.title)} ${(m.opps || []).map(o => esc(o.ref)).join(', ')}`).join('<br>') + '<br><br>Add it anyway only if it is a different job.', 'Add anyway');
        if (!ok) return false;
        r = await P.rpc('add_lead', { p: { ...body, force: true } });
      }
      P.invalidate(); P.toast(`Added as ${r.ref}.`); return r;
    },
  }).then(r => r?.id && P.go('#/lead/' + r.id));

  // ---------------------------------------------------------------- People and access
  P.views.users = async (view) => {
    P.setTitle('People and access');
    if (mgrOnly(view)) return;
    view.innerHTML = P.loading(3);
    const users = P.state.users = await P.rpc('list_users');
    view.innerHTML = `
      <div class="row" style="margin-bottom:12px"><p class="muted grow" style="margin:0">Each person signs in with their own email and password. Invite and reset links work once; send them by text or email.</p><button class="btn primary" data-act="invite">Invite someone</button></div>
      <div class="sheet">${users.map(u => `<div class="lead" style="cursor:default"><div class="paint" style="background:${u.active ? (u.role === 'manager' ? 'var(--ink)' : 'var(--blue)') : 'var(--line)'}"></div>
        <div><div class="co">${esc(u.full_name || u.email)} ${u.id === P.state.me.id ? '<span class="tag">You</span>' : ''}</div><div class="small">${esc(u.email)}${u.phone ? ', ' + esc(u.phone) : ''}</div>
          <div class="meta"><span>${u.role === 'manager' ? 'Manager' : 'Salesperson'}</span><span>${u.active ? 'Active' : 'Turned off'}</span><span>${u.open} open leads</span><span>${u.last_seen_at ? 'Last seen ' + esc(P.ago(u.last_seen_at)) : 'Has not signed in yet'}</span></div></div>
        <div class="side">${u.id !== P.state.me.id ? `${u.active ? `<button class="btn small" data-act="resetLink" data-id="${u.id}">${u.last_seen_at ? 'Reset link' : 'New invite link'}</button>` : ''}
          <button class="btn small" data-act="setRole" data-id="${u.id}" data-role="${u.role === 'manager' ? 'sales' : 'manager'}">${u.role === 'manager' ? 'Make salesperson' : 'Make manager'}</button>
          <button class="btn small ${u.active ? 'danger' : ''}" data-act="${u.active ? 'deactivate' : 'reactivate'}" data-id="${u.id}">${u.active ? 'Turn off' : 'Turn on'}</button>` : '<a class="btn small" href="#/me">My account</a>'}</div></div>`).join('')}</div>
      <p class="small muted" style="margin-top:12px">Turning someone off signs them out everywhere at once. Their leads stay assigned to them until you reassign or release them from Team or All leads.</p>`;
  };
  const showLink = (title, link, user) => {
    const first = (user?.full_name || '').split(' ')[0] || '';
    const msg = `Hi ${first}, here is your link to the Speedy sales portal. It works once: ${link}`;
    const done = P.dialog({ title, ok: '', cancel: 'Done',
      body: `<p>Send this to ${esc(user?.full_name || user?.email || 'them')}. It works once and expires (one hour by default), so send it now. If it expires, make a new one here.</p>
        <label class="field"><span>Link</span><input type="text" readonly value="${esc(link)}" id="lnk"></label>
        <div class="row"><button class="btn primary" type="button" id="cp">Copy link</button>
        ${user?.phone ? `<a class="btn" href="sms:${esc(user.phone)}?&body=${encodeURIComponent(msg)}">Text it</a>` : ''}
        <a class="btn" href="mailto:${esc(user?.email || '')}?subject=${encodeURIComponent('Your Speedy sales portal link')}&body=${encodeURIComponent(msg)}">Email it</a></div>` });
    const b = document.getElementById('cp'), inp = document.getElementById('lnk');
    inp.addEventListener('focus', () => inp.select());
    b.onclick = async () => { try { await navigator.clipboard.writeText(link); b.textContent = 'Copied'; } catch { inp.select(); b.textContent = 'Press and hold the link to copy'; } };
    return done;
  };
  P.act.invite = () => P.dialog({
    title: 'Invite someone', ok: 'Create invite link',
    fields: [{ name: 'full_name', label: 'Name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true },
             { name: 'phone', label: 'Mobile number (to text the link)', type: 'tel' },
             { name: 'role', label: 'Role', type: 'select', options: [['sales', 'Salesperson'], ['manager', 'Manager']], value: 'sales' }],
    onOk: async (v) => { const r = await P.fn('admin-users', { action: 'invite', ...v }); return { ...r, user: v }; },
  }).then(r => { if (r?.link) { showLink('Invite link ready', r.link, r.user); P.route(); } });
  P.act.resetLink = (el) => P.busy(el, async () => {
    const u = P.state.users.find(x => x.id === el.dataset.id);
    const r = await P.fn('admin-users', { action: 'reset_link', user_id: u.id });
    showLink(u.last_seen_at ? 'Password reset link' : 'New invite link', r.link, u);
  });
  P.act.setRole = (el) => P.busy(el, async () => { await P.fn('admin-users', { action: 'set_role', user_id: el.dataset.id, role: el.dataset.role }); P.toast('Role updated.'); P.route(); });
  P.act.deactivate = async (el) => {
    const u = P.state.users.find(x => x.id === el.dataset.id);
    if (!await P.confirm(`Turn off ${u.full_name || u.email}?`, `They are signed out on every device right away and cannot sign back in. Their ${u.open} open leads stay assigned until you move them.`, 'Turn off', true)) return;
    P.busy(el, async () => { const r = await P.fn('admin-users', { action: 'deactivate', user_id: u.id }); P.toast(r.note || 'Turned off.'); P.route(); });
  };
  P.act.reactivate = (el) => P.busy(el, async () => { await P.fn('admin-users', { action: 'reactivate', user_id: el.dataset.id }); P.toast('Turned on. Send them a reset link if they forgot their password.'); P.route(); });

  // ---------------------------------------------------------------- Files: Excel, PDF, import
  P.views.files = async (view) => {
    P.setTitle('Excel and PDF');
    const mgr = P.isMgr();
    view.innerHTML = `
      <p class="muted">The portal is the live record. Files are snapshots: each one is stamped with the time it was made, and anything changed later shows up in the portal, not in the file.</p>
      <section class="section"><header><h2>My pipeline</h2></header><div class="panel row">
        <button class="btn primary" data-act="exportXlsx" data-scope="mine">Download Excel</button><a class="btn" href="#/print/mine">Phone PDF</a>
        <span class="small muted grow">Your claimed leads in Flip's workbook format: This Week, Sales Leads and Gov Contracts, with yellow columns for call notes.</span></div></section>
      ${mgr ? `<section class="section"><header><h2>Whole team</h2></header><div class="panel row">
        <button class="btn primary" data-act="exportXlsx" data-scope="team">Download team Excel</button><a class="btn" href="#/print/team">Team PDF</a>
        <span class="small muted grow">Every open lead, available or claimed, with owners. Good for emailing to someone without a login.</span></div></section>` : ''}
      <section class="section"><header><h2>Bring call notes back from a workbook</h2></header><div class="panel">
        <p class="small">Upload a workbook exported from the portal (or the older pipeline workbook). You see every proposed change first. New notes are added to the timeline; a status or follow-up date only changes when the sheet's Last Contact is newer than what the portal has. ${mgr ? 'Managers can import for any lead.' : 'Only rows for your own leads are imported.'}</p>
        <label class="field"><span>Workbook (.xlsx)</span><input type="file" id="imp_file" accept=".xlsx"></label>
        <div id="imp_out"></div></div></section>`;
    document.getElementById('imp_file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; P.importPreview(f); };  // reset so the same file can be picked again
  };
  P.act.exportXlsx = (btn) => P.busy(btn, async () => {
    const data = await P.rpc('export_rows', { p_scope: btn.dataset.scope });
    if (!data.rows.length) { P.toast(btn.dataset.scope === 'mine' ? 'You have no claimed leads to export yet.' : 'Nothing to export.', 'error'); return; }
    await P.buildWorkbook(data);
    P.toast(`Downloaded ${data.rows.length} leads.`);
  });

  P.views.print = async (view, r) => {
    const scope = r.arg === 'team' ? 'team' : 'mine';
    P.setTitle(scope === 'team' ? 'Team PDF' : 'My pipeline PDF', true);
    view.innerHTML = P.loading(3);
    const data = await P.rpc('export_rows', { p_scope: scope });
    view.innerHTML = `<div class="noprint row" style="margin-bottom:12px"><button class="btn primary" data-act="print">Save as PDF or print</button><span class="small muted">On a phone: Share, then Print, then save or share the PDF.</span></div>` + P.printHtml(data);
  };
  P.act.print = () => window.print();

  // ---------------------------------------------------------------- account
  P.views.me = async (view) => {
    P.setTitle('My account');
    const m = P.state.me;
    view.innerHTML = `<div class="panel" style="max-width:560px">
      <label class="field"><span>Name</span><input type="text" id="me_name" value="${esc(m.full_name)}"></label>
      <label class="field"><span>Mobile number</span><input type="tel" id="me_phone" value="${esc(m.phone || '')}"></label>
      <p class="small muted">Signed in as ${esc(m.email)} (${m.role === 'manager' ? 'manager' : 'salesperson'}).</p>
      <div class="row"><button class="btn primary" data-act="saveMe">Save</button><button class="btn" data-act="changePw">Change password</button><button class="btn danger" data-act="signOut">Sign out</button></div></div>`;
  };
  P.act.saveMe = (el) => P.busy(el, async () => {
    P.state.me = { ...P.state.me, ...(await P.rpc('update_my_profile', { p_full_name: document.getElementById('me_name').value, p_phone: document.getElementById('me_phone').value })) };
    P.toast('Saved.');
  });
  P.act.changePw = () => P.dialog({ title: 'Change password', ok: 'Change password',
    fields: [{ name: 'pw', label: 'New password (at least 10 characters)', type: 'password', required: true }, { name: 'pw2', label: 'Type it again', type: 'password', required: true }],
    onOk: async (v) => {
      if (v.pw.length < 10) throw new Error('Use at least 10 characters.');
      if (v.pw !== v.pw2) throw new Error('The two passwords do not match.');
      const { error } = await P.sb.auth.updateUser({ password: v.pw });
      if (error) throw new Error(error.message);
    } }).then(v => v && P.toast('Password changed.'));
  P.act.signOut = async () => { await P.sb.auth.signOut(); location.hash = '#/'; location.reload(); };
})();
