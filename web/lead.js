/* Lead detail: a side panel over the current page. Claim, log calls, change stage, set follow-ups and quotes from here. */
(function () {
  const { esc, ui } = P;
  let cur = null, loadingId = null;
  const QUICK = [[1, 'Tomorrow'], [3, 'In 3 days'], [7, 'Next week'], [14, 'In 2 weeks'], [30, 'In a month']];
  const TABS = [['overview', 'Overview'], ['activity', 'Activity'], ['contacts', 'Contacts'], ['project', 'Project'], ['source', 'Source and history']];
  const canWork = (o) => o.is_mine || (P.isMgr() && !!o.owner_id);

  // ---------------------------------------------------------------- open, reload
  P.showLead = async (id, opts = {}) => {
    const D = P.drawer;
    const same = D.open && D.kind === 'lead' && D.key === id;
    if (same && !opts.force) return;
    D.show('lead', id);
    if (!same) { D.set(P.dwLoading()); P.state.leadTab = opts.tab || 'overview'; }
    else if (opts.tab) P.state.leadTab = opts.tab;
    loadingId = id;
    try {
      const o = await P.rpc('get_opportunity', { p_id: id });
      if (loadingId !== id || !(D.open && D.key === id)) return;
      cur = o;
      render(same);
      if (!same) D.focus();
    } catch (e) {
      if (loadingId !== id || !(D.open && D.key === id)) return;
      D.set(`<div class="dw-head">${P.dwHead({ title: 'Could not open this lead' })}<div style="height:14px"></div></div>
        <div class="dw-body">${P.empty('Could not open this lead', esc(e.message), '<button class="btn" data-act="closeDrawer">Close</button>')}</div>`);
    }
  };
  const reload = async (msg) => {
    if (msg) P.toast(msg);
    const id = cur.id;
    await Promise.all([P.showLead(id, { force: true }), P.afterChange()]);
  };

  // ---------------------------------------------------------------- header
  function ownbar(o) {
    const mgr = P.isMgr(), stageSel = () => `<label class="sr" for="dw_stage">Stage</label><select id="dw_stage" data-stage-select aria-label="Stage">${(P.state.me.stages || []).filter(s => s.key !== 'available').map(s => `<option value="${s.key}" ${s.key === o.stage ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>`;
    const menu = `<button class="btn icon" data-act="leadMenu" aria-label="More actions" aria-haspopup="menu" title="More actions">${P.icon('more')}</button>`;
    if (o.stage === 'available') return `<div class="ownbar open"><div class="what"><b>Unclaimed</b>Claim it before you call so the team knows it is yours.</div>
      <button class="btn primary" data-act="claim">Claim this lead</button>${mgr ? '<button class="btn" data-act="assign">Assign</button>' : ''}</div>`;
    const since = o.claimed_at ? `Claimed ${esc(P.date(o.claimed_at))}` : '';
    const last = o.last_activity_at ? `last activity ${esc(P.ago(o.last_activity_at))}${o.last_activity_by_name && !o.is_mine ? ` by ${esc(o.last_activity_by_name)}` : ''}` : 'no activity logged yet';
    if (o.is_mine) return `<div class="ownbar"><div class="what"><b>Yours</b>${since}${since ? ', ' : ''}${last}</div>${stageSel()}
      <button class="btn primary" data-act="logTab">${P.icon('phone')}Log activity</button>${menu}</div>`;
    if (o.owner_id) return `<div class="ownbar"><div class="what"><b>${esc(o.owner_name)} owns this</b>${since}${since ? ', ' : ''}${last}.${mgr ? '' : ' Talk to them before calling anyone here.'}</div>
      ${mgr ? stageSel() + `<button class="btn" data-act="logTab">Log activity</button>${menu}` : ui.stage(o.stage)}</div>`;
    return `<div class="ownbar"><div class="what"><b>${esc(P.stageLabel(o.stage))}</b>${esc(o.outcome_reason || 'Not owned by anyone.')}</div>${mgr ? '<button class="btn" data-act="release">Reopen to pool</button>' : ''}</div>`;
  }
  function alerts(o) {
    const out = [];
    if (o.needs_review) out.push(`<div class="alert warn">${P.icon('alert')}<div class="grow"><b>Check this lead.</b> ${esc(o.review_reason || '')}${P.isMgr() ? `<div class="row" style="margin-top:8px"><button class="btn sm" data-act="reviewOne" data-a="publish">${o.stage === 'available' ? 'Publish to the pool' : 'Looks fine'}</button><button class="btn sm danger" data-act="reviewOne" data-a="archive">Archive</button></div>` : ''}</div></div>`);
    if (o.stale && (o.is_mine || P.isMgr())) out.push(`<div class="alert warn">${P.icon('clock')}<div class="grow">No activity in ${o.stale_days}+ days. Log a call, set a follow-up or release it so a teammate can work it.</div></div>`);
    const others = (o.company_opps || []).filter(x => x.owner_name && P.ACTIVE.includes(x.stage) && x.owner_name !== P.state.me.full_name);
    if (others.length) out.push(`<div class="alert warn">${P.icon('team')}<div class="grow">${esc([...new Set(others.map(x => x.owner_name))].join(', '))} ${others.length === 1 ? 'is' : 'are'} also working ${esc(o.company?.name || 'this company')}. Coordinate before you call.</div></div>`);
    if (o.superseded_by) out.push(`<div class="alert info">${P.icon('info')}<div class="grow">Follow-up continues in <a href="#/lead/${o.superseded_by.id}" data-lead="${o.superseded_by.id}">${esc(o.superseded_by.ref)}</a>.</div></div>`);
    const dup = o.project?.possible_duplicate;
    if (dup && P.isMgr()) out.push(`<div class="alert info">${P.icon('info')}<div class="grow">Looks like <b>${esc(dup.title)}</b>${dup.source_name ? ` (${esc(dup.source_name)})` : ''}${(dup.opps || []).length ? `: ${dup.opps.map(x => `<a href="#/lead/${x.id}" data-lead="${x.id}">${esc(x.ref)}</a>`).join(', ')}` : ''}. Archive one if they are the same job.</div></div>`);
    if (o.project?.match_note && (o.project.other_sources || []).length) out.push(`<div class="alert info">${P.icon('info')}<div class="grow">${esc(o.project.match_note)}. Also listed by: ${esc(o.project.other_sources.map(k => ({ sam: 'SAM.gov', usaspending: 'USAspending.gov', fdot: 'FDOT', orlando: 'City of Orlando permits', legacy: 'original pipeline', news: 'news' }[k] || k)).join(', '))}.</div></div>`);
    return out.join('');
  }

  function render(keepScroll) {
    const o = cur, p = o.project || {}, tab = P.state.leadTab || 'overview';
    const company = o.company?.name || p.owner_name || o.title;
    const nVisible = (o.timeline || []).filter(t => ['call', 'email', 'text', 'visit', 'meeting', 'note', 'quote', 'follow_up'].includes(t.kind)).length;
    const nContacts = (o.contacts || []).length + (p.pocs || []).filter(c => c.name || c.phone || c.email).length;
    const counts = { activity: nVisible, contacts: nContacts };
    const dl = p.deadline ? (() => { const n = P.dayDiff(p.deadline), open = ['bidding', 'upcoming'].includes(p.stage) && new Date(p.deadline) >= Date.now();
      return `<span class="${open && n <= 7 ? 'due-hot' : ''}">${P.icon('clock')}${p.stage === 'upcoming' ? 'Response due' : open ? 'Bids due' : 'Deadline'} ${esc(P.deadline(p))}${open ? ' · ' + esc(P.rel(n)) : ''}</span>`; })() : '';
    const head = P.dwHead({
      ref: `${esc(o.ref)} · ${esc(P.KIND[o.kind] || o.kind)}`,
      tools: o.project?.source_url ? `<a class="btn ghost sm desk-only" href="${P.url(p.source_url)}" target="_blank" rel="noopener">${P.icon('ext', 'sm')}Source</a>` : '',
      title: esc(company), sub: esc(p.title || o.title),
      meta: `${ui.prio(o.priority, true)}<span>${P.icon('pin')}${esc(P.place(p))}</span>${p.stage ? `<span>${esc(P.PSTAGE[p.stage] || p.stage)}</span>` : ''}${dl}`,
    });
    const tabs = `<div class="tabs" role="tablist" aria-label="Lead sections">${TABS.map(([k, t]) => `<button class="tab" role="tab" id="lt_${k}" aria-controls="lp_body" aria-selected="${tab === k}" data-act="leadTab" data-tab="${k}">${esc(t)}${counts[k] ? ` <span class="n">${counts[k]}</span>` : ''}</button>`).join('')}</div>`;
    const body = { overview, activity, contacts, project, source }[tab](o);
    P.drawer.set(`<div class="dw-head">${head}${ownbar(o)}${tabs}</div><div class="dw-body" id="lp_body" role="tabpanel" aria-labelledby="lt_${tab}">${alerts(o)}${body}</div>`, { keepScroll });
    P.state.log = { kind: 'call', outcome: null };
  }
  P.act.leadTab = (el) => { P.state.leadTab = el.dataset.tab; render(); document.getElementById('lt_' + el.dataset.tab)?.focus(); };
  P.act.logTab = () => { P.state.leadTab = 'activity'; render(); setTimeout(() => document.getElementById('lg_body')?.focus(), 30); };

  // ---------------------------------------------------------------- tabs
  function nextCard(o) {
    const edit = canWork(o);
    if (o.stage === 'available') return o.next_action ? `<div class="nextcard">${P.icon('flag')}<div class="grow"><div class="small muted">Suggested first step</div><b>${esc(o.next_action)}</b></div></div>` : '';
    if (!o.full_access) return '';
    if (!o.next_action && !o.next_action_due) return edit && P.ACTIVE.concat(['nurture']).includes(o.stage) ? `<div class="nextcard">${P.icon('flag')}<div class="grow"><div class="small muted">Next action</div><span class="muted">None set. Leads without a follow-up date do not show up on Today.</span></div><button class="btn sm" data-act="setFollowUp">Set follow-up</button></div>` : '';
    const n = o.next_action_due ? P.dayDiff(o.next_action_due) : null;
    return `<div class="nextcard ${n !== null && n <= 0 && P.ACTIVE.includes(o.stage) ? 'hot' : ''}">${P.icon('flag')}<div class="grow"><div class="small muted">Next action</div><b>${esc(o.next_action || 'Follow up')}</b>${o.next_action_due ? `<div style="margin-top:4px">${ui.due(o.next_action_due)} <span class="small muted">${esc(P.date(o.next_action_due, { weekday: true }))}</span></div>` : ''}</div>
      ${edit ? '<button class="btn sm" data-act="setFollowUp">Change</button>' : ''}</div>`;
  }
  function overview(o) {
    const p = o.project || {}, r = o.priority_reasons || {};
    const approach = P.APPROACH[o.approach];
    const facts = [
      ['Location', `${p.location_text ? esc(p.location_text) + '<div class="sub">' : ''}${esc([p.city, p.county ? p.county + ' County' : '', p.zip, p.region && p.region !== 'Unknown' ? p.region : ''].filter(Boolean).join(' · ') || 'Location not recorded')}${p.location_text ? '</div>' : ''}`],
      p.category && ['Project type', esc(p.category)],
      ['Project stage', `${esc(P.PSTAGE[p.stage] || p.stage || '')}${p.status_text ? `<div class="sub">${esc(p.status_text)}</div>` : ''}`],
      p.deadline && [p.stage === 'upcoming' ? 'Response due' : 'Bid deadline', `${esc(P.deadline(p))}${p.deadline_note ? `<div class="sub">${esc(p.deadline_note)}</div>` : ''}`],
      ['Project value', p.project_value ? `${esc(P.money(p.project_value))} <span class="sub">whole project, not Speedy's share</span>` : p.value_label ? esc(p.value_label) : P.unknown('Not public')],
      ['Owner or agency', p.owner_name ? esc(p.owner_name) : P.unknown()],
      p.winner_name && [p.winner_status === 'low_bidder' ? 'Apparent low bidder' : p.winner_status === 'intended' ? 'Intended award' : 'Awarded to', `${esc(p.winner_name)}${p.winner_amount ? ' at ' + esc(P.money(p.winner_amount)) : ''}${p.winner_status === 'low_bidder' ? '<div class="sub">Low bid only, not a final award.</div>' : ''}`],
      o.full_access && ['Speedy quote', o.quote_amount != null ? `${esc(P.money(o.quote_amount))}${o.quote_sent_at ? `<div class="sub">Sent ${esc(P.date(o.quote_sent_at))}</div>` : ''}` : P.unknown('Not quoted yet')],
      o.expected_work_date && ['Expected work', esc(P.date(o.expected_work_date))],
    ].filter(Boolean);
    const confirmed = o.services_confirmed || [], likely = (o.services || []).filter(s => !confirmed.includes(s));
    const ev = Array.isArray(p.evidence) ? p.evidence : [];
    const documented = ev.filter(e => e.confidence === 'documented'), inferred = ev.filter(e => e.confidence !== 'documented');
    const svc = confirmed.length || likely.length || (p.scope_evidence || []).length || ev.length || o.speedy_scope || o.scope_confirmed_note;
    const evRow = (e) => `<li><div><b class="strong">${esc(e.term)}</b>${(e.services || []).length ? ` <span class="small muted">→ ${esc(e.services.slice(0, 3).join(', '))}</span>` : ''}</div>
      ${e.snippet ? `<q class="snip">${esc(e.snippet)}</q>` : ''}
      <div class="small faint">${esc([e.doc || '', e.field ? 'in the ' + e.field : '', e.page ? 'page ' + e.page : ''].filter(Boolean).join(', '))}${e.url ? ` · <a href="${P.url(e.url)}" target="_blank" rel="noopener">Open</a>` : ''}</div></li>`;
    const others = (o.company_opps || []).length + (o.project_opps || []).length + (o.company_contact_log || []).length;
    return `${nextCard(o) ? `<div class="panel">${nextCard(o)}</div>` : ''}
      <div class="panel"><h3>Key facts</h3><dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></div>
      ${approach && (P.isGov(p) || o.kind === 'gov_bid' || P.ROUTE[o.approach] === 'direct') ? `<div class="panel"><h3>How to pursue it ${ui.route(o.approach)}</h3><p><b>${esc(approach[0])}.</b> ${esc(approach[1])}</p>${o.approach_note ? `<p class="small muted">From the research: ${esc(o.approach_note)}</p>` : ''}</div>`
        : approach ? `<div class="panel"><h3>How to pursue it</h3><p><b>${esc(approach[0])}.</b> ${esc(approach[1])}</p>${o.approach_note ? `<p class="small muted">${esc(o.approach_note)}</p>` : ''}</div>` : ''}
      ${svc ? `<div class="panel"><h3>Relevant services</h3>
        ${confirmed.length || o.scope_confirmed_note ? `<div class="callout ok"><b>Confirmed by the contact:</b> ${esc(confirmed.join(', '))}${o.scope_confirmed_note ? (confirmed.length ? '. ' : '') + esc(o.scope_confirmed_note) : ''}</div>` : ''}
        ${likely.length ? `<div class="chips" style="margin-bottom:8px">${likely.map(s => `<span class="badge outline">${esc(s)}</span>`).join('')}</div><p class="small muted" style="margin-top:-2px">Likely services, not yet confirmed with a contact.</p>` : ''}
        ${documented.length ? `<div class="callout"><b>Documented in the source</b> (project scope, not a request for Speedy pricing):<ul class="evidence">${documented.map(evRow).join('')}</ul></div>` : ''}
        ${inferred.length ? `<div class="callout dash"><b>Inferred from the project type</b> (not stated in the source):<ul class="evidence">${inferred.map(evRow).join('')}</ul></div>` : ''}
        ${!ev.length && (p.scope_evidence || []).length ? `<div class="callout"><b>The source describes:</b> ${esc(p.scope_evidence.join(', '))}. This is project scope, not a request for Speedy pricing.</div>` : ''}
        ${o.speedy_scope ? `<div class="callout dash"><b>Our read (inferred):</b> ${esc(o.speedy_scope)}</div>` : ''}</div>` : ''}
      <div class="panel"><h3>Why it is ${esc(o.priority || 'ranked')}</h3>
        ${r.summary ? `<p class="small">${esc(r.summary)}.</p>` : ''}
        <div class="factor"><span>Fit with Speedy's work</span><b>${o.fit_score ?? '?'}/100</b><div class="scorebar"><i style="width:${o.fit_score || 0}%"></i></div></div>
        <div class="factor"><span>Urgency</span><b>${o.urgency_score ?? '?'}/100</b><div class="scorebar"><i style="width:${o.urgency_score || 0}%;background:var(--hot)"></i></div></div>
        ${(r.fit || []).length || (r.urgency || []).length ? `<details class="plain"><summary>How the score is made</summary><div style="margin-top:10px">
          ${(r.fit || []).map(x => `<div class="factor"><span>${esc(x.factor)}: ${esc(x.text)}</span><b>${x.points}/${x.max}</b></div>`).join('')}
          ${(r.urgency || []).map(x => `<p class="small">${esc(x.text)}</p>`).join('')}
          <p class="small muted">Fit and urgency are scored separately; a close deadline alone does not make a lead Hot.${o.legacy_priority ? ` The original pipeline ranked this ${esc(o.legacy_priority)}.` : ''}</p></div></details>` : ''}</div>
      ${others ? coordination(o) : ''}`;
  }
  function coordination(o) {
    const co = o.company_opps || [], pj = o.project_opps || [], log = o.company_contact_log || [];
    const line = (x) => `<div class="mini" data-lead="${x.id}" style="padding-left:0;padding-right:0"><div class="t"><a class="ell" href="#/lead/${x.id}" data-lead="${x.id}">${esc(x.ref)} · ${esc(x.company_name || x.project_title || x.title)}</a></div>
      <div class="s">${x.owner_name ? esc(x.owner_name) : 'Unclaimed'} · ${esc(P.stageLabel(x.stage))}${x.last_activity_at ? ' · last activity ' + esc(P.ago(x.last_activity_at)) : ''}</div><div class="r">${P.icon('right', 'sm')}</div></div>`;
    return `<div class="panel"><h3>Coordination</h3>
      ${log.length ? `<p class="small muted" style="margin-bottom:6px">Recent contact with ${esc(o.company?.name || 'this company')}</p>${log.slice(0, 5).map(l => `<p class="small" style="margin-bottom:4px">${esc(P.date(l.at))}: ${esc(l.user_name || 'Someone')} ${esc({ call: 'called', email: 'emailed', text: 'texted' }[l.kind] || 'met')} ${esc(l.contact_name || '')} on ${esc(l.ref || 'another lead')}</p>`).join('')}` : ''}
      ${co.length ? `<p class="small muted" style="margin:10px 0 0">Other opportunities with ${esc(o.company?.name || 'this company')}</p>${co.map(line).join('')}` : ''}
      ${pj.length ? `<p class="small muted" style="margin:10px 0 0">Other opportunities on this project</p>${pj.map(line).join('')}` : ''}</div>`;
  }

  function activity(o) {
    let composer = '';
    if (o.stage === 'available' && !P.isMgr()) composer = `<div class="callout" style="margin-bottom:20px">Claim this lead to log calls and notes. <button class="linkbtn" data-act="claim">Claim it now</button></div>`;
    else if (!o.full_access) composer = `<div class="callout" style="margin-bottom:20px">${esc(o.owner_name || 'The owner')} owns this lead. Call and note details are visible to the owner and managers.</div>`;
    else if (!o.owner_id) composer = `<div class="composer" id="logbox"><div class="lbl">Research note</div><p class="small muted">Managers can add research to unowned leads. Assign it before logging calls.</p>
      <label class="field"><span class="sr">Note</span><textarea id="lg_body" placeholder="What you found and where"></textarea></label><div class="savebar"><button class="btn primary" data-act="saveLog" data-kind="note" id="lg_save">Save note</button></div></div>`;
    else composer = composerHtml(o);
    return composer + `<div class="panel"><h3>History</h3>${timeline(o)}</div>`;
  }
  function composerHtml(o) {
    const contacts = (o.contacts || []).map(c => `<option value="${c.id}">${esc(c.name || c.phone || c.email)}${c.title ? ' (' + esc(c.title) + ')' : ''}</option>`).join('');
    const stages = (P.state.me.stages || []).filter(s => s.key !== 'available').map(s => `<option value="${s.key}" ${s.key === o.stage ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
    const svc = [...new Set(P.SERVICES.concat(o.services || []))];
    return `<div class="composer" id="logbox">
      <div class="seg" role="group" aria-label="Type of activity" style="margin-bottom:12px">${[['call', 'Call'], ['email', 'Email'], ['text', 'Text'], ['visit', 'Visit'], ['note', 'Note']].map(([k, t], i) => `<button type="button" data-act="logKind" data-kind="${k}" aria-pressed="${i === 0}">${t}</button>`).join('')}</div>
      <div id="lg_outwrap"><div class="lbl">Outcome</div><div class="chips" id="lg_outcomes" role="group" aria-label="Outcome" style="margin-bottom:12px">${P.OUTCOMES.map(([k, t]) => `<button type="button" class="chip" data-act="logOutcome" data-outcome="${k}" aria-pressed="false">${esc(t)}</button>`).join('')}</div></div>
      <label class="field"><span>Notes</span><textarea id="lg_body" placeholder="Who you spoke to, what they need, what you promised"></textarea></label>
      ${contacts ? `<label class="field"><span>Contact <span class="faint">(optional)</span></span><select id="lg_contact"><option value="">Not a listed contact</option>${contacts}</select></label>` : ''}
      <div class="grid2">
        <label class="field"><span>Next action</span><input type="text" id="lg_next" value="${esc(o.next_action || '')}" placeholder="Send pricing, call back the PM"></label>
        <label class="field"><span>Follow-up date</span><input type="date" id="lg_due" value="${esc(o.next_action_due || '')}"></label>
      </div>
      <div class="chips" style="margin:-6px 0 12px">${QUICK.map(([n, t]) => `<button type="button" class="chip" data-act="quickDue" data-days="${n}">${t}</button>`).join('')}</div>
      <details class="more" id="lg_more"><summary>${P.icon('right')}Stage, services, quote and outcome</summary>
        <label class="field"><span>Stage</span><select id="lg_stage">${stages}</select></label>
        <div class="lbl">Services the contact confirmed</div>
        <div class="chips" style="margin-bottom:14px">${svc.map(s => `<button type="button" class="chip" data-act="toggleChip" data-svc="${esc(s)}" aria-pressed="${(o.services_confirmed || []).includes(s)}">${esc(s)}</button>`).join('')}</div>
        <label class="field"><span>Scope they described <span class="faint">(optional)</span></span><input type="text" id="lg_scope" value="${esc(o.scope_confirmed_note || '')}" placeholder="40 cores, 6 in., 12 in. slab; GPR first"></label>
        <div class="grid2">
          <label class="field"><span>Speedy quote amount ($)</span><input type="number" id="lg_quote" min="0" step="any" value="${o.quote_amount ?? ''}"><span class="help">Speedy's price, not the project value.</span></label>
          <label class="field"><span>Quote sent on</span><input type="date" id="lg_qdate" value="${esc(o.quote_sent_at || '')}"></label>
          <label class="field"><span>Expected work date</span><input type="date" id="lg_work" value="${esc(o.expected_work_date || '')}"></label>
          <label class="field"><span>Outcome reason</span><input type="text" id="lg_reason" value="${esc(o.outcome_reason || '')}" placeholder="Needed for Won, Lost or Disqualified"></label>
        </div>
      </details>
      <div class="savebar"><button class="btn primary" data-act="saveLog" id="lg_save">Save call</button><span class="hint" id="lg_hint">${o.stage === 'claimed' ? 'Saving a call, email, text or visit moves this to Contacted.' : ''}</span></div>
    </div>`;
  }
  const KIND_LABEL = { call: 'Call', email: 'Email', text: 'Text', visit: 'Visit', meeting: 'Meeting', note: 'Note', claim: 'Claimed', release: 'Released', assign: 'Assigned', quote: 'Quote',
    follow_up: 'Follow-up set', contact: 'Contact', system: 'System', refresh: 'Source refresh', import: 'Imported', review: 'Review', stage: 'Stage' };
  function timeline(o) {
    const fmt = (v) => v == null || v === '' ? 'none' : Array.isArray(v) ? (v.join(', ') || 'none') : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? P.date(v) : String(v);
    const items = (o.timeline || []).map(t => {
      const cls = ['call', 'email', 'text', 'visit', 'meeting'].includes(t.kind) ? 'contact-kind' : t.to_stage ? 'stage-kind' : ['system', 'refresh', 'import', 'review', 'claim', 'release', 'assign'].includes(t.kind) ? 'sys-kind' : '';
      const when = `<div class="when">${esc(P.dateTime(t.at))} · ${esc(t.user_name)}</div>`;
      if (t.hidden) return `<li class="${cls}"><span class="pt"></span>${when}<div class="muted small">${esc(KIND_LABEL[t.kind] || t.kind)} logged. Details are visible to the owner and managers.</div></li>`;
      const ch = t.data?.changes ? Object.entries(t.data.changes).filter(([k]) => k !== 'stage').map(([k, [a, b]]) => `${k.replace(/_/g, ' ')}: ${fmt(a)} → ${fmt(b)}`).join('; ') : '';
      const label = t.kind === 'note' && !t.body && t.to_stage ? 'Stage changed' : KIND_LABEL[t.kind] || t.kind;
      return `<li class="${cls}"><span class="pt"></span>${when}
        <div class="what">${esc(label)}${t.outcome ? ': ' + esc((P.OUTCOMES.find(x => x[0] === t.outcome) || [0, t.outcome.replace(/_/g, ' ')])[1]) : ''}${t.to_stage ? ` <span class="badge outline">${esc(P.stageLabel(t.from_stage || ''))} → ${esc(P.stageLabel(t.to_stage))}</span>` : ''}${t.contact_name ? ` <span class="small muted">with ${esc(t.contact_name)}</span>` : ''}</div>
        ${t.body ? `<div class="body">${esc(t.body)}</div>` : ''}${ch ? `<div class="chg">${esc(ch)}</div>` : ''}</li>`;
    }).join('');
    return items ? `<ul class="timeline">${items}</ul>` : '<p class="muted">Nothing logged yet.</p>';
  }

  function contacts(o) {
    const canEdit = o.full_access && o.company && (o.owner_id || P.isMgr()) && (o.is_mine || P.isMgr());
    const c0 = o.company;
    const list = (o.contacts || []).map(c => `<div class="contact">
        <div class="who"><b>${esc(c.name || 'Main line')}</b>${c.title ? ` <span class="small muted">${esc(c.title)}</span>` : ''}
          ${c.phone ? `<div>${esc(c.phone)}</div>` : ''}${c.email ? `<div class="small">${esc(c.email)}</div>` : ''}${c.web && !c.phone && !c.email ? `<div class="small">${esc(c.web)}</div>` : ''}
          <div class="small ${c.verified ? '' : 'faint'}" style="margin-top:2px">${c.verified ? `${P.icon('check', 'sm')} Verified by ${esc(c.verified_by_name || 'the team')} ${esc(P.date(c.verified_at))}` : c.source === 'salesperson' ? 'Added by the team, not verified' : 'From research, not confirmed by a call'}</div></div>
        <div class="acts">${c.phone ? `<a class="btn sm primary" href="${P.tel(c.phone)}">${P.icon('phone', 'sm')}Call</a>` : ''}${c.email ? `<a class="btn sm" href="mailto:${esc(c.email)}">${P.icon('mail', 'sm')}Email</a>` : ''}
          ${canEdit ? `<button class="btn sm ghost" data-act="editContact" data-id="${c.id}">Edit</button>` : ''}</div></div>`).join('');
    const pocs = (o.project?.pocs || []).filter(c => c.name || c.email || c.phone || c.web).map(c => `<div class="contact"><div class="who"><b>${esc(c.name || 'Agency contact')}</b>${c.title ? ` <span class="small muted">${esc(c.title)}</span>` : ''}
        ${c.phone ? `<div>${esc(c.phone)}</div>` : ''}${c.email ? `<div class="small">${esc(c.email)}</div>` : ''}${c.web ? `<div class="small"><a href="${P.url(c.web)}" target="_blank" rel="noopener">${esc(c.web.replace(/^https?:\/\//, '').slice(0, 60))}</a></div>` : ''}<div class="small faint">From the notice</div></div>
        <div class="acts">${c.phone ? `<a class="btn sm" href="${P.tel(c.phone)}">${P.icon('phone', 'sm')}Call</a>` : ''}${c.email ? `<a class="btn sm" href="mailto:${esc(c.email)}">${P.icon('mail', 'sm')}Email</a>` : ''}</div></div>`).join('');
    const site = c0?.website ? `<a href="${esc(/^https?:/.test(c0.website) ? c0.website : 'https://' + c0.website)}" target="_blank" rel="noopener">${esc(c0.website)}</a>` : '';
    return `${c0 ? `<div class="panel"><h3>${P.icon('building')}${esc(c0.name)}${canEdit ? `<span class="tools"><button class="btn sm" data-act="addContact">${P.icon('plus', 'sm')}Add contact</button></span>` : ''}</h3>
        <dl class="facts" style="margin-bottom:6px">${c0.kind ? `<dt>Company type</dt><dd>${esc({ contractor: 'Builder or contractor', developer: 'Owner or developer', agency: 'Public agency' }[c0.kind] || c0.kind)}</dd>` : ''}
          ${c0.hq ? `<dt>Based in</dt><dd>${esc(c0.hq)}</dd>` : ''}${c0.phone ? `<dt>Main line</dt><dd><a href="${P.tel(c0.phone)}">${esc(c0.phone)}</a></dd>` : ''}${site ? `<dt>Website</dt><dd>${site}</dd>` : ''}</dl>
        ${list || '<p class="muted small">No phone or email on file yet. Use the website or the source link to find the estimator, then add them here.</p>'}</div>`
      : '<div class="panel"><p class="muted">No company is linked yet. The agency contacts from the notice are below.</p></div>'}
      ${pocs ? `<div class="panel"><h3>Agency contacts</h3>${pocs}</div>` : ''}`;
  }

  function project(o) {
    const p = o.project;
    if (!p) return '<p class="muted">No project record is linked to this lead.</p>';
    const bidders = (p.bidders || []).length > 1 ? `<details class="plain" style="margin-top:8px"><summary>All ${p.bidders.length} bidders</summary><ol class="small" style="margin:8px 0 0;padding-left:20px">${p.bidders.map(b => `<li>${esc(b.name)}${b.amount ? ' · ' + esc(P.money(b.amount)) : ''}</li>`).join('')}</ol></details>` : '';
    return `<div class="panel"><h3>Project details</h3><dl class="facts">
        <dt>Project</dt><dd>${esc(p.title)}</dd>
        <dt>Owner or agency</dt><dd>${p.owner_name ? esc(p.owner_name) : P.unknown()}${p.level ? `<div class="sub">${esc(p.level)}</div>` : ''}</dd>
        <dt>Location</dt><dd>${esc(p.location_text || '')}${p.location_text ? '<br>' : ''}<span class="sub">${esc(P.place(p))}</span></dd>
        <dt>Stage</dt><dd>${esc(P.PSTAGE[p.stage] || p.stage)}${p.status_text ? `<div class="sub">${esc(p.status_text)}</div>` : ''}</dd>
        <dt>Value</dt><dd>${p.project_value ? esc(P.money(p.project_value)) + ' <span class="sub">whole project</span>' : p.value_label ? esc(p.value_label) : P.unknown('Not public')}${p.size_note ? `<div class="sub">${esc(p.size_note)}</div>` : ''}</dd>
        ${p.deadline ? `<dt>${p.stage === 'upcoming' ? 'Response due' : 'Bid deadline'}</dt><dd>${esc(P.deadline(p))}${p.deadline_note ? `<div class="sub">${esc(p.deadline_note)}</div>` : ''}</dd>` : ''}
        ${p.solicitation_no ? `<dt>Solicitation</dt><dd>${esc(p.solicitation_no)}</dd>` : ''}
        ${p.set_aside ? `<dt>Bid rules</dt><dd>${esc(p.set_aside)}</dd>` : ''}
        ${p.winner_name ? `<dt>${p.winner_status === 'low_bidder' ? 'Apparent low bidder' : p.winner_status === 'intended' ? 'Intended award' : 'Awarded to'}</dt><dd>${esc(p.winner_name)}${p.winner_amount ? ' at ' + esc(P.money(p.winner_amount)) : ''}${p.winner_as_of ? `<div class="sub">As of ${esc(P.date(p.winner_as_of))}${p.winner_status === 'low_bidder' ? '. Low bid only; not final until the agency posts the award.' : ''}</div>` : ''}${p.winner_source_url ? `<div class="sub"><a href="${P.url(p.winner_source_url)}" target="_blank" rel="noopener">Bid results</a></div>` : ''}</dd>` : ''}
      </dl>${bidders}</div>
      ${p.source_summary ? `<div class="panel"><h3>From the source</h3><p>${esc(p.source_summary)}</p></div>` : ''}
      ${(o.also_covers || []).length ? `<div class="panel"><h3>Also covers</h3>${o.also_covers.map(x => `<p class="small">${esc(x.title)}${x.solicitation_no ? ' (' + esc(x.solicitation_no) + ')' : ''}${x.winner_name ? `: ${esc(x.winner_name)}` : ''} ${x.source_url ? `<a href="${P.url(x.source_url)}" target="_blank" rel="noopener">source</a>` : ''}</p>`).join('')}</div>` : ''}
      ${o.legacy ? `<div class="panel"><h3>Original pipeline research</h3><p class="small">${esc(o.legacy.pitch || o.legacy.fit || '')}</p>${o.legacy.dateText ? `<p class="small">${esc(o.legacy.dateText)}</p>` : ''}${o.legacy.nextAction ? `<p class="small muted">Next step then: ${esc(o.legacy.nextAction)}</p>` : ''}</div>` : ''}`;
  }

  function source(o) {
    const p = o.project || {};
    const verified = p.last_verified_at ? esc(P.dateTime(p.last_verified_at)) : P.unknown(p.imported_at ? `Not re-checked since import on ${P.date(p.imported_at)}` : 'Not verified yet');
    const check = ['failed', 'missing'].includes(p.verify_status) ? `<div class="sub" style="color:var(--danger)">${p.verify_status === 'missing' ? 'The source no longer lists it' : 'The last check failed'} (${esc(P.dateTime(p.last_checked_at))}). Details may be out of date.</div>` : '';
    const changes = (p.recent_changes || []);
    const own = (o.ownership || []);
    return `<div class="panel"><h3>Source</h3><dl class="facts">
        <dt>Where it came from</dt><dd>${esc(p.source_label || p.source_name || 'Not recorded')}${p.source_url ? `<div><a href="${P.url(p.source_url)}" target="_blank" rel="noopener">${P.icon('ext', 'sm')} Open the source</a></div>` : ''}</dd>
        <dt>Published</dt><dd>${p.published_at ? esc(P.date(p.published_at, { year: true })) : P.unknown()}</dd>
        <dt>Found by the portal</dt><dd>${p.discovered_at ? esc(P.date(p.discovered_at, { year: true })) : P.unknown()}${p.discovered_note ? `<div class="sub">${esc(p.discovered_note)}</div>` : ''}</dd>
        <dt>Last verified</dt><dd>${verified}${check}<div class="sub">Verified means a refresh read it successfully from the source.</div></dd>
        <dt>Status</dt><dd>${ui.stage(o.stage)}${o.outcome_reason && o.full_access ? `<div class="sub">${esc(o.outcome_reason)}</div>` : ''}</dd>
        <dt>Added to the portal</dt><dd>${esc(P.date(o.created_at, { year: true }))}</dd>
      </dl></div>
      <div class="panel"><h3>Source changes</h3>${changes.length ? `<ul class="timeline">${changes.map(c => `<li class="${c.material ? 'stage-kind' : 'sys-kind'}"><span class="pt"></span><div class="when">${esc(P.dateTime(c.at))}${c.material ? '' : ' · minor'}</div>
        <div><b class="strong">${esc(String(c.field).replace(/_/g, ' '))}</b>: ${c.old ? `${esc(String(c.old).slice(0, 90))} → ` : ''}${esc(String(c.new).slice(0, 160))}</div></li>`).join('')}</ul>` : '<p class="muted small">No changes recorded by refreshes.</p>'}</div>
      <div class="panel"><h3>Ownership history</h3>${own.length ? `<ul class="timeline">${own.map(h => `<li class="sys-kind"><span class="pt"></span><div class="when">${esc(P.dateTime(h.at))} · by ${esc(h.by)}</div>
        <div>${esc(h.action[0].toUpperCase() + h.action.slice(1))}${h.from ? ' from ' + esc(h.from) : ''}${h.to ? ' to ' + esc(h.to) : ''}</div>${h.reason ? `<div class="chg">${esc(h.reason)}</div>` : ''}</li>`).join('')}</ul>` : '<p class="muted small">Nobody has claimed it yet.</p>'}</div>`;
  }

  // ---------------------------------------------------------------- actions (shared with lists)
  P.claimLead = (id, btn) => P.busy(btn, async () => {
    let r = await P.rpc('claim_opportunity', { p_id: id });
    if (!r.ok && r.reason === 'company_conflict') {
      const who = r.owners.map(x => `<b>${esc(x.name)}</b> (${esc(x.ref)}, ${esc(P.stageLabel(x.stage))}${x.last_activity_at ? ', last activity ' + esc(P.ago(x.last_activity_at)) : ''})`).join('<br>');
      const ok = await P.confirm('A teammate works this company', `${who}<br><br>You can still claim this opportunity. Check with them first so you do not both call the same person.`, 'Claim anyway');
      if (!ok) return;
      r = await P.rpc('claim_opportunity', { p_id: id, p_ack_company: true });
    }
    const inPanel = P.drawer.open && P.drawer.kind === 'lead' && P.drawer.key === id;
    if (!r.ok) { P.toast(r.message || 'Could not claim this lead.', 'error'); await Promise.all([P.afterChange(), inPanel && P.showLead(id, { force: true })]); return; }
    P.toast(r.already_yours ? 'Already yours.' : 'Claimed. It is in your pipeline.');
    await Promise.all([P.afterChange(), inPanel && P.showLead(id, { force: true })]);
  }, 'Claiming…');
  P.act.claim = (btn) => P.claimLead(cur.id, btn);

  // stage changes from the panel or the board; asks for what the database requires
  P.moveStage = async (o, to) => {
    if (!to || to === o.stage) return false;
    const save = async (extra) => {
      const r = await P.rpc('log_activity', { p_id: o.id, p: { kind: 'note', stage: to, ...extra } });
      if (r && r.ok === false) throw new Error(r.message);
    };
    const label = P.stageLabel(to);
    let done = false;
    if (['won', 'lost', 'disqualified'].includes(to)) {
      done = !!await P.dialog({ title: `Mark as ${label.toLowerCase()}`, ok: `Mark ${label.toLowerCase()}`,
        fields: [{ name: 'reason', label: to === 'won' ? 'What won it' : to === 'lost' ? 'Why it was lost' : 'Why it is not a fit', type: 'textarea', required: true, value: o.outcome_reason || '',
                   placeholder: to === 'won' ? 'Price, relationship, schedule' : to === 'lost' ? 'Went to another cutter, project cancelled, price' : 'Wrong work type, outside our area' },
                 ...(to === 'won' ? [{ name: 'quote', label: 'Speedy quote amount ($)', type: 'number', value: o.quote_amount ?? '' }] : [])],
        onOk: async (v) => save({ outcome_reason: v.reason, ...(v.quote ? { quote_amount: v.quote } : {}) }) });
    } else if (to === 'follow_up') {
      done = !!await P.dialog({ title: 'Move to Follow up', ok: 'Move',
        fields: [{ name: 'due', label: 'Follow-up date', type: 'date', required: true, value: o.next_action_due || '', quick: QUICK },
                 { name: 'next', label: 'Next action', value: o.next_action || '', placeholder: 'Call the PM for a decision' }],
        onOk: async (v) => save({ next_action_due: v.due, next_action: v.next }) });
    } else if (to === 'quote_needed') {
      done = !!await P.dialog({ title: 'Request a quote', body: '<p class="muted">Managers get a notice to price it.</p>', ok: 'Request quote',
        fields: [{ name: 'body', label: 'What needs pricing', type: 'textarea', placeholder: 'Services, quantities, slab or wall thickness, access, schedule, who to send it to' }],
        onOk: async (v) => save({ body: v.body }) });
    } else {
      try { await save({}); done = true; } catch (e) { P.toast(e.message, 'error'); }
    }
    if (!done) return false;
    P.toast(to === 'quote_needed' ? 'Quote requested. Managers have been notified.' : `Moved to ${label}.`);
    const inPanel = P.drawer.open && P.drawer.kind === 'lead' && P.drawer.key === o.id;
    await Promise.all([P.afterChange(), inPanel && P.showLead(o.id, { force: true })]);
    return true;
  };
  document.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-stage-select]') || !cur) return;
    const sel = e.target, to = sel.value;
    sel.disabled = true;
    const moved = await P.moveStage(cur, to);
    if (!moved && sel.isConnected) { sel.value = cur.stage; sel.disabled = false; }
  });

  P.act.leadMenu = (el) => {
    const o = cur, mgr = P.isMgr(), active = P.ACTIVE.includes(o.stage);
    P.menu(el, [
      canWork(o) && { label: 'Set follow-up', icon: 'cal', run: () => P.act.setFollowUp() },
      canWork(o) && active && !['quote_needed', 'quote_sent'].includes(o.stage) && { label: 'Request a quote', icon: 'quote', run: () => P.moveStage(o, 'quote_needed') },
      o.full_access && o.company && canWork(o) && { label: 'Add contact', icon: 'plus', run: () => P.act.addContact() },
      o.project?.source_url && { label: 'Open the source', icon: 'ext', run: () => window.open(o.project.source_url, '_blank', 'noopener') },
      '-',
      mgr && { label: o.owner_id ? 'Reassign' : 'Assign', icon: 'swap', run: () => P.act.assign() },
      (o.is_mine && (active || o.stage === 'nurture')) || (mgr && o.owner_id) ? { label: mgr && !o.is_mine ? 'Release to the pool' : 'Release', icon: 'release', danger: true, run: () => P.act.release() } : null,
    ].filter((x, i, a) => x && !(x === '-' && (i === 0 || i === a.length - 1))), { label: 'Lead actions' });
  };
  P.act.setFollowUp = () => P.dialog({
    title: 'Set follow-up', ok: 'Save follow-up',
    fields: [{ name: 'next', label: 'Next action', value: cur.next_action || '', placeholder: 'Send pricing, call back the PM' },
             { name: 'due', label: 'Follow-up date', type: 'date', value: cur.next_action_due || '', quick: QUICK }],
    onOk: async (v) => { const r = await P.rpc('log_activity', { p_id: cur.id, p: { kind: 'follow_up', next_action: v.next, next_action_due: v.due || null } }); if (r.ok === false) throw new Error(r.message); },
  }).then(v => v && reload('Follow-up saved.'));
  P.act.release = () => P.dialog({
    title: cur.is_mine ? 'Release this lead' : 'Release to the pool', ok: 'Release', danger: true,
    body: '<p>It goes back to Available for anyone to claim. Its history and notes stay with it.</p>',
    fields: [{ name: 'reason', label: 'Why', type: 'text', placeholder: 'Not a fit for me, wrong region, no answer after 5 tries' }],
    onOk: async (v) => { await P.rpc('release_opportunity', { p_id: cur.id, p_reason: v.reason }); },
  }).then(v => v && reload('Released to the pool.'));
  P.act.assign = async () => {
    let users;
    try { users = (P.state.users = await P.rpc('list_users')).filter(u => u.active); } catch (e) { P.toast(e.message, 'error'); return; }
    P.dialog({
      title: cur.owner_id ? 'Reassign' : 'Assign', ok: 'Save',
      fields: [{ name: 'user', label: 'Owner', type: 'select', value: cur.owner_id || '', options: [['', 'Nobody (back to the pool)'], ...users.map(u => [u.id, `${u.full_name || u.email} (${u.open} open)`])] },
               { name: 'reason', label: 'Note for the history', type: 'text' }],
      onOk: async (v) => { const r = await P.rpc('assign_opportunity', { p_id: cur.id, p_user: v.user || null, p_reason: v.reason }); if (r && r.ok === false) throw new Error(r.message); },
    }).then(v => v && reload('Ownership updated.'));
  };
  P.act.logKind = (el) => {
    P.state.log.kind = el.dataset.kind;
    el.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === el));
    document.getElementById('lg_outwrap').classList.toggle('hidden', el.dataset.kind === 'note');
    document.getElementById('lg_save').textContent = 'Save ' + el.textContent.toLowerCase();
  };
  P.act.logOutcome = (el) => {
    const on = el.getAttribute('aria-pressed') !== 'true';
    el.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', 'false'));
    el.setAttribute('aria-pressed', on);
    P.state.log.outcome = on ? el.dataset.outcome : null;
    const st = document.getElementById('lg_stage');
    if (on && st) {
      const map = { quote_requested: 'quote_needed', meeting_set: 'qualified' };
      if (map[el.dataset.outcome]) { st.value = map[el.dataset.outcome]; document.getElementById('lg_more').open = true; }
      if (el.dataset.outcome === 'wrong_number') document.getElementById('lg_hint').textContent = 'Tip: fix or remove the wrong number on the Contacts tab.';
    }
  };
  P.act.quickDue = (el) => { document.getElementById('lg_due').value = P.addDays(Number(el.dataset.days)); el.parentElement.querySelectorAll('.chip').forEach(b => b.setAttribute('aria-pressed', b === el)); };
  P.act.toggleChip = (el) => el.setAttribute('aria-pressed', el.getAttribute('aria-pressed') !== 'true');
  P.act.saveLog = (btn) => P.busy(btn, async () => {
    const g = (id) => document.getElementById(id);
    const kind = btn.dataset.kind || P.state.log.kind;
    const p = { kind, body: g('lg_body')?.value || '' };
    if (cur.owner_id) {
      Object.assign(p, { outcome: kind === 'note' ? null : P.state.log.outcome, contact_id: g('lg_contact')?.value || null,
        next_action: g('lg_next').value, next_action_due: g('lg_due').value || null });
      if (g('lg_more').open || g('lg_stage').value !== cur.stage) {
        Object.assign(p, {
          stage: g('lg_stage').value !== cur.stage ? g('lg_stage').value : null,
          services_confirmed: [...document.querySelectorAll('#lg_more [data-svc][aria-pressed="true"]')].map(b => b.dataset.svc),
          scope_confirmed_note: g('lg_scope').value, quote_amount: g('lg_quote').value || null, quote_sent_at: g('lg_qdate').value || null,
          expected_work_date: g('lg_work').value || null, outcome_reason: g('lg_reason').value,
        });
      }
    }
    if (['won', 'lost', 'disqualified'].includes(p.stage) && !p.outcome_reason) { g('lg_more').open = true; g('lg_reason').focus(); throw new Error('Add the outcome reason first.'); }
    if (p.stage === 'follow_up' && !p.next_action_due) { g('lg_due').focus(); throw new Error('Set a follow-up date for the Follow up stage.'); }
    const r = await P.rpc('log_activity', { p_id: cur.id, p });
    if (r.ok === false) throw new Error(r.message);
    await reload(p.stage === 'quote_needed' ? 'Quote requested. Managers have been notified.' : r.auto_stage ? 'Saved. Moved to Contacted.' : 'Saved.');
  });
  const contactForm = (c = {}) => [
    { name: 'name', label: 'Name', value: c.name }, { name: 'title', label: 'Title', value: c.title, placeholder: 'Estimator, PM, superintendent' },
    { name: 'phone', label: 'Phone', type: 'tel', value: c.phone }, { name: 'email', label: 'Email', type: 'email', value: c.email },
    { name: 'verified', label: 'I confirmed these details myself (spoke to them or got them from the company)', type: 'checkbox', value: c.verified },
  ];
  P.act.addContact = () => P.dialog({ title: 'Add a contact', fields: contactForm(), ok: 'Add contact',
    onOk: async (v) => { await P.rpc('save_contact', { p: { ...v, opportunity_id: cur.id } }); } }).then(v => { if (v) { P.state.leadTab = 'contacts'; reload('Contact added.'); } });
  P.act.editContact = (el) => {
    const c = cur.contacts.find(x => x.id === el.dataset.id);
    P.dialog({ title: 'Edit contact', body: '<p class="small muted">The old details stay in the activity history.</p>',
      fields: [...contactForm(c), { name: 'archived', label: 'Remove this contact (wrong number, left the company)', type: 'checkbox' }], ok: 'Save contact',
      onOk: async (v) => { await P.rpc('save_contact', { p: { ...v, id: c.id, opportunity_id: cur.id } }); } }).then(v => v && reload('Contact saved.'));
  };
  P.act.reviewOne = (el) => P.busy(el, async () => {
    await P.rpc('resolve_review', { p_id: cur.id, p_action: el.dataset.a, p_note: null });
    await reload(el.dataset.a === 'archive' ? 'Archived.' : 'Review cleared.');
  });

  // ---------------------------------------------------------------- notifications panel
  function renderNotes(list) {
    const fresh = list.filter(n => !n.read), old = list.filter(n => n.read);
    const item = (n) => `<div class="mini ${n.read ? '' : 'unread'}" ${n.opportunity_id ? `data-lead="${n.opportunity_id}"` : ''} style="padding-left:20px;padding-right:20px">
      <div class="t">${n.opportunity_id ? `<a class="ell" href="#/lead/${n.opportunity_id}" data-lead="${n.opportunity_id}">${esc(n.title)}</a>` : `<span class="ell">${esc(n.title)}</span>`}${n.read ? '' : '<span class="sr">, new</span>'}</div><div class="s" style="white-space:normal">${esc(n.body || '')}</div><div class="r"><span class="small faint nowrap">${esc(P.ago(n.at))}</span></div></div>`;
    P.drawer.set(`<div class="dw-head">${P.dwHead({ title: 'Notifications', tools: fresh.length ? '<button class="btn sm" data-act="markRead">Mark all read</button>' : '' })}<div style="height:14px"></div></div>
      <div class="dw-body" style="padding:0">${list.length ? `${fresh.length ? `<div class="feedday">New</div>${fresh.map(item).join('')}` : ''}${old.length ? `<div class="feedday">Earlier</div>${old.map(item).join('')}` : ''}`
        : P.empty('No notifications yet', 'Follow-ups due, source changes on your leads and assignments show up here.')}</div>`);
  }
  P.act.notifications = async () => {
    P.drawer.show('notes', 'notes', { narrow: true });
    P.drawer.set(P.dwLoading());
    try {
      const list = P.state.notes = await P.rpc('get_notifications');
      if (P.drawer.kind !== 'notes') return;
      renderNotes(list); P.drawer.focus();
    } catch (e) { P.drawer.set(`<div class="dw-head">${P.dwHead({ title: 'Notifications' })}<div style="height:14px"></div></div><div class="dw-body">${P.errorState(e.message)}</div>`); }
  };
  P.act.markRead = (btn) => P.busy(btn, async () => {
    await P.rpc('mark_notifications_read', { p_ids: null });
    P.setUnread(0);
    (P.state.notes || []).forEach(n => { n.read = true; });
    renderNotes(P.state.notes || []);
    P.state.rerender?.();
  });
})();
