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
  const SRC_TABS = [['overview', 'Overview'], ['coverage', 'Coverage'], ['review', 'Review queue'], ['missed', 'Missed check'], ['runs', 'Refresh runs'], ['changes', 'Source changes'], ['settings', 'Settings']];
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
    const [s, d] = await Promise.all([P.rpc('sources_status'), P.rpc('discovery_overview').catch(() => null)]);
    s.discovery = d; P.state.sources = s;
    if ((P.state.srcTab || 'overview') === 'settings') P.state.terms = await P.rpc('service_terms_list');
    if (P.state.page !== 'sources') return;
    renderSources(view);
    clearTimeout(pollTimer);
    if (s.runs.some(x => x.status === 'running')) pollTimer = setTimeout(() => P.state.page === 'sources' && !document.querySelector('dialog[open]') && loadSources(view).catch(() => {}), 10000);
  }
  P.act.srcTab = async (el) => {
    P.state.srcTab = el.dataset.tab;
    if (el.dataset.tab === 'settings' && !P.state.terms) P.state.terms = await P.rpc('service_terms_list').catch(() => null);
    if (el.dataset.tab === 'missed' && !P.state.missedList) P.state.missedList = await P.rpc('missed_checks_list').catch(() => []);
    renderSources(document.getElementById('view')); document.querySelector(`.tab[data-tab="${el.dataset.tab}"]`)?.focus();
  };
  const srcName = (id) => P.state.sources.sources.find(x => x.id === id)?.name || id;
  function renderSources(view) {
    const s = P.state.sources, tab = P.state.srcTab || 'overview';
    const running = s.runs.some(r => r.status === 'running');
    const body = { overview: srcOverview, coverage: srcCoverage, review: srcReview, missed: srcMissed, runs: srcRuns, changes: srcChanges, settings: srcSettings }[tab](s);
    view.innerHTML = `${P.pageHead({ title: 'Sources and refreshes', sub: 'Where leads come from, when they were last checked, and what changed.',
        actions: `<button class="btn" data-act="runUpkeep">Run daily upkeep</button><button class="btn primary" data-act="runRefresh" data-source="all">${P.icon('refresh')}Refresh all now</button>` })}
      ${running ? `<div class="alert info">${P.icon('refresh')}<div class="grow">A refresh is running. This page updates every 10 seconds.</div></div>` : ''}
      ${tabsHtml('srcTab', tab, SRC_TABS.map(([k, l]) => [k, l, k === 'review' ? s.review.length : null]))}${body}`;
  }
  // Five states that are never confused: working (with or without new records), failed, not checked recently,
  // needs a login or subscription, and configured but never successful.
  const statusOf = (x) => {
    if (x.kind === 'paid') return '<span class="status"><span class="dot"></span>Needs a paid subscription</span>';
    if (x.kind === 'needs_credentials') return '<span class="status"><span class="dot"></span>Needs logins (not collected)</span>';
    if (x.kind !== 'automated') return `<span class="status"><span class="dot"></span>${esc({ legacy: 'One-time import', manual: 'Not automated: added by hand' }[x.kind] || 'Not automated')}</span>`;
    if (!x.enabled) return '<span class="status"><span class="dot"></span>Turned off</span>';
    if (!x.last_success_at) return x.last_run_at ? '<span class="status fail"><span class="dot danger"></span>Configured but has never worked</span>' : '<span class="status"><span class="dot"></span>Configured, not run yet</span>';
    if (x.last_status === 'failed') return `<span class="status fail"><span class="dot danger"></span>Last run failed${x.consecutive_failures > 1 ? ` (${x.consecutive_failures} in a row)` : ''}</span>`;
    if (Date.now() - new Date(x.last_success_at) > 30 * 3600e3) return `<span class="status warn"><span class="dot warm"></span>Not checked since ${esc(P.ago(x.last_success_at))}</span>`;
    if (x.last_status === 'partial') return '<span class="status warn"><span class="dot warm"></span>Partly worked</span>';
    const lr = x.last_run;
    return `<span class="status ok"><span class="dot ok"></span>${lr && lr.discovered === 0 && lr.updated === 0 ? 'Working, nothing new last run' : 'Working'}</span>`;
  };
  function srcOverview(s) {
    const fr = s.freshness, auto = s.sources.filter(x => x.kind === 'automated'), failing = auto.filter(x => x.last_status === 'failed');
    return `<div class="kpis">
        <div class="kpi"><div class="lbl">Verified in the last 7 days</div><div class="val">${fr.verified_7d}</div><div class="sub">Open leads' projects</div></div>
        <div class="kpi"><div class="lbl">Verified 8 to 30 days ago</div><div class="val">${fr.verified_30d}</div><div class="sub">Still reasonably current</div></div>
        <div class="kpi"><div class="lbl">Older or never re-checked</div><div class="val">${fr.never + fr.older}</div><div class="sub">${fr.never} never, ${fr.older} older than 30 days</div></div>
        <div class="kpi ${fr.failed ? 'attn' : ''}"><div class="lbl">Last check failed</div><div class="val">${fr.failed}</div><div class="sub">Or no longer listed by the source</div></div></div>
      <p class="sec-note" style="margin-top:-12px">A project counts as verified only when a refresh read it successfully from its source. Failed checks never update the date.</p>
      ${discoveryStrip(s.discovery)}
      ${sec('Sources', `<div class="card">${s.sources.map(x => `<div class="srcrow">
          <div class="name">${esc(x.name)} ${statusOf(x)}</div>
          <div class="small muted">${esc(x.coverage)}</div>
          <div class="small" style="color:var(--ink-2)">${esc(x.schedule_note)}${x.last_success_at ? ` · Last success ${esc(P.ago(x.last_success_at))}` : ''}${x.last_run_at && x.last_status !== 'success' ? ` · Last run ${esc(P.ago(x.last_run_at))}` : ''}</div>
          ${x.last_error && x.last_status !== 'success' ? `<div class="small" style="color:var(--danger)">${esc(String(x.last_error).slice(0, 200))}</div>` : ''}
          ${srcStats(x, s.discovery)}
          ${x.access_notes ? `<details class="plain"><summary>Access notes</summary><p class="small muted" style="margin-top:6px">${esc(x.access_notes)}</p></details>` : ''}
          <div class="acts">${x.kind === 'automated' ? `<button class="btn sm" data-act="runRefresh" data-source="${x.id}">Run now</button>` : x.kind !== 'legacy' ? '<button class="btn sm" data-act="addLead">Add a find</button>' : ''}</div></div>`).join('')}</div>`,
        { note: `${auto.filter(x => x.last_status === 'success').length} of ${P.plural(auto.length, 'automated source')} working${failing.length ? `, ${failing.length} failing` : ''}${auto.some(x => !x.last_status) ? `, ${auto.filter(x => !x.last_status).length} not run yet` : ''}. Failed runs retry every hour, up to 3 times.` })}`;
  }
  const dsrc = (d, id) => (d?.sources || []).find(x => x.id === id);
  function srcStats(x, d) {
    const y = dsrc(d, x.id);
    if (!y || x.kind !== 'automated') return '';
    const lr = y.last_run;
    return `<div class="small muted">${lr ? `Last run looked at ${P.plural(lr.examined, 'record')}: ${lr.relevant} relevant, ${lr.discovered} new, ${lr.updated} updated${lr.merged ? `, ${lr.merged} merged` : ''}.` : 'Not run yet.'}
      Last 30 days: ${P.plural(y.found_30d, 'new project')}, ${y.relevant_30d} with Speedy scope.</div>`;
  }
  function discoveryStrip(d) {
    if (!d) return '';
    const m = d.summary || {};
    const cell = (v, l, attn) => `<div><div class="lbl">${esc(l)}</div><div class="val${attn ? ' attn' : ''}">${v ?? 0}</div></div>`;
    return sec('Discovery, last 7 days', `<div class="metricgrid wide4">
        ${cell(m.examined_7d, 'Records examined')}${cell(m.relevant_7d, 'Relevant to Speedy')}${cell(m.discovered_7d, 'New projects')}${cell(m.updated_7d, 'Projects updated')}
        ${cell(m.merged_7d, 'Matched across sources')}${cell(m.high_7d, 'Documented scope found')}${cell(m.awards_7d, 'Relevant awards')}${cell(m.awaiting_review, 'Waiting for review', m.awaiting_review > 0)}
        ${cell(m.duplicates_open, 'Possible duplicates', m.duplicates_open > 0)}${cell(`${m.sources_ok}/${m.sources_automated}`, 'Automated sources OK')}${cell(m.sources_errors, 'Sources with errors', m.sources_errors > 0)}${cell(m.sources_stale, 'Stale (no success in 3 days)', m.sources_stale > 0)}
      </div>`, { note: 'Counts come from refresh runs that actually executed. A source counts as working only after it retrieved and processed records.' });
  }
  function srcCoverage(s) {
    const d = s.discovery || {}, f = P.state.covRegion || '', gaps = !!P.state.covGaps;
    const counties = (d.counties || []).filter(c => (!f || c.region === f) && (!gaps || (!c.found_90d && !c.local_sources.length)));
    const regions = d.regions || [];
    const statewide = (d.sources || []).filter(x => x.kind === 'automated' && !/City|county/i.test(x.geography || ''));
    const yes = '<span class="status ok"><span class="dot ok"></span>';
    return `${sec('What each source covers', `<div class="tablewrap"><table class="tbl"><thead><tr><th scope="col">Source</th><th scope="col">Area</th><th scope="col">What it finds</th><th scope="col">How</th>
        <th scope="col">Last tried</th><th scope="col">Last success</th><th class="num" scope="col">Examined</th><th class="num" scope="col">Relevant, 30 days</th><th scope="col">Status and limits</th></tr></thead><tbody>
        ${(d.sources || []).map(x => `<tr><td><b class="strong">${esc(x.name)}</b>${x.url ? `<div class="sub"><a href="${P.url(x.url)}" target="_blank" rel="noopener">Open</a></div>` : ''}</td>
          <td>${esc(x.geography || '')}</td><td class="small">${esc(x.project_types || '')}</td><td class="small">${esc(x.method || '')}</td>
          <td class="nowrap">${x.last_run_at ? esc(P.ago(x.last_run_at)) : '<span class="faint">Never</span>'}</td><td class="nowrap">${x.last_success_at ? esc(P.ago(x.last_success_at)) : '<span class="faint">Never</span>'}</td>
          <td class="num">${x.last_run ? x.last_run.examined : '<span class="faint">—</span>'}</td><td class="num">${x.kind === 'automated' ? x.relevant_30d : '<span class="faint">—</span>'}</td>
          <td class="small">${statusOf(x)}${x.kind !== 'automated' ? `<div class="sub">${esc(String(x.access_notes || '').slice(0, 160))}${String(x.access_notes || '').length > 160 ? '…' : ''}</div>` : ''}</td></tr>`).join('')}
        </tbody></table></div>`, { note: 'Examined = records the last run looked at. Relevant = new projects in the last 30 days whose scope matched Speedy\'s services (documented or inferred).' })}
      ${sec('Regions', `<div class="tablewrap"><table class="tbl"><thead><tr><th scope="col">Region</th><th class="num" scope="col">Counties</th><th class="num" scope="col">Available leads</th><th class="num" scope="col">New projects, 30 days</th></tr></thead><tbody>
        ${regions.map(r => `<tr><td>${esc(r.region)}</td><td class="num">${r.counties}</td><td class="num">${r.available}</td><td class="num">${r.found_30d}</td></tr>`).join('')}</tbody></table></div>`)}
      ${sec('Counties', `<div class="row" style="margin-bottom:10px"><label class="field" style="margin:0"><span class="sr">Region</span><select data-act-change="covRegion"><option value="">All regions</option>${regions.map(r => `<option ${f === r.region ? 'selected' : ''}>${esc(r.region)}</option>`).join('')}</select></label>
          <label class="check" style="margin:0"><input type="checkbox" data-act-change="covGaps" ${gaps ? 'checked' : ''}><span>Only counties with no records and no local source</span></label><span class="small muted grow">${counties.length} of 67</span></div>
        <div class="tablewrap"><table class="tbl"><thead><tr><th scope="col">County</th><th scope="col">Region</th><th class="num" scope="col">FDOT district</th><th class="num" scope="col">Projects found, 90 days</th><th class="num" scope="col">Open leads</th><th scope="col">Local source</th><th scope="col">Records came from</th></tr></thead><tbody>
        ${counties.map(c => `<tr><td>${esc(c.county)}</td><td>${esc(c.region)}</td><td class="num">${c.fdot_district}</td><td class="num">${c.found_90d || '<span class="faint">0</span>'}</td><td class="num">${c.open_leads || '<span class="faint">0</span>'}</td>
          <td>${c.local_sources.length ? yes + esc(c.local_sources.join(', ')) + '</span>' : '<span class="faint">None yet</span>'}</td><td class="small">${esc((c.sources_90d || []).join(', '))}</td></tr>`).join('')}</tbody></table></div>`,
        { note: `Every county is checked by the statewide sources (${esc(statewide.map(x => x.name.replace(/ \(.*\)$/, '')).join('; '))}), which cover federal work and state road and bridge contracts. County, city, school and utility bid boards are not collected automatically yet, so local public work in counties without a local source depends on manual finds.` })}`;
  }
  document.addEventListener('change', (e) => {
    const k = e.target.dataset?.actChange;
    if (k === 'covRegion') { P.state.covRegion = e.target.value; renderSources(document.getElementById('view')); }
    if (k === 'covGaps') { P.state.covGaps = e.target.checked; renderSources(document.getElementById('view')); }
  });
  const CAUSE = { already_in_pipeline: 'Already in the pipeline', source_not_monitored: 'Source not monitored', access_restricted: 'Source needs a login or subscription',
    collector_failed: 'Collector failed', source_not_refreshed: 'Source not refreshed recently', filtered_or_not_reached: 'Filtered out or not reached', not_found: 'Not found' };
  function srcMissed() {
    const r = P.state.missed, pr = P.state.probe, hist = P.state.missedList || [];
    return `${sec('Check a project we may have missed', `<div class="card card-pad" style="max-width:760px">
        <form data-form="missed" class="row" style="gap:8px;align-items:end"><label class="field grow" style="margin:0"><span>Link, solicitation or contract number, permit number, or project name</span>
          <input type="text" name="q" required placeholder="https://sam.gov/opp/…, W912EP26B0012, BLD2026-12345" value="${esc(P.state.missedQ || '')}"></label><button class="btn primary" type="submit">Check</button></form>
        ${r ? `<div class="probe"><div class="alert ${r.cause === 'already_in_pipeline' ? 'info' : 'warn'}">${P.icon(r.cause === 'already_in_pipeline' ? 'check' : 'info')}<div class="grow"><b>${esc(CAUSE[r.cause] || r.cause)}</b><div class="small">${esc(r.detail || '')}</div>
            ${(r.matches || []).map(x => `<div class="small" style="margin-top:6px">${esc(x.title)} · ${esc(x.source_name || '')}${(x.opps || []).map(o => ` · <a href="#/lead/${o.id}" data-lead="${o.id}">${esc(o.ref)}</a> ${esc(P.stageLabel(o.stage))}${o.needs_review ? ' (in review)' : ''}${o.owner ? ', ' + esc(o.owner) : ''}`).join('')}</div>`).join('')}</div></div>
          <div class="row" style="gap:8px;margin-top:10px">
            ${r.probe_supported && r.cause !== 'already_in_pipeline' ? '<button class="btn" data-act="probeMissed">Check the record</button>' : ''}
            ${r.cause !== 'already_in_pipeline' ? '<button class="btn ghost" data-act="addLead">Add it by hand</button><button class="btn ghost" data-act="missedNotRelevant">Not relevant</button>' : ''}</div>
          ${pr ? `<div class="panel" style="margin-top:12px"><h3>${esc(pr.title || 'Record')}</h3>${pr.error ? `<p class="due-hot">${esc(pr.error)}</p>` : `
            <p class="small"><b>${esc({ high: 'Confirmed relevant scope', potential: 'Strong subcontracting potential', review: 'Possible opportunity requiring review', low: 'Low relevance' }[pr.relevance] || pr.relevance)}</b>. ${esc(pr.reason || '')}</p>
            ${(pr.would_skip || []).length ? `<p class="small">Why the collector would skip it:</p><ul class="small">${pr.would_skip.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="small">The collector would accept it; it was likely not reached yet (page or new-item limits) or arrived after the last run.</p>'}
            ${pr.imported ? '<p class="small strong">Imported. It is in the review queue or the pool, depending on its scope.</p>' : '<button class="btn primary" data-act="importMissed">Import it</button>'}`}</div>` : ''}</div>` : ''}
      </div>`, { note: 'Use this when you find a real Florida project the portal did not show. Each check is logged so the gaps can be fixed and added to the tests.' })}
      ${hist.length ? sec('Recent checks', `<div class="tablewrap"><table class="tbl"><thead><tr><th scope="col">When</th><th scope="col">What was checked</th><th scope="col">Finding</th><th scope="col">Resolution</th><th scope="col">By</th></tr></thead><tbody>
        ${hist.map(h => `<tr><td class="nowrap">${esc(P.ago(h.at))}</td><td class="small" style="max-width:320px;overflow-wrap:anywhere">${esc(h.input)}</td><td class="small">${esc(CAUSE[h.cause] || h.cause || '')}${h.source_name ? `<div class="sub">${esc(h.source_name)}</div>` : ''}</td><td class="small">${esc((h.resolution || '').replace(/_/g, ' '))}</td><td class="small">${esc(h.by || '')}</td></tr>`).join('')}</tbody></table></div>`) : ''}`;
  }
  document.addEventListener('submit', async (e) => {
    if (e.target.dataset?.form !== 'missed') return;
    e.preventDefault();
    const q = new FormData(e.target).get('q');
    const btn = e.target.querySelector('button');
    await P.busy(btn, async () => {
      P.state.missedQ = q; P.state.probe = null;
      P.state.missed = await P.rpc('check_missed', { p_input: q });
      P.state.missedList = await P.rpc('missed_checks_list');
      renderSources(document.getElementById('view'));
    });
  });
  P.act.probeMissed = (el) => P.busy(el, async () => {
    P.state.probe = await P.fn('refresh', { source: 'probe', url: P.state.missedQ }).catch(e => ({ error: e.message }));
    if (P.state.probe?.error && !P.state.probe.title) P.state.probe = { error: P.state.probe.error };
    await P.rpc('resolve_missed_check', { p_id: P.state.missed.id, p: { probe: P.state.probe } });
    renderSources(document.getElementById('view'));
  });
  P.act.importMissed = (el) => P.busy(el, async () => {
    const r = await P.fn('refresh', { source: 'probe', url: P.state.missedQ, import: true });
    if (r.error) throw new Error(r.error);
    P.state.probe = r;
    await P.rpc('resolve_missed_check', { p_id: P.state.missed.id, p: { resolution: 'imported', probe: r } });
    P.state.missedList = await P.rpc('missed_checks_list');
    P.invalidate(); renderSources(document.getElementById('view')); P.toast('Imported.');
  });
  P.act.missedNotRelevant = (el) => P.busy(el, async () => {
    await P.rpc('resolve_missed_check', { p_id: P.state.missed.id, p: { resolution: 'not_relevant' } });
    P.state.missed = null; P.state.missedList = await P.rpc('missed_checks_list');
    renderSources(document.getElementById('view')); P.toast('Logged as not relevant.');
  });
  function srcReview(s) {
    return sec('Waiting for review', s.review.length ? `<div class="list">${s.review.map(r => `<div class="srcrow">
        <div class="name"><a href="#/lead/${r.id}" data-lead="${r.id}">${esc(r.title)}</a> ${ui.prio(r.priority)} <span class="badge outline">${esc({ discovery: 'New find', duplicate: 'Possible duplicate', cancelled: 'Cancelled at source', missing: 'No longer listed' }[r.review_kind] || 'Check')}</span></div>
        <div class="small" style="color:var(--ink-2)">${esc(r.review_reason || '')}</div>
        <div class="small muted">${esc(r.ref)} · ${esc(r.owner_name || 'Unowned')} · ${esc(P.stageLabel(r.stage))} · flagged ${esc(P.ago(r.created_at))}${r.source_url ? ` · <a href="${P.url(r.source_url)}" target="_blank" rel="noopener">Source</a>` : ''}</div>
        <div class="acts"><button class="btn sm" data-act="review" data-id="${r.id}" data-a="publish">${r.review_kind === 'discovery' ? 'Publish' : r.review_kind === 'duplicate' ? 'Keep both' : 'Keep'}</button><button class="btn sm danger" data-act="review" data-id="${r.id}" data-a="archive">Archive</button></div></div>`).join('')}</div>`
      : P.empty('Nothing to review', 'New finds and source changes that need a look show up here.', '', 'card'),
      { n: s.review.length, note: '<b>Publish</b> puts a new find in the Available pool. <b>Keep</b> (or <b>Keep both</b> for a possible duplicate) clears the flag and leaves the lead as it is. <b>Archive</b> closes it. Salespeople do not see unreviewed new finds.' });
  }
  function srcRuns(s) {
    const f = P.state.runFilter || 'all';
    const runs = s.runs.filter(r => f === 'all' || (f === 'scheduled' ? ['schedule', 'retry'].includes(r.trigger) : f === 'manual' ? r.trigger === 'manual' : f === 'failed' ? ['failed', 'partial'].includes(r.status) : true));
    const trig = (r) => r.trigger === 'schedule' ? '<span class="badge outline">Scheduled</span>' : r.trigger === 'manual' ? '<span class="badge accent">Manual</span>' : r.trigger === 'retry' ? `<span class="badge outline">Retry #${r.attempt}</span>` : `<span class="badge later">${esc(r.trigger)}</span>`;
    const res = (r) => r.status === 'success' ? '<span class="status ok"><span class="dot ok"></span>Success</span>' : r.status === 'running' ? '<span class="status"><span class="dot accent"></span>Running</span>' : r.status === 'partial' ? '<span class="status warn"><span class="dot warm"></span>Partial</span>' : '<span class="status fail"><span class="dot danger"></span>Failed</span>';
    const dur = (r) => r.finished_at ? Math.max(1, Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000)) + ' s' : '';
    return `<div class="row" style="margin-bottom:12px"><div class="seg" role="group" aria-label="Show runs">${[['all', 'All'], ['scheduled', 'Scheduled'], ['manual', 'Manual'], ['failed', 'Failed or partial']].map(([k, l]) => `<button data-act="runFilter" data-f="${k}" aria-pressed="${f === k}">${l}</button>`).join('')}</div>
      <span class="small muted grow">${s.runs.length ? `Last ${s.runs.length} runs. Scheduled runs come from the timer; manual runs were started from this page.` : 'No refresh has run yet.'}</span></div>
      ${runs.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th scope="col">Started</th><th scope="col">Source</th><th scope="col">How</th><th scope="col">Result</th><th class="num" scope="col">Examined</th><th class="num" scope="col">Relevant</th><th class="num" scope="col">New</th><th class="num" scope="col">Updated</th><th class="num" scope="col">Merged</th><th class="num" scope="col">Flagged</th><th class="num" scope="col">Errors</th><th scope="col"><span class="sr">Log</span></th></tr></thead><tbody>
        ${runs.map(r => `<tr><td class="nowrap">${esc(P.dateTime(r.started_at))}<div class="sub">${esc(dur(r))}</div></td><td>${esc(srcName(r.source_id))}</td><td>${trig(r)}</td><td>${res(r)}${r.error ? `<div class="sub" title="${esc(r.error)}">${esc(String(r.error).slice(0, 60))}${String(r.error).length > 60 ? '…' : ''}</div>` : ''}</td>
          <td class="num">${r.examined || r.fetched}</td><td class="num">${r.relevant ?? ''}</td><td class="num">${r.discovered}</td><td class="num">${r.updated}</td><td class="num">${r.merged}</td><td class="num">${r.flagged}</td><td class="num">${r.errors || '<span class="faint">0</span>'}</td>
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
      <button class="btn primary" data-act="saveSettings">Save settings</button></div>
      ${scheduleHtml(s.settings.refresh_schedule?.value)}
      ${termsHtml(P.state.terms)}`;
  }
  function scheduleHtml(v) {
    if (!v) return '';
    const t = (k, l, help) => `<label class="field"><span>${esc(l)}</span><input type="time" id="sch_${k}" value="${esc(v[k] || '')}" required><span class="help">${esc(help)}</span></label>`;
    return sec('Refresh schedule (Eastern time)', `<div class="card card-pad" style="max-width:640px">
      <label class="check"><input type="checkbox" id="sch_enabled" ${v.enabled === false ? '' : 'checked'}><span>Run the automatic schedule</span></label>
      <div class="grid2" style="margin-top:10px">
        ${t('morning', 'Morning collection', 'Every automated source refreshes.')}${t('verify', 'Check and retry', 'Anything that failed or did not finish runs again.')}
        ${t('snapshot', 'Morning snapshot', 'Leads re-ranked and the morning data marked verified.')}${t('alert', 'Alert managers if late', 'Only when a source is still failing.')}
        ${t('midday', 'Midday check', (v.midday_sources || []).join(', ') + '.')}${t('afternoon', 'Afternoon check', (v.afternoon_sources || []).join(', ') + '.')}
      </div>
      <p class="small muted">Runs on Supabase's servers, so no computer needs to be on. Times follow daylight saving time automatically. The scheduler checks every 5 minutes, so a step can start up to 5 minutes after its time.</p>
      <button class="btn primary" data-act="saveSchedule">Save schedule</button></div>`);
  }
  const KIND_LABEL = { direct: ['Documented scope', 'The source names Speedy work. Makes a lead high priority evidence.'],
    indicator: ['Project types', 'Usually needs Speedy. Marked as inferred, never as a confirmed request.'],
    negative: ['Lowers relevance', 'Roofing, finishes, design services and similar.'], exclude: ['Not construction', 'Dropped unless a documented term also appears.'],
    category: ['Project category', 'Only sorts projects into categories.'] };
  function termsHtml(list) {
    if (!list) return '';
    const groups = Object.keys(KIND_LABEL).map(k => [k, list.filter(t => t.kind === k)]).filter(([, l]) => l.length);
    return sec('Search terms', `<div class="card">${groups.map(([k, l]) => `<details class="plain termgroup" ${k === 'direct' ? 'open' : ''}><summary><b class="strong">${esc(KIND_LABEL[k][0])}</b> <span class="small muted">${l.length} · ${esc(KIND_LABEL[k][1])}</span></summary>
        <div class="tablewrap"><table class="tbl"><thead><tr><th scope="col">Name</th><th scope="col">Looks for</th><th scope="col">Services</th><th class="num" scope="col">Weight</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>
        ${l.map(t => `<tr class="${t.enabled ? '' : 'off'}"><td>${esc(t.label)}${t.enabled ? '' : ' <span class="badge later">Off</span>'}</td><td><code class="pat">${esc(t.pattern.length > 90 ? t.pattern.slice(0, 90) + '…' : t.pattern)}</code></td>
          <td class="small">${esc((t.services || []).join(', '))}</td><td class="num">${t.weight}</td>
          <td class="nowrap"><button class="btn sm ghost" data-act="editTerm" data-id="${t.id}">Edit</button><button class="btn sm ghost" data-act="toggleTerm" data-id="${t.id}" data-on="${t.enabled ? 0 : 1}">${t.enabled ? 'Turn off' : 'Turn on'}</button></td></tr>`).join('')}
        </tbody></table></div></details>`).join('')}</div>`,
      { note: 'The refreshes read these on every run. Words are matched at the start of a word and ignore capitals; separate alternatives with |. Changes apply to the next refresh, not to leads already found.',
        tools: '<button class="btn sm" data-act="editTerm">Add a term</button>' });
  }
  P.act.toggleTerm = (el) => P.busy(el, async () => {
    await P.rpc('save_service_term', { p: { id: Number(el.dataset.id), enabled: el.dataset.on === '1' } });
    P.state.terms = await P.rpc('service_terms_list'); renderSources(document.getElementById('view'));
    P.toast(el.dataset.on === '1' ? 'Term turned on.' : 'Term turned off. The next refresh ignores it.');
  });
  P.act.editTerm = (el) => {
    const t = (P.state.terms || []).find(x => String(x.id) === el.dataset.id) || { kind: 'direct', weight: 3, services: [] };
    P.dialog({ title: t.id ? `Edit "${t.label}"` : 'Add a search term', ok: 'Save', wide: true,
      fields: [
        { name: 'label', label: 'Name', value: t.label || '', required: true, help: 'Shown as the reason a lead matched, for example "core drilling".' },
        { name: 'pattern', label: 'Words to look for', value: t.pattern || '', required: true, help: 'For example: core drill\\w*|coring|core holes?' },
        { name: 'kind', label: 'What a match means', type: 'select', value: t.kind, required: true, options: Object.entries(KIND_LABEL).map(([k, v]) => [k, v[0]]) },
        { name: 'weight', label: 'Weight', type: 'text', value: t.weight, help: 'Documented scope 3; project types 1 or 2; lowers relevance -1 to -3.' },
        { name: 'services', label: 'Speedy services it points to', value: (t.services || []).join(', '), help: 'Comma separated: ' + P.SERVICES.join(', ') },
      ],
      onOk: async (v) => {
        const services = v.services.split(',').map(x => x.trim()).filter(Boolean);
        const bad = services.filter(x => !P.SERVICES.includes(x));
        if (bad.length) throw new Error(`Not a Speedy service: ${bad.join(', ')}`);
        await P.rpc('save_service_term', { p: { id: t.id || null, label: v.label, pattern: v.pattern, kind: v.kind, weight: v.weight === '' ? null : Number(v.weight), services } });
        P.state.terms = await P.rpc('service_terms_list'); renderSources(document.getElementById('view')); P.toast('Search term saved.');
      } });
  };
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
  P.act.saveSchedule = (el) => P.busy(el, async () => {
    const cur = P.state.sources.settings.refresh_schedule.value, g = (k) => document.getElementById('sch_' + k).value;
    const v = { ...cur, enabled: document.getElementById('sch_enabled').checked };
    for (const k of ['morning', 'verify', 'snapshot', 'alert', 'midday', 'afternoon']) v[k] = g(k);
    const m = (x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5));
    if (!(m(v.morning) < m(v.verify) && m(v.verify) < m(v.snapshot) && m(v.snapshot) < m(v.alert))) throw new Error('Keep the morning steps in order: collection, check, snapshot, alert.');
    await P.rpc('update_setting', { p_key: 'refresh_schedule', p_value: v });
    P.state.sources.settings.refresh_schedule.value = v;
    P.toast('Schedule saved. It applies from the next 5-minute check.');
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
  // ---------------------------------------------------------------- Team report (managers)
  P.views.reports = async (view) => {
    P.setPage('Team report');
    if (!P.isMgr()) { view.innerHTML = P.pageHead({ title: 'Team report' }) + P.empty('Managers only', 'Ask a manager for team numbers.'); return; }
    const f = P.state.repF ||= { from: P.addDays(-30), to: P.todayET(), user_id: '', region: '', source_id: '' };
    view.innerHTML = P.pageHead({ title: 'Team report' }) + P.skeleton(6);
    const [r, t, src] = await Promise.all([P.rpc('team_report', { p: f }), P.state.team || P.rpc('team_overview'), P.state.sources || P.rpc('sources_status')]);
    P.state.team = t;
    if (P.state.page !== 'reports') return;
    const tot = r.totals || {};
    const opt = (v, cur, label) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
    const people = r.people.filter(p => p.attempts || p.claimed || p.active_now || p.won || p.lost);
    const col = (k, l) => `<th class="num" scope="col">${l}</th>`;
    const maxA = Math.max(1, ...people.map(p => p.attempts));
    const bar = (n, max) => `<span class="trk" style="display:block;width:80px;height:8px;background:#EEF0EE;border-radius:3px;overflow:hidden"><i style="display:block;height:100%;background:var(--accent);width:${Math.round(100 * n / max)}%"></i></span>`;
    view.innerHTML = `${P.pageHead({ title: 'Team report', sub: `${esc(P.date(r.from))} to ${esc(P.date(r.to))}. Activity is what people did; results are what came of it.` })}
      <form class="report-filters" data-form="repFilter">
        <label class="field"><span>From</span><input type="date" name="from" value="${esc(f.from)}"></label>
        <label class="field"><span>To</span><input type="date" name="to" value="${esc(f.to)}"></label>
        <label class="field"><span>Person</span><select name="user_id">${opt('', f.user_id, 'Everyone')}${(t.people || []).filter(p => p.active).map(p => opt(p.id, f.user_id, p.name || p.email)).join('')}</select></label>
        <label class="field"><span>Region</span><select name="region">${opt('', f.region, 'All Florida')}${P.REGIONS.filter(x => x !== 'Unknown').map(x => opt(x, f.region, x)).join('')}</select></label>
        <label class="field"><span>Lead source</span><select name="source_id">${opt('', f.source_id, 'All sources')}${(src.sources || []).map(x => opt(x.id, f.source_id, x.name)).join('')}</select></label>
        <button class="btn" type="submit">Apply</button>
      </form>
      ${sec('Activity', `<div class="metricgrid wide4">${[['Leads claimed or assigned', tot.claimed], ['Calls, emails and visits', tot.attempts], ['Conversations', tot.conversations], ['Follow-ups scheduled', tot.follow_ups_set]]
        .map(([l, v]) => `<div><div class="lbl">${l}</div><div class="val">${v ?? 0}</div></div>`).join('')}</div>`, { note: 'A conversation is a logged contact where someone was reached (not a no-answer, voicemail or wrong contact).' })}
      ${sec('Results', `<div class="metricgrid wide4">${[['Quotes requested', tot.quotes_requested], ['Quotes sent', tot.quotes_sent], ['Won', tot.won], ['Lost', tot.lost]]
        .map(([l, v]) => `<div><div class="lbl">${l}</div><div class="val">${v ?? 0}</div></div>`).join('')}</div>`,
        { note: tot.win_rate != null ? `Win rate ${tot.win_rate}% of leads closed in this period.` : 'Win rate shows once at least 5 leads have been won or lost in the period.' })}
      ${sec('By person', people.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th scope="col">Person</th>${col('', 'Claimed')}${col('', 'Contacts')}<th scope="col"><span class="sr">Contacts bar</span></th>${col('', 'Conversations')}${col('', 'Quotes req.')}${col('', 'Quotes sent')}${col('', 'Won')}${col('', 'Lost')}${col('', 'Active now')}${col('', 'Overdue now')}${col('', 'Inactive now')}</tr></thead><tbody>
        ${people.map(p => `<tr data-person="${p.id}" class="clickable"><td><a href="#/reports?person=${p.id}" data-person="${p.id}">${esc(p.full_name || 'Unknown')}</a></td><td class="num">${p.claimed}</td><td class="num">${p.attempts}</td><td>${bar(p.attempts, maxA)}</td><td class="num">${p.conversations}</td>
          <td class="num">${p.quotes_requested}</td><td class="num">${p.quotes_sent}</td><td class="num">${p.won}</td><td class="num">${p.lost}</td><td class="num">${p.active_now}</td><td class="num ${p.overdue_now ? 'due-hot' : ''}">${p.overdue_now}</td><td class="num ${p.inactive_now ? 'due-hot' : ''}">${p.inactive_now}</td></tr>`).join('')}
        </tbody></table></div>` : P.empty('No activity in this period', 'Try a longer date range.', '', 'sm'),
        { note: `"Inactive now" means an assigned lead with no logged work for ${r.stale_days} days. Leads differ in quality and timing, so compare people with care.` })}
      ${(r.quotes_attention || []).length ? sec('Quotes that need attention', `<div class="card">${r.quotes_attention.map(q => `<div class="mini" data-lead="${q.id}"><div class="t"><a class="ell" href="#/lead/${q.id}" data-lead="${q.id}">${esc(q.title)}</a></div>
          <div class="s">${esc(q.ref)} · ${esc(q.owner || 'Unassigned')} · ${esc(P.QUOTE_STATUS[q.quote_status] || q.quote_status)}${q.requested ? ' · requested ' + esc(P.date(q.requested)) : ''}${q.sent ? ' · sent ' + esc(P.date(q.sent)) : ''}${q.amount ? ' · ' + esc(P.money(q.amount)) : ''}</div>
          <div class="r">${q.due ? ui.due(q.due) : ''}</div></div>`).join('')}</div>`, { n: r.quotes_attention.length, note: 'Requested two or more days ago without a price, or sent at least a week ago with no answer.' }) : ''}
      ${(r.stage_time || []).length ? sec('Average days in each stage', `<div class="hbars">${r.stage_time.map(x => `<div class="hbar" style="grid-template-columns:150px minmax(0,1fr) 90px"><span class="lab">${esc(P.stageLabel(x.stage))}</span><span class="trk"><i style="width:${Math.min(100, Math.round(100 * x.days / Math.max(...r.stage_time.map(y => Number(y.days)), 1)))}%"></i></span><span class="v">${x.days} d <span class="faint">(${x.n})</span></span></div>`).join('')}</div>`, { note: 'From stage changes logged in this period. Small counts are not reliable.' }) : ''}
      ${(r.by_source || []).length ? sec('By lead source', `<div class="tablewrap"><table class="tbl"><thead><tr><th scope="col">Source</th><th class="num" scope="col">Being worked</th><th class="num" scope="col">Quoted</th><th class="num" scope="col">Won in period</th></tr></thead><tbody>
        ${r.by_source.map(x => `<tr><td>${esc(x.source)}</td><td class="num">${x.active}</td><td class="num">${x.quotes}</td><td class="num">${x.won}</td></tr>`).join('')}</tbody></table></div>`) : ''}`;
  };
  document.addEventListener('submit', (e) => {
    if (e.target.dataset?.form !== 'repFilter') return;
    e.preventDefault();
    P.state.repF = Object.fromEntries(new FormData(e.target));
    P.views.reports(document.getElementById('view'));
  });

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
        <section class="card card-pad"><div class="sec-head"><h2>My territory and services</h2></div>
          <p class="small muted" style="margin-top:-6px">Used for your morning briefing and Hot lead list. You still see leads from all of Florida.</p>
          <div class="lbl">Territory</div><div class="chips" style="margin-bottom:14px">${P.REGIONS.filter(x => x !== 'Unknown').map(x => `<button type="button" class="chip" data-act="toggleChip" data-pref="territory" data-v="${esc(x)}" aria-pressed="${(m.prefs?.territory || ['Central FL']).includes(x)}">${esc(x)}</button>`).join('')}</div>
          <div class="lbl">Services I sell most</div><div class="chips" style="margin-bottom:14px">${P.SERVICES.map(x => `<button type="button" class="chip" data-act="toggleChip" data-pref="services" data-v="${esc(x)}" aria-pressed="${(m.prefs?.services || []).includes(x)}">${esc(x)}</button>`).join('')}</div>
          <div class="lbl">Notifications</div>
          ${[['follow_ups', 'Follow-up and stalled-lead reminders'], ['assignments', 'Leads assigned to me and manager updates'], ['deadlines', 'Bid deadlines coming up'], ['updates', 'Source changes, awards and watched projects or companies'], m.role === 'manager' && ['discoveries', 'New finds and the daily review summary']].filter(Boolean)
            .map(([k, l]) => `<label class="check"><input type="checkbox" data-notify="${k}" ${m.prefs?.notify?.[k] === false ? '' : 'checked'}><span>${esc(l)}</span></label>`).join('')}
          <p class="small faint" style="margin:6px 0 12px">Refresh failures and the 6 AM data alert always reach managers.</p>
          <button class="btn primary" data-act="savePrefs">Save preferences</button></section>
        <section class="card card-pad"><div class="sec-head"><h2>Sign-in</h2></div>
          <div class="row"><button class="btn" data-act="changePw">Change password</button><button class="btn danger" data-act="signOut">${P.icon('logout')}Sign out</button></div></section>
      </div>`;
  };
  P.act.savePrefs = (el) => P.busy(el, async () => {
    const pick = (k) => [...document.querySelectorAll(`[data-pref="${k}"][aria-pressed="true"]`)].map(b => b.dataset.v);
    const territory = pick('territory');
    if (!territory.length) throw new Error('Pick at least one region for your territory.');
    const notify = Object.fromEntries([...document.querySelectorAll('[data-notify]')].map(i => [i.dataset.notify, i.checked]));
    const r = await P.rpc('update_my_prefs', { p: { territory, services: pick('services'), notify } });
    P.state.me = { ...P.state.me, prefs: r.prefs }; P.state.briefing = null;
    P.toast('Preferences saved.');
  });
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
