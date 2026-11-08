/* Today, and one leads system behind Available, My pipeline, All leads and Gov contracts. */
(function () {
  const { esc, ui } = P;
  const me = () => P.state.me;
  const phone = () => matchMedia('(max-width: 760px)').matches;

  // ---------------------------------------------------------------- ordering
  const pr = { Hot: 0, Warm: 1, Later: 2 };
  const regionRank = (r) => { const i = P.REGIONS.indexOf(r.region || 'Unknown'); return i < 0 ? 9 : i; };
  const score = (r) => (r.fit_score || 0) + (r.urgency_score || 0);
  const ts = (v) => v ? new Date(v.length === 10 ? v + 'T12:00:00' : v).getTime() : null;
  // the soonest date that matters on this row: my follow-up, or a bid/response deadline still ahead
  const nextDate = (r) => {
    const ds = [];
    if (r.next_action_due && P.ACTIVE.includes(r.stage)) ds.push(ts(r.next_action_due));
    if (P.isOpenBid(r)) ds.push(ts(r.deadline));
    return ds.length ? Math.min(...ds) : Infinity;
  };
  const dlKey = (r) => { const t = ts(r.deadline); if (t == null) return [2, 0]; return t >= Date.now() ? [0, t] : [1, -t]; };
  const SORTS = {
    priority: (a, b) => (pr[a.priority] ?? 3) - (pr[b.priority] ?? 3) || score(b) - score(a) || regionRank(a) - regionRank(b),
    urgency: (a, b) => nextDate(a) - nextDate(b) || (b.urgency_score || 0) - (a.urgency_score || 0) || SORTS.priority(a, b),
    deadline: (a, b) => { const x = dlKey(a), y = dlKey(b); return x[0] - y[0] || x[1] - y[1] || SORTS.priority(a, b); },
    region: (a, b) => regionRank(a) - regionRank(b) || SORTS.priority(a, b),
    newest: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
    activity: (a, b) => String(b.last_activity_at || '').localeCompare(String(a.last_activity_at || '')),
  };
  const SORT_LABEL = { urgency: 'Most urgent', priority: 'Priority', deadline: 'Deadline', region: 'Closest to Orlando', newest: 'Newest', activity: 'Recent activity' };
  P.SORTS = SORTS;

  // ---------------------------------------------------------------- filters
  const uniq = (vals) => [...new Set(vals.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
  const cityOf = (r) => r.city || (r.county ? r.county + ' County' : '');
  const FILTERS = {
    region: { label: 'Region', opts: () => P.REGIONS.map(r => [r, r]), test: (r, v) => (r.region || 'Unknown') === v },
    city: { label: 'City or county', opts: (rows) => uniq(rows.map(cityOf)).map(v => [v, v]), test: (r, v) => cityOf(r) === v },
    kind: { label: 'Type', opts: () => Object.entries(P.KIND), test: (r, v) => r.kind === v },
    route: { label: 'How to pursue', opts: () => [['direct', 'Bid direct'], ['sub', 'Subcontract'], ['watch', 'Watch']], test: (r, v) => P.ROUTE[r.approach] === v },
    service: { label: 'Service', opts: (rows) => uniq(rows.flatMap(r => (r.services || []).concat(r.services_confirmed || []))).map(v => [v, v]),
      test: (r, v) => (r.services || []).concat(r.services_confirmed || []).includes(v) },
    pstage: { label: 'Project stage', opts: (rows) => uniq(rows.map(r => r.project_stage)).map(v => [v, P.PSTAGE[v] || v]), test: (r, v) => r.project_stage === v },
    source: { label: 'Source', opts: (rows) => [...new Map(rows.filter(r => r.source_id).map(r => [r.source_id, r.source_name || r.source_id])).entries()].sort((a, b) => a[1].localeCompare(b[1])),
      test: (r, v) => r.source_id === v },
    deadline: { label: 'Deadline', opts: () => [['7', 'Next 7 days'], ['14', 'Next 14 days'], ['30', 'Next 30 days'], ['passed', 'Already passed'], ['none', 'No deadline']],
      test: (r, v) => v === 'none' ? !r.deadline : v === 'passed' ? !!r.deadline && ts(r.deadline) < Date.now() : P.isOpenBid(r) && P.dayDiff(r.deadline) <= Number(v) },
    priority: { label: 'Priority', opts: () => [['Hot', 'Hot'], ['Warm', 'Warm'], ['Later', 'Later']], test: (r, v) => r.priority === v },
    owner: { label: 'Assignee', opts: (rows) => [['none', 'Unclaimed'], ['me', 'Me'], ...[...new Map(rows.filter(r => r.owner_id && r.owner_id !== me().id).map(r => [r.owner_id, r.owner_name || 'Teammate'])).entries()].sort((a, b) => a[1].localeCompare(b[1]))],
      test: (r, v) => v === 'none' ? !r.owner_id : v === 'me' ? r.owner_id === me().id : r.owner_id === v },
    stage: { label: 'Status', opts: () => (me().stages || []).map(s => [s.key, s.key === 'available' ? 'Unclaimed' : s.label]), test: (r, v) => r.stage === v },
    followup: { label: 'Follow-up', opts: () => [['overdue', 'Overdue'], ['today', 'Due today'], ['week', 'Due in the next 7 days'], ['none', 'No date set']],
      test: (r, v) => {
        if (!P.ACTIVE.includes(r.stage)) return false;
        const n = r.next_action_due ? P.dayDiff(r.next_action_due) : null;
        return v === 'none' ? n === null : v === 'overdue' ? n !== null && n < 0 : v === 'today' ? n === 0 : n !== null && n >= 0 && n <= 7;
      } },
    fresh: { label: 'Last verified', opts: () => [['7', 'In the last 7 days'], ['30', 'In the last 30 days'], ['never', 'Not re-checked yet'], ['failed', 'Last check failed']],
      test: (r, v) => {
        const d = r.last_verified_at ? (Date.now() - ts(r.last_verified_at)) / 864e5 : null;
        return v === 'never' ? d === null : v === 'failed' ? ['failed', 'missing'].includes(r.verify_status) : d !== null && d <= Number(v);
      } },
  };
  const applyFilters = (rows, f, keys) => {
    const toks = (f.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(r => (!toks.length || toks.every(t => (r.search_text || '').includes(t))) && keys.every(k => !f[k] || FILTERS[k].test(r, f[k])));
  };

  // ---------------------------------------------------------------- row pieces
  // the one date that matters most on a row
  const keyDate = (r) => {
    if (r.next_action_due && P.ACTIVE.includes(r.stage) && (r.owner_id === me().id || P.isMgr())) return `<span>${P.icon('cal')}Follow-up ${ui.due(r.next_action_due)}</span>`;
    const d = ui.deadline(r);
    return d ? `<span>${P.icon('clock')}${d}</span>` : '';
  };
  const ownerCell = (r, mode) => {
    if (r.stage === 'available') return mode === 'pool' ? '' : '<span class="who">Unclaimed</span>';
    if (r.owner_id === me().id) return mode === 'mine' ? '' : '<span class="who">You</span>';
    return r.owner_name ? `<span class="who">${esc(r.owner_name)}</span>` : '';
  };
  const claimBtn = (r) => r.stage === 'available' && !r.needs_review ? `<button class="btn sm soft" data-act="claimRow" data-id="${r.id}" aria-label="Claim ${esc(P.companyOf(r))}">Claim</button>` : '';
  const conflict = (r) => r.company_owners?.length && r.owner_id !== me().id
    ? `<div class="li-warn">${esc(r.company_owners.map(o => o.name).join(', '))} also working this company</div>` : '';
  let common = new Set();   // next-action texts shared by many rows on screen (generic advice)
  const nextLine = (r) => r.next_action && !common.has(r.next_action) ? `<div class="li-next"><b>Next:</b> ${esc(r.next_action)}</div>` : '';

  function rowHtml(r, mode) {
    const bar = `<div class="bar ${r.priority === 'Hot' ? 'hot' : r.priority === 'Warm' ? 'warm' : ''}" aria-hidden="true"></div>`;
    const label = `${P.companyOf(r)}: ${r.project_title || r.title}`;
    if (mode === 'gov') {
      const agency = r.project_owner || r.company_name || '';
      return `<div class="li gov" data-lead="${r.id}">${bar}${ui.dtile(r)}
        <div class="li-main"><div class="li-top"><a class="li-co" href="#/lead/${r.id}" data-lead="${r.id}">${esc(r.project_title || r.title)}</a>${ui.prio(r.priority)}</div>
          <div class="li-title">${esc(agency)}${r.solicitation_no ? ` <span class="faint">· ${esc(r.solicitation_no)}</span>` : ''}</div>
          <div class="li-meta"><span>${P.icon('pin')}${esc(P.place(r))}</span><span>${esc(P.PSTAGE[r.project_stage] || '')}</span>${r.project_value ? `<span>${P.icon('dollar')}${esc(P.money(r.project_value))}</span>` : r.value_label ? `<span>${esc(r.value_label)}</span>` : ''}${r.winner_name ? `<span>${r.winner_status === 'low_bidder' ? 'Low bidder' : 'Winner'}: ${esc(r.winner_name)}</span>` : ''}</div>
          ${nextLine(r)}</div>
        <div class="li-side">${ui.route(r.approach)}${claimBtn(r) || (r.owner_id ? ownerCell(r, 'gov') + (r.owner_id === me().id || P.isMgr() ? ui.stage(r.stage) : '') : '')}</div></div>`;
    }
    const side = mode === 'pool' ? claimBtn(r)
      : mode === 'mine' ? ui.stage(r.stage)
      : `${ownerCell(r, mode)}${r.stage === 'available' ? claimBtn(r) : ui.stage(r.stage)}`;
    return `<div class="li" data-lead="${r.id}">${bar}
      <div class="li-main"><div class="li-top"><a class="li-co" href="#/lead/${r.id}" data-lead="${r.id}" aria-label="${esc(label)}">${esc(P.companyOf(r))}</a>${ui.prio(r.priority)}${r.needs_review && P.isMgr() ? '<span class="badge warm">Review</span>' : ''}${r.stale ? '<span class="badge warm">No recent activity</span>' : ''}</div>
        <div class="li-title">${esc(r.project_title || r.title)}</div>
        <div class="li-meta"><span>${P.icon('pin')}${esc(P.place(r))}</span>${r.project_stage && r.project_stage !== 'unknown' ? `<span>${esc(P.PSTAGE[r.project_stage])}</span>` : ''}${keyDate(r)}</div>
        ${nextLine(r)}${conflict(r)}</div>
      <div class="li-side">${side}</div></div>`;
  }
  P.rowHtml = rowHtml;

  function cardHtml(r, mode) {
    const gov = mode === 'gov';
    const title = gov ? (r.project_title || r.title) : P.companyOf(r);
    const second = gov ? (r.project_owner || r.company_name || '') : (r.project_title || r.title);
    const foot = r.stage === 'available' ? `<span class="who">${mode === 'pool' ? esc(P.KIND[r.kind] || '') : 'Unclaimed'}</span>${claimBtn(r)}`
      : `<span class="who">${r.owner_id === me().id ? 'You' : esc(r.owner_name || '')}</span>${ui.stage(r.stage)}`;
    return `<div class="lcard ${r.priority === 'Hot' ? 'hot' : r.priority === 'Warm' ? 'warm' : ''}" data-lead="${r.id}">
      <div class="top">${gov ? ui.dtile(r) : ''}<div class="grow" style="min-width:0"><div class="row" style="flex-wrap:nowrap"><a class="co" href="#/lead/${r.id}" data-lead="${r.id}">${esc(title)}</a>${ui.prio(r.priority)}</div><div class="pj">${esc(second)}</div></div></div>
      <div class="facts"><span>${P.icon('pin')}<span class="ell">${esc(P.place(r))}</span></span>
        ${r.project_stage && r.project_stage !== 'unknown' ? `<span>${P.icon('flag')}<span class="ell">${esc(P.PSTAGE[r.project_stage])}</span></span>` : ''}
        ${gov && (r.project_value || r.value_label) ? `<span>${P.icon('dollar')}${esc(P.money(r.project_value) || r.value_label)}</span>` : ''}
        ${!gov && keyDate(r) ? `<span>${keyDate(r)}</span>` : ''}
        ${gov ? `<span>${ui.route(r.approach)}</span>` : ''}</div>
      ${r.next_action ? `<div class="small" style="color:var(--ink-2)"><span class="muted">Next:</span> ${esc(r.next_action)}</div>` : ''}
      <div class="foot">${foot}</div></div>`;
  }

  // table columns
  const COLS = {
    prio: ['', r => `<span class="dot ${r.priority === 'Hot' ? 'hot' : r.priority === 'Warm' ? 'warm' : ''}" title="${esc(r.priority || '')}"></span>`, 'prio-cell'],
    company: ['Company and project', r => `<a class="cell-main" href="#/lead/${r.id}" data-lead="${r.id}">${esc(P.companyOf(r))}</a><div class="sub">${esc(r.project_title || r.title)}</div>`, 'wrap-lg'],
    agency: ['Project and agency', r => `<a class="cell-main" href="#/lead/${r.id}" data-lead="${r.id}">${esc(r.project_title || r.title)}</a><div class="sub">${esc(r.project_owner || r.company_name || '')}${r.solicitation_no ? ' · ' + esc(r.solicitation_no) : ''}</div>`, 'wrap-lg'],
    where: ['Location', r => `${esc(cityOf(r) || '—')}<div class="sub">${esc(r.region || 'Unknown')}</div>`],
    kind: ['Type', r => esc(P.KIND[r.kind] || r.kind || '')],
    pstage: ['Project stage', r => `${esc(P.PSTAGE[r.project_stage] || '')}${r.winner_name ? `<div class="sub">${esc(r.winner_name)}</div>` : ''}`],
    keydate: ['Key date', r => keyDate(r) || '<span class="faint">—</span>'],
    deadline: ['Deadline', r => r.deadline ? `<span class="${P.isOpenBid(r) && P.dayDiff(r.deadline) <= 7 ? 'due-hot' : ''}">${esc(P.deadline(r))}</span>${P.isOpenBid(r) ? `<div class="sub">${esc(P.rel(P.dayDiff(r.deadline)))}</div>` : ''}` : '<span class="faint">None</span>'],
    value: ['Value', r => r.project_value ? esc(P.money(r.project_value)) : r.value_label ? `<span class="sub">${esc(r.value_label)}</span>` : '<span class="faint">—</span>', 'num'],
    route: ['How to pursue', r => ui.route(r.approach)],
    owner: ['Assignee', r => r.owner_id ? esc(r.owner_id === me().id ? 'You' : r.owner_name || '') : '<span class="faint">—</span>'],
    status: ['Status', r => ui.stage(r.stage)],
    followup: ['Follow-up', r => r.next_action_due && P.ACTIVE.includes(r.stage) ? ui.due(r.next_action_due) : '<span class="faint">—</span>'],
    next: ['Next action', r => r.next_action ? `<span class="small">${esc(r.next_action)}</span>` : '<span class="faint">—</span>'],
    last: ['Last activity', r => r.last_activity_at ? `${esc(P.ago(r.last_activity_at))}<div class="sub">${esc(r.last_activity_by_name || '')}</div>` : '<span class="faint">None yet</span>'],
    source: ['Source', r => `<span class="small">${esc(r.source_name || '')}</span>`],
    verified: ['Verified', r => r.last_verified_at ? esc(P.date(r.last_verified_at)) : `<span class="faint">${['failed', 'missing'].includes(r.verify_status) ? 'Check failed' : 'Not yet'}</span>`],
    scores: ['Fit / urgency', r => `${r.fit_score ?? '?'} / ${r.urgency_score ?? '?'}`, 'num'],
    created: ['Added', r => esc(P.date(r.created_at))],
    claim: ['', r => claimBtn(r)],
  };
  const COL_LABEL = (k) => COLS[k][0] || { prio: 'Priority', claim: 'Claim button' }[k];

  // ---------------------------------------------------------------- list definitions
  const notClosed = (r) => !P.CLOSED.includes(r.stage);
  const govClosed = (r) => P.CLOSED.includes(r.stage) || ['completed', 'cancelled'].includes(r.project_stage);
  const LISTS = {
    pool: {
      title: 'Available', base: r => r.stage === 'available' && !r.needs_review,
      sub: (n) => `${P.plural(n, 'lead')} ready to claim, ranked by fit and timing. Claim one before you call so nobody doubles up.`,
      sort: 'priority', sorts: ['priority', 'urgency', 'region', 'newest'], views: ['list', 'cards', 'table'],
      filters: ['region', 'city', 'kind', 'service', 'pstage', 'source', 'deadline', 'priority', 'fresh'],
      cols: ['prio', 'company', 'where', 'pstage', 'keydate', 'next', 'claim'], mode: 'pool',
      none: ['Nothing to claim right now', 'Every lead is claimed. New ones arrive with each refresh.'],
    },
    mine: {
      title: 'My pipeline', base: r => r.owner_id === me().id,
      sub: (n, rows) => { const due = rows.filter(r => P.ACTIVE.includes(r.stage) && r.next_action_due && r.next_action_due <= P.todayET()).length; return `${P.plural(n, 'active lead')}${due ? `, ${due} with a follow-up due` : ''}.`; },
      subCount: r => P.ACTIVE.includes(r.stage),
      tabs: [['active', 'Active', r => P.ACTIVE.includes(r.stage)], ['nurture', 'Nurture', r => r.stage === 'nurture'], ['closed', 'Closed', r => P.CLOSED.includes(r.stage)]],
      sort: 'urgency', sorts: ['urgency', 'priority', 'activity', 'newest'], views: ['list', 'board', 'table', 'cards'],
      filters: ['followup', 'stage', 'priority', 'region', 'kind', 'deadline', 'source'],
      cols: ['prio', 'company', 'status', 'followup', 'next', 'last'], mode: 'mine',
      none: ['No leads here yet', 'Claim leads from Available and they show up here.'], noneAction: '<a class="btn primary" href="#/pool">Browse available leads</a>',
    },
    all: {
      title: 'All leads', mgr: true, base: r => true,
      sub: (n) => `Every opportunity in the portal. ${P.plural(n, 'open lead')} across the team.`,
      subCount: r => notClosed(r) && !(r.stage === 'available' && r.needs_review),
      tabs: [['open', 'Open', r => notClosed(r) && !(r.stage === 'available' && r.needs_review)], ['claimed', 'Being worked', r => P.ACTIVE.includes(r.stage)],
             ['stalled', 'Stalled', r => r.stale], ['review', 'Needs review', r => r.needs_review], ['all', 'Everything', r => true]],
      sort: 'priority', sorts: ['priority', 'urgency', 'activity', 'newest', 'region'], views: ['table', 'list', 'board', 'cards'],
      filters: ['owner', 'stage', 'followup', 'priority', 'region', 'kind', 'source', 'deadline', 'fresh'],
      cols: ['prio', 'company', 'where', 'owner', 'status', 'followup', 'last', 'verified'], mode: 'all',
      actions: () => `<button class="btn" data-act="addLead">${P.icon('plus')}Add a lead</button>`,
      none: ['Nothing matches', 'Clear the filters to see every lead.'],
    },
    gov: {
      title: 'Gov contracts', base: P.isGov,
      sub: (n) => `Public solicitations and awards. ${P.plural(n, 'bid')} open now. Each one says whether to bid direct or subcontract.`,
      subCount: r => r.project_stage === 'bidding' && !govClosed(r),
      tabs: [['open', 'Open for bids', r => r.project_stage === 'bidding' && !govClosed(r)], ['upcoming', 'Upcoming', r => ['upcoming', 'planning'].includes(r.project_stage) && !govClosed(r)],
             ['pending', 'Award pending', r => r.project_stage === 'bid_closed' && !govClosed(r)], ['awarded', 'Awarded', r => P.WINNER_STAGES.includes(r.project_stage) && !govClosed(r)],
             ['closed', 'Closed', govClosed], ['all', 'All', r => true]],
      sort: 'deadline', sorts: ['deadline', 'priority', 'newest', 'activity'], views: ['list', 'table', 'cards'],
      filters: ['route', 'region', 'owner', 'source', 'deadline', 'priority', 'stage'],
      cols: ['prio', 'deadline', 'agency', 'where', 'value', 'pstage', 'route', 'owner'], mode: 'gov',
      none: ['No government work here', 'Try another tab or clear the filters.'],
    },
  };
  P.LISTS = LISTS;

  // ---------------------------------------------------------------- list page
  const st = () => P.state.filters[P.state.curList];
  const PAGE = 30;
  function viewOf(key) {
    const L = LISTS[key], f = P.state.filters[key];
    let v = f.view || P.store.get('view.' + key, null) || (phone() ? 'list' : L.views[0]);
    if (!L.views.includes(v) || (phone() && v === 'table')) v = phone() ? 'list' : L.views[0];
    return v;
  }
  function rowsFor(key, { ignoreTab } = {}) {
    const L = LISTS[key], f = P.state.filters[key], board = P.state.board || [];
    const base = board.filter(L.base);
    const tab = L.tabs ? (L.tabs.find(t => t[0] === f.tab) || L.tabs[0]) : null;
    const tabbed = tab && !ignoreTab ? base.filter(tab[2]) : base;
    const rows = applyFilters(tabbed, f, L.filters).sort(SORTS[f.sort] || SORTS[L.sort]);
    return { base, tab, tabbed, rows };
  }

  function renderListPage(view, key) {
    const L = LISTS[key], f = P.state.filters[key];
    const base = (P.state.board || []).filter(L.base);
    const n = base.filter(L.subCount || (() => true)).length;
    const v = viewOf(key);
    const viewBtns = L.views.filter(x => !(phone() && x === 'table')).map(x => `<button type="button" data-act="setView" data-v="${x}" aria-pressed="${v === x}" title="${esc({ list: 'List', cards: 'Cards', table: 'Table', board: 'Board' }[x])}" aria-label="${esc({ list: 'List view', cards: 'Card view', table: 'Table view', board: 'Board view' }[x])}">${P.icon(x)}</button>`).join('');
    view.innerHTML = `${P.pageHead({ title: L.title, sub: L.sub(n, base), actions: L.actions?.() || '' })}
      <div id="lv-tabs"></div>
      <div class="toolbar">
        <label class="search-box">${P.icon('search')}<span class="sr">Search</span><input type="search" data-lf="q" value="${esc(f.q || '')}" placeholder="Search company, project, contact, solicitation #" autocomplete="off"></label>
        <button class="btn" data-act="openFilters" aria-haspopup="dialog" aria-expanded="false" id="lv-fbtn">${P.icon('filter')}Filters</button>
        <label class="sr" for="lv-sort">Sort by</label>
        <select class="sort" id="lv-sort" data-lf="sort">${L.sorts.map(s => `<option value="${s}" ${(f.sort || L.sort) === s ? 'selected' : ''}>${esc(SORT_LABEL[s])}</option>`).join('')}</select>
        <div class="sp desk-only"></div>
        <div class="seg" role="group" aria-label="Layout">${viewBtns}</div>
        <button class="btn icon ${v === 'table' ? '' : 'hidden'}" data-act="openCols" id="lv-cols" aria-label="Choose columns" title="Columns">${P.icon('sliders')}</button>
      </div>
      <div class="activechips" id="lv-chips"></div>
      <div class="resultbar" id="lv-bar"></div>
      <div id="lv-results"></div>`;
    renderResults();
  }

  function renderResults() {
    const key = P.state.curList, L = LISTS[key], f = st();
    if (!L || !document.getElementById('lv-results')) return;
    const v = viewOf(key);
    const { base, tab, tabbed, rows } = rowsFor(key, { ignoreTab: v === 'board' });
    // tabs (hidden on the board, which shows every stage as a column)
    const tabsEl = document.getElementById('lv-tabs');
    tabsEl.innerHTML = L.tabs && v !== 'board' ? `<div class="tabs" role="tablist" aria-label="${esc(L.title)} views">${L.tabs.map(([k, t, fn]) => `<button class="tab" role="tab" data-act="listTab" data-tab="${k}" aria-selected="${tab[0] === k}">${esc(t)} <span class="n">${base.filter(fn).length}</span></button>`).join('')}</div>` : '';
    // active filters
    const active = L.filters.filter(k => f[k]);
    const fb = document.getElementById('lv-fbtn');
    if (fb) fb.innerHTML = `${P.icon('filter')}Filters${active.length ? `<span class="count">${active.length}</span>` : ''}`;
    const chips = document.getElementById('lv-chips');
    chips.innerHTML = active.length ? active.map(k => { const o = FILTERS[k].opts(tabbed).find(([x]) => String(x) === String(f[k])); return `<button class="fchip" data-act="dropFilter" data-k="${k}" aria-label="Remove filter ${esc(FILTERS[k].label)}">${esc(FILTERS[k].label)}: ${esc(o ? o[1] : f[k])}${P.icon('x')}</button>`; }).join('') + '<button class="linkbtn small" data-act="clearFilters">Clear all</button>' : '';
    chips.classList.toggle('hidden', !active.length);
    // results
    const limit = f.limit || (v === 'table' ? 50 : PAGE);
    const shown = v === 'board' ? rows : rows.slice(0, limit);
    document.getElementById('lv-bar').innerHTML = `<span>${rows.length === tabbed.length ? `${P.plural(rows.length, 'lead')}` : `${rows.length} of ${tabbed.length} match`}${v !== 'board' && rows.length > shown.length ? ` · showing ${shown.length}` : ''}</span><span class="sp"></span>${P.syncHtml()}`;
    const out = document.getElementById('lv-results');
    const freq = {}; shown.forEach(r => { if (r.next_action) freq[r.next_action] = (freq[r.next_action] || 0) + 1; });
    common = new Set(Object.entries(freq).filter(([, n]) => n >= 3 && n >= shown.length * 0.2).map(([t]) => t));
    if (!rows.length) {
      out.innerHTML = `<div class="card">${tabbed.length || f.q ? P.empty('No leads match', 'Try a different search or clear a filter.', '<button class="btn" data-act="clearFilters">Clear filters</button>')
        : P.empty(L.none[0], esc(L.none[1]), L.noneAction || '')}</div>`;
      return;
    }
    const more = rows.length > shown.length ? `<div class="showmore"><button class="btn" data-act="showMore">Show ${Math.min(v === 'table' ? 50 : PAGE, rows.length - shown.length)} more</button></div>` : '';
    if (v === 'cards') out.innerHTML = `<div class="cards">${shown.map(r => cardHtml(r, L.mode)).join('')}</div>${more.replace('class="showmore"', 'class="showmore" style="border:0"')}`;
    else if (v === 'table') {
      const main = L.cols.filter(c => ['company', 'agency'].includes(c));
      const cols = P.store.get('cols.' + key, L.cols).filter(c => COLS[c]);
      for (const mc of main) if (!cols.includes(mc)) cols.splice(Math.min(1, cols.length), 0, mc);
      out.innerHTML = `<div class="tablewrap"><table class="tbl"><thead><tr>${cols.map(c => `<th class="${COLS[c][2] === 'num' ? 'num' : ''}" scope="col">${esc(COLS[c][0]) || `<span class="sr">${esc(COL_LABEL(c))}</span>`}</th>`).join('')}</tr></thead>
        <tbody>${shown.map(r => `<tr class="click" data-lead="${r.id}">${cols.map(c => `<td class="${COLS[c][2] || ''}">${COLS[c][1](r)}</td>`).join('')}</tr>`).join('')}</tbody></table>${more}</div>`;
    } else if (v === 'board') out.innerHTML = boardHtml(rows, key);
    else out.innerHTML = `<div class="list">${shown.map(r => rowHtml(r, L.mode)).join('')}${more}</div>`;
  }
  P.renderList = renderResults;

  // ---------------------------------------------------------------- board (stage columns)
  const CLOSED_COLS = ['nurture', 'won', 'lost', 'disqualified', 'archived'];
  function boardHtml(rows, key) {
    const f = st(), showClosed = !!f.closedCols;
    const owned = rows.filter(r => r.owner_id);
    const stages = P.ACTIVE.concat(showClosed ? CLOSED_COLS : []);
    const card = (r) => `<div class="bcard ${r.priority === 'Hot' ? 'hot' : r.priority === 'Warm' ? 'warm' : ''}" draggable="true" data-lead="${r.id}" data-stage="${r.stage}">
        <a class="co" href="#/lead/${r.id}" data-lead="${r.id}" draggable="false">${esc(P.companyOf(r))}</a><div class="pj">${esc(r.project_title || r.title)}</div>
        <div class="meta">${r.next_action_due && P.ACTIVE.includes(r.stage) ? ui.due(r.next_action_due) : ''}${key === 'all' ? `<span>${esc(r.owner_id === me().id ? 'You' : r.owner_name || '')}</span>` : ''}${r.stale ? '<span class="badge warm">No recent activity</span>' : ''}</div>
        <button class="btn ghost sm icon mv" data-act="moveMenu" data-id="${r.id}" aria-label="Move ${esc(P.companyOf(r))} to another stage" title="Move to…">${P.icon('more')}</button></div>`;
    const cols = stages.map(s => {
      const list = owned.filter(r => r.stage === s), lim = f['col_' + s] || 20;
      return `<section class="bcol" data-drop="${s}" aria-label="${esc(P.stageLabel(s))}"><div class="bcol-head">${esc(P.stageLabel(s))} <span class="n">${list.length}</span></div>
        <div class="bcol-body">${list.slice(0, lim).map(card).join('') || '<div class="bcol-empty">Nothing here</div>'}${list.length > lim ? `<button class="btn ghost sm" data-act="colMore" data-s="${s}">Show ${list.length - lim} more</button>` : ''}</div></section>`;
    }).join('');
    return `<div class="row" style="margin-bottom:10px"><span class="small muted grow">${phone() ? 'Use a card\'s ⋯ menu to move it to another stage.' : 'Drag cards between stages, or use a card\'s ⋯ menu.'}</span>
      <button class="btn sm" data-act="toggleClosedCols" aria-pressed="${showClosed}">${showClosed ? 'Hide closed stages' : 'Show closed stages'}</button></div>
      <div class="board" id="board">${cols}</div>`;
  }
  P.act.toggleClosedCols = () => { st().closedCols = !st().closedCols; renderResults(); };
  P.act.colMore = (el) => { st()['col_' + el.dataset.s] = (st()['col_' + el.dataset.s] || 20) + 40; renderResults(); };
  P.act.moveMenu = (el) => {
    const r = P.state.board.find(x => x.id === el.dataset.id);
    if (!r) return;
    const can = r.owner_id === me().id || P.isMgr();
    if (!can) { P.toast('Only the owner or a manager can move this lead.', 'error'); return; }
    P.menu(el, [{ heading: 'Move to' }, ...P.ACTIVE.concat(CLOSED_COLS).filter(s => s !== r.stage).map(s => ({ label: P.stageLabel(s), run: () => P.moveStage(r, s) }))], { label: 'Move to stage' });
  };
  // drag and drop between columns
  let dragId = null;
  document.addEventListener('dragstart', (e) => {
    const c = e.target.closest?.('.bcard'); if (!c) return;
    dragId = c.dataset.lead; c.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId);
  });
  document.addEventListener('dragend', (e) => { e.target.closest?.('.bcard')?.classList.remove('dragging'); document.querySelectorAll('.bcol.over').forEach(x => x.classList.remove('over')); dragId = null; });
  document.addEventListener('dragover', (e) => { const col = e.target.closest?.('[data-drop]'); if (!col || !dragId) return; e.preventDefault(); document.querySelectorAll('.bcol.over').forEach(x => x !== col && x.classList.remove('over')); col.classList.add('over'); });
  document.addEventListener('drop', async (e) => {
    const col = e.target.closest?.('[data-drop]'); if (!col || !dragId) return;
    e.preventDefault(); col.classList.remove('over');
    const r = P.state.board.find(x => x.id === dragId), to = col.dataset.drop;
    if (!r || r.stage === to) return;
    if (!(r.owner_id === me().id || P.isMgr())) { P.toast('Only the owner or a manager can move this lead.', 'error'); return; }
    const cardEl = document.querySelector(`.bcard[data-lead="${r.id}"]`);
    cardEl?.classList.add('saving');
    const moved = await P.moveStage(r, to);
    if (!moved) cardEl?.classList.remove('saving');
  });

  // ---------------------------------------------------------------- toolbar events
  document.addEventListener('input', (e) => {
    const k = e.target.dataset?.lf;
    if (!k || !P.state.curList) return;
    if (k === 'q') { st().q = e.target.value; st().limit = 0; clearTimeout(P._qt); P._qt = setTimeout(renderResults, 160); }
  });
  document.addEventListener('change', (e) => {
    const k = e.target.dataset?.lf, fk = e.target.dataset?.f, ck = e.target.dataset?.col;
    if (k === 'sort' && P.state.curList) { st().sort = e.target.value; st().limit = 0; renderResults(); }
    if (fk && P.state.curList) { st()[fk] = e.target.value; st().limit = 0; renderResults(); }
    if (ck && P.state.curList) {
      const key = P.state.curList, L = LISTS[key];
      const cols = [...document.querySelectorAll('[data-col]')].filter(x => x.checked).map(x => x.dataset.col).concat(L.cols.filter(c => ['company', 'agency'].includes(c)));
      const order = L.cols.concat(Object.keys(COLS).filter(c => !L.cols.includes(c)));
      P.store.set('cols.' + key, order.filter(c => cols.includes(c)));
      renderResults();
    }
  });
  P.act.listTab = (el) => { st().tab = el.dataset.tab; st().limit = 0; renderResults(); document.querySelector(`.tab[data-tab="${el.dataset.tab}"]`)?.focus(); };
  P.act.showMore = () => { const v = viewOf(P.state.curList); st().limit = (st().limit || (v === 'table' ? 50 : PAGE)) + (v === 'table' ? 50 : PAGE); renderResults(); };
  P.act.setView = (el) => {
    const key = P.state.curList; st().view = el.dataset.v; P.store.set('view.' + key, el.dataset.v); st().limit = 0;
    document.querySelectorAll('[data-act="setView"]').forEach(b => b.setAttribute('aria-pressed', b === el));
    document.getElementById('lv-cols')?.classList.toggle('hidden', el.dataset.v !== 'table');
    renderResults();
  };
  P.act.dropFilter = (el) => { delete st()[el.dataset.k]; st().limit = 0; renderResults(); };
  P.act.clearFilters = () => { const L = LISTS[P.state.curList]; L.filters.forEach(k => delete st()[k]); st().q = ''; st().limit = 0; const s = document.querySelector('[data-lf="q"]'); if (s) s.value = ''; P.closePop(); renderResults(); };
  P.act.openFilters = (el) => {
    const key = P.state.curList, L = LISTS[key], f = st();
    const { tabbed } = rowsFor(key);
    const html = `<h2 style="font-size:15px;margin-bottom:12px">Filter ${esc(L.title.toLowerCase())}</h2><div class="fgrid">${L.filters.map(k => `<label class="field"><span>${esc(FILTERS[k].label)}</span>
      <select data-f="${k}"><option value="">Any</option>${FILTERS[k].opts(tabbed).map(([v, t]) => `<option value="${esc(v)}" ${String(f[k] || '') === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`).join('')}</div>
      <div class="ffoot"><button class="btn ghost" data-act="clearFilters">Clear all</button><button class="btn primary" data-act="closePop">Done</button></div>`;
    P.popover(el, html, { cls: 'filters', label: 'Filters' });
  };
  P.act.closePop = () => P.closePop();
  P.act.openCols = (el) => {
    const key = P.state.curList, L = LISTS[key], cur = P.store.get('cols.' + key, L.cols);
    const avail = [...new Set(L.cols.concat(['kind', 'deadline', 'pstage', 'keydate', 'owner', 'status', 'followup', 'next', 'last', 'source', 'verified', 'value', 'route', 'scores', 'created']))]
      .filter(c => !(key === 'pool' && ['owner', 'status', 'followup', 'last'].includes(c)) && !(key === 'mine' && ['owner', 'claim'].includes(c)));
    P.popover(el, `<div class="mlabel" style="padding:0 0 8px">Columns</div>${avail.map(c => `<label class="check"><input type="checkbox" data-col="${c}" ${cur.includes(c) || ['company', 'agency'].includes(c) && L.cols.includes(c) ? 'checked' : ''} ${['company', 'agency'].includes(c) && L.cols.includes(c) ? 'disabled' : ''}><span>${esc(COL_LABEL(c))}</span></label>`).join('')}
      <button class="linkbtn small" data-act="resetCols">Reset to default</button>`, { cls: 'cols', label: 'Columns' });
  };
  P.act.resetCols = () => { P.store.set('cols.' + P.state.curList, LISTS[P.state.curList].cols); P.closePop(); renderResults(); };
  P.act.claimRow = (btn) => P.claimLead(btn.dataset.id, btn);

  for (const key of Object.keys(LISTS)) {
    P.views[key] = async (view, r) => {
      const L = LISTS[key];
      if (L.mgr && !P.isMgr()) { view.innerHTML = P.pageHead({ title: L.title }) + P.empty('Managers only', 'This page is for managers.', '<a class="btn" href="#/today">Go to Today</a>'); return; }
      P.state.curList = key;
      const f = P.state.filters[key] = P.state.filters[key] || { sort: L.sort, tab: L.tabs?.[0][0] };
      // start-up parameters from links (e.g. #/pool?priority=Hot) override the remembered filters once
      if (Object.keys(r.params).length) {
        L.filters.forEach(k => delete f[k]);
        for (const [k, v] of Object.entries(r.params)) {
          if (k === 'tab' && L.tabs?.some(t => t[0] === v)) f.tab = v;
          else if (k === 'sort' && L.sorts.includes(v)) f.sort = v;
          else if (k === 'view' && L.views.includes(v)) f.view = v;
          else if (FILTERS[k] && L.filters.includes(k)) f[k] = v;
        }
        f.limit = 0;
        P.cleanHash();
      }
      P.setPage(L.title);
      if (!P.state.board) view.innerHTML = P.pageHead({ title: L.title }) + P.skeleton(8);
      await P.loadBoard();
      if (P.state.page !== key) return;
      renderListPage(view, key);
      P.state.rerender = () => { if (P.state.page === key) { const sub = view.querySelector('.page-head .sub'); if (sub) { const base = P.state.board.filter(L.base); sub.innerHTML = L.sub(base.filter(L.subCount || (() => true)).length, base); } renderResults(); } };
      P.state.cleanup = () => { P.state.curList = null; };
    };
  }

  // ---------------------------------------------------------------- Today
  const mini = (r, right, line) => `<div class="mini" data-lead="${r.id}">
      <div class="t">${r.priority === 'Hot' || r.priority === 'Warm' ? `<span class="dot ${r.priority.toLowerCase()}" title="${r.priority}"></span>` : ''}<a class="ell" href="#/lead/${r.id}" data-lead="${r.id}">${esc(P.companyOf(r))}</a>${r.priority === 'Hot' || r.priority === 'Warm' ? `<span class="sr">, ${r.priority}</span>` : ''}</div>
      <div class="s">${esc(r.project_title || r.title)} · ${esc(P.place(r))}</div>
      ${line ? `<div class="s">${line}</div>` : ''}
      <div class="r">${right || ''}</div></div>`;
  const card = (id, title, n, body, tools = '') => `<section class="card" id="${id}" aria-labelledby="${id}-h"><div class="sec-head"><h2 id="${id}-h">${esc(title)}${n != null ? ` <span class="n">${n}</span>` : ''}</h2><div class="tools">${tools}</div></div>${body}</section>`;
  const viewAll = (href, label = 'View all') => `<a class="btn ghost sm" href="${href}">${esc(label)}${P.icon('right', 'sm')}</a>`;

  function renderToday(view) {
    const board = P.state.board || [], today = P.todayET(), my = board.filter(r => r.owner_id === me().id && P.ACTIVE.includes(r.stage));
    const overdue = my.filter(r => r.next_action_due && r.next_action_due < today).sort(SORTS.urgency);
    const dueToday = my.filter(r => r.next_action_due === today);
    const stale = my.filter(r => r.stale && !overdue.includes(r) && !dueToday.includes(r));
    const flagged = my.filter(r => r.needs_review && !overdue.includes(r) && !dueToday.includes(r) && !stale.includes(r));
    const attention = [...overdue, ...dueToday, ...stale, ...flagged];
    const soon = my.filter(r => r.next_action_due && r.next_action_due > today && r.next_action_due <= P.addDays(7)).sort(SORTS.urgency);
    const priorities = [...attention, ...soon];
    const deadlines = board.filter(r => P.isOpenBid(r) && P.dayDiff(r.deadline) <= 7 && (r.owner_id === me().id || (r.stage === 'available' && !r.needs_review))).sort(SORTS.deadline);
    const pool = board.filter(r => r.stage === 'available' && !r.needs_review);
    const hotAll = pool.filter(r => r.priority === 'Hot').sort(SORTS.priority);
    const notes = P.state.notes || [];
    const quotes = my.filter(r => ['quote_needed', 'quote_sent'].includes(r.stage)).length;
    const why = [overdue.length && `${overdue.length} overdue`, dueToday.length && `${dueToday.length} due today`, stale.length && `${stale.length} stalled`, flagged.length && `${flagged.length} flagged by a refresh`].filter(Boolean).join(' · ');
    const nextDl = deadlines[0];
    const central = hotAll.filter(r => r.region === 'Central FL').length;
    const dateLine = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });

    const kpis = `<div class="kpis">
      <button class="kpi ${attention.length ? 'attn' : ''}" data-act="jump" data-to="sec-pri"><div class="lbl">Needs attention</div><div class="val">${attention.length}</div><div class="sub">${esc(why || 'You are caught up')}</div></button>
      <a class="kpi" href="#/mine"><div class="lbl">My active leads</div><div class="val">${my.length}</div><div class="sub">${quotes ? `${P.plural(quotes, 'quote')} in progress` : my.length ? `${my.filter(r => r.stage === 'claimed').length} not contacted yet` : 'Claim one from Available'}</div></a>
      <button class="kpi ${nextDl && P.dayDiff(nextDl.deadline) <= 2 ? 'attn' : ''}" data-act="jump" data-to="sec-dl"><div class="lbl">Deadlines in 7 days</div><div class="val">${deadlines.length}</div><div class="sub">${nextDl ? `Next: ${esc(P.date(nextDl.deadline))}, ${esc(P.rel(P.dayDiff(nextDl.deadline)))}` : 'None this week'}</div></button>
      <a class="kpi" href="#/pool?priority=Hot"><div class="lbl">Hot leads to claim</div><div class="val">${hotAll.length}</div><div class="sub">${hotAll.length ? `${central} in Central FL` : 'None in the pool right now'}</div></a></div>`;

    const mgrQueue = P.isMgr() ? (() => {
      const q = board.filter(r => r.stage === 'quote_needed'), rv = board.filter(r => r.needs_review), stl = board.filter(r => r.stale);
      const item = (href, n, label) => `<a href="${href}" class="row" style="gap:6px;color:var(--ink);text-decoration:none"><b style="font-size:15px">${n}</b><span class="muted">${esc(label)}</span>${P.icon('right', 'sm')}</a>`;
      return `<div class="card card-pad row" style="gap:10px 28px;margin:-8px 0 24px"><span class="small strong" style="color:var(--ink-2)">Team queue</span>
        ${item('#/all?stage=quote_needed&tab=all', q.length, q.length === 1 ? 'quote requested' : 'quotes requested')}${item('#/sources?tab=review', rv.length, 'waiting for review')}${item('#/all?tab=stalled', stl.length, stl.length === 1 ? 'stalled claim' : 'stalled claims')}</div>`;
    })() : '';

    const priBody = priorities.length ? `<div>${priorities.slice(0, 7).map(r => mini(r, r.next_action_due ? ui.due(r.next_action_due) : r.stale ? '<span class="badge warm">No recent activity</span>' : r.needs_review ? '<span class="badge warm">Check source</span>' : '',
        r.next_action ? `<span class="muted">Next:</span> ${esc(r.next_action)}` : '<span class="faint">No next action set</span>')).join('')}</div>`
      : P.empty(my.length ? 'You are caught up' : 'No leads yet', my.length ? 'No follow-ups due this week.' : 'Claim a lead from Available to start your pipeline.', my.length ? '' : '<a class="btn primary" href="#/pool">Browse available leads</a>', 'sm');
    const dlBody = deadlines.length ? `<div>${deadlines.slice(0, 6).map(r => mini(r, `<span class="small ${P.dayDiff(r.deadline) <= 2 ? 'due-hot' : ''}">${esc(P.date(r.deadline))} · ${esc(P.rel(P.dayDiff(r.deadline)))}</span>`,
        `${r.owner_id === me().id ? 'Yours' : 'Unclaimed'} · ${esc((P.APPROACH[r.approach] || [''])[0])}`)).join('')}</div>`
      : P.empty('No bid deadlines this week', '', '', 'sm');
    const hotBody = hotAll.length ? `<div>${hotAll.slice(0, 5).map(r => mini(r, claimBtn(r), (r.services || []).length ? `<span class="muted">Likely work:</span> ${esc(r.services.slice(0, 3).join(', '))}` : r.next_action ? `<span class="muted">Next:</span> ${esc(r.next_action)}` : '')).join('')}</div>`
      : P.empty('No Hot leads in the pool', 'New finds arrive with each refresh.', '', 'sm');
    const noteBody = notes.length ? `<div>${notes.slice(0, 6).map(n => `<div class="mini ${n.read ? '' : 'unread'}" ${n.opportunity_id ? `data-lead="${n.opportunity_id}"` : ''}>
        <div class="t">${n.opportunity_id ? `<a class="ell" href="#/lead/${n.opportunity_id}" data-lead="${n.opportunity_id}">${esc(n.title)}</a>` : `<span class="ell">${esc(n.title)}</span>`}${n.read ? '' : '<span class="sr">, new</span>'}</div><div class="s">${esc(n.body || '')}</div><div class="r"><span class="small faint nowrap">${esc(P.ago(n.at))}</span></div></div>`).join('')}</div>`
      : P.empty('Nothing new', 'Assignments, source changes on your leads and due follow-ups show up here.', '', 'sm');

    view.innerHTML = `${P.pageHead({ title: 'Today', sub: `${esc(dateLine)}. ${my.length ? `You have ${P.plural(my.length, 'active lead')}.` : 'You have no active leads yet.'}`, actions: P.syncHtml() })}
      ${kpis}${mgrQueue}
      <div class="cols">
        <div class="stack">
          ${card('sec-pri', 'My priorities', priorities.length, priBody, priorities.length > 7 ? viewAll('#/mine?sort=urgency') : my.length ? viewAll('#/mine', 'My pipeline') : '')}
          ${card('sec-dl', 'Upcoming deadlines', deadlines.length, dlBody, viewAll('#/gov?tab=open', 'Gov contracts'))}
        </div>
        <div class="stack">
          ${card('sec-hot', 'Hot leads worth claiming', hotAll.length, hotBody, hotAll.length > 5 ? viewAll('#/pool?priority=Hot') : '')}
          ${card('sec-new', 'Recent activity and changes', null, noteBody, notes.length ? '<button class="btn ghost sm" data-act="notifications">View all</button>' : '')}
        </div>
      </div>`;
  }
  P.act.jump = (el) => { const t = document.getElementById(el.dataset.to); t?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); t?.querySelector('[data-lead]')?.focus({ preventScroll: true }); };

  P.views.today = async (view) => {
    P.setPage('Today');
    if (!P.state.board) view.innerHTML = P.loadingPage('Today');
    const [, notes] = await Promise.all([P.loadBoard(), P.rpc('get_notifications').catch(() => null)]);
    if (notes) P.state.notes = notes;
    if (P.state.page !== 'today') return;
    renderToday(view);
    P.state.rerender = () => P.state.page === 'today' && renderToday(view);
  };

  // ---------------------------------------------------------------- More (phone)
  P.views.more = async (view) => {
    const groups = P.NAV().map(([g, items]) => [g, items.filter(([k]) => !['today', 'pool', 'mine', 'gov'].includes(k))]).filter(([, items]) => items.length);
    view.innerHTML = `${P.pageHead({ title: 'More' })}
      ${groups.map(([g, items]) => `<section class="section"><div class="sec-head"><h2>${esc(g)}</h2></div><div class="list">${items.map(([k, label, icon]) => `<a class="mini" href="#/${k}" style="grid-template-columns:auto 1fr auto;text-decoration:none;color:inherit">${P.icon(icon)}<div class="t">${esc(label)}</div>${P.icon('right', 'sm')}</a>`).join('')}</div></section>`).join('')}
      <section class="section"><div class="sec-head"><h2>Account</h2></div><div class="list">
        <a class="mini" href="#/me" style="grid-template-columns:auto 1fr auto;text-decoration:none;color:inherit">${P.icon('account')}<div class="t">My account</div>${P.icon('right', 'sm')}</a>
        <button class="mini" data-act="signOut" style="grid-template-columns:auto 1fr;width:100%;border:0;border-top:1px solid var(--line);background:none;text-align:left;font:inherit">${P.icon('logout')}<div class="t">Sign out</div></button></div></section>`;
  };
})();
