/* Speedy Sales Portal: shared state, vocabulary, formatting, API, feedback, side panel, shell and router. */
(function () {
  const cfg = window.SPEEDY_CONFIG || {};
  const P = window.P = {
    cfg,
    sb: window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { storageKey: 'speedy-portal-auth', flowType: 'implicit', detectSessionInUrl: false, persistSession: true, autoRefreshToken: true },
    }),
    state: { me: null, board: null, boardAt: 0, boardErr: null, filters: {}, users: null, page: null },
    views: {},
    act: {},
  };

  // per-browser conveniences (view choice, columns, sidebar). Never required for the app to work.
  P.store = {
    get(k, d) { try { const v = localStorage.getItem('speedy.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('speedy.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  // ---------------------------------------------------------------- vocabulary
  P.REGIONS = ['Central FL', 'Tampa Bay', 'Northeast FL', 'Southwest FL', 'Southeast FL', 'Panhandle', 'Unknown'];
  P.PSTAGE = { planning: 'Planning', design: 'In design', permitting: 'Permit filed', upcoming: 'Procurement announced', bidding: 'Open for bids', bid_closed: 'Bids closed, award pending',
    low_bidder: 'Apparent low bidder (not final)', intent_to_award: 'Intended award', awarded: 'Awarded', preconstruction: 'Starting soon',
    under_construction: 'Under construction', completed: 'Completed', cancelled: 'Cancelled', unknown: 'Stage unknown' };
  P.APPROACH = {
    bid_direct: ['Bid it directly', 'Speedy can submit its own bid or quote to the agency.'],
    plan_holders: ['Call the plan holders', 'Bids are open. Call the contractors who pulled plans and offer sub pricing before bid day.'],
    quote_bidders: ['Quote the bidding contractors', 'Find out who is bidding and get them sub pricing before the deadline.'],
    approach_prime: ['Approach the prime contractor', 'A builder is picked or is the apparent low bidder. Call their estimator or project manager.'],
    approach_developer: ['Approach the developer', 'No builder named yet. Ask the owner or developer who is building it and get on the bid list.'],
    track_award: ['Find the winner, then call', 'Bids are closed. Check the bid tab or award notice; when the winner posts, call them.'],
    watch: ['Watch for the bid or award', 'Not open yet or the award is pending. Check back; nothing to quote today.'],
    relationship: ['Relationship follow-up', 'Past contact with this company. Check in about new work.'],
  };
  // how Speedy would win the work: its own bid to the agency, or as a subcontractor to whoever builds it
  P.ROUTE = { bid_direct: 'direct', plan_holders: 'sub', quote_bidders: 'sub', approach_prime: 'sub', approach_developer: 'sub', relationship: 'sub', track_award: 'watch', watch: 'watch' };
  P.KIND = { gov_bid: 'Government bid', contractor_outreach: 'Contractor outreach', private_project: 'Private project', relationship: 'Relationship' };
  P.SERVICES = ['GPR scanning', 'Core drilling', 'Slab sawing', 'Wall sawing', 'Wire sawing', 'Chain sawing', 'Hand sawing', 'Curb sawing', 'Breaking & removal', 'Road & bridge deconstruction', 'Robotic demolition', 'Selective demolition', 'Diamond grinding', 'Surface preparation'];
  P.OUTCOMES = [['spoke', 'Spoke with contractor'], ['no_answer', 'No answer'], ['voicemail', 'Left voicemail'], ['call_back', 'Call back later'],
    ['requested_info', 'Requested information'], ['interested', 'Interested'], ['quote_requested', 'Quote requested'], ['not_interested', 'Not interested'], ['wrong_contact', 'Wrong contact']];
  P.OUTCOME_LABEL = Object.fromEntries(P.OUTCOMES.concat([['reached', 'Spoke with them'], ['wrong_number', 'Wrong contact'], ['sent_info', 'Sent info'], ['meeting_set', 'Meeting set']]));
  P.QUOTE_STATUS = { requested: 'Requested', in_progress: 'Being priced', sent: 'Sent', accepted: 'Accepted', declined: 'Declined', no_response: 'No response yet' };
  P.ACTIVE = ['claimed', 'contacted', 'qualified', 'quote_needed', 'quote_sent', 'follow_up'];
  P.CLOSED = ['won', 'lost', 'disqualified', 'archived'];
  P.WINNER_STAGES = ['low_bidder', 'intent_to_award', 'awarded', 'preconstruction', 'under_construction'];

  // ---------------------------------------------------------------- formatting
  const esc = P.esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TZ = 'America/New_York';
  const etDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
  P.todayET = () => etDay.format(new Date());
  P.addDays = (n) => { const d = new Date(P.todayET() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  P.dayOf = (v) => !v ? null : (typeof v === 'string' && v.length === 10 ? v : etDay.format(new Date(v)));
  // whole calendar days from today (Eastern), negative when past
  P.dayDiff = (v) => { const d = P.dayOf(v); return d == null ? null : Math.round((Date.parse(d + 'T12:00:00Z') - Date.parse(P.todayET() + 'T12:00:00Z')) / 864e5); };
  P.daysUntil = P.dayDiff;
  const thisYear = new Date().getFullYear();
  P.date = (v, opts = {}) => {
    if (!v) return '';
    const dateOnly = typeof v === 'string' && v.length === 10;
    const d = dateOnly ? new Date(v + 'T12:00:00') : new Date(v);
    if (isNaN(d)) return '';
    const o = { month: 'short', day: 'numeric', timeZone: dateOnly ? undefined : TZ };
    if (d.getFullYear() !== thisYear || opts.year) o.year = 'numeric';
    if (opts.weekday) o.weekday = 'short';
    return d.toLocaleDateString('en-US', o);
  };
  P.time = (v) => v ? new Date(v).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '';
  P.dateTime = (v) => v ? new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '';
  P.deadline = (r) => !r.deadline ? '' : r.deadline_is_date ? P.date(r.deadline) : P.dateTime(r.deadline) + ' ET';
  P.rel = (n) => n == null ? '' : n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? `in ${n} days` : `${-n} days ago`;
  P.ago = (v) => {
    if (!v) return '';
    const s = (Date.now() - new Date(v)) / 1000;
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    const d = Math.round(s / 86400);
    return d === 1 ? 'yesterday' : d < 30 ? d + ' days ago' : P.date(v);
  };
  P.money = (n) => n == null || n === '' ? '' : n >= 1e9 ? '$' + (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : '$' + Math.round(n).toLocaleString('en-US');
  P.plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  P.stageLabel = (k) => k === 'in_review' ? 'Waiting for review' : (P.state.me?.stages || []).find(s => s.key === k)?.label || k;
  P.unknown = (t = 'Not recorded') => `<span class="unknown">${esc(t)}</span>`;
  P.url = (u) => /^https?:\/\//i.test(String(u || '').trim()) ? esc(String(u).trim()) : '#';   // stored links: http(s) only
  P.tel = (p) => 'tel:' + String(p || '').replace(/[^\d+]/g, '').replace(/^(\d{10})$/, '+1$1');
  P.isMgr = () => P.state.me?.role === 'manager';
  P.initials = (n) => String(n || '?').split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  P.place = (r) => [r.city || (r.county ? r.county + ' County' : ''), r.region && r.region !== 'Unknown' ? r.region : ''].filter(Boolean).join(', ') || 'Location not recorded';
  P.companyOf = (r) => r.company_name || r.project_owner || r.company?.name || r.project?.owner_name || 'No company yet';
  P.isGov = (r) => r.kind === 'gov_bid' || (r.level && r.level !== 'Private');
  P.isOpenBid = (r) => ['bidding', 'upcoming'].includes(r.project_stage ?? r.stage) && r.deadline && new Date(r.deadline) >= Date.now();

  // ---------------------------------------------------------------- icons
  const ICONS = {
    today: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4M9 15l2 2 4-4"/>',
    pool: '<path d="m12 3.5 8.5 4.7L12 13 3.5 8.2 12 3.5Z"/><path d="m3.5 12.5 8.5 4.8 8.5-4.8M3.5 16.5l8.5 4.8 8.5-4.8"/>',
    mine: '<rect x="3.5" y="4" width="4.5" height="15" rx="1"/><rect x="9.75" y="4" width="4.5" height="10.5" rx="1"/><rect x="16" y="4" width="4.5" height="7" rx="1"/>',
    all: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
    gov: '<path d="M3 20.5h18M5 20.5V10M9.5 20.5V10M14.5 20.5V10M19 20.5V10M3 10l9-6 9 6"/>',
    team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.8 2.6 2.6 3 5.2"/>',
    users: '<path d="M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6L12 3Z"/><circle cx="12" cy="10.5" r="2.5"/><path d="M8 16.5c.9-1.6 2.3-2.4 4-2.4s3.1.8 4 2.4"/>',
    sources: '<path d="M20 11a8 8 0 0 0-14.6-4.5L3.5 9M4 13a8 8 0 0 0 14.6 4.5l1.9-2.5M3.5 4.5V9H8M20.5 19.5V15H16"/>',
    files: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8l-5-5Z"/><path d="M14 3v5h5M12 11v6M9.5 14.5 12 17l2.5-2.5"/>',
    account: '<circle cx="12" cy="8" r="4"/><path d="M4 20.5c1.2-3.8 4.3-5.8 8-5.8s6.8 2 8 5.8"/>',
    more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>',
    bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    filter: '<path d="M4 5h16l-6 7.5V19l-4-2v-4.5L4 5Z"/>',
    list: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    cards: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    table: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
    board: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9.2 4v16M14.8 4v16"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    phone: '<path d="M5 4h3.5l1.8 4.5-2.3 1.4a11 11 0 0 0 6.1 6.1l1.4-2.3L20 15.5V19a1.5 1.5 0 0 1-1.6 1.5C10.6 20 4 13.4 3.5 5.6A1.5 1.5 0 0 1 5 4Z"/>',
    mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
    pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    alert: '<path d="M12 4 2.8 19.5h18.4L12 4Z"/><path d="M12 10v4.5M12 17.2v.01"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.01"/>',
    ext: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
    collapse: '<path d="m11 7-5 5 5 5M18 7l-5 5 5 5"/>',
    right: '<path d="m9 6 6 6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L3.5 9M4 13a8 8 0 0 0 14.6 4.5l1.9-2.5M3.5 4.5V9H8M20.5 19.5V15H16"/>',
    logout: '<path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 16.5 14.5 12 10 7.5M14.5 12H4"/>',
    note: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
    sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    building: '<rect x="5" y="3.5" width="14" height="17" rx="1"/><path d="M9 7.5h2M13 7.5h2M9 11.5h2M13 11.5h2M10 20.5v-4h4v4"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    quote: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8l-5-5Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    release: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    swap: '<path d="M7 4 3 8l4 4M3 8h13M17 12l4 4-4 4M21 16H8"/>',
    dollar: '<path d="M12 3v18M16.5 7.5c-.8-1.3-2.5-2-4.5-2-2.5 0-4.5 1.3-4.5 3.2 0 4.3 9 2.4 9 6.6 0 1.9-2 3.2-4.5 3.2-2.1 0-3.9-.8-4.7-2.2"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  };
  P.prioTag = (p) => p ? `<span class="tag ${p.toLowerCase()}">${esc(p)}</span>` : '';   // print view
  P.icon = (k, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k] || ''}</svg>`;

  // ---------------------------------------------------------------- small UI pieces
  P.ui = {
    prio: (p, always) => !p || (p === 'Later' && !always) ? '' : `<span class="badge ${p.toLowerCase()}"><i></i>${esc(p)}</span>`,
    stage: (k) => {
      const cls = k === 'available' ? 'accent' : ['quote_needed', 'quote_sent'].includes(k) ? 'accent' : k === 'won' ? 'ok' : ['lost', 'disqualified', 'archived', 'nurture'].includes(k) ? 'later' : 'outline';
      return `<span class="badge ${cls}">${esc(k === 'available' ? 'Unclaimed' : P.stageLabel(k))}</span>`;
    },
    // follow-up date (date only)
    due: (d, prefix = '') => {
      if (!d) return '';
      const n = P.dayDiff(d);
      if (n < 0) return `<span class="badge hot">${esc(prefix)}Overdue · ${esc(P.date(d))}</span>`;
      if (n === 0) return `<span class="badge hot">${esc(prefix)}Due today</span>`;
      if (n === 1) return `<span class="badge warm">${esc(prefix)}Tomorrow</span>`;
      return `<span class="badge outline">${esc(prefix)}${esc(P.date(d))}</span>`;
    },
    route: (a) => {
      const k = P.ROUTE[a];
      return k === 'direct' ? '<span class="badge outline-accent">Bid direct</span>' : k === 'sub' ? '<span class="badge outline">Subcontract</span>' : k === 'watch' ? '<span class="badge later">Watch</span>' : '';
    },
    // a bid or response deadline still ahead, with urgency colour inside 7 days
    deadline: (r, short) => {
      if (!P.isOpenBid(r)) return '';
      const n = P.dayDiff(r.deadline), what = (r.project_stage ?? r.stage) === 'upcoming' ? 'Response due' : 'Bids due';
      return `<span class="${n <= 7 ? 'due-hot' : ''}">${short ? '' : what + ' '}${esc(short ? P.date(r.deadline) : P.deadline(r))}${n <= 14 ? ` · ${esc(P.rel(n))}` : ''}</span>`;
    },
    dtile: (r) => {
      if (!r.deadline) return '<div class="dtile none" aria-label="No deadline"><div class="m">Due</div><div class="d">None</div></div>';
      const dt = new Date(r.deadline), n = P.dayDiff(r.deadline), open = P.isOpenBid(r);
      const m = dt.toLocaleDateString('en-US', { month: 'short', timeZone: TZ }).toUpperCase(), day = dt.toLocaleDateString('en-US', { day: 'numeric', timeZone: TZ });
      const w = !open ? 'closed' : n === 0 ? 'today' : n === 1 ? '1 day' : n + ' days';
      return `<div class="dtile ${open && n <= 7 ? 'hot' : ''}" aria-label="Deadline ${esc(P.deadline(r))}"><div class="m">${m}</div><div class="d">${day}</div><div class="w">${w}</div></div>`;
    },
    avatar: (name, cls = '') => `<span class="avatar ${cls}" aria-hidden="true">${esc(P.initials(name))}</span>`,
  };

  // ---------------------------------------------------------------- API
  const ERR = {
    not_authorized: 'Your account is not active. Ask your manager.', manager_only: 'Only a manager can do this.',
    not_owner: 'Only the owner or a manager can change this lead.', claim_first: 'Claim this lead before logging work on it.',
    reason_required: 'Add the reason (why it was won, lost or disqualified).', follow_up_date_required: 'Set a follow-up date.',
    not_found: 'That lead no longer exists or is not visible to you.', use_release: 'Use Release to put a lead back in the pool.',
    'Failed to fetch': 'No connection to the portal. Check your signal and try again.',
  };
  P.friendly = (e) => {
    const m = e?.message || String(e);
    if (e?.hint) return e.hint;
    if (/JWT expired|invalid JWT|refresh_token/i.test(m)) return 'Your session expired. Sign in again.';
    return ERR[m] || m;
  };
  P.rpc = async (fn, args) => {
    const { data, error } = await P.sb.rpc(fn, args || {});
    if (error) { const e = new Error(P.friendly(error)); e.raw = error; throw e; }
    return data;
  };
  P.fn = async (name, body) => {
    const { data, error } = await P.sb.functions.invoke(name, { body: { ...body, portal_url: location.origin + location.pathname } });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); msg = j.error || msg; } catch { /* keep generic */ }
      throw new Error(msg);
    }
    return data;
  };
  let boardP = null;
  P.loadBoard = async (force) => {
    if (!force && P.state.board && Date.now() - P.state.boardAt < 60000) return P.state.board;
    if (boardP) return boardP;
    boardP = (async () => {
      try {
        P.state.board = await P.rpc('get_board');
        P.state.boardAt = Date.now(); P.state.boardErr = null;
      } catch (e) { P.state.boardErr = e.message; if (!P.state.board) throw e; }
      finally { boardP = null; }
      P.updateCounts(); P.updateSync();
      return P.state.board;
    })();
    return boardP;
  };
  P.invalidate = () => { P.state.boardAt = 0; };
  // after any change: fresh board, redraw the page underneath, update nav counts
  P.afterChange = async () => {
    P.invalidate();
    try { await P.loadBoard(true); } catch { /* keep showing what we have */ }
    try { P.state.rerender?.(); } catch (e) { console.error(e); }
  };

  // ---------------------------------------------------------------- feedback
  let toastTimer;
  P.toast = (msg, kind) => {
    document.querySelector('.toast')?.remove();
    const t = document.createElement('div');
    t.className = 'toast' + (kind === 'error' ? ' error' : '');
    t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    t.innerHTML = P.icon(kind === 'error' ? 'alert' : 'check') + `<span>${esc(msg)}</span>`;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('on'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.remove('on'); setTimeout(() => t.remove(), 200); }, kind === 'error' ? 7000 : 3600);
  };
  P.skeleton = (n = 6, kind = 'list') => kind === 'cards'
    ? `<div class="cards" aria-busy="true" aria-label="Loading">${'<div class="lcard"><div class="skel" style="height:14px;width:60%"></div><div class="skel" style="height:12px;width:90%"></div><div class="skel" style="height:12px;width:40%"></div></div>'.repeat(n)}</div>`
    : `<div class="list" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, (_, i) => `<div class="skel-row"><div class="skel" style="height:14px;width:${38 + (i * 17) % 30}%"></div><div class="skel" style="height:12px;width:${55 + (i * 23) % 35}%"></div></div>`).join('')}</div>`;
  P.loadingPage = (title) => `${P.pageHead({ title })}<div class="kpis">${'<div class="kpi"><div class="skel" style="height:12px;width:50%"></div><div class="skel" style="height:24px;width:30%;margin-top:10px"></div></div>'.repeat(4)}</div>${P.skeleton(5)}`;
  P.errorState = (msg) => `<div class="empty" role="alert"><b>Could not load this</b>${esc(msg)}<br><button class="btn" data-act="retry">Try again</button></div>`;
  P.empty = (title, body, action, cls = '') => `<div class="empty ${cls}"><b>${esc(title)}</b>${body ? `<div>${body}</div>` : ''}${action || ''}</div>`;
  P.busy = async (btn, fn, label) => {
    let html;
    if (btn) { btn.disabled = true; html = btn.innerHTML; btn.innerHTML = `<span class="spin" aria-hidden="true"></span>${esc(label || (/^save/i.test(btn.textContent.trim()) ? 'Saving…' : btn.textContent.trim()))}`; btn.setAttribute('aria-busy', 'true'); }
    try { return await fn(); }
    catch (e) { P.toast(e.message || String(e), 'error'); }
    finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = html; btn.removeAttribute('aria-busy'); } }
  };

  // Modal dialog. fields: [{name,label,type,options,value,required,placeholder,help,quick:[[days,label]]}]
  P.dialog = ({ title, body = '', fields = [], ok = 'Save', cancel = 'Cancel', danger = false, wide = false, onOk }) => new Promise((resolve) => {
    P.closePop();
    const d = document.createElement('dialog');
    if (wide) d.classList.add('wide');
    d.setAttribute('aria-labelledby', 'dlg_t');
    const f = fields.map(x => {
      const id = 'f_' + x.name;
      if (x.type === 'checkbox') return `<label class="check"><input type="checkbox" name="${x.name}" ${x.value ? 'checked' : ''}><span>${esc(x.label)}</span></label>`;
      const lab = `<span>${esc(x.label)}${x.required ? '' : ' <span class="faint">(optional)</span>'}</span>`;
      let input;
      if (x.type === 'select') input = `<select id="${id}" name="${x.name}">${x.options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(x.value ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
      else if (x.type === 'textarea') input = `<textarea id="${id}" name="${x.name}" placeholder="${esc(x.placeholder || '')}">${esc(x.value || '')}</textarea>`;
      else input = `<input id="${id}" name="${x.name}" type="${x.type || 'text'}" value="${esc(x.value ?? '')}" placeholder="${esc(x.placeholder || '')}" ${x.required ? 'required' : ''} ${x.type === 'number' ? 'step="any" min="0"' : ''} ${x.type === 'url' ? 'inputmode="url"' : ''}>`;
      const quick = x.quick ? `<div class="chips" style="margin-top:4px">${x.quick.map(([n, t]) => `<button type="button" class="chip" data-quick="${x.name}" data-days="${n}">${esc(t)}</button>`).join('')}</div>` : '';
      return `<label class="field" for="${id}">${lab}${input}${quick}${x.help ? `<span class="help">${esc(x.help)}</span>` : ''}</label>`;
    }).join('');
    d.innerHTML = `<form method="dialog" novalidate><div class="dhead"><h2 id="dlg_t">${esc(title)}</h2></div><div class="dbody">${body}${f}<div class="alert error hidden" role="alert"></div></div>
      <div class="dfoot"><button class="btn" value="cancel" type="button" data-x>${esc(cancel)}</button>${ok ? `<button class="btn ${danger ? 'danger solid' : 'primary'}" value="ok" type="submit">${esc(ok)}</button>` : ''}</div></form>`;
    document.body.appendChild(d);
    const prev = document.activeElement;
    const close = (v) => { d.close(); d.remove(); try { prev?.focus?.({ preventScroll: true }); } catch { /* gone */ } resolve(v); };
    d.querySelector('[data-x]').onclick = () => close(null);
    d.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    d.addEventListener('click', (e) => {
      const q = e.target.closest('[data-quick]');
      if (q) { d.querySelector(`[name="${q.dataset.quick}"]`).value = P.addDays(Number(q.dataset.days)); d.querySelectorAll(`[data-quick="${q.dataset.quick}"]`).forEach(b => b.setAttribute('aria-pressed', b === q)); }
    });
    d.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const vals = {};
      const errBox = d.querySelector('.alert.error');
      for (const x of fields) {
        const el = d.querySelector(`[name="${x.name}"]`);
        vals[x.name] = x.type === 'checkbox' ? el.checked : el.value.trim();
        if (x.required && !vals[x.name]) { el.focus(); errBox.textContent = `${x.label} is required.`; errBox.classList.remove('hidden'); return; }
      }
      if (!onOk) return close(vals);
      const btn = d.querySelector('button[type=submit]'), html = btn.innerHTML;
      btn.disabled = true; btn.innerHTML = `<span class="spin" aria-hidden="true"></span>${esc(btn.textContent)}`; errBox.classList.add('hidden');
      try { const r = await onOk(vals, d); if (r !== false) return close(r ?? vals); }
      catch (err) { errBox.textContent = err.message; errBox.classList.remove('hidden'); }
      if (d.open) { btn.disabled = false; btn.innerHTML = html; }
    };
    d.showModal();
    (d.querySelector('input:not([type=checkbox]),select,textarea') || d.querySelector('button[type=submit]') || d.querySelector('[data-x]'))?.focus();
  });
  P.confirm = (title, body, ok = 'Continue', danger) => P.dialog({ title, body: `<p>${body}</p>`, ok, danger });

  // ---------------------------------------------------------------- popovers and menus
  let pop = null;
  const phone = () => matchMedia('(max-width: 760px)').matches;
  P.closePop = () => {
    if (!pop) return;
    const { el, scrim, anchor, onClose } = pop; pop = null;
    el.classList.remove('on'); el.setAttribute('aria-hidden', 'true'); el.setAttribute('inert', ''); scrim?.remove(); setTimeout(() => el.remove(), 120);
    anchor?.setAttribute('aria-expanded', 'false');
    onClose?.();
    if (anchor?.isConnected && el.contains(document.activeElement)) anchor.focus({ preventScroll: true });
  };
  P.popover = (anchor, html, { cls = '', label = '', onClose, sheet = true } = {}) => {
    if (pop && pop.anchor === anchor) { P.closePop(); return null; }
    P.closePop();
    const el = document.createElement('div');
    const asSheet = sheet && phone();
    el.className = `pop ${cls} ${asSheet ? 'sheet' : ''}`;
    el.setAttribute('role', cls.includes('menu') ? 'menu' : 'dialog');
    if (label) el.setAttribute('aria-label', label);
    el.innerHTML = html;
    let scrim = null;
    if (asSheet) { scrim = document.createElement('div'); scrim.className = 'sheet-scrim'; scrim.onclick = () => P.closePop(); document.body.appendChild(scrim); }
    document.body.appendChild(el);
    if (!asSheet) {
      const a = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
      let left = a.left; if (left + w > innerWidth - 8) left = Math.max(8, a.right - w);
      let top = a.bottom + 6; if (top + h > innerHeight - 8 && a.top - h - 6 > 8) top = a.top - h - 6;
      el.style.left = left + 'px'; el.style.top = top + 'px';
    }
    anchor.setAttribute('aria-expanded', 'true');
    pop = { el, scrim, anchor, onClose };
    requestAnimationFrame(() => el.classList.add('on'));
    (el.querySelector('[role=menuitem],[role=menuitemradio],input,select,button') || el).focus?.({ preventScroll: true });
    return el;
  };
  // items: [{label, icon, run, danger, checked}] or '-' or {heading}
  P.menu = (anchor, items, opts = {}) => {
    const fns = [];
    // drop empty entries and separators that would sit at an edge or next to another separator
    items = items.filter(Boolean).filter((it, i, a) => it !== '-' || (i > 0 && i < a.length - 1 && a[i - 1] !== '-'));
    const html = `<div class="menu">${items.map(it => {
      if (it === '-') return '<hr>';
      if (it.heading) return `<div class="mlabel">${esc(it.heading)}</div>`;
      fns.push(it.run);
      const role = it.checked != null ? 'menuitemradio' : 'menuitem';
      return `<button type="button" role="${role}" ${it.checked != null ? `aria-checked="${!!it.checked}"` : ''} class="${it.danger ? 'danger' : ''}" data-mi="${fns.length - 1}">${it.icon ? P.icon(it.icon) : ''}<span>${esc(it.label)}</span>${it.checked ? P.icon('check', 'sm') : ''}</button>`;
    }).join('')}</div>`;
    const el = P.popover(anchor, html, { cls: 'menu-pop', label: opts.label || 'Actions' });
    if (!el) return;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mi]'); if (!b) return;
      P.closePop(); fns[Number(b.dataset.mi)]?.();
    });
    el.addEventListener('keydown', (e) => {
      const list = [...el.querySelectorAll('[data-mi]')], i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    });
  };
  document.addEventListener('mousedown', (e) => {
    if (pop && !pop.el.contains(e.target) && !pop.anchor.contains(e.target) && !e.target.closest('.sheet-scrim')) P.closePop();
  });
  addEventListener('resize', () => { if (pop && !pop.el.classList.contains('sheet')) P.closePop(); });

  // ---------------------------------------------------------------- side panel (lead and person detail)
  const D = P.drawer = {
    kind: null, key: null, open: false, back: null,
    el: () => document.getElementById('drawer'),
    show(kind, key, { narrow = false } = {}) {
      const el = D.el(); if (!el) return;
      if (!D.open) D.back = document.activeElement;
      D.kind = kind; D.key = key; D.open = true;
      el.classList.toggle('narrow', narrow);
      el.classList.add('on'); el.removeAttribute('aria-hidden'); el.removeAttribute('inert');
      document.getElementById('scrim').classList.add('on');
      if (phone()) document.body.style.overflow = 'hidden';
    },
    set(html, { keepScroll } = {}) {
      const el = D.el(); if (!el) return;
      const body = el.querySelector('.dw-body'), top = keepScroll && body ? body.scrollTop : 0;
      el.innerHTML = html;
      if (keepScroll) { const b = el.querySelector('.dw-body'); if (b) b.scrollTop = top; }
    },
    focus() { const el = D.el(); (el.querySelector('#dw_title') || el.querySelector('button'))?.focus({ preventScroll: true }); },
    hide() {
      const el = D.el(); if (!el || !D.open) return;
      D.open = false; D.kind = null; D.key = null;
      el.classList.remove('on'); el.setAttribute('aria-hidden', 'true'); el.setAttribute('inert', '');
      document.getElementById('scrim').classList.remove('on');
      document.body.style.overflow = '';
      setTimeout(() => { if (!D.open) el.innerHTML = ''; }, 260);
      if (D.back?.isConnected) D.back.focus({ preventScroll: true });
      D.back = null;
    },
  };
  // open a lead or person over the current page; the address keeps the page underneath so Back closes it
  P.openPanel = (param, id) => {
    const r = P.parseHash();
    const q = new URLSearchParams(r.params); q.delete('lead'); q.delete('person'); q.delete('company'); q.set(param, id);
    const h = '#/' + (r.path || 'today') + '?' + q;
    if (r.params.lead || r.params.person || r.params.company) { history.replaceState(null, '', h); P.route(); }
    else { P.state.drawerPushed = true; location.hash = h; }
  };
  P.openLead = (id) => P.openPanel('lead', id);
  P.openPerson = (id) => P.openPanel('person', id);
  P.openCompany = (id) => P.openPanel('company', id);
  // open a lead straight on its Activity tab, ready to log a call
  P.act.logCall = (el) => { P.state.nextLeadTab = 'activity'; P.openLead(el.dataset.id); };
  P.closeDrawer = () => {
    const r = P.parseHash();
    if (r.params.lead || r.params.person || r.params.company) {
      if (P.state.drawerPushed) { P.state.drawerPushed = false; history.back(); return; }
      const q = new URLSearchParams(r.params); q.delete('lead'); q.delete('person'); q.delete('company');
      const s = q.toString();
      history.replaceState(null, '', '#/' + r.path + (s ? '?' + s : ''));
      P.route();
    } else D.hide();
  };
  P.act.closeDrawer = () => P.closeDrawer();
  P.dwHead = ({ ref = '', title, sub = '', meta = '', tools = '' }) => `<div class="dw-top"><span class="ref">${ref}</span>${tools}<button class="btn ghost icon sm" data-act="closeDrawer" aria-label="Close panel">${P.icon('x')}</button></div>
    <h2 class="dw-title" id="dw_title" tabindex="-1">${title}</h2>${sub ? `<div class="dw-sub">${sub}</div>` : ''}${meta ? `<div class="dw-meta">${meta}</div>` : ''}`;
  P.dwLoading = () => `<div class="dw-head"><div class="dw-top"><span class="ref"></span><button class="btn ghost icon sm" data-act="closeDrawer" aria-label="Close panel">${P.icon('x')}</button></div>
    <div class="skel" style="height:20px;width:55%;margin:6px 0 8px"></div><div class="skel" style="height:14px;width:75%;margin-bottom:18px"></div></div>
    <div class="dw-body" aria-busy="true" aria-label="Loading">${'<div class="skel" style="height:14px;margin-bottom:12px"></div>'.repeat(6)}</div>`;

  // ---------------------------------------------------------------- shell
  P.NAV = () => {
    const mgr = P.isMgr();
    return [
      ['Daily work', [['today', 'Today', 'today']]],
      ['Opportunities', [['pool', 'Available', 'pool'], ['mine', 'My pipeline', 'mine'], mgr && ['all', 'All leads', 'all']]],
      ['Government', [['gov', 'Gov contracts', 'gov']]],
      mgr && ['Management', [['team', 'Team', 'team'], ['users', 'People and access', 'users']]],
      mgr && ['Data and system', [['sources', 'Sources and refreshes', 'sources']]],
      ['Reports', [mgr && ['reports', 'Team report', 'flag'], ['files', 'Excel and PDF', 'files']]],
    ].filter(Boolean).map(([g, items]) => [g, items.filter(Boolean)]);
  };
  P.TITLES = { today: 'Today', pool: 'Available', mine: 'My pipeline', all: 'All leads', gov: 'Gov contracts', team: 'Team', users: 'People and access',
    sources: 'Sources and refreshes', files: 'Excel and PDF', reports: 'Team report', me: 'My account', more: 'More', print: 'Print' };
  P.renderShell = () => {
    const me = P.state.me, collapsed = P.store.get('sidebar', innerWidth < 1180 ? 'collapsed' : 'open') === 'collapsed';
    const link = ([k, label, icon]) => `<a class="sb-link" href="#/${k}" data-nav="${k}" title="${esc(label)}">${P.icon(icon)}<span class="txt">${esc(label)}</span><span class="sb-count" data-count="${k}"></span></a>`;
    document.getElementById('root').innerHTML = `
      <div class="app ${collapsed ? 'collapsed' : ''}" id="app">
        <a class="sr" href="#view" data-act="skip">Skip to content</a>
        <aside class="sidebar" aria-label="Main navigation">
          <div class="sb-brand"><img class="full" src="assets/logo-dark.png" alt="Speedy Concrete Cutting"><img class="mark" src="assets/mark-dark.png" alt="Speedy"></div>
          <nav class="sb-nav">${P.NAV().map(([g, items]) => `<div class="sb-group" role="group" aria-label="${esc(g)}"><div class="sb-label">${esc(g)}</div>${items.map(link).join('')}</div>`).join('')}</nav>
          <div class="sb-foot">
            <button class="sb-btn" data-act="notifications" title="Notifications" aria-label="Notifications">${P.icon('bell')}<span class="txt">Notifications</span><span class="badge-n hidden" data-unread></span></button>
            <a class="sb-user" href="#/me" data-nav="me" title="My account">${P.ui.avatar(me.full_name || me.email)}<span class="who"><b>${esc(me.full_name || me.email)}</b><span>${P.isMgr() ? 'Manager' : 'Salesperson'}</span></span></a>
            <button class="sb-btn sb-collapse" data-act="toggleSidebar" aria-label="Collapse sidebar" title="Collapse sidebar">${P.icon('collapse')}<span class="txt">Collapse</span></button>
          </div>
        </aside>
        <div class="main">
          <header class="topbar"><img src="assets/mark-dark.png" alt="Speedy"><div class="ttl" id="ttl">Speedy</div>
            <button data-act="notifications" aria-label="Notifications">${P.icon('bell')}<span class="badge-n hidden" data-unread></span></button></header>
          <main id="view" class="page" tabindex="-1"></main>
        </div>
        <nav class="bottomnav" aria-label="Main">
          ${[['today', 'Today', 'today'], ['pool', 'Available', 'pool'], ['mine', 'Pipeline', 'mine'], ['gov', 'Gov', 'gov'], ['more', 'More', 'more']].map(([k, l, i]) => `<a href="#/${k}" data-nav="${k}">${P.icon(i)}<span>${l}</span>${k === 'today' ? '<span class="n hidden" data-mcount="today"></span>' : ''}</a>`).join('')}
        </nav>
        <div class="scrim" id="scrim" data-act="closeDrawer"></div>
        <aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="dw_title" aria-hidden="true" inert></aside>
      </div>`;
    P.setUnread(me.unread || 0);
    P.updateCounts();
  };
  P.act.skip = () => document.getElementById('view').focus();
  P.act.toggleSidebar = () => {
    const app = document.getElementById('app'), c = !app.classList.contains('collapsed');
    app.classList.toggle('collapsed', c); P.store.set('sidebar', c ? 'collapsed' : 'open');
    const b = app.querySelector('.sb-collapse'); b.setAttribute('aria-label', c ? 'Expand sidebar' : 'Collapse sidebar'); b.title = c ? 'Expand sidebar' : 'Collapse sidebar';
  };
  P.setPage = (title) => {
    document.title = title + ' · Speedy Sales';
    const t = document.getElementById('ttl'); if (t) t.textContent = title;
  };
  P.pageHead = ({ title, sub = '', actions = '' }) => {
    P.setPage(title);
    return `<div class="page-head"><div class="titles"><h1>${esc(title)}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
  };
  P.setUnread = (n) => {
    P.state.unread = n;
    document.querySelectorAll('[data-unread]').forEach(b => { b.textContent = n > 99 ? '99+' : n; b.classList.toggle('hidden', !n); });
  };
  // nav counts: exactly what each list shows by default
  P.counts = () => {
    const b = P.state.board || [], me = P.state.me?.id, today = P.todayET();
    const mine = b.filter(r => r.owner_id === me && P.ACTIVE.includes(r.stage));
    return {
      pool: b.filter(r => r.stage === 'available' && !r.needs_review).length,
      mine: mine.length,
      due: mine.filter(r => r.next_action_due && r.next_action_due <= today).length,
      review: P.isMgr() ? b.filter(r => r.needs_review).length : 0,
    };
  };
  P.updateCounts = () => {
    if (!P.state.board) return;
    const c = P.counts();
    const set = (k, v, alert) => document.querySelectorAll(`[data-count="${k}"]`).forEach(el => { el.textContent = v || ''; el.classList.toggle('hot', !!alert && !!v); });
    set('pool', c.pool); set('mine', c.mine); set('today', c.due, true); set('sources', c.review, true);
    document.querySelectorAll('[data-mcount="today"]').forEach(el => { el.textContent = c.due; el.classList.toggle('hidden', !c.due); });
  };
  // "Updated 2 min ago" with a refresh button, shown on data pages
  const freshText = () => {
    const f = P.state.fresh;
    if (!f || !f.verified_at) return f && f.last_success_at ? `Sources checked ${P.ago(f.last_success_at)}` : 'Not refreshed yet';
    const t = new Date(f.verified_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
    const day = f.day === P.todayET() ? '' : ' ' + P.date(f.verified_at);
    if (f.status === 'ready') return `Data verified ${t}${day} ET`;
    const late = f.sources_total - f.sources_ok;
    return `${late} of ${f.sources_total} source${f.sources_total === 1 ? '' : 's'} delayed · checked ${t}${day}`;
  };
  P.syncHtml = () => `<span class="sync${P.state.fresh && P.state.fresh.status && P.state.fresh.status !== 'ready' ? ' warn' : ''}" id="sync">${P.state.boardErr ? `<span class="due-hot">Offline copy from ${esc(P.ago(P.state.boardAt))}</span>`
    : `<button class="linklike" data-act="freshInfo" aria-label="Data freshness details">${esc(freshText())}</button>`}<button data-act="refreshBoard" aria-label="Reload leads" title="Reload leads">${P.icon('refresh', 'sm')}</button></span>`;
  P.loadFresh = async () => { try { P.state.fresh = await P.rpc('data_freshness'); P.updateSync(); } catch { /* the indicator is optional */ } };
  P.act.freshInfo = (el) => {
    const f = P.state.fresh || {};
    P.popover(el, `<div class="pop-body"><b class="strong">Morning data</b>
      <p class="small muted" style="margin:4px 0 8px">The portal collects from every source at 4:15 AM Eastern, retries anything that failed, and verifies by 5:30 AM. This shows when each source last refreshed successfully.</p>
      <ul class="plain-list">${(f.sources || []).map(x => `<li><span class="dot ${x.ok ? 'ok' : 'warm'}"></span> ${esc(x.name)} <span class="small faint">${x.last_success_at ? esc(P.ago(x.last_success_at)) : 'never'}</span></li>`).join('')}</ul>
      ${P.isMgr() ? '<a class="btn sm" href="#/sources?tab=overview" style="margin-top:8px">Source details</a>' : ''}</div>`);
  };
  P.updateSync = () => { const s = document.getElementById('sync'); if (s) s.outerHTML = P.syncHtml(); };
  setInterval(() => P.state.board && P.updateSync(), 30000);
  P.act.refreshBoard = async (el) => {
    const s = el.closest('.sync'); s?.classList.add('busy');
    try { await P.loadBoard(true); P.state.rerender?.(); P.toast('Up to date.'); }
    catch (e) { P.toast(e.message, 'error'); }
    finally { document.getElementById('sync')?.classList.remove('busy'); }
  };

  // ---------------------------------------------------------------- router
  P.parseHash = () => {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, q] = h.split('?');
    const parts = path.split('/').filter(Boolean);
    return { name: parts[0] || 'today', arg: parts[1], path: parts.join('/') || 'today', params: Object.fromEntries(new URLSearchParams(q || '')) };
  };
  P.go = (hash) => { if (location.hash === hash) P.route({ force: true }); else location.hash = hash; };
  let curKey = null;
  const PANEL_KEYS = ['lead', 'person', 'company'];
  const viewKey = (r) => r.path + '?' + new URLSearchParams(Object.entries(r.params).filter(([k]) => !PANEL_KEYS.includes(k)));
  // a view that consumed its start-up parameters (e.g. ?priority=Hot) drops them from the address
  P.cleanHash = () => {
    const r = P.parseHash(), keep = new URLSearchParams();
    if (r.params.lead) keep.set('lead', r.params.lead);
    if (r.params.person) keep.set('person', r.params.person);
    if (r.params.company) keep.set('company', r.params.company);
    const s = keep.toString();
    history.replaceState(null, '', '#/' + r.path + (s ? '?' + s : ''));
    curKey = r.path + '?';
  };
  P.route = async (opts = {}) => {
    if (!P.state.me) return;
    const r = P.parseHash();
    if (r.name === 'lead' && r.arg) {   // old links: #/lead/<id> opens the panel over the last page
      const base = P.state.page && P.views[P.state.page] ? P.state.page : 'today';
      history.replaceState(null, '', `#/${base}?lead=${encodeURIComponent(r.arg)}`);
      return P.route();
    }
    const view = document.getElementById('view');
    if (!view) return;
    const key = viewKey(r);
    let rendering = null;
    if (key !== curKey || opts.force) {
      const pageChanged = P.state.page !== r.name;
      curKey = key;
      try { P.state.cleanup?.(); } catch { /* ignore */ }
      P.state.cleanup = null; P.state.rerender = null; P.state.page = r.name;
      P.closePop();
      document.querySelectorAll('[data-nav]').forEach(a => {
        const on = a.dataset.nav === r.name || (a.dataset.nav === 'more' && !['today', 'pool', 'mine', 'gov'].includes(r.name));
        if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      });
      if (pageChanged) window.scrollTo(0, 0);
      const fn = P.views[r.name];
      const vp = { ...r, params: Object.fromEntries(Object.entries(r.params).filter(([k]) => !PANEL_KEYS.includes(k))) };
      rendering = fn
        ? Promise.resolve().then(() => fn(view, vp)).catch(e => { console.error(e); view.innerHTML = P.pageHead({ title: P.TITLES[r.name] || 'Speedy' }) + P.errorState(e.message); })
        : Promise.resolve(view.innerHTML = P.pageHead({ title: 'Page not found' }) + P.empty('Page not found', 'That address does not match a page in the portal.', '<a class="btn" href="#/today">Go to Today</a>'));
    }
    if (r.params.lead && P.showLead) { const tab = P.state.nextLeadTab; P.state.nextLeadTab = null; P.showLead(r.params.lead, tab ? { tab } : {}); }
    else if (r.params.person && P.showPerson) P.showPerson(r.params.person);
    else if (r.params.company && P.showCompany) P.showCompany(r.params.company);
    else { P.state.drawerPushed = false; if (D.open && ['lead', 'person', 'company'].includes(D.kind)) D.hide(); }
    await rendering;
  };
  P.act.retry = () => { P.invalidate(); P.route({ force: true }); };

  // ---------------------------------------------------------------- global events
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el) { const f = P.act[el.dataset.act]; if (f) { e.preventDefault(); f(el, e); } return; }
    const row = e.target.closest('[data-lead],[data-person],[data-company]');
    if (row && (row === e.target.closest('a,button,input,select,textarea,label') || !e.target.closest('a,button,input,select,textarea,label'))) {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;   // let modified clicks open a new tab
      e.preventDefault();
      if (row.dataset.lead) P.openLead(row.dataset.lead); else if (row.dataset.company) P.openCompany(row.dataset.company); else P.openPerson(row.dataset.person);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (pop) { e.preventDefault(); P.closePop(); return; }
      if (document.querySelector('dialog[open]')) return;
      if (D.open) { e.preventDefault(); P.closeDrawer(); return; }
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-lead][role=button],[data-person][role=button]')) {
      e.preventDefault(); e.target.click();
    }
    // keep keyboard focus inside the open side panel
    if (e.key === 'Tab' && D.open && !document.querySelector('dialog[open]') && !pop) {
      const items = [...D.el().querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex="0"]')].filter(x => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (!D.el().contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
})();
