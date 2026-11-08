/* Manager pages (Team, Sources, People and access) plus Excel and PDF, and the account page. */
(function () {
  const { esc, ui } = P;
  const mgrOnly = (view, title) => { if (P.isMgr()) return false; view.innerHTML = P.pageHead({ title }) + P.empty('Managers only', 'Ask a manager if you need something from this page.', '<a class="btn" href="#/today">Go to Today</a>'); return true; };
  const tabsHtml = (act, cur, list) => `<div class="tabs" role="tablist">${list.map(([k, t, n]) => `<button class="tab" role="tab" data-act="${act}" data-tab="${k}" aria-selected="${cur === k}">${esc(t)}${n != null ? ` <span class="n">${n}</span>` : ''}</button>`).join('')}</div>`;
  const sec = (title, body, { n, tools = '', note = '', id = '' } = {}) => `<section class="section" ${id ? `id="${id}"` : ''}><div class="sec-head"><h2>${esc(title)}${n != null ? ` <span class="n">${n}</span>` : ''}</h2><div class="tools">${tools}</div></div>${note ? `<p class="sec-note">${note}</p>` : ''}${body}</section>`;
  const hbars = (rows, { max, href } = {}) => {
    const m = max || Math.max(1, ...rows.map(r => r[1]));
    return `<div class="hbars">${rows.map(([label, v, cls = '', key]) => {
      const inner = `<span class="lab" title="${esc(label)}">${esc(label)}</span><span class="trk"><i class="${cls}" style="width:${Math.min(100, (v / m) * 100)}%;${v ? '' : 'min-width:0'}"></i></span><span class="v">${v}</span>`;
      return href && key ? `<a class="hbar" href="${href(key)}" style="color:inherit;text-decoration:none">${inner}</a>` : `<div class="hbar">${inner}</div>`;
    }).join('')}</div>`;
  };

  // ---------------------------------------------------------------- Team
  const TEAM_TABS = [['overview', 'Overview'], ['people', 'People'], ['accountability', 'Accountability'], ['pool', 'Pool and sources'], ['activity', 'Activity']];
  P.views.team = async (view, r) => {
    if (mgrOnly(view, 'Team')) return;
    P.setPage('Team');
    if (r.params.tab && TEAM_TABS.some(t => t[0] === r.params.tab)) { P.state.teamTab = r.params.tab; P.cleanHash(); }
    view.innerHTML = P.loadingPage('Team');
    const [t] = await Promise.all([P.rpc('team_overview'), P.loadBoard()]);
    P.state.team = t;
    if (P.state.page !== 'team') return;
    renderTeam(view);
    P.state.rerender = async () => { try { P.state.team = await P.rpc('team_overview'); } catch { /* keep old */ } if (P.state.page === 'team') renderTeam(view); };
  };
  P.act.teamTab = (el) => { P.state.teamTab = el.dataset.tab; renderTeam(document.getElementById('view')); document.querySelector(`.tab[data-tab="${el.dataset.tab}"]`)?.focus(); };

  function teamFacts(t) {
    const board = P.state.board || [], today = P.todayET();
    const active = board.filter(r => P.ACTIVE.includes(r.stage));
    const overdue = active.filter(r => r.next_action_due && r.next_action_due < today);
    const stalled = active.filter(r => r.stale);
    const attention = new Set([...overdue, ...stalled].map(r => r.id));
    const people = t.people.filter(p => p.active);
    return { board, today, active, overdue, stalled, attention, people };
  }

  function renderTeam(view) {
    const t = P.state.team, tab = P.state.teamTab || 'overview', F = teamFacts(t);
    const pl = t.pipeline || {};
    const body = { overview: teamOverview, people: teamPeople, accountability: teamAccount, pool: teamPool, activity: teamActivity }[tab](t, F, pl);
    view.innerHTML = `${P.pageHead({ title: 'Team', sub: 'Who is working on what, what needs a nudge, and how the pipeline is moving.', actions: '<a class="btn" href="#/users">People and access</a>' })}
      ${tabsHtml('teamTab', tab, TEAM_TABS.map(([k, l]) => [k, l, k === 'accountability' ? (t.stale_list.length + F.overdue.length) || null : null]))}${body}`;
  }

  function teamOverview(t, F, pl) {
    const sum = (ks) => ks.reduce((s, k) => s + (pl[k] || 0), 0);
    const total = Object.values(pl).reduce((s, n) => s + n, 0);
    const won = t.people.reduce((s, p) => s + p.won, 0), lost = t.people.reduce((s, p) => s + p.lost, 0);
    const wonValue = t.people.reduce((s, p) => s + Number(p.won_value || 0), 0), quoted = t.people.reduce((s, p) => s + Number(p.quoted_value || 0), 0);
    const sales = F.people.filter(p => p.role !== 'manager').length;
    const main = [['Available to claim', pl.available || 0, 'muted', 'available'], ...P.ACTIVE.map(k => [P.stageLabel(k), pl[k] || 0, '', k]), ['Won', pl.won || 0, 'ok', 'won']];
    const rest = [['Waiting for review', pl.in_review || 0, 'muted', null], ...['lost', 'nurture', 'disqualified', 'archived'].map(k => [P.stageLabel(k), pl[k] || 0, 'muted', k])];
    const href = (k) => k === 'available' ? '#/all?stage=available&tab=open' : `#/all?stage=${k}&tab=all`;
    const work = F.people.filter(p => p.open || p.role !== 'manager').sort((a, b) => b.open - a.open);
    return `<div class="kpis five">
        <div class="kpi"><div class="lbl">Active members</div><div class="val">${F.people.length}</div><div class="sub">${P.plural(sales, 'salesperson', 'salespeople')}, ${P.plural(F.people.length - sales, 'manager')}</div></div>
        <a class="kpi" href="#/all?tab=claimed"><div class="lbl">Leads being worked</div><div class="val">${sum(P.ACTIVE)}</div><div class="sub">Claimed through follow-up</div></a>
        <button class="kpi ${F.attention.size ? 'attn' : ''}" data-act="teamTab" data-tab="accountability"><div class="lbl">Needs action</div><div class="val">${F.attention.size}</div><div class="sub">${F.overdue.length} overdue, ${F.stalled.length} stalled</div></button>
        <button class="kpi" data-act="teamTab" data-tab="accountability"><div class="lbl">Claims to review</div><div class="val">${t.stale_list.length}</div><div class="sub">No activity for ${t.stale_days}+ days</div></button>
        <a class="kpi" href="#/all?tab=all&stage=quote_needed"><div class="lbl">Quotes in progress</div><div class="val">${sum(['quote_needed', 'quote_sent'])}</div><div class="sub">${pl.quote_needed || 0} to price, ${pl.quote_sent || 0} sent</div></a></div>
      <div class="cols">
        <div class="stack">
          <section class="card card-pad"><div class="sec-head"><h2>Pipeline by stage <span class="n">${total} opportunities</span></h2></div>
            <p class="sec-note">Each opportunity is counted once, by its current stage. "Available to claim" is the pool salespeople see; new finds waiting for a manager's review are counted separately.</p>
            ${hbars(main, { href })}
            <details class="plain" style="margin-top:14px"><summary>Closed, parked and review (${sum(['lost', 'nurture', 'disqualified', 'archived', 'in_review'])})</summary><div style="margin-top:10px">${hbars(rest, { href, max: Math.max(1, ...main.map(m => m[1])) })}</div></details></section>
        </div>
        <div class="stack">
          <section class="card card-pad"><div class="sec-head"><h2>Sales results</h2></div>
            <div class="metricgrid">
              <div><div class="lbl">Won</div><div class="val">${won}</div></div>
              <div><div class="lbl">Won value</div><div class="val">${esc(P.money(wonValue) || '$0')}</div></div>
              <div><div class="lbl">Lost</div><div class="val">${lost}</div></div>
              <div><div class="lbl">Quoted value</div><div class="val">${esc(P.money(quoted) || '$0')}</div></div>
              <div><div class="lbl">Win rate</div><div class="val">${won + lost ? Math.round(100 * won / (won + lost)) + '%' : '—'}</div></div>
              <div><div class="lbl">Quotes sent</div><div class="val">${pl.quote_sent || 0}</div></div></div>
            <p class="sec-note" style="margin:10px 0 0">Values are Speedy's own quote amounts as logged by the team. Win rate is won ÷ (won + lost)${won + lost ? '' : '; it shows once leads are closed'}.</p></section>
          <section class="card card-pad"><div class="sec-head"><h2>Workload</h2><div class="tools"><span class="small muted">Limit ${t.max_open_claims} each</span></div></div>
            ${work.length ? hbars(work.map(p => [p.name || p.email, p.open, p.open >= t.max_open_claims ? 'muted' : '']), { max: Math.max(t.max_open_claims, ...work.map(p => p.open)) }) : '<p class="muted small">Nobody is holding leads yet.</p>'}</section>
        </div>
      </div>`;
  }

  function teamPeople(t, F) {
    const rows = t.people.slice().sort((a, b) => (b.active - a.active) || (b.open - a.open) || String(a.name).localeCompare(String(b.name)));
    const pend = (id) => F.active.filter(r => r.owner_id === id && r.next_action_due);
    return sec('Team members', `<div class="tablewrap"><table class="tbl"><thead><tr><th scope="col">Member</th><th class="num" scope="col">Active leads</th><th scope="col">Follow-ups</th><th scope="col">Recent activity</th><th scope="col">Quotes</th><th class="num" scope="col">Won / lost</th></tr></thead><tbody>
      ${rows.map(p => { const pe = pend(p.id), od = pe.filter(r => r.next_action_due < F.today).length;
        return `<tr class="click" data-person="${p.id}">
        <td><div class="row" style="flex-wrap:nowrap">${ui.avatar(p.name || p.email, '')}<div style="min-width:0"><a class="cell-main" href="#/team?person=${p.id}" data-person="${p.id}">${esc(p.name || p.email)}</a><div class="sub">${p.role === 'manager' ? 'Manager' : 'Salesperson'}${p.active ? '' : ', turned off'} · seen ${esc(p.last_seen_at ? P.ago(p.last_seen_at) : 'never')}</div></div></div></td>
        <td class="num">${p.open}</td>
        <td>${pe.length ? `${pe.length} scheduled${od ? ` <span class="badge hot">${od} overdue</span>` : ''}` : '<span class="faint">None scheduled</span>'}${p.stale ? `<div class="sub">${p.stale} stalled</div>` : ''}</td>
        <td>${p.activities_7d} this week<div class="sub">${p.last_activity_at ? 'Last ' + esc(P.ago(p.last_activity_at)) : 'Nothing logged yet'}</div></td>
        <td>${p.quotes_open} open<div class="sub">${esc(P.money(p.quoted_value) || '$0')} quoted</div></td>
        <td class="num">${p.won} / ${p.lost}${p.won_value ? `<div class="sub">${esc(P.money(p.won_value))}</div>` : ''}</td></tr>`; }).join('')}
      </tbody></table></div>`, { n: t.people.length, note: 'Activity counts the calls, emails, texts, visits, meetings, notes and quotes each person logged. Open a person for their full numbers, leads and history.' });
  }

  function teamAccount(t, F) {
    const board = F.board;
    const hot = board.filter(r => r.stage === 'available' && !r.needs_review && r.priority === 'Hot').sort(P.SORTS.priority);
    const byOwner = {};
    F.overdue.forEach(r => { (byOwner[r.owner_name || 'Unknown'] = byOwner[r.owner_name || 'Unknown'] || []).push(r); });
    const inactive = F.people.filter(p => (p.open > 0 || p.role !== 'manager') && !p.activities_7d);
    const mini = (r, right, line) => `<div class="mini" data-lead="${r.id}"><div class="t"><a class="ell" href="#/lead/${r.id}" data-lead="${r.id}">${esc(P.companyOf(r))}</a></div><div class="s">${esc(r.project_title || r.title || '')}</div>${line ? `<div class="s">${line}</div>` : ''}<div class="r">${right || ''}</div></div>`;
    return `
      ${sec('Claims to review', t.stale_list.length ? `<div class="list">${t.stale_list.map(s => `<div class="mini" data-lead="${s.id}"><div class="t"><a class="ell" href="#/lead/${s.id}" data-lead="${s.id}">${esc(s.company_name || s.title)}</a></div>
          <div class="s">${esc(s.owner_name)} · ${esc(P.stageLabel(s.stage))} · claimed ${esc(P.date(s.claimed_at))} · ${s.last_activity_at ? 'last activity ' + esc(P.ago(s.last_activity_at)) : 'never worked'}</div>
          <div class="r"><button class="btn sm" data-act="assignRow" data-id="${s.id}" data-owner="${s.owner_id}">Reassign</button></div></div>`).join('')}</div>` : P.empty('Every claim has recent activity', '', '', 'sm card'),
        { n: t.stale_list.length, note: `Claimed leads with no logged activity for ${t.stale_days}+ days. Nothing is released automatically: check in, reassign, or release from the lead.` })}
      ${sec('Overdue follow-ups', F.overdue.length ? Object.entries(byOwner).sort((a, b) => b[1].length - a[1].length).map(([name, list]) => `<div class="card" style="margin-bottom:10px"><div class="sec-head" style="padding:10px 16px 0"><h2 style="font-size:14px">${esc(name)} <span class="n">${list.length}</span></h2></div>
          ${list.sort((a, b) => a.next_action_due.localeCompare(b.next_action_due)).map(r => mini(r, ui.due(r.next_action_due), r.next_action ? `Next: ${esc(r.next_action)}` : '')).join('')}</div>`).join('') : P.empty('No overdue follow-ups', '', '', 'sm card'), { n: F.overdue.length })}
      ${sec('Hot leads nobody has claimed', hot.length ? `<div class="list">${hot.slice(0, 10).map(r => mini(r, `<button class="btn sm" data-act="assignRow" data-id="${r.id}">Assign</button>`, esc(P.place(r)))).join('')}${hot.length > 10 ? `<div class="showmore"><a class="btn" href="#/pool?priority=Hot">See all ${hot.length}</a></div>` : ''}</div>` : P.empty('No unclaimed Hot leads', '', '', 'sm card'), { n: hot.length })}
      ${sec('Members with no activity this week', inactive.length ? `<div class="list">${inactive.map(p => `<div class="mini" data-person="${p.id}"><div class="t"><a href="#/team?person=${p.id}" data-person="${p.id}">${esc(p.name || p.email)}</a></div>
          <div class="s">${p.last_activity_at ? 'Last logged work ' + esc(P.ago(p.last_activity_at)) : 'Has not logged any work yet'} · ${P.plural(p.open, 'open lead')} · seen ${esc(p.last_seen_at ? P.ago(p.last_seen_at) : 'never')}</div><div class="r">${P.icon('right', 'sm')}</div></div>`).join('')}</div>` : P.empty('Everyone logged work this week', '', '', 'sm card'), { n: inactive.length })}`;
  }

  function teamPool(t) {
    const trend = t.pool_trend || [], first = trend[0], last = trend[trend.length - 1];
    const delta = first && last && trend.length > 1 ? last.available - first.available : null;
    const spark = (() => {
      if (trend.length < 2) return '';
      const w = 600, h = 64, vals = trend.map(p => p.available), max = Math.max(...vals, 1), min = Math.min(...vals, 0);
      const xy = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - 4 - ((v - min) / (max - min || 1)) * (h - 8)}`).join(' ');
      return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Available leads per day, ${esc(P.date(first.day))} to ${esc(P.date(last.day))}"><polyline points="${xy}" fill="none" stroke="#2156C8" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
    })();
    const src = t.source_productivity.filter(s => s.total);
    return `${sec('Available pool', `<div class="card card-pad">${last ? `<div class="metricgrid" style="margin-bottom:12px">
          <div><div class="lbl">Available to claim</div><div class="val">${last.available}</div></div><div><div class="lbl">Hot available</div><div class="val">${last.available_hot}</div></div>
          <div><div class="lbl">Being worked</div><div class="val">${last.claimed_open}</div></div></div>
        <p class="small">${delta === null ? 'The trend starts after the second daily snapshot.' : delta < 0 ? `<b>Down ${-delta}</b> since ${esc(P.date(first.day))}: claims are outpacing new finds.` : delta > 0 ? `Up ${delta} since ${esc(P.date(first.day))}.` : `No change since ${esc(P.date(first.day))}.`} ${last.review_queue} waiting for review.</p>${spark}
        <p class="sec-note" style="margin:8px 0 0">Daily snapshot, last taken ${esc(P.dateTime(last.created_at))}. New finds depend on what agencies and builders publish; there is no fixed number per day.</p>`
      : '<p class="muted">No snapshots yet. The first one is taken at the next refresh or daily upkeep.</p>'}</div>`)}
      ${sec('Where leads come from', `<div class="tablewrap"><table class="tbl"><thead><tr><th scope="col">Source</th><th class="num" scope="col">Total</th><th class="num" scope="col">Available</th><th class="num" scope="col">Hot available</th><th class="num" scope="col">Worked</th><th class="num" scope="col">Contacted</th><th class="num" scope="col">Quoted</th><th class="num" scope="col">Won</th><th class="num" scope="col">Added, 30 days</th></tr></thead><tbody>
        ${src.map(s => `<tr><td>${esc(s.name)}</td><td class="num">${s.total}</td><td class="num">${s.available}</td><td class="num">${s.hot_available}</td><td class="num">${s.worked}</td><td class="num">${s.contacted}</td><td class="num">${s.quoted}</td><td class="num">${s.won}</td><td class="num">${s.added_30d}</td></tr>`).join('')}
        </tbody></table></div>`, { tools: '<a class="btn sm" href="#/sources">Sources and refreshes</a>', note: 'Worked means claimed at least once. Contacted, quoted and won count leads that reached that stage or beyond.' })}`;
  }

  const VERB = { call: 'called', email: 'emailed', text: 'texted', visit: 'visited', meeting: 'met', note: 'added a note', quote: 'logged a quote', follow_up: 'set a follow-up', claim: 'claimed', release: 'released', assign: 'assigned',
    contact: 'updated a contact', review: 'reviewed', import: 'imported notes', stage: 'changed the stage' };
  const feedHtml = (items, { who = true } = {}) => {
    if (!items.length) return P.empty('No activity logged yet', '', '', 'sm');
    let day = null;
    return items.map(a => {
      const d = P.dayOf(a.at), head = d !== day ? `<div class="feedday">${esc(P.dayDiff(d) === 0 ? 'Today' : P.dayDiff(d) === -1 ? 'Yesterday' : P.date(d, { weekday: true }))}</div>` : '';
      day = d;
      const verb = a.kind === 'note' && !a.body && a.to_stage ? 'moved' : VERB[a.kind] || a.kind;
      return `${head}<div class="feed" ${a.opportunity_id ? `data-lead="${a.opportunity_id}" style="cursor:pointer"` : ''}><span class="tm">${esc(P.time(a.at))}</span>
        <div class="x">${who ? `<b>${esc(a.user_name || 'Someone')}</b> ` : ''}${esc(verb)}${a.outcome ? ` (${esc(a.outcome.replace(/_/g, ' '))})` : ''}${a.to_stage && !['claim', 'release', 'assign', 'review'].includes(a.kind) ? ` to ${esc(P.stageLabel(a.to_stage))}` : ''}${a.ref ? ` · <a href="#/lead/${a.opportunity_id}" data-lead="${a.opportunity_id}">${esc(a.ref)}</a> ${esc(a.company_name || a.title || '')}` : ''}${a.body ? `<div class="body">${esc(a.body)}</div>` : ''}</div></div>`;
    }).join('');
  };
  function teamActivity(t) {
    return sec('Recent team activity', `<div class="card">${feedHtml(t.recent)}</div>`, { note: 'The 40 most recent things people logged. Automatic refresh and system entries are left out.' });
  }

  // person panel
  P.showPerson = async (id) => {
    const D = P.drawer;
    if (!P.isMgr()) return;
    const same = D.open && D.kind === 'person' && D.key === id;
    if (same) return;
    D.show('person', id, { narrow: false });
    D.set(P.dwLoading());
    try {
      const [t, acts] = await Promise.all([P.state.team || P.rpc('team_overview'), P.rpc('person_activity', { p_user: id }), P.loadBoard()]);
      P.state.team = t;
      if (!(D.open && D.key === id)) return;
      const p = t.people.find(x => x.id === id);
      if (!p) throw new Error('That person was not found.');
      const today = P.todayET(), mine = (P.state.board || []).filter(r => r.owner_id === id);
      const active = mine.filter(r => P.ACTIVE.includes(r.stage)).sort(P.SORTS.urgency);
      const by = Object.entries(p.by_stage || {}).sort((a, b) => ((P.state.me.stages || []).find(s => s.key === a[0])?.sort || 0) - ((P.state.me.stages || []).find(s => s.key === b[0])?.sort || 0));
      const m = (lbl, val, cls = '') => `<div><div class="lbl">${esc(lbl)}</div><div class="val ${cls}">${val}</div></div>`;
      D.set(`<div class="dw-head">${P.dwHead({ ref: p.role === 'manager' ? 'Manager' : 'Salesperson', title: esc(p.name || p.email), sub: `${esc(p.email)}${p.active ? '' : ' · turned off'}`,
          meta: `<span>${P.icon('clock')}Last seen ${esc(p.last_seen_at ? P.ago(p.last_seen_at) : 'never')}</span><span>Last logged work ${esc(p.last_activity_at ? P.ago(p.last_activity_at) : 'never')}</span>` })}
        <div class="row" style="margin:12px 0 14px"><a class="btn" href="#/all?owner=${id}&tab=open">${P.icon('all')}Their leads in All leads</a><a class="btn ghost" href="#/users">Manage access</a></div></div>
        <div class="dw-body">
          <div class="panel"><h3>Numbers</h3><div class="metricgrid">
            ${m('Active leads', p.open)}${m('Overdue follow-ups', p.overdue, p.overdue ? 'attn' : '')}${m('Stalled claims', p.stale, p.stale ? 'attn' : '')}
            ${m('Calls, 7 days', p.calls_7d)}${m('Activity, 7 days', p.activities_7d)}${m('Activity, 30 days', p.activities_30d)}
            ${m('Quotes in progress', p.quotes_open)}${m('Quoted value', esc(P.money(p.quoted_value) || '$0'))}${m('Won / lost', `${p.won} / ${p.lost}`)}</div>
            ${p.won_value ? `<p class="sec-note" style="margin:8px 0 0">Won value ${esc(P.money(p.won_value))}.</p>` : ''}
            ${by.length ? `<div class="chips" style="margin-top:12px">${by.map(([k, n]) => `<span class="badge outline">${esc(P.stageLabel(k))} ${n}</span>`).join('')}</div>` : ''}</div>
          <div class="panel"><h3>Active leads <span class="n faint" style="font-weight:500">${active.length}</span></h3>
            ${active.length ? `<div class="card">${active.slice(0, 12).map(r => `<div class="mini" data-lead="${r.id}"><div class="t"><a class="ell" href="#/lead/${r.id}" data-lead="${r.id}">${esc(P.companyOf(r))}</a></div><div class="s">${esc(P.stageLabel(r.stage))} · ${esc(r.project_title || r.title)}</div>
              <div class="r">${r.next_action_due ? ui.due(r.next_action_due) : r.stale ? '<span class="badge warm">Stalled</span>' : ''}</div></div>`).join('')}</div>${active.length > 12 ? `<p class="small" style="margin-top:8px"><a href="#/all?owner=${id}&tab=open">See all ${active.length}</a></p>` : ''}`
              : '<p class="muted small">No active leads.</p>'}</div>
          <div class="panel"><h3>Recent activity</h3><div class="card">${feedHtml(acts, { who: false })}</div></div>
        </div>`);
      D.focus();
    } catch (e) {
      if (D.open && D.key === id) D.set(`<div class="dw-head">${P.dwHead({ title: 'Could not open this person' })}<div style="height:14px"></div></div><div class="dw-body">${P.errorState(e.message)}</div>`);
    }
  };

  // assign or reassign straight from a list row
  P.act.assignRow = async (btn) => {
    let users;
    try { users = (P.state.users = await P.rpc('list_users')).filter(u => u.active); } catch (e) { P.toast(e.message, 'error'); return; }
    const owner = btn.dataset.owner || '';
    const v = await P.dialog({
      title: owner ? 'Reassign' : 'Assign', ok: 'Save',
      fields: [{ name: 'user', label: 'Owner', type: 'select', value: owner, options: [['', 'Nobody (back to the pool)'], ...users.map(u => [u.id, `${u.full_name || u.email} (${u.open} open)`])] },
               { name: 'reason', label: 'Note for the history', type: 'text' }],
      onOk: async (v) => { const r = await P.rpc('assign_opportunity', { p_id: btn.dataset.id, p_user: v.user || null, p_reason: v.reason }); if (r && r.ok === false) throw new Error(r.message); },
    });
    if (v) { P.toast('Ownership updated.'); P.afterChange(); }
  };

  // ---------------------------------------------------------------- Sources and refreshes
  let pollTimer;
  const SRC_TABS = [['overview', 'Overview'], ['review', 'Review queue'], ['runs', 'Refresh runs'], ['changes', 'Source changes'], ['settings', 'Settings']];
  P.views.sources = async (view, r) => {
    if (mgrOnly(view, 'Sources and refreshes')) return;
    P.setPage('Sources and refreshes');
    if (r.params.tab && SRC_TABS.some(t => t[0] === r.params.tab)) { P.state.srcTab = r.params.tab; P.cleanHash(); }
    if (!P.state.sources) view.innerHTML = P.loadingPage('Sources and refreshes');
    await loadSources(view);
    P.state.rerender = () => loadSources(view);
    P.state.cleanup = () => clearTimeout(pollTimer);
  };
  async function loadSources(view) {
    const s = P.state.sources = await P.rpc('sources_status');
    if (P.state.page !== 'sources') return;
    renderSources(view);
    clearTimeout(pollTimer);
    if (s.runs.some(x => x.status === 'running')) pollTimer = setTimeout(() => P.state.page === 'sources' && !document.querySelector('dialog[open]') && loadSources(view).catch(() => {}), 10000);
  }
  P.act.srcTab = (el) => { P.state.srcTab = el.dataset.tab; renderSources(document.getElementById('view')); document.querySelector(`.tab[data-tab="${el.dataset.tab}"]`)?.focus(); };
  const srcName = (id) => P.state.sources.sources.find(x => x.id === id)?.name || id;
  function renderSources(view) {
    const s = P.state.sources, tab = P.state.srcTab || 'overview';
    const running = s.runs.some(r => r.status === 'running');
    const body = { overview: srcOverview, review: srcReview, runs: srcRuns, changes: srcChanges, settings: srcSettings }[tab](s);
    view.innerHTML = `${P.pageHead({ title: 'Sources and refreshes', sub: 'Where leads come from, when they were last checked, and what changed.',
        actions: `<button class="btn" data-act="runUpkeep">Run daily upkeep</button><button class="btn primary" data-act="runRefresh" data-source="all">${P.icon('refresh')}Refresh all now</button>` })}
      ${running ? `<div class="alert info">${P.icon('refresh')}<div class="grow">A refresh is running. This page updates every 10 seconds.</div></div>` : ''}
      ${tabsHtml('srcTab', tab, SRC_TABS.map(([k, l]) => [k, l, k === 'review' ? s.review.length : null]))}${body}`;
  }
  const statusOf = (x) => x.kind !== 'automated' ? `<span class="status">${esc({ needs_credentials: 'Needs logins or paid access', legacy: 'One-time import', manual: 'Added by hand', paid: 'Paid service' }[x.kind] || 'Manual')}</span>`
    : x.last_status === 'failed' ? `<span class="status fail"><span class="dot danger"></span>Last run failed${x.consecutive_failures > 1 ? ` (${x.consecutive_failures} in a row)` : ''}</span>`
    : x.last_status === 'partial' ? '<span class="status warn"><span class="dot warm"></span>Partly worked</span>'
    : x.last_status === 'success' ? '<span class="status ok"><span class="dot ok"></span>Working</span>' : '<span class="status"><span class="dot"></span>Not run yet</span>';
  function srcOverview(s) {
    const fr = s.freshness, auto = s.sources.filter(x => x.kind === 'automated'), failing = auto.filter(x => x.last_status === 'failed');
    return `<div class="kpis">
        <div class="kpi"><div class="lbl">Verified in the last 7 days</div><div class="val">${fr.verified_7d}</div><div class="sub">Open leads' projects</div></div>
        <div class="kpi"><div class="lbl">Verified 8 to 30 days ago</div><div class="val">${fr.verified_30d}</div><div class="sub">Still reasonably current</div></div>
        <div class="kpi"><div class="lbl">Older or never re-checked</div><div class="val">${fr.never + fr.older}</div><div class="sub">${fr.never} never, ${fr.older} older than 30 days</div></div>
        <div class="kpi ${fr.failed ? 'attn' : ''}"><div class="lbl">Last check failed</div><div class="val">${fr.failed}</div><div class="sub">Or no longer listed by the source</div></div></div>
      <p class="sec-note" style="margin-top:-12px">A project counts as verified only when a refresh read it successfully from its source. Failed checks never update the date.</p>
      ${sec('Sources', `<div class="card">${s.sources.map(x => `<div class="srcrow">
          <div class="name">${esc(x.name)} ${statusOf(x)}</div>
          <div class="small muted">${esc(x.coverage)}</div>
          <div class="small" style="color:var(--ink-2)">${esc(x.schedule_note)}${x.last_success_at ? ` · Last success ${esc(P.ago(x.last_success_at))}` : ''}${x.last_run_at && x.last_status !== 'success' ? ` · Last run ${esc(P.ago(x.last_run_at))}` : ''}</div>
          ${x.last_error && x.last_status !== 'success' ? `<div class="small" style="color:var(--danger)">${esc(String(x.last_error).slice(0, 200))}</div>` : ''}
          ${x.access_notes ? `<details class="plain"><summary>Access notes</summary><p class="small muted" style="margin-top:6px">${esc(x.access_notes)}</p></details>` : ''}
          <div class="acts">${x.kind === 'automated' ? `<button class="btn sm" data-act="runRefresh" data-source="${x.id}">Run now</button>` : x.kind !== 'legacy' ? '<button class="btn sm" data-act="addLead">Add a find</button>' : ''}</div></div>`).join('')}</div>`,
        { note: `${auto.filter(x => x.last_status === 'success').length} of ${P.plural(auto.length, 'automated source')} working${failing.length ? `, ${failing.length} failing` : ''}${auto.some(x => !x.last_status) ? `, ${auto.filter(x => !x.last_status).length} not run yet` : ''}. Failed runs retry every hour, up to 3 times.` })}`;
  }
  function srcReview(s) {
    return sec('Waiting for review', s.review.length ? `<div class="list">${s.review.map(r => `<div class="srcrow">
        <div class="name"><a href="#/lead/${r.id}" data-lead="${r.id}">${esc(r.title)}</a> ${ui.prio(r.priority)}</div>
        <div class="small" style="color:var(--ink-2)">${esc(r.review_reason || '')}</div>
        <div class="small muted">${esc(r.ref)} · ${esc(r.owner_name || 'Unowned')} · ${esc(P.stageLabel(r.stage))} · flagged ${esc(P.ago(r.created_at))}${r.source_url ? ` · <a href="${P.url(r.source_url)}" target="_blank" rel="noopener">Source</a>` : ''}</div>
        <div class="acts"><button class="btn sm" data-act="review" data-id="${r.id}" data-a="publish">${r.review_kind === 'discovery' ? 'Publish' : 'Keep'}</button><button class="btn sm danger" data-act="review" data-id="${r.id}" data-a="archive">Archive</button></div></div>`).join('')}</div>`
      : P.empty('Nothing to review', 'New finds and source changes that need a look show up here.', '', 'card'),
      { n: s.review.length, note: '<b>Publish</b> puts a new find in the Available pool. <b>Keep</b> clears the flag and leaves the lead as it is. <b>Archive</b> closes it. Salespeople do not see unreviewed new finds.' });
  }
  function srcRuns(s) {
    const f = P.state.runFilter || 'all';
    const runs = s.runs.filter(r => f === 'all' || (f === 'scheduled' ? ['schedule', 'retry'].includes(r.trigger) : f === 'manual' ? r.trigger === 'manual' : f === 'failed' ? ['failed', 'partial'].includes(r.status) : true));
    const trig = (r) => r.trigger === 'schedule' ? '<span class="badge outline">Scheduled</span>' : r.trigger === 'manual' ? '<span class="badge accent">Manual</span>' : r.trigger === 'retry' ? `<span class="badge outline">Retry #${r.attempt}</span>` : `<span class="badge later">${esc(r.trigger)}</span>`;
    const res = (r) => r.status === 'success' ? '<span class="status ok"><span class="dot ok"></span>Success</span>' : r.status === 'running' ? '<span class="status"><span class="dot accent"></span>Running</span>' : r.status === 'partial' ? '<span class="status warn"><span class="dot warm"></span>Partial</span>' : '<span class="status fail"><span class="dot danger"></span>Failed</span>';
    const dur = (r) => r.finished_at ? Math.max(1, Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000)) + ' s' : '';
    return `<div class="row" style="margin-bottom:12px"><div class="seg" role="group" aria-label="Show runs">${[['all', 'All'], ['scheduled', 'Scheduled'], ['manual', 'Manual'], ['failed', 'Failed or partial']].map(([k, l]) => `<button data-act="runFilter" data-f="${k}" aria-pressed="${f === k}">${l}</button>`).join('')}</div>
      <span class="small muted grow">${s.runs.length ? `Last ${s.runs.length} runs. Scheduled runs come from the timer; manual runs were started from this page.` : 'No refresh has run yet.'}</span></div>
      ${runs.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th scope="col">Started</th><th scope="col">Source</th><th scope="col">How</th><th scope="col">Result</th><th class="num" scope="col">Read</th><th class="num" scope="col">New</th><th class="num" scope="col">Updated</th><th class="num" scope="col">Merged</th><th class="num" scope="col">Flagged</th><th class="num" scope="col">Errors</th><th scope="col"><span class="sr">Log</span></th></tr></thead><tbody>
        ${runs.map(r => `<tr><td class="nowrap">${esc(P.dateTime(r.started_at))}<div class="sub">${esc(dur(r))}</div></td><td>${esc(srcName(r.source_id))}</td><td>${trig(r)}</td><td>${res(r)}${r.error ? `<div class="sub" title="${esc(r.error)}">${esc(String(r.error).slice(0, 60))}${String(r.error).length > 60 ? '…' : ''}</div>` : ''}</td>
          <td class="num">${r.fetched}</td><td class="num">${r.discovered}</td><td class="num">${r.updated}</td><td class="num">${r.merged}</td><td class="num">${r.flagged}</td><td class="num">${r.errors || '<span class="faint">0</span>'}</td>
          <td><button class="btn sm ghost" data-act="runLog" data-id="${r.id}">Log</button></td></tr>`).join('')}</tbody></table></div>` : P.empty('No runs match', '', '', 'card')}`;
  }
  P.act.runFilter = (el) => { P.state.runFilter = el.dataset.f; renderSources(document.getElementById('view')); };
  function srcChanges(s) {
    const all = P.state.allChanges;
    const list = s.changes.filter(c => all || c.material);
    const groups = [];
    const byP = new Map();
    list.forEach(c => { if (!byP.has(c.project_id)) { const g = { c, items: [] }; byP.set(c.project_id, g); groups.push(g); } byP.get(c.project_id).items.push(c); });
    return `<div class="row" style="margin-bottom:12px"><label class="check" style="margin:0"><input type="checkbox" data-act-change="allChanges" ${all ? 'checked' : ''}><span>Include minor changes</span></label><span class="small muted grow">Newest first, grouped by project.</span></div>
      ${groups.length ? `<div class="card">${groups.map(({ c, items }) => `<div class="chgroup"><div class="ttl">${esc(c.project_title)}</div>
        <div class="small muted">${(c.opps || []).map(o => `<a href="#/lead/${o.id}" data-lead="${o.id}">${esc(o.ref)}</a> ${esc(o.owner_name || 'unowned')}`).join(' · ') || 'No lead attached'}</div>
        <ul>${items.map(x => `<li><span class="d">${esc(P.dateTime(x.at))}</span><span><b class="strong">${esc(String(x.field).replace(/_/g, ' '))}</b>: ${x.old ? esc(String(x.old).slice(0, 80)) + ' → ' : ''}${esc(String(x.new).slice(0, 160))}</span></li>`).join('')}</ul></div>`).join('')}</div>`
        : P.empty(all ? 'No changes recorded yet' : 'No important changes recently', all ? '' : 'Tick "Include minor changes" to see everything the refreshes recorded.', '', 'card')}`;
  }
  document.addEventListener('change', (e) => { if (e.target.dataset?.actChange === 'allChanges') { P.state.allChanges = e.target.checked; renderSources(document.getElementById('view')); } });
  function srcSettings(s) {
    return `<div class="card card-pad" style="max-width:640px">
      <label class="field"><span>Suggest review of claims with no activity after (days)</span><input type="number" id="st_stale" min="3" max="90" value="${esc(s.settings.stale_days?.value)}"><span class="help">${esc(s.settings.stale_days?.description || '')}</span></label>
      <label class="field"><span>Most open leads one person can hold</span><input type="number" id="st_max" min="5" max="500" value="${esc(s.settings.max_open_claims?.value)}"><span class="help">${esc(s.settings.max_open_claims?.description || '')}</span></label>
      <button class="btn primary" data-act="saveSettings">Save settings</button></div>`;
  }
  P.act.runRefresh = (btn) => P.busy(btn, async () => {
    await P.fn('refresh', { source: btn.dataset.source });
    P.toast('Refresh started. Results show here in a few minutes.');
    setTimeout(() => P.state.page === 'sources' && loadSources(document.getElementById('view')).catch(() => {}), 2500);
  }, 'Starting…');
  P.act.runUpkeep = (btn) => P.busy(btn, async () => {
    const r = await P.rpc('daily_maintenance');
    P.toast(`Upkeep done: ${r.bids_closed} bids closed, ${r.stale} stale claims flagged, ${r.due} follow-ups due.`);
    await loadSources(document.getElementById('view')); P.invalidate();
  }, 'Running…');
  P.act.runLog = (el) => {
    const r = P.state.sources.runs.find(x => String(x.id) === el.dataset.id);
    P.dialog({ title: `${srcName(r.source_id)}, ${P.dateTime(r.started_at)}`, wide: true, ok: '', cancel: 'Close',
      body: `${r.error ? `<div class="alert error">${esc(r.error)}</div>` : ''}<pre class="log">${esc((r.log || []).join('\n') || 'No log lines.')}</pre>` });
  };
  P.act.review = (el) => P.busy(el, async () => {
    await P.rpc('resolve_review', { p_id: el.dataset.id, p_action: el.dataset.a, p_note: null });
    P.toast(el.dataset.a === 'archive' ? 'Archived.' : el.textContent.trim() === 'Publish' ? 'Published to the pool.' : 'Kept. Flag cleared.');
    P.invalidate(); await loadSources(document.getElementById('view')); P.loadBoard(true).catch(() => {});
  });
  P.act.saveSettings = (el) => P.busy(el, async () => {
    await P.rpc('update_setting', { p_key: 'stale_days', p_value: Number(document.getElementById('st_stale').value) });
    await P.rpc('update_setting', { p_key: 'max_open_claims', p_value: Number(document.getElementById('st_max').value) });
    P.toast('Settings saved.');
  });
  P.act.addLead = () => P.dialog({
    title: 'Add a lead you found', ok: 'Add lead', wide: true,
    body: '<p class="small muted">For a project from the news, a local bid board, a permit or a referral. The source link is required so everyone can check it.</p>',
    fields: [
      { name: 'project_title', label: 'Project', required: true }, { name: 'source_url', label: 'Source link', type: 'url', required: true },
      { name: 'source_id', label: 'Where it came from', type: 'select', options: [['private_news', 'News or owner announcement'], ['local_portals', 'County, city, airport, school or university bid board'], ['fdot_bid_notices', 'FDOT or Turnpike bid notice'], ['portal_manual', 'Other']] },
      { name: 'company_name', label: 'Builder or company to call' }, { name: 'company_kind', label: 'That company is', type: 'select', options: [['contractor', 'The builder or contractor'], ['developer', 'The owner or developer'], ['agency', 'A public agency']] },
      { name: 'contact_name', label: 'Contact name' }, { name: 'contact_phone', label: 'Contact phone', type: 'tel' }, { name: 'contact_email', label: 'Contact email', type: 'email' },
      { name: 'owner_name', label: 'Project owner' }, { name: 'city', label: 'City' },
      { name: 'region', label: 'Region', type: 'select', options: P.REGIONS.map(r => [r, r]), value: 'Central FL', required: true },
      { name: 'project_stage', label: 'Project stage', type: 'select', options: Object.entries(P.PSTAGE), value: 'unknown', required: true },
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
      P.toast(`Added as ${r.ref}.`); return r;
    },
  }).then(async (r) => { if (r?.id) { await P.afterChange(); P.openLead(r.id); } });

  // ---------------------------------------------------------------- People and access
  P.views.users = async (view) => {
    if (mgrOnly(view, 'People and access')) return;
    P.setPage('People and access');
    view.innerHTML = P.pageHead({ title: 'People and access' }) + P.skeleton(4);
    const users = P.state.users = await P.rpc('list_users');
    if (P.state.page !== 'users') return;
    const on = users.filter(u => u.active).length;
    view.innerHTML = `${P.pageHead({ title: 'People and access', sub: `${P.plural(on, 'active account')}. Each person signs in with their own email and password; invite and reset links work once.`,
        actions: `<button class="btn primary" data-act="invite">${P.icon('plus')}Invite someone</button>` })}
      <div class="tablewrap"><table class="tbl"><thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Status</th><th class="num" scope="col">Open leads</th><th scope="col">Last seen</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>
      ${users.map(u => `<tr><td><div class="row" style="flex-wrap:nowrap">${ui.avatar(u.full_name || u.email)}<div style="min-width:0"><div class="cell-main">${esc(u.full_name || u.email)}${u.id === P.state.me.id ? ' <span class="badge later">You</span>' : ''}</div><div class="sub">${esc(u.email)}${u.phone ? ' · ' + esc(u.phone) : ''}</div></div></div></td>
        <td>${u.role === 'manager' ? 'Manager' : 'Salesperson'}</td>
        <td>${u.active ? '<span class="status ok"><span class="dot ok"></span>Active</span>' : '<span class="status"><span class="dot"></span>Turned off</span>'}</td>
        <td class="num">${u.open}</td>
        <td class="small">${u.last_seen_at ? esc(P.ago(u.last_seen_at)) : '<span class="faint">Not signed in yet</span>'}</td>
        <td><div class="row" style="justify-content:flex-end;flex-wrap:nowrap">${u.id !== P.state.me.id ? `${u.active ? `<button class="btn sm" data-act="resetLink" data-id="${u.id}">${u.last_seen_at ? 'Reset link' : 'New invite link'}</button>` : ''}
          <button class="btn sm ghost icon" data-act="userMenu" data-id="${u.id}" aria-label="More for ${esc(u.full_name || u.email)}">${P.icon('more')}</button>` : '<a class="btn sm ghost" href="#/me">My account</a>'}</div></td></tr>`).join('')}
      </tbody></table></div>
      <p class="sec-note" style="margin-top:12px">Turning someone off signs them out everywhere at once. Their leads stay assigned until you reassign or release them from Team or All leads.</p>`;
  };
  P.act.userMenu = (el) => {
    const u = P.state.users.find(x => x.id === el.dataset.id);
    P.menu(el, [
      { label: u.role === 'manager' ? 'Make salesperson' : 'Make manager', icon: 'swap', run: () => setRole(u, u.role === 'manager' ? 'sales' : 'manager') },
      u.open && { label: 'See their leads', icon: 'all', run: () => P.go(`#/all?owner=${u.id}&tab=open`) },
      '-',
      u.active ? { label: 'Turn off', icon: 'logout', danger: true, run: () => deactivate(u) } : { label: 'Turn on', icon: 'check', run: () => reactivate(u) },
    ], { label: 'Account actions' });
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
             { name: 'role', label: 'Role', type: 'select', options: [['sales', 'Salesperson'], ['manager', 'Manager']], value: 'sales', required: true,
               help: 'Salespeople see the pool and their own leads. Managers also see the team, sources and access.' }],
    onOk: async (v) => { const r = await P.fn('admin-users', { action: 'invite', ...v }); return { ...r, user: v }; },
  }).then(r => { if (r?.link) { showLink('Invite link ready', r.link, r.user); P.route({ force: true }); } });
  P.act.resetLink = (el) => P.busy(el, async () => {
    const u = P.state.users.find(x => x.id === el.dataset.id);
    const r = await P.fn('admin-users', { action: 'reset_link', user_id: u.id });
    showLink(u.last_seen_at ? 'Password reset link' : 'New invite link', r.link, u);
  }, 'Making link…');
  const setRole = async (u, role) => {
    try { await P.fn('admin-users', { action: 'set_role', user_id: u.id, role }); P.toast(`${u.full_name || u.email} is now a ${role === 'manager' ? 'manager' : 'salesperson'}.`); P.route({ force: true }); }
    catch (e) { P.toast(e.message, 'error'); }
  };
  const deactivate = async (u) => {
    if (!await P.confirm(`Turn off ${u.full_name || u.email}?`, `They are signed out on every device right away and cannot sign back in. Their ${P.plural(u.open, 'open lead')} stay assigned until you move them.`, 'Turn off', true)) return;
    try { const r = await P.fn('admin-users', { action: 'deactivate', user_id: u.id }); P.toast(r.note || 'Turned off.'); P.route({ force: true }); } catch (e) { P.toast(e.message, 'error'); }
  };
  const reactivate = async (u) => {
    try { await P.fn('admin-users', { action: 'reactivate', user_id: u.id }); P.toast('Turned on. Send them a reset link if they forgot their password.'); P.route({ force: true }); } catch (e) { P.toast(e.message, 'error'); }
  };

  // ---------------------------------------------------------------- Excel and PDF
  P.views.files = async (view) => {
    const mgr = P.isMgr();
    view.innerHTML = `${P.pageHead({ title: 'Excel and PDF', sub: 'Files are snapshots stamped with the time they were made. The portal stays the live record.' })}
      <div class="stack" style="max-width:860px">
        <section class="card card-pad"><div class="sec-head"><h2>My pipeline</h2></div>
          <p class="small muted">Your claimed leads in the familiar workbook layout: This Week, Sales Leads and Gov Contracts, with yellow columns for call notes.</p>
          <div class="row"><button class="btn primary" data-act="exportXlsx" data-scope="mine">${P.icon('files')}Download Excel</button><a class="btn" href="#/print/mine">Phone PDF</a></div></section>
        ${mgr ? `<section class="card card-pad"><div class="sec-head"><h2>Whole team</h2></div>
          <p class="small muted">Every open lead, available or claimed, with owners. Good for sending to someone without a login.</p>
          <div class="row"><button class="btn primary" data-act="exportXlsx" data-scope="team">${P.icon('files')}Download team Excel</button><a class="btn" href="#/print/team">Team PDF</a></div></section>` : ''}
        <section class="card card-pad"><div class="sec-head"><h2>Bring call notes back from a workbook</h2></div>
          <p class="small muted">Upload a workbook exported from the portal (or the older pipeline workbook). You see every proposed change before anything is saved. New notes are added to the history; a status or follow-up date only changes when the sheet's Last Contact is newer than the portal's. ${mgr ? 'Managers can import for any lead.' : 'Only rows for your own leads are imported.'}</p>
          <label class="field" style="max-width:420px"><span>Workbook (.xlsx)</span><input type="file" id="imp_file" accept=".xlsx"></label>
          <div id="imp_out"></div></section>
      </div>`;
    document.getElementById('imp_file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; P.importPreview(f); };  // reset so the same file can be picked again
  };
  P.act.exportXlsx = (btn) => P.busy(btn, async () => {
    const data = await P.rpc('export_rows', { p_scope: btn.dataset.scope });
    if (!data.rows.length) { P.toast(btn.dataset.scope === 'mine' ? 'You have no claimed leads to export yet.' : 'Nothing to export.', 'error'); return; }
    await P.buildWorkbook(data);
    P.toast(`Downloaded ${P.plural(data.rows.length, 'lead')}.`);
  }, 'Preparing…');

  P.views.print = async (view, r) => {
    const scope = r.arg === 'team' ? 'team' : 'mine';
    const title = scope === 'team' ? 'Team PDF' : 'My pipeline PDF';
    view.innerHTML = P.pageHead({ title }) + P.skeleton(4);
    const data = await P.rpc('export_rows', { p_scope: scope });
    view.innerHTML = `<div class="noprint">${P.pageHead({ title, sub: 'On a phone: Share, then Print, then save or share the PDF.', actions: `<a class="btn" href="#/files">Back</a><button class="btn primary" data-act="print">Save as PDF or print</button>` })}</div>${P.printHtml(data)}`;
  };
  P.act.print = () => window.print();

  // ---------------------------------------------------------------- account
  P.views.me = async (view) => {
    const m = P.state.me;
    view.innerHTML = `${P.pageHead({ title: 'My account', sub: `Signed in as ${esc(m.email)}.` })}
      <div class="stack" style="max-width:560px">
        <section class="card card-pad"><div class="row" style="margin-bottom:16px">${ui.avatar(m.full_name || m.email, 'lg')}<div><div class="strong">${esc(m.full_name || m.email)}</div><div class="small muted">${m.role === 'manager' ? 'Manager' : 'Salesperson'}</div></div></div>
          <label class="field"><span>Name</span><input type="text" id="me_name" value="${esc(m.full_name)}" autocomplete="name"></label>
          <label class="field"><span>Mobile number</span><input type="tel" id="me_phone" value="${esc(m.phone || '')}" autocomplete="tel"><span class="help">Managers use it to text you invite and reset links.</span></label>
          <button class="btn primary" data-act="saveMe">Save changes</button></section>
        <section class="card card-pad"><div class="sec-head"><h2>Sign-in</h2></div>
          <div class="row"><button class="btn" data-act="changePw">Change password</button><button class="btn danger" data-act="signOut">${P.icon('logout')}Sign out</button></div></section>
      </div>`;
  };
  P.act.saveMe = (el) => P.busy(el, async () => {
    P.state.me = { ...P.state.me, ...(await P.rpc('update_my_profile', { p_full_name: document.getElementById('me_name').value, p_phone: document.getElementById('me_phone').value })) };
    document.querySelectorAll('.sb-user .who b').forEach(b => { b.textContent = P.state.me.full_name || P.state.me.email; });
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
