/* Lead view: ownership, calling, logging, research, history. */
(function () {
  const { esc } = P;
  let cur = null;   // the opportunity on screen

  P.views.lead = async (view, r) => {
    P.setTitle('Lead', true);
    view.innerHTML = P.loading(3);
    cur = await P.rpc('get_opportunity', { p_id: r.arg });
    renderLead(view, r.params);
  };
  const reload = async (msg) => {
    P.invalidate();
    cur = await P.rpc('get_opportunity', { p_id: cur.id });
    renderLead(document.getElementById('view'), {});
    if (msg) P.toast(msg);
    P.loadBoard(true).catch(() => {});
  };

  function ownerBand(o) {
    const me = P.state.me;
    if (o.stage === 'available') return `<div class="owner-band open"><div class="what"><b>Available</b>Nobody owns this yet. Claim it before you call so the team knows.</div>
      <button class="btn claim" data-act="claim">Claim this lead</button>${P.isMgr() ? '<button class="btn" data-act="assign">Assign</button>' : ''}</div>`;
    if (o.is_mine) return `<div class="owner-band mine"><div class="what"><b>Yours: ${esc(P.stageLabel(o.stage))}</b>Claimed ${esc(P.date(o.claimed_at))}${o.last_activity_at ? `, last activity ${esc(P.ago(o.last_activity_at))}` : ', no activity logged yet'}${o.stale ? `. <strong>No activity in ${o.stale_days}+ days</strong>: log a call, set a follow-up or release it.` : ''}</div>
      ${P.ACTIVE.includes(o.stage) || o.stage === 'nurture' ? '<button class="btn" data-act="release">Release</button>' : ''}${P.isMgr() ? '<button class="btn" data-act="assign">Reassign</button>' : ''}</div>`;
    if (o.owner_id) return `<div class="owner-band ${P.CLOSED.includes(o.stage) ? 'closed' : 'taken'}"><div class="what"><b>${esc(o.owner_name)} owns this: ${esc(P.stageLabel(o.stage))}</b>${o.last_activity_at ? `Last activity ${esc(P.ago(o.last_activity_at))} by ${esc(o.last_activity_by_name || o.owner_name)}.` : 'No activity logged yet.'} ${me.role === 'manager' ? '' : 'Talk to them before calling anyone here.'}</div>
      ${P.isMgr() ? '<button class="btn" data-act="assign">Reassign</button><button class="btn" data-act="release">Release to pool</button>' : ''}</div>`;
    return `<div class="owner-band closed"><div class="what"><b>${esc(P.stageLabel(o.stage))}</b>${esc(o.outcome_reason || '')}${o.superseded_by ? ` Follow-up continues in <a href="#/lead/${o.superseded_by.id}">${esc(o.superseded_by.ref)}</a>.` : ''}</div>
      ${P.isMgr() ? '<button class="btn" data-act="release">Reopen to pool</button>' : ''}</div>`;
  }

  function contactsBlock(o) {
    const canEdit = o.full_access && o.company;
    const list = (o.contacts || []).map(c => `<div class="contact">
        <div class="who"><b>${esc(c.name || 'Main line')}</b>${c.title ? `<span class="small">${esc(c.title)}</span><br>` : ''}
          <span class="small ${c.verified ? '' : 'muted'}">${c.verified ? `Verified by ${esc(c.verified_by_name || 'the team')} ${esc(P.date(c.verified_at))}` : c.source === 'salesperson' ? 'Added by the team, not verified' : 'From research, not confirmed by a call'}</span>
          ${c.phone ? `<div>${esc(c.phone)}</div>` : ''}${c.email ? `<div class="small">${esc(c.email)}</div>` : ''}${c.web && !c.phone && !c.email ? `<div class="small">${esc(c.web)}</div>` : ''}</div>
        <div class="acts">${c.phone ? `<a class="btn call small" href="${P.tel(c.phone)}" data-callid="${c.id}">Call</a>` : ''}${c.email ? `<a class="btn small" href="mailto:${esc(c.email)}">Email</a>` : ''}
          ${canEdit ? `<button class="btn small" data-act="editContact" data-id="${c.id}">Edit</button>` : ''}</div></div>`).join('');
    const pocs = (o.project?.pocs || []).filter(c => c.name || c.email || c.phone || c.web).map(c => `<div class="contact"><div class="who"><b>${esc(c.name || 'Agency contact')}</b>${c.title ? `<span class="small">${esc(c.title)}</span>` : ''}
        <span class="small muted">From the notice</span>${c.phone ? `<div>${esc(c.phone)}</div>` : ''}${c.email ? `<div class="small">${esc(c.email)}</div>` : ''}${c.web ? `<div class="small"><a href="${esc(c.web)}" target="_blank" rel="noopener">${esc(c.web.replace(/^https?:\/\//, '').slice(0, 60))}</a></div>` : ''}</div>
        <div class="acts">${c.phone ? `<a class="btn call small" href="${P.tel(c.phone)}">Call</a>` : ''}${c.email ? `<a class="btn small" href="mailto:${esc(c.email)}">Email</a>` : ''}</div></div>`).join('');
    const site = o.company?.website ? `<p class="small">Website: <a href="${esc(/^https?:/.test(o.company.website) ? o.company.website : 'https://' + o.company.website)}" target="_blank" rel="noopener">${esc(o.company.website)}</a></p>` : '';
    return `<section class="panel"><div class="row"><h2 class="grow">Who to call</h2>${canEdit ? '<button class="btn small" data-act="addContact">Add contact</button>' : ''}</div>
      ${o.company ? `<p class="small muted">${esc(o.company.name)}${o.company.hq ? ', ' + esc(o.company.hq) : ''}</p>` : ''}
      ${list || (o.company ? '<p class="muted">No phone or email on file. Use the website or source link to find the estimator, then add them here.</p>' : '')}
      ${pocs ? `<h3>Agency contacts</h3>${pocs}` : ''}${site}</section>`;
  }

  function logBlock(o) {
    if (!o.full_access || (!o.owner_id && !P.isMgr())) return '';
    if (!o.owner_id) return `<section class="panel"><h2>Add a research note</h2><p class="small muted">Managers can note research on unowned leads. Assign it before logging calls.</p>
      <label class="field"><span>Note</span><textarea id="lg_body"></textarea></label><button class="btn primary" data-act="saveLog" data-kind="note">Save note</button></section>`;
    const contacts = (o.contacts || []).map(c => `<option value="${c.id}">${esc(c.name || c.phone || c.email)}</option>`).join('');
    const stages = (P.state.me.stages || []).filter(s => s.key !== 'available').map(s => `<option value="${s.key}" ${s.key === o.stage ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
    const svc = [...new Set(P.SERVICES.concat(o.services || []))];
    return `<section class="logbox" id="logbox"><h2>Log a call or note</h2>
      <div class="seg" role="group" aria-label="Type" style="margin-bottom:10px">${[['call', 'Call'], ['email', 'Email'], ['text', 'Text'], ['visit', 'Visit'], ['note', 'Note']].map(([k, t], i) => `<button data-act="logKind" data-kind="${k}" aria-pressed="${i === 0}">${t}</button>`).join('')}</div>
      <div class="chips" id="lg_outcomes" role="group" aria-label="Outcome">${P.OUTCOMES.map(([k, t]) => `<button class="chip" data-act="logOutcome" data-outcome="${k}" aria-pressed="false">${esc(t)}</button>`).join('')}</div>
      <label class="field" style="margin-top:12px"><span>What happened</span><textarea id="lg_body" placeholder="Who you spoke to, what they need, what you promised"></textarea></label>
      ${contacts ? `<label class="field"><span>Contact <span class="muted small">(optional)</span></span><select id="lg_contact"><option value="">Not a listed contact</option>${contacts}</select></label>` : ''}
      <div class="grid2">
        <label class="field"><span>Next action</span><input type="text" id="lg_next" value="${esc(o.next_action || '')}" placeholder="Send pricing, call back the PM"></label>
        <label class="field"><span>Follow-up date</span><input type="date" id="lg_due" value="${esc(o.next_action_due || '')}"></label>
      </div>
      <div class="chips" style="margin:-4px 0 12px">${[[1, 'Tomorrow'], [3, 'In 3 days'], [7, 'Next week'], [14, 'In 2 weeks'], [30, 'In a month']].map(([n, t]) => `<button class="chip" data-act="quickDue" data-days="${n}">${t}</button>`).join('')}</div>
      <details id="lg_more"><summary>Stage, services, quote and outcome</summary>
        <label class="field"><span>Stage</span><select id="lg_stage">${stages}</select></label>
        <fieldset style="border:0;padding:0;margin:0 0 12px"><legend style="font-weight:600;font-size:.9rem;margin-bottom:6px">Services the contact confirmed</legend>
          <div class="chips">${svc.map(s => `<button class="chip" data-act="toggleChip" data-svc="${esc(s)}" aria-pressed="${(o.services_confirmed || []).includes(s)}">${esc(s)}</button>`).join('')}</div></fieldset>
        <label class="field"><span>Scope they described <span class="muted small">(optional)</span></span><input type="text" id="lg_scope" value="${esc(o.scope_confirmed_note || '')}" placeholder="40 cores, 6 in., 12 in. slab; GPR first"></label>
        <div class="grid2">
          <label class="field"><span>Speedy quote amount ($)</span><input type="number" id="lg_quote" min="0" step="any" value="${o.quote_amount ?? ''}"><span class="kv-note">Speedy's price, not the project value.</span></label>
          <label class="field"><span>Quote sent on</span><input type="date" id="lg_qdate" value="${esc(o.quote_sent_at || '')}"></label>
          <label class="field"><span>Expected work date</span><input type="date" id="lg_work" value="${esc(o.expected_work_date || '')}"></label>
          <label class="field"><span>Outcome reason</span><input type="text" id="lg_reason" value="${esc(o.outcome_reason || '')}" placeholder="Needed for Won, Lost or Disqualified"></label>
        </div>
      </details>
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="saveLog" id="lg_save">Save call</button><span class="small muted" id="lg_hint">${o.stage === 'claimed' ? 'Saving a call, email, text or visit moves this to Contacted.' : ''}</span></div>
    </section>`;
  }

  function why(o) {
    const r = o.priority_reasons || {};
    return `<section class="panel"><h2>Why it is ${esc(o.priority || 'ranked')} here</h2>
      <p class="small">${esc(r.summary || '')}. Fit and urgency are scored separately: a close deadline alone does not make a lead Hot.</p>
      <h3>Fit ${o.fit_score ?? '?'}/100</h3>
      ${(r.fit || []).map(x => `<div class="factor"><span>${esc(x.factor)}: ${esc(x.text)}</span><b>${x.points}/${x.max}</b><div class="bar"><i style="width:${Math.round(100 * x.points / x.max)}%"></i></div></div>`).join('')}
      <h3>Urgency ${o.urgency_score ?? '?'}/100</h3>${(r.urgency || []).map(x => `<p class="small">${esc(x.text)}</p>`).join('')}
      ${o.legacy_priority ? `<p class="small muted">The original pipeline ranked this ${esc(o.legacy_priority)}.</p>` : ''}</section>`;
  }

  function research(o) {
    const p = o.project;
    if (!p) return '';
    const approach = P.APPROACH[o.approach] || [o.approach, ''];
    const evidence = (p.scope_evidence || []).length ? `<div class="confirmed" style="background:var(--slab-2);border-color:var(--steel)"><b>The source describes:</b> ${esc(p.scope_evidence.join(', '))}. This is the project scope, not a request for Speedy pricing.</div>` : '';
    const confirmed = (o.services_confirmed || []).length || o.scope_confirmed_note ? `<div class="confirmed"><b>Confirmed by the contact:</b> ${esc((o.services_confirmed || []).join(', '))}${o.scope_confirmed_note ? '. ' + esc(o.scope_confirmed_note) : ''}</div>` : '';
    const winner = p.winner_name ? `<dt>${p.winner_status === 'low_bidder' ? 'Apparent low bidder' : p.winner_status === 'intended' ? 'Intended award' : 'Awarded to'}</dt>
      <dd><b>${esc(p.winner_name)}</b>${p.winner_amount ? ' at ' + esc(P.money(p.winner_amount)) : ''}${p.winner_as_of ? ', ' + esc(P.date(p.winner_as_of)) : ''}
        ${p.winner_status === 'low_bidder' ? '<div class="small">Low bid only. Not a final award until the agency posts it.</div>' : ''}</dd>` : '';
    const bidders = (p.bidders || []).length > 1 ? `<details><summary>All ${p.bidders.length} bidders</summary><ol class="small">${p.bidders.map(b => `<li>${esc(b.name)} ${b.amount ? esc(P.money(b.amount)) : ''}</li>`).join('')}</ol></details>` : '';
    const verified = p.last_verified_at ? esc(P.dateTime(p.last_verified_at)) : P.unknown(p.imported_at ? `Not re-checked since import on ${P.date(p.imported_at)}` : 'Not verified yet');
    const checkNote = ['failed', 'missing'].includes(p.verify_status) ? `<div class="small" style="color:var(--red)">${p.verify_status === 'missing' ? 'The source no longer lists it' : 'The last check failed'} (${esc(P.dateTime(p.last_checked_at))}). Details may be out of date.</div>` : '';
    const changes = (p.recent_changes || []).filter(c => c.material).slice(0, 5);
    return `<section class="panel"><h2>The project</h2>
      <dl class="facts">
        <dt>Project</dt><dd>${esc(p.title)}</dd>
        <dt>Owner</dt><dd>${p.owner_name ? esc(p.owner_name) : P.unknown()}</dd>
        <dt>Where</dt><dd>${esc(p.location_text || '')}${p.city || p.county ? `<div class="small muted">${esc([p.city, p.county ? p.county + ' County' : ''].filter(Boolean).join(', '))}, ${esc(p.region)}</div>` : `<div class="small muted">${esc(p.region)}</div>`}</dd>
        <dt>Project stage</dt><dd>${esc(P.PSTAGE[p.stage] || p.stage)}${p.status_text ? `<div class="small">${esc(p.status_text)}</div>` : ''}</dd>
        <dt>Project value</dt><dd>${p.project_value ? esc(P.money(p.project_value)) + ' <span class="small muted">(whole project, not Speedy\'s share)</span>' : p.value_label ? esc(p.value_label) : P.unknown('Not public')}${p.size_note ? `<div class="small">${esc(p.size_note)}</div>` : ''}</dd>
        <dt>Speedy quote</dt><dd>${o.full_access ? (o.quote_amount != null ? esc(P.money(o.quote_amount)) + (o.quote_sent_at ? `, sent ${esc(P.date(o.quote_sent_at))}` : '') : P.unknown('Not quoted yet')) : P.unknown('Visible to the owner')}</dd>
        ${o.expected_work_date ? `<dt>Expected work</dt><dd>${esc(P.date(o.expected_work_date))}</dd>` : ''}
        ${p.deadline ? `<dt>${p.stage === 'upcoming' ? 'Response due' : 'Bid deadline'}</dt><dd>${esc(P.deadline(p))}${p.deadline_note ? `<div class="small">${esc(p.deadline_note)}</div>` : ''}</dd>` : ''}
        ${p.solicitation_no ? `<dt>Solicitation</dt><dd>${esc(p.solicitation_no)}</dd>` : ''}
        ${p.set_aside ? `<dt>Rules</dt><dd>${esc(p.set_aside)}</dd>` : ''}
        ${winner}
      </dl>${bidders}
      ${o.kind === 'gov_bid' || p.level !== 'Private' ? `<h3>How to pursue it</h3><p><b>${esc(approach[0])}.</b> ${esc(approach[1])}</p>${o.approach_note ? `<p class="small muted">From the research: ${esc(o.approach_note)}</p>` : ''}` : ''}
      <h3>Why it may need Speedy</h3>
      ${p.source_summary ? `<p class="small"><b>From the source:</b> ${esc(p.source_summary)}</p>` : ''}
      ${evidence}${confirmed}
      ${o.speedy_scope ? `<div class="inferred"><b>Our read (inferred, not confirmed):</b> ${esc(o.speedy_scope)}</div>` : ''}
      ${(o.services || []).length ? `<p class="small">Likely services: ${esc(o.services.join(', '))}</p>` : ''}
      <h3>Source and freshness</h3>
      <dl class="facts small">
        <dt>Source</dt><dd>${esc(p.source_label || p.source_name || '')}${p.source_url ? ` <a href="${esc(p.source_url)}" target="_blank" rel="noopener">Open source</a>` : ''}</dd>
        <dt>Published</dt><dd>${p.published_at ? esc(P.date(p.published_at, { year: true })) : P.unknown()}</dd>
        <dt>Discovered</dt><dd>${p.discovered_at ? esc(P.date(p.discovered_at, { year: true })) : P.unknown()}${p.discovered_note ? `<div class="muted">${esc(p.discovered_note)}</div>` : ''}</dd>
        <dt>Last verified</dt><dd>${verified}${checkNote}</dd>
      </dl>
      ${changes.length ? `<h3>Recent source changes</h3>${changes.map(c => `<p class="small"><b>${esc(P.date(c.at))}:</b> ${esc(c.field)} ${c.old ? `from ${esc(String(c.old).slice(0, 80))} ` : ''}to ${esc(String(c.new).slice(0, 120))}</p>`).join('')}` : ''}
      ${(o.also_covers || []).length ? `<h3>Also covers</h3>${o.also_covers.map(x => `<p class="small">${esc(x.title)}${x.solicitation_no ? ' (' + esc(x.solicitation_no) + ')' : ''}${x.winner_name ? `: ${esc(x.winner_name)}` : ''} ${x.source_url ? `<a href="${esc(x.source_url)}" target="_blank" rel="noopener">source</a>` : ''}</p>`).join('')}` : ''}
      ${o.legacy ? `<details><summary>Original pipeline research</summary><p class="small">${esc(o.legacy.pitch || o.legacy.fit || '')}</p>${o.legacy.dateText ? `<p class="small">${esc(o.legacy.dateText)}</p>` : ''}${o.legacy.nextAction ? `<p class="small">Next step then: ${esc(o.legacy.nextAction)}</p>` : ''}</details>` : ''}
    </section>`;
  }

  function relationships(o) {
    const co = o.company_opps || [], pj = o.project_opps || [], log = o.company_contact_log || [];
    if (!co.length && !pj.length && !log.length) return '';
    const line = (x) => `<p class="small"><a href="#/lead/${x.id}">${esc(x.ref)}</a> ${esc(x.company_name ? x.company_name + ': ' : '')}${esc(x.title)}<br><span class="muted">${x.owner_name ? esc(x.owner_name) + ', ' : 'Available, '}${esc(P.stageLabel(x.stage))}${x.last_activity_at ? ', last activity ' + esc(P.ago(x.last_activity_at)) : ''}</span></p>`;
    return `<section class="panel"><h2>Coordination</h2>
      ${log.length ? `<h3>Recent contact with ${esc(o.company?.name || 'this company')}</h3>${log.map(l => `<p class="small">${esc(P.date(l.at))}: ${esc(l.user_name || 'Someone')} ${esc(l.kind === 'call' ? 'called' : l.kind === 'email' ? 'emailed' : l.kind === 'text' ? 'texted' : 'met')} ${esc(l.contact_name || '')} on ${esc(l.ref || 'another lead')}</p>`).join('')}` : ''}
      ${co.length ? `<h3>Other opportunities with ${esc(o.company?.name || 'this company')}</h3>${co.map(line).join('')}` : ''}
      ${pj.length ? `<h3>Other opportunities on this project</h3>${pj.map(line).join('')}` : ''}</section>`;
  }

  function history(o) {
    const items = (o.timeline || []).map(t => {
      if (t.hidden) return `<li class="${esc(t.kind)}"><div class="when">${esc(P.dateTime(t.at))} · ${esc(t.user_name)}</div><div class="muted small">${esc(t.kind === 'note' ? 'Note' : t.kind[0].toUpperCase() + t.kind.slice(1))} logged (details visible to the owner and managers)</div></li>`;
      const ch = t.data?.changes ? Object.entries(t.data.changes).filter(([k]) => k !== 'stage').map(([k, [a, b]]) => `${k.replace(/_/g, ' ')}: ${a == null || a === '' ? 'none' : Array.isArray(a) ? a.join(', ') : a} to ${b == null || b === '' ? 'none' : Array.isArray(b) ? b.join(', ') : b}`).join('; ') : '';
      const label = { call: 'Call', email: 'Email', text: 'Text', visit: 'Visit', meeting: 'Meeting', note: 'Note', claim: 'Claimed', release: 'Released', assign: 'Assigned', quote: 'Quote', follow_up: 'Follow-up', contact: 'Contact', system: 'System', refresh: 'Source refresh', import: 'Imported', review: 'Review', stage: 'Stage' }[t.kind] || t.kind;
      return `<li class="${esc(t.kind)}"><div class="when">${esc(P.dateTime(t.at))} · ${esc(t.user_name)}</div>
        <div><b>${esc(label)}</b>${t.outcome ? ': ' + esc((P.OUTCOMES.find(x => x[0] === t.outcome) || [0, t.outcome])[1]) : ''}${t.to_stage ? ` <span class="tag">${esc(P.stageLabel(t.from_stage || ''))} to ${esc(P.stageLabel(t.to_stage))}</span>` : ''}${t.contact_name ? ` <span class="small muted">with ${esc(t.contact_name)}</span>` : ''}</div>
        ${t.body ? `<div class="body">${esc(t.body)}</div>` : ''}${ch ? `<div class="small muted">${esc(ch)}</div>` : ''}</li>`;
    }).join('');
    const own = (o.ownership || []).map(h => `<p class="small">${esc(P.dateTime(h.at))}: ${esc(h.action)} ${h.from ? 'from ' + esc(h.from) + ' ' : ''}${h.to ? 'to ' + esc(h.to) + ' ' : ''}by ${esc(h.by)}${h.reason ? ` (${esc(h.reason)})` : ''}</p>`).join('');
    return `<section class="panel"><h2>Activity</h2>${items ? `<ul class="timeline">${items}</ul>` : '<p class="muted">Nothing logged yet.</p>'}
      ${own ? `<details><summary>Ownership history</summary>${own}</details>` : ''}</section>`;
  }

  function renderLead(view, params) {
    const o = cur;
    P.setTitle(o.ref, true);
    const p = o.project || {};
    const companyName = o.company?.name || p.owner_name || o.title;
    const review = o.needs_review ? `<div class="alert warn"><b>Check this lead:</b> ${esc(o.review_reason || '')}${P.isMgr() ? ` <button class="linkbtn" data-act="reviewOne" data-a="publish">Looks fine</button> <button class="linkbtn" data-act="reviewOne" data-a="archive">Archive</button>` : ''}</div>` : '';
    const warn = (o.company_opps || []).filter(x => x.owner_name && P.ACTIVE.includes(x.stage) && x.owner_name !== P.state.me.full_name);
    view.innerHTML = `
      <div class="leadview">
        <div style="display:grid;gap:14px">
          <section class="panel head">
            <div class="row" style="justify-content:space-between"><span class="small muted">${esc(o.ref)} · ${esc(P.KIND[o.kind] || o.kind)}</span>${P.prioTag(o.priority)}</div>
            <div class="co">${esc(companyName)}</div>
            <div class="pj">${esc(p.title || o.title)}</div>
            <div class="row small muted"><span>${esc(p.region || '')}${p.city ? ', ' + esc(p.city) : ''}</span><span>${esc(P.PSTAGE[p.stage] || '')}</span>${p.deadline ? `<span>${p.stage === 'upcoming' ? 'Response' : 'Bids'} due ${esc(P.deadline(p))}</span>` : ''}</div>
            ${ownerBand(o)}${review}
            ${warn.length ? `<div class="alert warn">${esc(warn.map(x => x.owner_name).join(', '))} ${warn.length === 1 ? 'is' : 'are'} also working ${esc(companyName)} on another opportunity. Coordinate before you call.</div>` : ''}
            ${o.next_action ? `<p style="margin-top:10px"><b>Next action:</b> ${esc(o.next_action)}${o.next_action_due ? ` <span class="tag ${P.daysUntil(o.next_action_due) < 0 ? 'bad' : 'info'}">${esc(P.date(o.next_action_due))}</span>` : ''}</p>` : ''}
            ${o.is_mine && P.ACTIVE.includes(o.stage) && !['quote_needed', 'quote_sent'].includes(o.stage) ? '<button class="btn" data-act="requestQuote">Request a quote</button>' : ''}
          </section>
          ${contactsBlock(o)}
          ${logBlock(o)}
          ${history(o)}
        </div>
        <div style="display:grid;gap:14px">
          ${research(o)}
          ${why(o)}
          ${relationships(o)}
        </div>
      </div>`;
    P.state.log = { kind: 'call', outcome: null };
    if (params?.log === 'quote') P.act.requestQuote();
  }

  // ---------------------------------------------------------------- actions
  P.act.claim = (btn) => P.busy(btn, async () => {
    let r = await P.rpc('claim_opportunity', { p_id: cur.id });
    if (!r.ok && r.reason === 'company_conflict') {
      const who = r.owners.map(x => `${esc(x.name)} (${esc(x.ref)}, ${esc(P.stageLabel(x.stage))}${x.last_activity_at ? ', last activity ' + esc(P.ago(x.last_activity_at)) : ''})`).join('<br>');
      const ok = await P.confirm('A teammate works this company', `${who}<br><br>You can still claim this opportunity. Check with them first so you do not call the same person.`, 'Claim anyway');
      if (!ok) return;
      r = await P.rpc('claim_opportunity', { p_id: cur.id, p_ack_company: true });
    }
    if (!r.ok) { P.toast(r.message || 'Could not claim this lead.', 'error'); return reload(); }
    await reload(r.already_yours ? 'Already yours.' : 'Claimed. It is in your pipeline.');
  });
  P.act.release = () => P.dialog({
    title: cur.is_mine ? 'Release this lead' : 'Release to the pool', ok: 'Release',
    body: '<p>It goes back to Available. Its history and notes stay with it.</p>',
    fields: [{ name: 'reason', label: 'Why', type: 'text', placeholder: 'Not a fit for me, wrong region, no answer after 5 tries' }],
    onOk: async (v) => { await P.rpc('release_opportunity', { p_id: cur.id, p_reason: v.reason }); },
  }).then(v => v && reload('Released to the pool.'));
  P.act.assign = async () => {
    const users = (P.state.users = await P.rpc('list_users')).filter(u => u.active);
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
    document.getElementById('lg_outcomes').classList.toggle('hidden', el.dataset.kind === 'note');
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
      if (el.dataset.outcome === 'wrong_number') document.getElementById('lg_hint').textContent = 'Tip: edit or remove the wrong contact under Who to call.';
    }
  };
  P.act.quickDue = (el) => { document.getElementById('lg_due').value = P.addDays(Number(el.dataset.days)); };
  P.act.toggleChip = (el) => el.setAttribute('aria-pressed', el.getAttribute('aria-pressed') !== 'true');
  P.act.requestQuote = () => {
    const box = document.getElementById('logbox');
    if (!box) return;
    box.querySelector('[data-kind="note"]')?.click();
    document.getElementById('lg_more').open = true;
    document.getElementById('lg_stage').value = 'quote_needed';
    const b = document.getElementById('lg_body');
    b.placeholder = 'What needs pricing: services, quantities, slab or wall thickness, access, schedule, who to send it to';
    document.getElementById('lg_save').textContent = 'Request quote';
    document.getElementById('lg_hint').textContent = 'Managers get a notice to price it.';
    box.scrollIntoView({ behavior: 'smooth', block: 'start' }); b.focus({ preventScroll: true });
  };
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
    if (['won', 'lost', 'disqualified'].includes(p.stage) && !p.outcome_reason) { g('lg_reason').focus(); throw new Error('Add the outcome reason first.'); }
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
    onOk: async (v) => { await P.rpc('save_contact', { p: { ...v, opportunity_id: cur.id } }); } }).then(v => v && reload('Contact added.'));
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
  P.act.notifications = async () => {
    const list = await P.rpc('get_notifications').catch(e => { P.toast(e.message, 'error'); return null; });
    if (!list) return;
    const body = list.length ? list.map(n => `<div class="contact"><div class="who"><b>${esc(n.title)}</b><span class="small">${esc(n.body || '')}</span><br><span class="small muted">${esc(P.ago(n.at))}${n.read ? '' : ' · new'}</span></div>
      ${n.opportunity_id ? `<div class="acts"><a class="btn small" href="#/lead/${n.opportunity_id}" data-closedialog>Open</a></div>` : ''}</div>`).join('') : '<p class="muted">No notifications yet. You will see follow-ups due, source changes on your leads and assignments here.</p>';
    const p = P.dialog({ title: 'Notifications', body, ok: list.some(n => !n.read) ? 'Mark all read' : '', cancel: 'Close' });
    document.querySelectorAll('dialog [data-closedialog]').forEach(a => a.addEventListener('click', () => { const d = a.closest('dialog'); d.close(); d.remove(); }));
    if (await p) { await P.rpc('mark_notifications_read', { p_ids: null }); P.setUnread(0); }
  };
})();
