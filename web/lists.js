/* Lists: Today, Available, My pipeline, Gov contracts, All leads. */
(function () {
  const { esc } = P;
  const me = () => P.state.me;
  const regionRank = (r) => { const i = P.REGIONS.indexOf(r); return i < 0 ? 9 : i; };
  const pr = { Hot: 0, Warm: 1, Later: 2 };

  const SORTS = {
    priority: (a, b) => (pr[a.priority] ?? 3) - (pr[b.priority] ?? 3) || ((b.fit_score || 0) + (b.urgency_score || 0)) - ((a.fit_score || 0) + (a.urgency_score || 0)) || regionRank(a.region) - regionRank(b.region),
    deadline: (a, b) => (upcoming(a) ?? 9e15) - (upcoming(b) ?? 9e15) || SORTS.priority(a, b),
    followup: (a, b) => String(a.next_action_due || '9999') .localeCompare(String(b.next_action_due || '9999')) || SORTS.priority(a, b),
    region: (a, b) => regionRank(a.region) - regionRank(b.region) || SORTS.priority(a, b),
    newest: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
    activity: (a, b) => String(b.last_activity_at || '').localeCompare(String(a.last_activity_at || '')),
  };
  const SORT_LABEL = { priority: 'Priority', deadline: 'Deadline', followup: 'Follow-up date', region: 'Closest to Orlando', newest: 'Newest', activity: 'Last activity' };
  function upcoming(r) { if (!r.deadline) return null; const t = new Date(r.deadline).getTime(); return t >= Date.now() ? t : null; }

  // ---------------------------------------------------------------- filtering
  const FKEYS = ['region', 'city', 'service', 'pstage', 'owner', 'stage', 'source', 'deadline', 'fresh', 'priority'];
  function applyFilters(rows, f) {
    const toks = (f.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const now = Date.now();
    return rows.filter(r => {
      if (toks.length && !toks.every(t => (r.search_text || '').includes(t))) return false;
      if (f.region && (r.region || 'Unknown') !== f.region) return false;
      if (f.city && (r.city || r.county || '') !== f.city) return false;
      if (f.service && !(r.services || []).concat(r.services_confirmed || []).includes(f.service)) return false;
      if (f.pstage && r.project_stage !== f.pstage) return false;
      if (f.owner === 'none' && r.owner_id) return false;
      if (f.owner === 'me' && r.owner_id !== me().id) return false;
      if (f.owner && !['none', 'me'].includes(f.owner) && r.owner_id !== f.owner) return false;
      if (f.stage && r.stage !== f.stage) return false;
      if (f.source && r.source_id !== f.source) return false;
      if (f.priority && r.priority !== f.priority) return false;
      if (f.deadline) {
        const t = r.deadline ? new Date(r.deadline).getTime() : null;
        if (f.deadline === 'passed') { if (!t || t >= now) return false; }
        else if (!t || t < now || t > now + Number(f.deadline) * 86400000) return false;
      }
      if (f.fresh) {
        const v = r.last_verified_at ? (now - new Date(r.last_verified_at)) / 86400000 : null;
        if (f.fresh === 'never' && v !== null) return false;
        if (f.fresh === 'failed' && !['failed', 'missing'].includes(r.verify_status)) return false;
        if (['7', '30'].includes(f.fresh) && (v === null || v > Number(f.fresh))) return false;
      }
      return true;
    });
  }
  function options(rows, key, label) {
    const vals = [...new Set(rows.map(key).flat().filter(Boolean))].sort();
    return vals.map(v => [v, label ? label(v) : v]);
  }
  function filterBar(viewKey, rows, f, opts = {}) {
    const sel = (name, title, list, allLabel = 'Any') => `<label>${esc(title)}<select data-filter="${name}"><option value="">${esc(allLabel)}</option>${list.map(([v, t]) => `<option value="${esc(v)}" ${f[name] === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
    const people = [...new Map(rows.filter(r => r.owner_id).map(r => [r.owner_id, r.owner_name])).entries()];
    const active = FKEYS.filter(k => f[k]).length;
    return `
      <div class="toolbar">
        <input type="search" class="search" data-filter="q" value="${esc(f.q || '')}" placeholder="Search company, project, contact, solicitation #" aria-label="Search">
        <button class="btn" data-act="toggleFilters" aria-expanded="${f._open ? 'true' : 'false'}">Filters${active ? ` (${active})` : ''}</button>
        <label class="sr" for="sort_${viewKey}">Sort</label>
        <select id="sort_${viewKey}" data-filter="sort" style="width:auto">${(opts.sorts || ['priority', 'deadline', 'region', 'newest', 'activity']).map(s => `<option value="${s}" ${f.sort === s ? 'selected' : ''}>Sort: ${SORT_LABEL[s]}</option>`).join('')}</select>
      </div>
      <div class="filters ${f._open ? 'open' : ''}" id="filters">
        ${sel('region', 'Region', P.REGIONS.map(r => [r, r]))}
        ${sel('city', 'City or county', options(rows, r => r.city || r.county))}
        ${sel('service', 'Service', options(rows, r => (r.services || []).concat(r.services_confirmed || [])))}
        ${sel('pstage', 'Project stage', options(rows, r => r.project_stage, v => P.PSTAGE[v] || v))}
        ${opts.noOwner ? '' : sel('owner', 'Owner', [['none', 'Nobody (available)'], ['me', 'Me'], ...people.filter(([id]) => id !== me().id)])}
        ${opts.noStage ? '' : sel('stage', 'Status', (me().stages || []).map(s => [s.key, s.label]))}
        ${sel('priority', 'Priority', [['Hot', 'Hot'], ['Warm', 'Warm'], ['Later', 'Later']])}
        ${sel('source', 'Source', options(rows, r => r.source_id, v => (rows.find(r => r.source_id === v) || {}).source_name || v))}
        ${sel('deadline', 'Deadline', [['7', 'Next 7 days'], ['14', 'Next 14 days'], ['30', 'Next 30 days'], ['passed', 'Already passed']])}
        ${sel('fresh', 'Last verified', [['7', 'In the last 7 days'], ['30', 'In the last 30 days'], ['never', 'Not verified yet'], ['failed', 'Last check failed']])}
        <div style="align-self:end"><button class="btn small" data-act="clearFilters">Clear filters</button></div>
      </div>`;
  }
  P.act.toggleFilters = (el) => {
    const f = P.state.filters[P.state.curList]; f._open = !f._open;
    document.getElementById('filters').classList.toggle('open', f._open); el.setAttribute('aria-expanded', f._open);
  };
  P.act.clearFilters = () => { const f = P.state.filters[P.state.curList]; P.state.filters[P.state.curList] = { sort: f.sort, tab: f.tab, _open: true }; P.route(); };
  document.addEventListener('input', (e) => {
    const k = e.target.dataset?.filter;
    if (!k || !P.state.curList) return;
    P.state.filters[P.state.curList][k] = e.target.value;
    if (k === 'q') { clearTimeout(P._qt); P._qt = setTimeout(() => P.renderList(), 180); } else P.renderList();
  });

  // ---------------------------------------------------------------- rows
  function keyDate(r) {
    if (r.next_action_due && r.owner_id === me().id && P.ACTIVE.includes(r.stage)) {
      const d = P.daysUntil(r.next_action_due);
      return `<span class="${d < 0 ? 'due' : ''}">Follow up ${d < 0 ? 'overdue, ' : ''}${esc(P.date(r.next_action_due))}</span>`;
    }
    if (r.deadline && new Date(r.deadline) >= Date.now() && ['bidding', 'upcoming'].includes(r.project_stage)) {
      const d = P.daysUntil(r.deadline);
      return `<span class="${d <= 7 ? 'due' : ''}">${r.project_stage === 'upcoming' ? 'Response' : 'Bids'} due ${esc(P.deadline(r))}</span>`;
    }
    return '';
  }
  function rowMobile(r) {
    const co = r.company_name || r.project_owner || 'No company yet';
    const warn = r.company_owners?.length && r.owner_id !== me().id ? `<div class="warnline">${esc(r.company_owners.map(o => o.name).join(', '))} also working ${esc(co)}</div>` : '';
    return `<div class="lead" role="link" tabindex="0" data-href="#/lead/${r.id}">
      <div class="paint ${esc(r.priority)}" aria-hidden="true"></div>
      <div style="min-width:0">
        <div class="co">${esc(co)}</div>
        <div class="pj">${esc(r.project_title || r.title)}</div>
        <div class="meta"><span>${esc(r.region || 'Region unknown')}${r.city ? ', ' + esc(r.city) : r.county ? ', ' + esc(r.county) + ' County' : ''}</span><span>${esc(P.PSTAGE[r.project_stage] || '')}</span>${keyDate(r)}${r.stale ? '<span class="due">No activity in a while</span>' : ''}</div>
        ${r.next_action && (r.owner_id === me().id || !r.owner_id) ? `<div class="next"><b>Next:</b> ${esc(r.next_action)}</div>` : ''}
        ${warn}
      </div>
      <div class="side">${P.prioTag(r.priority)}${P.ownerTag(r)}${r.needs_review && P.isMgr() ? '<span class="tag bad">Review</span>' : ''}</div>
    </div>`;
  }
  function tableDesktop(rows, cols) {
    const C = {
      company: ['Company and project', r => `<b>${esc(r.company_name || r.project_owner || 'No company yet')}</b><div class="small">${esc(r.project_title || r.title)}</div>`],
      where: ['Where', r => `${esc(r.region || 'Unknown')}<div class="small muted">${esc(r.city || r.county || '')}</div>`],
      pstage: ['Project stage', r => `${esc(P.PSTAGE[r.project_stage] || '')}${r.winner_name ? `<div class="small muted">${esc(r.winner_name)}</div>` : ''}`],
      date: ['Key date', r => keyDate(r) || (r.deadline ? `<span class="muted small">${esc(P.deadline(r))}</span>` : '')],
      owner: ['Owner and status', r => P.ownerTag(r) + (r.company_owners?.length && r.owner_id !== me().id ? `<div class="warnline">${esc(r.company_owners.map(o => o.name).join(', '))} on this company</div>` : '')],
      next: ['Next action', r => r.next_action && (r.owner_id === me().id || !r.owner_id || P.isMgr()) ? `<span class="small">${esc(r.next_action)}</span>` : ''],
      last: ['Last activity', r => r.last_activity_at ? `${esc(P.ago(r.last_activity_at))}<div class="small muted">${esc(r.last_activity_by_name || '')}</div>` : '<span class="muted small">None yet</span>'],
      verified: ['Verified', r => r.last_verified_at ? esc(P.date(r.last_verified_at)) : `<span class="muted small">${r.verify_status === 'failed' ? 'Check failed' : 'Not yet'}</span>`],
      prio: ['Priority', r => P.prioTag(r.priority) + `<div class="small muted">Fit ${r.fit_score ?? '?'} · Urg ${r.urgency_score ?? '?'}</div>`],
    };
    return `<div class="scroll-x"><table class="data"><thead><tr><th class="pri"><span class="sr">Priority color</span></th>${cols.map(c => `<th>${C[c][0]}</th>`).join('')}</tr></thead><tbody>
      ${rows.map(r => `<tr class="click" data-href="#/lead/${r.id}" tabindex="0"><td class="pri"><div class="paint ${esc(r.priority)}"></div></td>${cols.map(c => `<td>${C[c][1](r)}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;
  }

  // ---------------------------------------------------------------- generic list view
  const LISTS = {
    pool: { title: 'Available leads', base: r => r.stage === 'available' && !r.needs_review, sort: 'priority', noOwner: true, noStage: true,
      intro: 'Unclaimed opportunities across Florida, closest to Orlando ranked higher. Claim one before you call so the team knows it is yours.',
      cols: ['prio', 'company', 'where', 'pstage', 'date', 'next', 'verified'],
      none: ['The pool is empty', 'Every available lead is claimed or filtered out. New ones arrive with each refresh.'] },
    mine: { title: 'My pipeline', base: r => r.owner_id === me().id, sort: 'followup', sorts: ['followup', 'priority', 'deadline', 'activity', 'region'], noOwner: true,
      tabs: [['open', 'Open', r => P.ACTIVE.includes(r.stage)], ['nurture', 'Nurture', r => r.stage === 'nurture'], ['closed', 'Won and lost', r => P.CLOSED.includes(r.stage)]],
      cols: ['prio', 'company', 'owner', 'date', 'next', 'last'],
      none: ['Nothing here yet', 'Claim leads from the Available list and they show up here.'], noneAction: '<a class="btn primary" href="#/pool">Browse available leads</a>' },
    gov: { title: 'Gov contracts', base: r => r.kind === 'gov_bid' || (r.level && r.level !== 'Private'), sort: 'deadline',
      tabs: [['open', 'Open and upcoming', r => ['bidding', 'upcoming'].includes(r.project_stage) && r.stage !== 'archived'],
             ['closed', 'Closed, award pending', r => r.project_stage === 'bid_closed' && r.stage !== 'archived'],
             ['winners', 'Winners to call', r => ['low_bidder', 'intent_to_award', 'awarded', 'preconstruction', 'under_construction'].includes(r.project_stage) && r.stage !== 'archived'],
             ['all', 'All', r => true]],
      intro: 'Public solicitations, closed bids and awards. Each one says how to pursue it: bid directly, call plan holders, quote the bidders, or approach the winner.',
      cols: ['prio', 'company', 'where', 'pstage', 'date', 'owner', 'next'],
      none: ['No government work matches', 'Try another tab or clear the filters.'] },
    all: { title: 'All leads', base: r => true, sort: 'priority', mgr: true,
      tabs: [['open', 'Open', r => !P.CLOSED.includes(r.stage)], ['review', 'Needs review', r => r.needs_review], ['stale', 'Stale claims', r => r.stale], ['all', 'Everything', r => true]],
      cols: ['prio', 'company', 'where', 'owner', 'date', 'last', 'verified'],
      none: ['Nothing matches', 'Clear the filters to see every lead.'] },
  };

  P.renderList = () => {
    const key = P.state.curList, L = LISTS[key], view = document.getElementById('view');
    if (!L || !view) return;
    const f = P.state.filters[key];
    const board = P.state.board || [];
    let base = board.filter(L.base);
    const tab = L.tabs ? (L.tabs.find(t => t[0] === f.tab) || L.tabs[0]) : null;
    const tabbed = tab ? base.filter(tab[2]) : base;
    const rows = applyFilters(tabbed, f).sort(SORTS[f.sort] || SORTS.priority);
    const tabsHtml = L.tabs ? `<div class="seg" role="group" aria-label="View" style="margin-bottom:12px">${L.tabs.map(([k, t, fn]) => `<button data-act="listTab" data-tab="${k}" aria-pressed="${tab[0] === k}">${esc(t)} <span class="muted">${base.filter(fn).length}</span></button>`).join('')}</div>` : '';
    const stale = P.state.boardErr ? `<div class="alert warn">Showing data from ${esc(P.ago(P.state.boardAt))}. ${esc(P.state.boardErr)}</div>` : '';
    const listHtml = rows.length ? `
        <div class="mobile-only sheet">${rows.map(rowMobile).join('')}</div>
        <div class="desk-only sheet">${tableDesktop(rows, L.cols)}</div>`
      : P.empty(tabbed.length ? 'No leads match these filters' : L.none[0], tabbed.length ? 'Clear a filter or change the search.' : L.none[1],
          tabbed.length ? '<br><button class="btn" data-act="clearFilters">Clear filters</button>' : (L.noneAction || ''));
    const keepFocus = document.activeElement?.dataset?.filter === 'q';
    view.innerHTML = `${stale}${L.intro ? `<p class="muted">${esc(L.intro)}</p>` : ''}${tabsHtml}${filterBar(key, tabbed, f, L)}
      <div class="resultline"><span>${rows.length} of ${tabbed.length} shown</span><button class="linkbtn" data-act="refreshBoard">Refresh list</button></div>${listHtml}`;
    if (keepFocus) { const s = view.querySelector('[data-filter="q"]'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  };
  P.act.listTab = (el) => { P.state.filters[P.state.curList].tab = el.dataset.tab; P.renderList(); };
  P.act.refreshBoard = async (el) => P.busy(el, async () => { await P.loadBoard(true); P.renderList(); P.toast('List updated'); });

  for (const key of Object.keys(LISTS)) {
    P.views[key] = async (view, r) => {
      const L = LISTS[key];
      P.setTitle(L.title);
      if (L.mgr && !P.isMgr()) { view.innerHTML = P.empty('Managers only', 'This page is for managers.'); return; }
      P.state.curList = key;
      P.state.filters[key] = P.state.filters[key] || { sort: L.sort, tab: L.tabs?.[0][0] };
      if (r.params.tab) P.state.filters[key].tab = r.params.tab;
      if (!P.state.board) view.innerHTML = P.loading();
      await P.loadBoard();
      P.renderList();
    };
  }

  // ---------------------------------------------------------------- Today
  P.views.today = async (view) => {
    P.setTitle('Today');
    P.state.curList = null;
    if (!P.state.board) view.innerHTML = P.loading(4);
    const [board, notes] = await Promise.all([P.loadBoard(), P.rpc('get_notifications').catch(() => [])]);
    const today = P.todayET(), my = board.filter(r => r.owner_id === me().id && P.ACTIVE.includes(r.stage));
    const overdue = my.filter(r => r.next_action_due && r.next_action_due < today).sort(SORTS.followup);
    const dueToday = my.filter(r => r.next_action_due === today);
    const noDate = my.filter(r => !r.next_action_due && !r.stale);
    const stale = my.filter(r => r.stale);
    const review = my.filter(r => r.needs_review);
    const in7 = (r) => r.deadline && new Date(r.deadline) >= Date.now() && new Date(r.deadline) <= Date.now() + 7 * 86400000 && ['bidding', 'upcoming'].includes(r.project_stage);
    const deadlines = board.filter(r => in7(r) && (r.owner_id === me().id || (r.stage === 'available' && !r.needs_review))).sort(SORTS.deadline);
    const hotPool = board.filter(r => r.stage === 'available' && !r.needs_review && r.priority === 'Hot').sort(SORTS.priority).slice(0, 6);
    const unread = notes.filter(n => !n.read).slice(0, 6);
    const block = (title, sub, rows, empty) => `<section class="section"><header><h2>${esc(title)} <span class="muted">${rows.length}</span></h2></header>${sub ? `<p class="muted small">${esc(sub)}</p>` : ''}
      ${rows.length ? `<div class="sheet">${rows.map(rowMobile).join('')}</div>` : `<p class="muted">${esc(empty)}</p>`}</section>`;
    const mgr = P.isMgr() ? (() => {
      const q = board.filter(r => r.stage === 'quote_needed'), rv = board.filter(r => r.needs_review), st = board.filter(r => r.stale);
      return `<div class="stats">
        <a class="stat" href="#/all?tab=open"><b>${q.length}</b><span>Quotes requested</span></a>
        <a class="stat ${rv.length ? 'alarm' : ''}" href="#/sources"><b>${rv.length}</b><span>Leads waiting for review</span></a>
        <a class="stat ${st.length ? 'alarm' : ''}" href="#/all?tab=stale"><b>${st.length}</b><span>Stale claims</span></a>
        <a class="stat" href="#/pool"><b>${board.filter(r => r.stage === 'available' && !r.needs_review).length}</b><span>Leads available</span></a></div>`;
    })() : '';
    view.innerHTML = `
      <p class="muted">${esc(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' }))}. ${my.length ? `You have ${my.length} open opportunit${my.length === 1 ? 'y' : 'ies'}.` : 'You have no open opportunities yet.'}</p>
      ${mgr}
      ${unread.length ? `<section class="section"><header><h2>New for you</h2><button class="linkbtn" data-act="notifications">See all</button></header><div class="sheet">${unread.map(n => `<div class="lead" role="link" tabindex="0" data-href="${n.opportunity_id ? '#/lead/' + n.opportunity_id : '#/today'}"><div class="paint" style="background:var(--blue)"></div><div><div class="co" style="font-size:1rem">${esc(n.title)}</div><div class="small">${esc(n.body || '')}</div></div><div class="side small muted">${esc(P.ago(n.at))}</div></div>`).join('')}</div></section>` : ''}
      ${block('Overdue follow-ups', '', overdue, 'Nothing overdue.')}
      ${block('Due today', '', dueToday, 'No follow-ups due today.')}
      ${block('Deadlines in the next 7 days', 'Your bids plus open bids nobody has claimed yet.', deadlines, 'No bid deadlines this week.')}
      ${stale.length ? block('Claims with no recent activity', `Log a call, set a follow-up or release them so a teammate can work them. Suggested after ${me().settings?.stale_days ?? 14} days; nothing is released automatically.`, stale, '') : ''}
      ${review.length ? block('Source changes to check', 'A refresh found something important on these (cancellation, missing notice).', review, '') : ''}
      ${noDate.length ? block('Open leads with no follow-up date', 'Set a next action so they show up here on the right day.', noDate.slice(0, 15), '') : ''}
      ${block('Hot leads nobody has claimed', 'Strong fit and timing. Claim one and call.', hotPool, 'No Hot leads in the pool right now.')}
      ${!my.length ? '<div class="state"><a class="btn primary" href="#/pool">Browse available leads</a></div>' : ''}`;
  };

  // ---------------------------------------------------------------- More (mobile)
  P.views.more = async (view) => {
    P.setTitle('More');
    const { m, x } = P.NAV();
    view.innerHTML = `<div class="sheet">${[...m, ...x, ['mine', 'My account', '#/me']].map(([, label, href]) => `<a class="lead" href="${href}" style="grid-template-columns:6px 1fr"><div class="paint"></div><div class="co" style="padding:4px 0">${esc(label)}</div></a>`).join('')}</div>`;
  };
})();
