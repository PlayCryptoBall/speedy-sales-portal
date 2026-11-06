/* Speedy Sales Portal: shared state, helpers, API, shell and router. */
(function () {
  const cfg = window.SPEEDY_CONFIG || {};
  const P = window.P = {
    cfg,
    sb: window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { storageKey: 'speedy-portal-auth', flowType: 'implicit', detectSessionInUrl: false, persistSession: true, autoRefreshToken: true },
    }),
    state: { me: null, board: null, boardAt: 0, boardErr: null, filters: {}, users: null },
    views: {},
    act: {},
  };

  // ---------------------------------------------------------------- vocabulary
  P.REGIONS = ['Central FL', 'Tampa Bay', 'North FL', 'Southwest FL', 'South FL', 'Panhandle', 'Unknown'];
  P.PSTAGE = { planning: 'Planning', upcoming: 'Procurement announced', bidding: 'Open for bids', bid_closed: 'Bids closed, award pending',
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
  P.KIND = { gov_bid: 'Government bid', contractor_outreach: 'Contractor outreach', private_project: 'Private project', relationship: 'Relationship' };
  P.SERVICES = ['GPR scanning', 'Core drilling', 'Slab sawing', 'Wall sawing', 'Wire sawing', 'Chain sawing', 'Curb sawing', 'Breaking & removal', 'Diamond grinding', 'Selective demolition'];
  P.OUTCOMES = [['reached', 'Reached them'], ['voicemail', 'Left voicemail'], ['no_answer', 'No answer'], ['wrong_number', 'Wrong number'],
    ['sent_info', 'Sent info'], ['meeting_set', 'Meeting set'], ['quote_requested', 'Asked for a quote'], ['not_interested', 'Not interested']];
  P.ACTIVE = ['claimed', 'contacted', 'qualified', 'quote_needed', 'quote_sent', 'follow_up'];
  P.CLOSED = ['won', 'lost', 'disqualified', 'archived'];

  // ---------------------------------------------------------------- formatting
  const esc = P.esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  P.attr = esc;
  const TZ = 'America/New_York';
  P.todayET = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  P.addDays = (n) => { const d = new Date(P.todayET() + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const thisYear = new Date().getFullYear();
  P.date = (v, opts = {}) => {
    if (!v) return '';
    const d = typeof v === 'string' && v.length === 10 ? new Date(v + 'T12:00:00') : new Date(v);
    if (isNaN(d)) return '';
    const o = { month: 'short', day: 'numeric', timeZone: v.length === 10 ? undefined : TZ };
    if (d.getFullYear() !== thisYear || opts.year) o.year = 'numeric';
    return d.toLocaleDateString('en-US', o);
  };
  P.dateTime = (v) => v ? new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '';
  P.deadline = (r) => {
    if (!r.deadline) return '';
    return r.deadline_is_date ? P.date(r.deadline) : P.dateTime(r.deadline) + ' ET';
  };
  P.daysUntil = (v) => {
    if (!v) return null;
    const ms = new Date(v.length === 10 ? v + 'T12:00:00' : v) - Date.now();
    return Math.ceil(ms / 86400000);
  };
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
  P.stageLabel = (k) => (P.state.me?.stages || []).find(s => s.key === k)?.label || k;
  P.unknown = (t = 'Not recorded') => `<span class="unknown">${esc(t)}</span>`;
  P.prioTag = (p) => p ? `<span class="tag ${p.toLowerCase()}">${esc(p)}</span>` : '';
  P.ownerTag = (r) => {
    if (r.stage === 'available') return '<span class="tag open">Available</span>';
    if (r.owner_id && r.owner_id === P.state.me.id) return `<span class="tag mine">Yours: ${esc(P.stageLabel(r.stage))}</span>`;
    if (r.owner_id) return `<span class="tag taken">${esc(r.owner_name || 'Teammate')}: ${esc(P.stageLabel(r.stage))}</span>`;
    return `<span class="tag ${r.stage === 'won' ? 'won' : ''}">${esc(P.stageLabel(r.stage))}</span>`;
  };
  P.tel = (p) => 'tel:' + String(p || '').replace(/[^\d+]/g, '').replace(/^(\d{10})$/, '+1$1');
  P.isMgr = () => P.state.me?.role === 'manager';
  P.qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

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
  P.loadBoard = async (force) => {
    if (!force && P.state.board && Date.now() - P.state.boardAt < 60000) return P.state.board;
    try {
      P.state.board = await P.rpc('get_board');
      P.state.boardAt = Date.now(); P.state.boardErr = null;
    } catch (e) { P.state.boardErr = e.message; if (!P.state.board) throw e; }
    P.updateCounts();
    return P.state.board;
  };
  P.invalidate = () => { P.state.boardAt = 0; };

  // ---------------------------------------------------------------- feedback
  let toastTimer;
  P.toast = (msg, kind) => {
    document.querySelector('.toast')?.remove();
    const t = document.createElement('div');
    t.className = 'toast' + (kind === 'error' ? ' error' : '');
    t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), kind === 'error' ? 7000 : 4000);
  };
  P.loading = (n = 6) => `<div class="sheet" aria-busy="true" aria-label="Loading">${'<div class="skeleton"></div>'.repeat(n)}</div>`;
  P.errorState = (msg, retry = 'retry') => `<div class="state" role="alert"><b>Could not load this</b>${esc(msg)}<br><button class="btn" data-act="${retry}">Try again</button></div>`;
  P.empty = (title, body, action) => `<div class="state"><b>${esc(title)}</b>${body || ''}${action || ''}</div>`;
  P.busy = async (btn, fn) => {
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Working…'; }
    try { return await fn(); }
    catch (e) { P.toast(e.message || String(e), 'error'); }
    finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset.label; } }
  };
  // Modal dialog. fields: [{name,label,type,options,value,required,placeholder,help}]
  P.dialog = ({ title, body = '', fields = [], ok = 'Save', cancel = 'Cancel', danger = false, onOk }) => new Promise((resolve) => {
    const d = document.createElement('dialog');
    const f = fields.map(x => {
      const id = 'f_' + x.name;
      const lab = `<span>${esc(x.label)}${x.required ? '' : ' <span class="muted small">(optional)</span>'}</span>`;
      let input;
      if (x.type === 'select') input = `<select id="${id}" name="${x.name}">${x.options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(x.value ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
      else if (x.type === 'textarea') input = `<textarea id="${id}" name="${x.name}" placeholder="${esc(x.placeholder || '')}">${esc(x.value || '')}</textarea>`;
      else if (x.type === 'checkbox') return `<label class="row" style="margin-bottom:12px"><input type="checkbox" name="${x.name}" ${x.value ? 'checked' : ''}> ${esc(x.label)}</label>`;
      else input = `<input id="${id}" name="${x.name}" type="${x.type || 'text'}" value="${esc(x.value ?? '')}" placeholder="${esc(x.placeholder || '')}" ${x.required ? 'required' : ''} ${x.type === 'number' ? 'step="any" min="0"' : ''}>`;
      return `<label class="field" for="${id}">${lab}${input}${x.help ? `<span class="kv-note">${esc(x.help)}</span>` : ''}</label>`;
    }).join('');
    d.innerHTML = `<form method="dialog"><div class="dhead"><h2>${esc(title)}</h2></div><div class="dbody">${body}${f}<div class="alert error hidden" role="alert"></div></div>
      <div class="dfoot"><button class="btn" value="cancel" type="button" data-x>${esc(cancel)}</button>${ok ? `<button class="btn ${danger ? 'danger' : 'primary'}" value="ok" type="submit">${esc(ok)}</button>` : ''}</div></form>`;
    document.body.appendChild(d);
    const close = (v) => { d.close(); d.remove(); resolve(v); };
    d.querySelector('[data-x]').onclick = () => close(null);
    d.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    d.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const vals = {};
      for (const x of fields) {
        const el = d.querySelector(`[name="${x.name}"]`);
        vals[x.name] = x.type === 'checkbox' ? el.checked : el.value.trim();
        if (x.required && !vals[x.name]) { el.focus(); return; }
      }
      if (!onOk) return close(vals);
      const btn = d.querySelector('button[type=submit]'), errBox = d.querySelector('.alert.error');
      btn.disabled = true; errBox.classList.add('hidden');
      try { const r = await onOk(vals, d); if (r !== false) close(r ?? vals); }
      catch (err) { errBox.textContent = err.message; errBox.classList.remove('hidden'); }
      finally { if (d.open) btn.disabled = false; }
    };
    d.showModal();
    (d.querySelector('input,select,textarea') || d.querySelector('button[type=submit]'))?.focus();
  });
  P.confirm = (title, body, ok = 'Continue', danger) => P.dialog({ title, body: `<p>${body}</p>`, ok, danger });

  // ---------------------------------------------------------------- shell
  const ICON = {
    today: '<path d="M4 6h16M4 12h10M4 18h7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="18" cy="16" r="3" stroke="currentColor" stroke-width="2" fill="none"/>',
    pool: '<rect x="3" y="5" width="18" height="4" rx="1" stroke="currentColor" stroke-width="2" fill="none"/><rect x="3" y="15" width="18" height="4" rx="1" stroke="currentColor" stroke-width="2" fill="none"/>',
    mine: '<circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="2" fill="none"/><path d="M4 20c1.5-4 5-5 8-5s6.5 1 8 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    gov: '<path d="M3 10l9-5 9 5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    more: '<circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/>',
    all: '<path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    team: '<circle cx="8" cy="9" r="3" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="17" cy="9" r="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M2 20c1-3 3.5-4 6-4s5 1 6 4M14 16c3 0 6 1 7 4" stroke="currentColor" stroke-width="2" fill="none"/>',
    sources: '<path d="M4 12a8 8 0 0 1 14-5l2-2v6h-6l2-2a5 5 0 1 0 1 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    users: '<rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="10" r="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M7 18c1-2 3-3 5-3s4 1 5 3" stroke="currentColor" stroke-width="2" fill="none"/>',
    files: '<path d="M6 3h8l4 4v14H6z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M9 13h6M9 17h6" stroke="currentColor" stroke-width="2"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;
  P.NAV = () => {
    const n = [['today', 'Today', '#/today'], ['pool', 'Available', '#/pool'], ['mine', 'My pipeline', '#/mine'], ['gov', 'Gov contracts', '#/gov']];
    const m = P.isMgr() ? [['all', 'All leads', '#/all'], ['team', 'Team', '#/team'], ['sources', 'Sources and refreshes', '#/sources'], ['users', 'People and access', '#/users']] : [];
    return { n, m, x: [['files', 'Excel and PDF', '#/files']] };
  };
  P.renderShell = () => {
    const { n, m, x } = P.NAV();
    const link = ([k, label, href]) => `<a href="${href}" data-nav="${k}">${svg(k)}<span>${esc(label)}</span><span class="count" data-count="${k}"></span></a>`;
    document.getElementById('root').innerHTML = `
      <div class="app">
        <nav class="rail" aria-label="Main">
          <div class="brand"><b>Speedy Sales</b><span>Florida pipeline, Orlando team</span></div>
          ${n.map(link).join('')}${m.length ? '<hr>' + m.map(link).join('') : ''}<hr>${x.map(link).join('')}
          <a href="#/me" data-nav="me">${svg('mine')}<span>My account</span></a>
          <div class="who"><b>${esc(P.state.me.full_name || P.state.me.email)}</b>${P.isMgr() ? 'Manager' : 'Salesperson'}</div>
        </nav>
        <div class="main">
          <header class="topbar"><button class="back hidden" data-act="back" aria-label="Back">Back</button><h1 id="title">Speedy</h1>
            <button class="bell" data-act="notifications" aria-label="Notifications"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg><b class="hidden" id="unread"></b></button>
          </header>
          <div id="banner"></div>
          <main id="view" class="page" tabindex="-1"></main>
        </div>
        <nav class="tabbar" aria-label="Main">
          ${n.map(([k, label, href]) => `<a href="${href}" data-nav="${k}">${svg(k)}<span>${esc(label.replace('Gov contracts', 'Gov').replace('My pipeline', 'Mine'))}</span><span class="count" data-count="${k}"></span></a>`).join('')}
          <a href="#/more" data-nav="more">${svg('more')}<span>More</span></a>
        </nav>
      </div>`;
    P.setUnread(P.state.me.unread || 0);
  };
  P.setTitle = (t, back) => {
    document.getElementById('title').textContent = t;
    document.title = t + ' · Speedy Sales';
    document.querySelector('.topbar .back').classList.toggle('hidden', !back);
  };
  P.setUnread = (n) => { const b = document.getElementById('unread'); if (!b) return; b.textContent = n > 99 ? '99+' : n; b.classList.toggle('hidden', !n); };
  P.updateCounts = () => {
    const b = P.state.board || [], me = P.state.me?.id, today = P.todayET();
    const c = {
      pool: b.filter(r => r.stage === 'available' && !r.needs_review).length,
      mine: b.filter(r => r.owner_id === me && P.ACTIVE.includes(r.stage)).length,
      today: b.filter(r => r.owner_id === me && P.ACTIVE.includes(r.stage) && r.next_action_due && r.next_action_due <= today).length,
    };
    document.querySelectorAll('[data-count]').forEach(el => { const v = c[el.dataset.count]; el.textContent = v ? v : ''; });
  };

  // ---------------------------------------------------------------- router
  P.parseHash = () => {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, q] = h.split('?');
    const parts = path.split('/').filter(Boolean);
    return { name: parts[0] || 'today', arg: parts[1], params: Object.fromEntries(new URLSearchParams(q || '')) };
  };
  P.go = (hash) => { if (location.hash === hash) P.route(); else location.hash = hash; };
  P.route = async () => {
    const r = P.parseHash();
    const view = document.getElementById('view');
    if (!view) return;
    document.querySelectorAll('[data-nav]').forEach(a => {
      const on = a.dataset.nav === r.name || (r.name === 'lead' && a.dataset.nav === P.state.lastList);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    const fn = P.views[r.name];
    if (!fn) { P.setTitle('Not found'); view.innerHTML = P.empty('Page not found', 'That address does not match a page in the portal.', '<a class="btn" href="#/today">Go to Today</a>'); return; }
    if (['pool', 'mine', 'gov', 'all', 'today'].includes(r.name)) P.state.lastList = r.name;
    window.scrollTo(0, 0);
    try { await fn(view, r); }
    catch (e) { view.innerHTML = P.errorState(e.message); }
  };
  P.act.retry = () => { P.invalidate(); P.route(); };
  P.act.back = () => { if (history.length > 1) history.back(); else P.go('#/' + (P.state.lastList || 'today')); };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const f = P.act[el.dataset.act];
    if (f) { e.preventDefault(); f(el, e); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-href]')) { e.preventDefault(); location.hash = e.target.dataset.href; }
  });
  document.addEventListener('click', (e) => {
    const row = e.target.closest('[data-href]');
    if (row && !e.target.closest('a,button,input,select,label')) location.hash = row.dataset.href;
  });
})();
