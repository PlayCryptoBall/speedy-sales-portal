/* Work on a lead (tasks, outreach drafts, quotes, award, job and money, files, people on the project) and the pages
   Tasks, Estimate requests, Money and Workspace settings. Every figure shown comes from its own record. */
(() => {
  const P = window.P, esc = P.esc;
  const $ = (id) => document.getElementById(id);
  const money2 = (n) => n == null ? '' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const catalog = async () => (P.state.catalog = P.state.catalog || await P.rpc('services_catalog'));
  const unitLabel = (u) => P.state.catalog?.units?.[u]?.label || u;
  const QSRC = { contractor: 'customer\'s quantity', verified: 'verified', measured: 'measured on site', assumed: 'assumed' };
  const VSTATUS = { draft: 'Draft', approved: 'Approved, not sent', sent: 'Sent', accepted: 'Accepted', rejected: 'Rejected', superseded: 'Replaced' };
  const JSTATUS = { ready_for_scheduling: 'Ready for scheduling', scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
  const ROLE = { awarded_contractor: 'Awarded contractor', intended_awardee: 'Intended award', low_bidder: 'Low bidder', bidder: 'Bidder', owner: 'Owner', developer: 'Developer',
    buyer: 'Buyer', seller: 'Seller', applicant: 'Applicant', subcontractor: 'Contractor or sub', architect: 'Architect', engineer: 'Engineer', agency_contact: 'Agency contact', tenant: 'Tenant', other: 'Other' };
  let W = null, O = null;   // the loaded work for the open lead, and the lead

  // ---------------------------------------------------------------- lead "Work" tab
  P.workSection = async (o, el) => {
    O = o; el.innerHTML = P.skeleton(4);
    try { await catalog(); W = await P.rpc('opportunity_work', { p_opportunity: o.id }); }
    catch (e) { el.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; return; }
    draw(el);
  };
  const reloadWork = async (msg) => { W = await P.rpc('opportunity_work', { p_opportunity: O.id }); const el = $('lw_work'); if (el) draw(el); if (msg) P.toast(msg); P.invalidate?.(); };

  function draw(el) {
    const can = W.can_work;
    el.innerHTML = [tasksPanel(can), outreachPanel(can), requestsPanel(), quotesPanel(can), moneyPanel(can), docsPanel(can), peoplePanel()].join('');
  }

  function tasksPanel(can) {
    if (!W.full_access) return '';
    const t = W.tasks;
    return `<div class="panel"><h3>Tasks <span class="n faint">${t.length}</span>${can ? `<span class="tools"><button class="btn sm" data-act="wTaskAdd">${P.icon('plus', 'sm')}Add task</button></span>` : ''}</h3>
      ${t.length ? `<ul class="wl">${t.map(x => `<li class="${x.overdue ? 'overdue' : ''}"><div class="grow"><b>${esc(x.title)}</b>
        <div class="small muted">${x.due_at ? `${x.overdue ? 'Overdue · ' : ''}due ${esc(P.dateTime(x.due_at))}` : 'No date'}${x.assignee ? ' · ' + esc(x.assignee) : ''}${x.notes ? ' · ' + esc(x.notes) : ''}</div></div>
        ${can ? `<button class="btn sm" data-act="wTaskDone" data-id="${x.id}" data-origin="${x.origin}">Done</button>` : ''}</li>`).join('')}</ul>`
        : `<p class="muted small">${O.no_action_reason ? 'Nothing scheduled: ' + esc(O.no_action_reason) : 'No open tasks.'}</p>`}</div>`;
  }
  P.act.wTaskAdd = () => P.dialog({ title: 'Add a task', ok: 'Add',
    fields: [{ name: 'title', label: 'What to do', required: true, placeholder: 'Ask for the MEP sheets' },
      { name: 'kind', label: 'Type', type: 'select', value: 'follow_up', options: [['call', 'Call'], ['email', 'Email'], ['follow_up', 'Follow up'], ['drawings', 'Get drawings'], ['site_visit', 'Site visit'], ['estimate', 'Estimate'], ['send_quote', 'Send quote'], ['vendor_setup', 'Vendor setup'], ['other', 'Other']] },
      { name: 'due_date', label: 'Due', type: 'date', value: P.addDays(1), quick: true }],
    onOk: (v) => P.rpc('save_task', { p: { ...v, opportunity_id: O.id } }) }).then(v => v && reloadWork('Task added.'));
  P.act.wTaskDone = (el) => {
    const mirror = el.dataset.origin === 'next_action';
    P.dialog({ title: 'Mark done', ok: 'Done',
      body: mirror ? '<p class="small muted" style="margin-bottom:8px">This is the lead\'s next step. Set the new one, or say why nothing is scheduled.</p>' : '',
      fields: [{ name: 'outcome', label: 'What happened' },
        ...(mirror ? [{ name: 'next_action', label: 'Next step' }, { name: 'next_action_due', label: 'Next step date', type: 'date', quick: true },
          { name: 'no_action_reason', label: 'Or: why nothing is scheduled', placeholder: 'Waiting for drawings from the GC' }] : [])],
      onOk: (v) => P.rpc('complete_task', { p_id: el.dataset.id, p: v }) }).then(v => v && reloadWork('Task done.'));
  };

  function outreachPanel(can) {
    if (!can || P.CLOSED.includes(O.stage)) return '';
    return `<div class="panel"><h3>Outreach draft</h3><p class="small muted">Built from this lead's record: who to call and why, the facts, the questions to ask, an email and a voicemail. Nothing is sent from the portal.</p>
      <button class="btn" data-act="wBrief">${P.icon('quote', 'sm')}Draft outreach</button></div>`;
  }
  P.act.wBrief = (el) => P.busy(el, async () => {
    const b = await P.rpc('generate_outreach_brief', { p_opportunity: O.id });
    const copyBtn = (label, text) => `<button type="button" class="btn sm" data-act="wCopy" data-draft="${b.id}" data-text="${esc(text)}">${P.icon('copy', 'sm')}${label}</button>`;
    const conf = { confirmed: 'Confirmed scope', documented: 'Documented in a source', inferred: 'Inferred: ask, do not assume', missing: 'No scope on record' }[b.scope_confidence];
    const k = b.contact;
    await P.dialog({ title: 'Outreach draft', wide: true, ok: null, cancel: 'Close', body: `
      <div class="brief">
        <section><h4>Who</h4>${k ? `<p><b>${esc(k.name)}</b>${k.title ? ', ' + esc(k.title) : ''} ${k.phone ? `· <a href="tel:${esc(k.phone.replace(/[^\d+]/g, ''))}">${esc(k.phone)}</a>` : ''} ${k.email ? `· <a href="mailto:${esc(k.email)}">${esc(k.email)}</a>` : ''}</p>
          ${k.email_unverified_guess ? `<p class="small warn-text">Email ${esc(k.email_unverified_guess)} is a guessed pattern, not verified.</p>` : ''}` : ''}<p class="small muted">${esc(b.why_this_contact)}</p></section>
        <section><h4>Facts on record</h4><ul>${b.facts.map(f => `<li>${esc(f)}</li>`).join('')}</ul></section>
        <section><h4>Scope <span class="badge ${b.scope_confidence === 'inferred' || b.scope_confidence === 'missing' ? 'warm' : 'ok'}">${esc(conf)}</span></h4><p>${esc(b.scope)}</p></section>
        <section><h4>Opener ${copyBtn('Copy', b.opener)}</h4><p>${esc(b.opener)}</p><p class="small muted">${esc(b.ask)}</p></section>
        <section><h4>Questions</h4><ol>${b.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ol></section>
        <section><h4>Email ${copyBtn('Copy email', `Subject: ${b.email_subject}\n\n${b.email}`)}</h4><pre class="draft">${esc(b.email)}</pre></section>
        <section><h4>Voicemail ${copyBtn('Copy', b.voicemail)}</h4><p>${esc(b.voicemail)}</p></section>
        ${b.follow_up ? `<section><h4>Follow-up ${copyBtn('Copy', b.follow_up)}</h4><p>${esc(b.follow_up)}</p></section>` : ''}
        <section><h4>Next step</h4><p>${esc(b.next_step)}</p></section>
        <p class="small muted">${esc(b.note)}</p></div>` });
  });
  P.act.wCopy = async (el) => { await P.copy(el.dataset.text || ''); P.toast('Copied. Sending is up to you.'); P.rpc('mark_outreach_draft', { p_id: el.dataset.draft, p_status: 'copied' }).catch(() => {}); };

  function requestsPanel() {
    if (!W.requests.length) return '';
    return `<div class="panel"><h3>Estimate requests</h3><ul class="wl">${W.requests.map(r => `<li><div class="grow"><a href="#/requests?id=${r.id}">${esc(r.ref)}</a>
      <span class="small muted"> · ${esc(r.status.replace('_', ' '))}${r.missing_count ? ` · ${r.missing_count} missing` : ''}</span></div></li>`).join('')}</ul></div>`;
  }

  // ---------------------------------------------------------------- quotes
  function quotesPanel(can) {
    if (!W.full_access) return '';
    const sentAny = W.quotes.some(q => q.versions.some(v => ['sent', 'accepted'].includes(v.status)));
    return `<div class="panel"><h3>Quotes${can && !P.CLOSED.includes(O.stage) ? `<span class="tools"><button class="btn sm" data-act="wQuoteNew">${P.icon('plus', 'sm')}New quote</button></span>` : ''}</h3>
      ${W.quotes.length ? W.quotes.map(q => quoteBlock(q, can)).join('') : '<p class="muted small">No quote yet. A quote is built from line items with explicit units; prices come from approved pricing rules or are marked as entered by hand.</p>'}
      ${can && sentAny && O.stage !== 'won' ? `<div style="margin-top:10px"><button class="btn primary" data-act="wAward">Record the award</button></div>` : ''}</div>`;
  }
  function quoteBlock(q, can) {
    const v = q.versions[0];
    const older = q.versions.slice(1);
    const lines = v.lines.length ? `<div class="tablewrap"><table class="tbl lines"><thead><tr><th>Line</th><th class="num">Qty</th><th>Unit</th><th class="num">Rate</th><th class="num">Amount</th>${v.status === 'draft' && can ? '<th></th>' : ''}</tr></thead><tbody>
      ${v.lines.map(l => `<tr><td>${esc(l.description)}<div class="small muted">${esc(QSRC[l.qty_source])}${l.rate_source === 'manual' ? ' · rate entered by hand' : ' · approved rate'}</div></td>
        <td class="num">${esc(String(l.qty))}</td><td>${esc(unitLabel(l.unit))}</td><td class="num">${money2(l.rate)}</td><td class="num">${money2(l.amount)}</td>
        ${v.status === 'draft' && can ? `<td><button class="btn ghost sm" data-act="wLineEdit" data-v="${v.id}" data-id="${l.id}">Edit</button></td>` : ''}</tr>`).join('')}
      </tbody><tfoot><tr><td colspan="4">Total</td><td class="num"><b>${money2(v.total)}</b></td>${v.status === 'draft' && can ? '<td></td>' : ''}</tr></tfoot></table></div>`
      : v.quick_amount != null ? `<p>Amount only: <b>${money2(v.quick_amount)}</b> <span class="small muted">(no line items recorded)</span></p>` : '<p class="muted small">No lines yet.</p>';
    const flags = v.flags.length && ['draft', 'approved'].includes(v.status) ? `<ul class="flags">${v.flags.map(f => `<li class="${f.level}">${esc(f.text)}</li>`).join('')}</ul>` : '';
    const acts = !can ? '' : v.status === 'draft' ? `<button class="btn sm" data-act="wLineAdd" data-v="${v.id}">${P.icon('plus', 'sm')}Line</button>
          <button class="btn sm" data-act="wVersionEdit" data-v="${v.id}" data-q="${q.id}">Scope, assumptions, validity</button><button class="btn sm primary" data-act="wApprove" data-v="${v.id}">Approve</button>`
      : v.status === 'approved' ? `<button class="btn sm primary" data-act="wSent" data-v="${v.id}">Record as sent</button><button class="btn sm" data-act="wNewVersion" data-v="${v.id}">Revise</button>`
      : ['sent', 'accepted', 'rejected'].includes(v.status) ? `<button class="btn sm" data-act="wNewVersion" data-v="${v.id}">New version</button>${['sent', 'accepted'].includes(v.status) ? `<button class="btn sm" data-act="wChange" data-q="${q.id}">Change request</button>` : ''}` : '';
    return `<div class="quote"><div class="qhead"><b>${esc(q.ref)} · version ${v.version_no}</b> <span class="badge ${v.status === 'accepted' ? 'ok' : v.status === 'sent' ? 'accent' : 'outline'}">${esc(VSTATUS[v.status])}</span>
        <span class="small muted">${v.valid_until ? 'valid to ' + esc(P.date(v.valid_until)) : 'no validity date'}${v.sent_at ? ` · sent ${esc(P.date(v.sent_at))} to ${esc(v.sent_to)}` : ''}</span></div>
      ${v.scope_summary ? `<p class="small">${esc(v.scope_summary)}</p>` : ''}${lines}
      ${v.assumptions.length || v.exclusions.length ? `<div class="small"><b>Assumptions:</b> ${esc(v.assumptions.join('; ') || 'none')}<br><b>Exclusions:</b> ${esc(v.exclusions.join('; ') || 'none')}</div>` : ''}
      ${flags}<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">${acts}</div>
      ${q.change_requests.length ? `<div class="small" style="margin-top:8px"><b>Change requests:</b> ${q.change_requests.map(c => esc(c.description) + ' (' + esc(c.status) + ')').join('; ')}</div>` : ''}
      ${older.length ? `<details class="plain"><summary class="small">Earlier versions (${older.length})</summary>${older.map(o => `<p class="small">Version ${o.version_no}: ${esc(VSTATUS[o.status])} · ${money2(o.total)}${o.sent_at ? ' · sent ' + esc(P.date(o.sent_at)) : ''}</p>`).join('')}</details>` : ''}</div>`;
  }
  const findV = (id) => { for (const q of W.quotes) { const v = q.versions.find(x => x.id === id); if (v) return [q, v]; } return []; };
  P.act.wQuoteNew = () => {
    const req = W.requests[0];
    P.dialog({ title: 'New quote', ok: 'Create',
      body: req ? `<p class="small muted" style="margin-bottom:8px">Lines start from ${esc(req.ref)}'s quantities (marked as the customer's) with no price until you set one.</p>` : '',
      fields: [{ name: 'title', label: 'Title', value: O.title }, { name: 'scope_summary', label: 'Scope summary', type: 'textarea' },
        ...(req ? [{ name: 'from_request', label: `Start from ${req.ref}`, type: 'checkbox', value: true }] : [])],
      onOk: (v) => P.rpc('create_quote', { p_opportunity: O.id, p: { title: v.title, scope_summary: v.scope_summary, estimate_request_id: v.from_request ? req.id : null } }) })
      .then(v => v && reloadWork('Quote started.'));
  };
  async function lineDialog(versionId, line) {
    const rules = (await P.rpc('pricing_rules_list')).filter(r => r.status === 'approved');
    const units = Object.entries(P.state.catalog.units).map(([k, u]) => [k, u.label]);
    return P.dialog({ title: line ? 'Edit line' : 'Add line', ok: 'Save',
      fields: [
        { name: 'kind', label: 'Type', type: 'select', value: line?.kind || 'work', options: [['work', 'Work'], ['mobilization', 'Mobilization'], ['minimum_charge', 'Minimum charge'], ['after_hours', 'After-hours adjustment'], ['access', 'Access adjustment'], ['scanning', 'Scanning'], ['removal', 'Removal'], ['disposal', 'Disposal'], ['other', 'Other']] },
        { name: 'description', label: 'Description', value: line?.description || '', required: true },
        { name: 'qty', label: 'Quantity', type: 'number', value: line?.qty ?? '', required: true },
        { name: 'unit', label: 'Unit', type: 'select', value: line?.unit || 'ea', options: units },
        { name: 'qty_source', label: 'Where the quantity came from', type: 'select', value: line?.qty_source || 'assumed', options: Object.entries(QSRC) },
        { name: 'pricing_rule_id', label: 'Approved pricing rule', type: 'select', value: line?.pricing_rule_id || '', options: [['', 'None: enter the rate by hand'], ...rules.map(r => [r.id, `${r.description}: ${money2(r.rate)} per ${unitLabel(r.unit)}`])] },
        { name: 'rate', label: 'Rate by hand ($ per unit)', type: 'number', value: line?.rate_source === 'manual' ? line.rate : '', help: 'Used only when no rule is chosen. Marked as entered by hand on the quote.' }],
      onOk: (v) => P.rpc('save_quote_line', { p_version: versionId, p: { ...v, id: line?.id, pricing_rule_id: v.pricing_rule_id || null } }) });
  }
  P.act.wLineAdd = (el) => lineDialog(el.dataset.v).then(v => v && reloadWork('Line saved.'));
  P.act.wLineEdit = (el) => { const [, v] = findV(el.dataset.v); lineDialog(el.dataset.v, v.lines.find(l => l.id === el.dataset.id)).then(r => r && reloadWork('Line saved.')); };
  P.act.wVersionEdit = (el) => {
    const [, v] = findV(el.dataset.v);
    P.dialog({ title: 'Scope, assumptions and validity', ok: 'Save', wide: true,
      fields: [{ name: 'scope_summary', label: 'Scope summary', type: 'textarea', value: v.scope_summary || '' },
        { name: 'assumptions', label: 'Assumptions (one per line)', type: 'textarea', value: v.assumptions.join('\n') },
        { name: 'exclusions', label: 'Exclusions (one per line)', type: 'textarea', value: v.exclusions.join('\n') },
        { name: 'valid_until', label: 'Price valid until', type: 'date', value: v.valid_until || '' }],
      onOk: (x) => P.rpc('update_quote_version', { p_version: v.id, p: { ...x, assumptions: x.assumptions.split('\n'), exclusions: x.exclusions.split('\n') } }) })
      .then(r => r && reloadWork('Saved.'));
  };
  P.act.wApprove = (el) => P.busy(el, async () => { await P.rpc('approve_quote_version', { p_version: el.dataset.v }); await reloadWork('Approved. The version is now frozen.'); });
  P.act.wSent = (el) => P.dialog({ title: 'Record the quote as sent', ok: 'Record',
    body: '<p class="small muted" style="margin-bottom:8px">Send it yourself (email or in person), then record it here. The lead moves to Quote sent.</p>',
    fields: [{ name: 'sent_to', label: 'Sent to', required: true, placeholder: 'Name and email' }, { name: 'sent_method', label: 'How', type: 'select', value: 'email', options: [['email', 'Email'], ['in_person', 'In person'], ['portal', 'Their bid portal'], ['other', 'Other']] },
      { name: 'sent_at', label: 'When', type: 'date', value: P.todayET() }],
    onOk: (v) => P.rpc('mark_quote_sent', { p_version: el.dataset.v, p: v }) }).then(v => v && reloadWork('Recorded as sent.'));
  P.act.wNewVersion = (el) => P.busy(el, async () => { await P.rpc('new_quote_version', { p_from: el.dataset.v }); await reloadWork('New draft version. The earlier one is kept as it was.'); });
  P.act.wChange = (el) => P.dialog({ title: 'Change request', ok: 'Record',
    fields: [{ name: 'description', label: 'What changed', type: 'textarea', required: true }, { name: 'requested_by', label: 'Asked by' }],
    onOk: (v) => P.rpc('record_change_request', { p_quote: el.dataset.q, p: v }) }).then(v => v && reloadWork('Change request recorded. Price it as a new version.'));
  P.act.wAward = () => {
    const sent = W.quotes.flatMap(q => q.versions.filter(v => ['sent', 'accepted', 'rejected'].includes(v.status)).map(v => [v.id, `${q.ref} v${v.version_no} · ${money2(v.total)}`]));
    P.dialog({ title: 'Record the award', ok: 'Record award',
      body: '<p class="small muted" style="margin-bottom:8px">An award is the customer\'s confirmation. It is not an invoice or a payment; those are recorded on the job.</p>',
      fields: [{ name: 'method', label: 'How they confirmed it', type: 'select', value: 'purchase_order', required: true, options: [['purchase_order', 'Purchase order'], ['subcontract', 'Subcontract'], ['signed_quote', 'Signed quote'], ['email', 'Email'], ['verbal', 'Verbal (follow up in writing)']] },
        { name: 'reference', label: 'PO, contract or email reference' }, { name: 'quote_version_id', label: 'Quote version accepted', type: 'select', value: sent[0]?.[0] || '', options: sent },
        { name: 'confirmed_on', label: 'Confirmed on', type: 'date', value: P.todayET() }, { name: 'requested_start', label: 'Requested start', type: 'date' },
        { name: 'note', label: 'Customer requirements or notes', type: 'textarea' }],
      onOk: (v) => P.rpc('record_award', { p_opportunity: O.id, p: v }) }).then(v => v && (P.reloadLead ? P.reloadLead('Award recorded. A job is ready for the handoff.') : reloadWork('Award recorded.')));
  };

  // ---------------------------------------------------------------- award, job, money
  function moneyPanel(can) {
    const m = W.money; if (!m) return '';
    const row = [['Quoted', m.quoted], ['Awarded', m.awarded], ['Completed', m.completed], ['Invoiced', m.invoiced], ['Collected', m.collected]];
    if (row.every(([, v]) => v == null) && !m.jobs.length) return '';
    return `<div class="panel"><h3>Award, job and money</h3>
      <div class="metricgrid wide5">${row.map(([k, v]) => `<div class="metric"><span class="small muted">${k}</span><b>${v == null ? '—' : money2(v)}</b></div>`).join('')}</div>
      ${m.warnings.length ? `<ul class="flags">${m.warnings.map(w => `<li class="block">${esc(w)}</li>`).join('')}</ul>` : ''}
      ${m.jobs.map(j => `<div class="quote"><div class="qhead"><b>${esc(j.ref)}</b> <span class="badge ${j.status === 'completed' ? 'ok' : 'outline'}">${esc(JSTATUS[j.status])}</span>
        <span class="small muted">${j.scheduled_start ? 'scheduled ' + esc(P.date(j.scheduled_start)) : ''}${j.handoff_reviewed ? ' · handoff reviewed' : ' · handoff not reviewed'}</span></div>
        <button class="btn sm" data-act="wJob" data-id="${j.id}">Open job</button></div>`).join('')}
      ${m.attribution.length ? `<p class="small" style="margin-top:8px"><b>Credit:</b> ${m.attribution.map(a => `${esc(a.role)}: ${esc(a.name || '')}${a.share < 1 ? ` (${Math.round(a.share * 100)}%)` : ''}`).join(' · ')}
        ${can ? ` <button class="btn ghost sm" data-act="wAttr">Change</button>` : ''}</p>` : ''}</div>`;
  }
  P.act.wAttr = () => P.dialog({ title: 'Who gets credit', ok: 'Save',
    body: '<p class="small muted" style="margin-bottom:8px">Used by commission calculations. Credit is split only as recorded here.</p>',
    fields: [{ name: 'role', label: 'Role', type: 'select', value: 'sourced', options: [['sourced', 'Sourced the lead'], ['developed', 'Developed it'], ['quoted', 'Quoted it'], ['closed', 'Closed it']] },
      { name: 'user_id', label: 'Person', type: 'select', options: [['', 'Someone without a login (type below)'], ...W.members.map(x => [x.id, x.name])] },
      { name: 'person_name', label: 'Name (if no login)' }, { name: 'share', label: 'Share (0 to 1)', type: 'number', value: 1 }],
    onOk: (v) => P.rpc('set_attribution', { p_opportunity: O.id, p: { ...v, user_id: v.user_id || null } }) }).then(v => v && reloadWork('Credit saved.'));
  P.act.wJob = async (el) => {
    const j = await P.rpc('get_job', { p_id: el.dataset.id }); const h = j.handoff || {};
    const ln = (h.accepted_scope?.lines || []).map(l => `<li>${esc(l.description)}: ${esc(String(l.qty))} ${esc(unitLabel(l.unit))} <span class="muted">(${esc(QSRC[l.qty_source] || l.qty_source)})</span></li>`).join('');
    const site = h.site || {};
    const done = await P.dialog({ title: `Job ${j.ref}`, wide: true, ok: null, cancel: 'Close', body: `
      <p><span class="badge outline">${esc(JSTATUS[j.status])}</span> ${j.amount != null ? money2(j.amount) : 'No amount'} ${j.scheduled_start ? `· scheduled ${esc(P.date(j.scheduled_start))} (confirmed by ${esc(j.schedule_source)})` : ''}</p>
      <h4>Handoff</h4>
      <p class="small"><b>Customer:</b> ${esc(h.customer?.company || '')} ${(h.customer?.contacts || []).map(c => `· ${esc(c.name || '')}${c.phone ? ' ' + esc(c.phone) : ''}`).join(' ')}</p>
      <p class="small"><b>Site:</b> ${esc([site.address, site.city].filter(Boolean).join(', ') || 'not recorded')}${site.site_contact ? ` · site contact ${esc(site.site_contact.name || '')} ${esc(site.site_contact.phone || '')}` : ''}</p>
      <p class="small"><b>Conditions:</b> hours ${esc(site.working_hours || 'unknown')} · power ${esc(site.power || 'unknown')} · water ${esc(site.water || 'unknown')} · removal ${esc(site.removal || 'unknown')}${site.access ? ' · ' + esc(site.access) : ''}</p>
      ${h.accepted_scope ? `<p class="small"><b>Accepted scope:</b> ${esc(h.accepted_scope.quote_ref)} v${h.accepted_scope.version_no} · ${money2(h.accepted_scope.total)}</p><ul class="small">${ln}</ul>` : '<p class="small warn-text">No accepted quote version is linked.</p>'}
      ${(h.unresolved || []).length ? `<p class="small"><b>Unresolved:</b></p><ul class="flags">${h.unresolved.map(u => `<li class="review">${esc(u)}</li>`).join('')}</ul>` : ''}
      <p class="small muted">${esc(h.scheduling?.note || '')}</p>
      <h4>Invoices</h4>${j.invoices.length ? j.invoices.map(i => `<p class="small">${esc(i.number)} · ${money2(i.amount)} · issued ${esc(P.date(i.issued_on))} · paid ${money2(i.paid)} · balance ${money2(i.balance)} ${i.status === 'void' ? '(void)' : `<button class="btn ghost sm" data-act="wPay" data-id="${i.id}">Record payment</button>`}</p>`).join('') : '<p class="small muted">None.</p>'}
      <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:10px">
        ${j.handoff_reviewed_at ? '' : `<button class="btn sm" data-act="wJobSet" data-id="${j.id}" data-op="review">Mark handoff reviewed</button>`}
        ${['ready_for_scheduling'].includes(j.status) ? `<button class="btn sm" data-act="wJobSet" data-id="${j.id}" data-op="schedule">Record the scheduled date</button>` : ''}
        ${['scheduled', 'in_progress'].includes(j.status) ? `<button class="btn sm" data-act="wJobSet" data-id="${j.id}" data-op="complete">Mark completed</button>` : ''}
        <button class="btn sm" data-act="wJobSet" data-id="${j.id}" data-op="invoice">Add invoice</button></div>` });
    return done;
  };
  P.act.wJobSet = (el) => {
    const id = el.dataset.id, op = el.dataset.op;
    document.querySelector('dialog[open] [data-x]')?.click();
    const after = () => reloadWork('Job updated.');
    if (op === 'review') return P.rpc('update_job', { p_id: id, p: { handoff_reviewed: true } }).then(after);
    if (op === 'schedule') return P.dialog({ title: 'Scheduled date', ok: 'Save', body: '<p class="small muted" style="margin-bottom:8px">Only a date dispatch has confirmed. The portal does not book crews.</p>',
      fields: [{ name: 'scheduled_start', label: 'Date', type: 'date', required: true }, { name: 'schedule_source', label: 'Confirmed by', required: true, placeholder: 'Dispatch, name' }],
      onOk: (v) => P.rpc('update_job', { p_id: id, p: { status: 'scheduled', ...v } }) }).then(v => v && after());
    if (op === 'complete') return P.dialog({ title: 'Job completed', ok: 'Save', fields: [{ name: 'completed_on', label: 'Completed on', type: 'date', value: P.todayET(), required: true },
      { name: 'follow_up_on', label: 'Check in with the customer on', type: 'date', help: 'Default: 60 days after completion.' }],
      onOk: (v) => P.rpc('update_job', { p_id: id, p: { status: 'completed', ...v } }) }).then(v => v && after());
    if (op === 'invoice') return P.dialog({ title: 'Add invoice', ok: 'Save', fields: [{ name: 'number', label: 'Invoice number', required: true }, { name: 'amount', label: 'Amount ($)', type: 'number', required: true },
      { name: 'issued_on', label: 'Issued on', type: 'date', value: P.todayET(), required: true }, { name: 'due_on', label: 'Due on', type: 'date' }],
      onOk: (v) => P.rpc('save_invoice', { p_job: id, p: v }) }).then(v => v && after());
  };
  P.act.wPay = (el) => { document.querySelector('dialog[open] [data-x]')?.click(); P.dialog({ title: 'Record a payment', ok: 'Save',
    fields: [{ name: 'amount', label: 'Amount ($; negative for a credit or refund)', type: 'number', required: true }, { name: 'received_on', label: 'Received on', type: 'date', value: P.todayET(), required: true },
      { name: 'method', label: 'Method', placeholder: 'Check, ACH' }, { name: 'reference', label: 'Reference' }],
    onOk: (v) => P.rpc('record_payment', { p_invoice: el.dataset.id, p: v }) }).then(v => v && reloadWork('Payment recorded.')); };

  // ---------------------------------------------------------------- files
  function docsPanel(can) {
    if (!W.full_access) return '';
    return `<div class="panel"><h3>Files <span class="n faint">${W.documents.length}</span>${can ? `<span class="tools"><label class="btn sm">${P.icon('plus', 'sm')}Add file<input type="file" hidden data-upload="opportunity_id" accept=".pdf,.jpg,.jpeg,.png,.heic,.webp,.tif,.tiff,.xlsx,.xls,.docx,.doc,.csv,.txt,.dwg"></label></span>` : ''}</h3>
      ${W.documents.length ? `<ul class="wl">${W.documents.map(d => `<li><div class="grow"><b>${esc(d.title)}</b><div class="small muted">${esc(d.kind)} · revision ${d.revisions[0].rev_no} · ${esc(P.date(d.revisions[0].uploaded_at))}${d.revisions[0].by ? ' · ' + esc(d.revisions[0].by) : ''}</div></div>
        <button class="btn sm" data-act="wDownload" data-path="${esc(d.revisions[0].path)}">Open</button></li>`).join('')}</ul>` : '<p class="muted small">Drawings, photos, purchase orders. Stored privately; links last one minute.</p>'}</div>`;
  }
  P.uploadFile = async (file, parent) => {
    const buf = await file.arrayBuffer();
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(x => x.toString(16).padStart(2, '0')).join('');
    const reg = await P.rpc('add_document_revision', { p: { ...parent, filename: file.name, title: file.name, mime: file.type || 'application/octet-stream', bytes: file.size, sha256: sha,
      kind: file.type.startsWith('image/') ? 'photo' : /\.(pdf|dwg)$/i.test(file.name) ? 'drawing' : 'other' } });
    if (reg.duplicate) return 'That file is already attached.';
    const up = await P.sb.storage.from('documents').upload(reg.path, file, { contentType: file.type, upsert: false });
    if (up.error) throw new Error('Upload failed: ' + up.error.message);
    await P.rpc('confirm_document_revision', { p_revision: reg.revision_id });
    return 'File added.';
  };
  document.addEventListener('change', async (e) => {
    const el = e.target.closest?.('input[data-upload]'); if (!el || !el.files?.length) return;
    try { const msg = await P.uploadFile(el.files[0], { [el.dataset.upload]: el.dataset.id || O.id }); el.dataset.id ? P.toast(msg) : await reloadWork(msg); }
    catch (err) { P.toast(err.message, 'error'); } finally { el.value = ''; }
  });
  P.act.wDownload = async (el) => {
    const { data, error } = await P.sb.storage.from('documents').createSignedUrl(el.dataset.path, 60);
    if (error) return P.toast('Could not open the file: ' + error.message, 'error');
    window.open(data.signedUrl, '_blank', 'noopener');
  };

  function peoplePanel() {
    const ps = (W.participants || []).filter(x => x.current);
    if (!ps.length) return '';
    return `<div class="panel"><h3>Companies on this project <span class="n faint">${ps.length}</span></h3><div class="tablewrap"><table class="tbl"><thead><tr><th>Company</th><th>Role</th><th class="num">Bid</th><th>Source</th></tr></thead><tbody>
      ${ps.map(x => `<tr><td>${esc(x.name)}${x.our_lead ? ` <a class="small" href="#/today?lead=${x.our_lead.id}" data-lead="${x.our_lead.id}">${esc(x.our_lead.ref)}</a>` : ''}</td><td>${esc(ROLE[x.role] || x.role)}${x.rank ? ' #' + x.rank : ''}</td>
        <td class="num">${x.amount != null ? esc(P.money(x.amount)) : ''}</td><td class="small">${x.source_url ? `<a href="${P.url(x.source_url)}" target="_blank" rel="noopener">${esc(x.source_name || 'source')}</a>` : esc(x.source_name || '')}${x.as_of ? ' · ' + esc(P.date(x.as_of)) : ''}</td></tr>`).join('')}
      </tbody></table></div><p class="small muted">Each bidder is its own row. The project's value is counted once, not per bidder.</p></div>`;
  }

  // ---------------------------------------------------------------- Tasks page
  P.views.tasks = async (view) => {
    view.innerHTML = P.pageHead({ title: 'Tasks', sub: 'Calls, follow-ups and estimating work assigned to you, in time order (Eastern time).' }) + `<div id="tk_body">${P.skeleton(6)}</div>`;
    const list = await P.rpc('task_list', { p: {} });
    const now = Date.now(), endToday = new Date(P.todayET() + 'T23:59:59-05:00').getTime();
    const groups = [['Overdue', list.filter(t => t.due_at && new Date(t.due_at) < now)], ['Today', list.filter(t => t.due_at && new Date(t.due_at) >= now && new Date(t.due_at) <= endToday)],
      ['Coming up', list.filter(t => t.due_at && new Date(t.due_at) > endToday)], ['No date', list.filter(t => !t.due_at)]].filter(g => g[1].length);
    $('tk_body').innerHTML = groups.length ? groups.map(([g, ts]) => `<div class="panel"><h3>${g} <span class="n faint">${ts.length}</span></h3><ul class="wl">${ts.map(t => `<li class="${t.overdue ? 'overdue' : ''}">
      <div class="grow"><b>${esc(t.title)}</b><div class="small muted">${t.due_at ? esc(P.dateTime(t.due_at)) : ''}${t.opportunity ? ` · <a href="#/tasks?lead=${t.opportunity.id}" data-lead="${t.opportunity.id}">${esc(t.opportunity.ref)} ${esc(t.opportunity.title)}</a>` : ''}${t.company && !t.opportunity ? ' · ' + esc(t.company.name) : ''}</div>
      ${t.contact ? `<div class="small">${esc(t.contact.name || '')}${t.contact.do_not_contact ? ' <span class="badge later">Do not contact</span>' : ''}${t.contact.phone ? ` · <a href="tel:${esc(t.contact.phone.replace(/[^\d+]/g, ''))}">${esc(t.contact.phone)}</a>` : ''}${t.contact.email ? ` · <a href="mailto:${esc(t.contact.email)}">${esc(t.contact.email)}</a>` : ''}</div>` : ''}</div>
      <button class="btn sm" data-act="tkDone" data-id="${t.id}" data-origin="${t.origin}">Done</button></li>`).join('')}</ul></div>`).join('')
      : P.empty('Nothing assigned', 'Tasks come from the next step on your leads, estimate requests and job follow-ups.');
  };
  P.act.tkDone = (el) => { O = { no_action_reason: null }; P.act.wTaskDone(el); };

  // ---------------------------------------------------------------- Estimate requests page
  P.views.requests = async (view, args) => {
    const id = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
    if (id) return requestDetail(view, id);
    view.innerHTML = P.pageHead({ title: 'Estimate requests', sub: 'What contractors asked to have priced. A request is not an estimate or a booking.',
      actions: '<button class="btn primary" data-act="erNew">New request</button>' }) + `<div id="er_body">${P.skeleton(6)}</div>`;
    const list = await P.rpc('estimate_requests', { p: {} });
    $('er_body').innerHTML = list.length ? `<div class="card">${list.map(r => `<a class="li" href="#/requests?id=${r.id}"><div class="grow"><b>${esc(r.ref)} · ${esc(r.company)}</b>
      <div class="small muted">${esc((r.services || []).join(', '))} · ${esc(r.job_address || 'no address')}${r.requested_date ? ' · wanted ' + esc(P.date(r.requested_date)) : ''}</div></div>
      <span class="badge ${r.status === 'ready' ? 'accent' : r.status === 'missing_info' ? 'warm' : 'outline'}">${esc(r.status.replace('_', ' '))}${r.missing_count ? ' · ' + r.missing_count : ''}</span></a>`).join('')}</div>`
      : P.empty('No requests yet', 'Requests arrive from the estimate request app once it is connected (Workspace settings, Integrations), or add one from a phone call.');
  };
  async function requestDetail(view, id) {
    view.innerHTML = P.skeleton(6);
    const [r] = await Promise.all([P.rpc('get_estimate_request', { p_id: id }), catalog()]);
    const files = await P.rpc('list_documents', { p: { estimate_request_id: id } });
    const ans = (it) => (it.fields || []).map(f => {
      const a = it.answers[f.key]; if (a == null || a === '') return '';
      const v = typeof a === 'object' ? `${a.value} ${unitLabel(a.unit)}` : String(a).replace(/_/g, ' ');
      return `<dt>${esc(f.label)}</dt><dd>${esc(v)}</dd>`;
    }).join('');
    view.innerHTML = P.pageHead({ title: `${r.ref} · ${r.company_name}`, sub: esc(r.disclaimer),
      actions: `<a class="btn" href="#/requests">All requests</a>${r.opportunity_id ? `<a class="btn" href="#/requests?id=${id}&lead=${r.opportunity_id}" data-lead="${r.opportunity_id}">Open lead</a>` : ''}
        ${r.quotes.length ? '' : `<button class="btn primary" data-act="erQuote" data-id="${id}" data-opp="${r.opportunity_id}">Start the quote</button>`}` }) +
      `${r.is_fixture ? '<div class="alert warn">Test fixture: example data, not a real customer.</div>' : ''}
      <div class="grid2"><div>
        ${r.missing.length ? `<div class="panel"><h3>Missing before pricing</h3><ul class="checks">${r.missing.map(m => `<li><label class="check"><input type="checkbox" data-miss="${esc(m.field)}"><span>${esc(m.scope)}: ${esc(m.label)}</span></label></li>`).join('')}</ul>
          <button class="btn sm" data-act="erResolve" data-id="${id}">Mark checked items resolved</button></div>` : '<div class="panel"><h3>Missing before pricing</h3><p class="small">Nothing.</p></div>'}
        ${r.items.map(it => `<div class="panel"><h3>${esc(it.service)}</h3><dl class="facts">${ans(it) || '<dd class="muted">No answers.</dd>'}</dl>${it.notes ? `<p class="small">${esc(it.notes)}</p>` : ''}<p class="small muted">Quantities as the customer gave them.</p></div>`).join('')}
      </div><div>
        <div class="panel"><h3>Requester</h3><p>${esc(r.contact_name || '')}${r.contact_phone ? ` · <a href="tel:${esc(r.contact_phone.replace(/[^\d+]/g, ''))}">${esc(r.contact_phone)}</a>` : ''}${r.contact_email ? ` · <a href="mailto:${esc(r.contact_email)}">${esc(r.contact_email)}</a>` : ''}</p><p class="small muted">Contact details as given by the requester (not verified).</p></div>
        <div class="panel"><h3>Job</h3><dl class="facts"><dt>Address</dt><dd>${r.job_address ? `<a href="https://maps.google.com/?q=${encodeURIComponent([r.job_address, r.job_city, 'FL'].filter(Boolean).join(', '))}" target="_blank" rel="noopener">${esc([r.job_address, r.job_city].filter(Boolean).join(', '))}</a>` : 'Not given'}</dd>
          <dt>Requested date</dt><dd>${r.requested_date ? esc(P.date(r.requested_date)) + (r.requested_date_flexible ? ' (flexible)' : '') : 'Not given'}</dd>
          <dt>Hours</dt><dd>${esc(r.working_hours || 'unknown')}</dd><dt>Power / water</dt><dd>${esc(r.power_available || 'unknown')} / ${esc(r.water_available || 'unknown')}</dd>
          <dt>Removal</dt><dd>${esc(r.removal_required || 'unknown')}${r.disposal_notes ? ' · ' + esc(r.disposal_notes) : ''}</dd>${r.access_notes ? `<dt>Access</dt><dd>${esc(r.access_notes)}</dd>` : ''}
          ${r.site_contact ? `<dt>Site contact</dt><dd>${esc(r.site_contact.name || '')} ${esc(r.site_contact.phone || '')}</dd>` : ''}</dl>${r.notes ? `<p class="small">${esc(r.notes)}</p>` : ''}</div>
        <div class="panel"><h3>Files <span class="tools"><label class="btn sm">${P.icon('plus', 'sm')}Add<input type="file" hidden data-upload="estimate_request_id" data-id="${id}"></label></span></h3>
          ${files.length ? `<ul class="wl">${files.map(d => `<li><div class="grow">${esc(d.title)}</div><button class="btn sm" data-act="wDownload" data-path="${esc(d.revisions[0].path)}">Open</button></li>`).join('')}</ul>` : '<p class="small muted">No photos or drawings yet.</p>'}</div>
      </div></div>`;
  }
  P.act.erResolve = (el) => P.busy(el, async () => {
    const fields = [...document.querySelectorAll('[data-miss]:checked')].map(x => x.dataset.miss);
    if (!fields.length) throw new Error('Tick what has been resolved.');
    await P.rpc('update_estimate_request', { p_id: el.dataset.id, p: { resolved: fields } }); P.toast('Updated.'); P.route();
  });
  P.act.erQuote = (el) => P.busy(el, async () => {
    await P.rpc('create_quote', { p_opportunity: el.dataset.opp, p: { estimate_request_id: el.dataset.id } });
    P.toast('Quote started with the customer\'s quantities. Price each line.'); P.openLead?.(el.dataset.opp); P.state.leadTab = 'work';
  });
  P.act.erNew = async () => {
    const cat = await catalog();
    const svc = cat.services.filter(s => s.active && s.fields.length);
    const pick = await P.dialog({ title: 'New estimate request', ok: 'Next', fields: [{ name: 'service', label: 'Service', type: 'select', options: svc.map(s => [s.key, s.name]) }] });
    if (!pick) return;
    const s = svc.find(x => x.key === pick.service);
    const fields = [
      { name: 'company', label: 'Contractor company', required: true }, { name: 'contact_name', label: 'Contact name' }, { name: 'contact_phone', label: 'Phone', type: 'tel' },
      { name: 'contact_email', label: 'Email', type: 'email' }, { name: 'address', label: 'Job address' }, { name: 'city', label: 'City' },
      { name: 'requested_date', label: 'Requested date', type: 'date' },
      ...s.fields.flatMap(f => ['length', 'area', 'volume', 'count', 'thickness', 'diameter', 'depth', 'time'].includes(f.dimension)
        ? [{ name: 'v_' + f.key, label: f.label, type: 'number', required: f.required }, { name: 'u_' + f.key, label: f.label + ': unit', type: 'select', value: f.units[0], options: f.units.map(u => [u, unitLabel(u)]) }]
        : f.dimension === 'choice' ? [{ name: 'c_' + f.key, label: f.label, type: 'select', options: [['', 'Not known'], ...(f.options || []).map(o => [o, o.replace(/_/g, ' ')])] }]
        : f.dimension === 'boolean' ? [{ name: 'b_' + f.key, label: f.label, type: 'checkbox' }] : [{ name: 't_' + f.key, label: f.label }]),
      { name: 'notes', label: 'Notes', type: 'textarea' }];
    const v = await P.dialog({ title: `New request: ${s.name}`, ok: 'Save request', wide: true, fields,
      onOk: (x) => {
        const answers = {};
        for (const f of s.fields) {
          if (x['v_' + f.key] !== undefined && x['v_' + f.key] !== '') answers[f.key] = { value: Number(x['v_' + f.key]), unit: x['u_' + f.key] };
          if (x['c_' + f.key]) answers[f.key] = x['c_' + f.key];
          if (x['b_' + f.key]) answers[f.key] = true;
          if (x['t_' + f.key]) answers[f.key] = x['t_' + f.key];
        }
        return P.rpc('submit_estimate_request', { p: { idempotency_key: 'manual-' + crypto.randomUUID(), company: { name: x.company },
          contact: { name: x.contact_name, phone: x.contact_phone, email: x.contact_email }, job: { address: x.address, city: x.city, requested_date: x.requested_date || null },
          items: [{ service: s.key, answers }], notes: x.notes } });
      } });
    if (v) { P.toast('Request saved. An estimating task was created.'); P.route(); }
  };

  // ---------------------------------------------------------------- Money page
  P.views.money = async (view) => {
    const yr = new Date().getFullYear();
    view.innerHTML = P.pageHead({ title: 'Money and commission', sub: 'Your credited work, calculated only from recorded awards, jobs, invoices and payments.' }) +
      `<div class="toolbar row" style="gap:8px;flex-wrap:wrap"><label class="field inline"><span>From</span><input type="date" id="mn_from" value="${yr}-01-01"></label><label class="field inline"><span>To</span><input type="date" id="mn_to" value="${P.todayET()}"></label>
       <label class="field inline"><span>What-if rate %</span><input type="number" id="mn_rate" step="0.1" min="0" placeholder="none"></label><button class="btn" data-act="mnRun">Show</button><button class="btn" data-act="mnAgreement">Record an agreement</button></div><div id="mn_body">${P.skeleton(4)}</div>`;
    P.act.mnRun();
  };
  P.act.mnRun = async () => {
    const rate = $('mn_rate').value;
    const r = await P.rpc('commission_report', { p: { from: $('mn_from').value, to: $('mn_to').value, scenario_rate: rate ? Number(rate) / 100 : null } });
    const ST = { owed: 'Owed under agreement', scenario: 'Scenario (what-if)', not_eligible: 'Not eligible', needs_cost: 'Needs job cost', no_agreement: 'No agreement' };
    $('mn_body').innerHTML = `${r.note ? `<div class="alert warn">${esc(r.note)}</div>` : ''}
      <div class="metricgrid"><div class="metric"><span class="small muted">Owed under recorded agreements</span><b>${money2(r.owed)}</b></div>${r.scenario ? `<div class="metric"><span class="small muted">Scenario only (not owed)</span><b>${money2(r.scenario)}</b></div>` : ''}</div>
      <div class="panel"><h3>Lines</h3>${r.lines.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th>Date</th><th>Lead</th><th>From</th><th class="num">Base</th><th class="num">Rate</th><th class="num">Share</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>
        ${r.lines.map(l => `<tr><td>${esc(P.date(l.date))}</td><td><a href="#/money?lead=${l.opportunity_id}" data-lead="${l.opportunity_id}">${esc(l.ref)}</a> ${esc(l.company || '')}${l.repeat ? ' <span class="small muted">(repeat)</span>' : ''}</td>
          <td>${esc(l.event)}: ${esc(l.record_type)}</td><td class="num">${money2(l.base)}</td><td class="num">${l.rate != null ? (l.rate * 100).toFixed(2) + '%' : ''}</td><td class="num">${Math.round(l.share * 100)}%</td>
          <td class="num">${money2(l.amount)}</td><td>${esc(ST[l.status] || l.status)}${l.agreement ? `<div class="small muted">${esc(l.agreement)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted small">No credited awards, jobs, invoices or payments in this range.</p>'}</div>
      <div class="panel"><h3>Agreements on record</h3>${r.agreements.length ? r.agreements.map(a => `<p class="small"><b>${esc(a.title)}</b> · ${esc(a.status)} · ${esc(a.basis.replace('_', ' '))} on ${esc(a.trigger_event)} · first job ${(a.first_job_rate * 100).toFixed(2)}%, repeat ${(a.repeat_rate * 100).toFixed(2)}% · from ${esc(P.date(a.effective_from))}${a.effective_to ? ' to ' + esc(P.date(a.effective_to)) : ''}${a.approved_by_name ? ` · approved by ${esc(a.approved_by_name)} ${esc(P.date(a.approved_on))}` : ' · not approved'}</p>`).join('') : '<p class="muted small">None. Without one, nothing is calculated as owed.</p>'}</div>`;
  };
  P.act.mnAgreement = () => P.dialog({ title: 'Record a commission agreement', ok: 'Save', wide: true,
    body: '<p class="small muted" style="margin-bottom:8px">Enter only what was actually agreed. It counts as owed only when active with who approved it and when.</p>',
    fields: [{ name: 'title', label: 'Name', required: true }, { name: 'status', label: 'Status', type: 'select', value: 'draft', options: [['draft', 'Draft (proposal)'], ['active', 'Active (approved)'], ['ended', 'Ended']] },
      { name: 'effective_from', label: 'Effective from', type: 'date', required: true }, { name: 'effective_to', label: 'Effective to', type: 'date' },
      { name: 'basis', label: 'Calculated on', type: 'select', options: [['revenue', 'Revenue'], ['gross_profit', 'Gross profit (define below)']] },
      { name: 'profit_definition', label: 'Profit definition (for gross profit)' },
      { name: 'trigger_event', label: 'Earned when', type: 'select', value: 'collected', options: [['booked', 'Award booked'], ['completed', 'Job completed'], ['invoiced', 'Invoiced'], ['collected', 'Payment collected']] },
      { name: 'first_job_rate', label: 'First-job rate %', type: 'number', required: true }, { name: 'repeat_rate', label: 'Repeat-business rate %', type: 'number', required: true },
      { name: 'approved_by_name', label: 'Approved by (name)' }, { name: 'approved_on', label: 'Approved on', type: 'date' }, { name: 'document_note', label: 'Where the signed agreement is' }],
    onOk: (v) => P.rpc('save_commission_agreement', { p: { ...v, first_job_rate: Number(v.first_job_rate) / 100, repeat_rate: Number(v.repeat_rate) / 100, effective_to: v.effective_to || null } }) })
    .then(v => v && P.act.mnRun());

  // ---------------------------------------------------------------- Workspace settings
  P.views.settings = async (view) => {
    view.innerHTML = P.pageHead({ title: 'Workspace settings', sub: 'Branding, services, pricing rules and integrations for the current workspace.' }) + `<div id="ws_body">${P.skeleton(6)}</div>`;
    P.state.catalog = null;
    const w = P.ws(); const mgr = ['owner', 'manager'].includes(w?.role);
    const [cat, rules, ints] = await Promise.all([catalog(), P.rpc('pricing_rules_list'), mgr ? P.rpc('list_integrations').catch(() => []) : []]);
    const b = w?.branding || {};
    $('ws_body').innerHTML = `
      <div class="panel"><h3>Branding${mgr ? `<span class="tools"><button class="btn sm" data-act="wsBrand">Edit</button></span>` : ''}</h3>
        <dl class="facts"><dt>Workspace</dt><dd>${esc(w?.name || '')} (${w?.kind === 'personal' ? 'private to you' : 'shared'})</dd><dt>Company name on drafts</dt><dd>${esc(b.display_name || '')}</dd><dt>Short name</dt><dd>${esc(b.short_name || '')}</dd><dt>Phone on drafts</dt><dd>${esc(b.phone || 'not set')}</dd></dl></div>
      <div class="panel"><h3>Services offered</h3><ul class="wl">${cat.services.map(s => `<li><div class="grow"><b>${esc(s.name)}</b><div class="small muted">${esc(s.description)}${s.fields.length ? ` · asks ${s.fields.length} question${s.fields.length === 1 ? '' : 's'}` : ''}</div></div>
        ${mgr ? `<button class="btn sm" data-act="wsSvc" data-key="${s.key}" data-on="${!s.active}">${s.active ? 'Turn off' : 'Turn on'}</button>` : `<span class="badge ${s.active ? 'ok' : 'outline'}">${s.active ? 'On' : 'Off'}</span>`}</li>`).join('')}</ul></div>
      <div class="panel"><h3>Pricing rules <span class="tools"><button class="btn sm" data-act="wsRule">${P.icon('plus', 'sm')}Propose a rule</button></span></h3>
        <p class="small muted">Rates are entered by people with the authority to set them. A rule prices quote lines only after a workspace manager approves it. Approved rules are retired and replaced, not edited.</p>
        ${rules.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th>Rule</th><th class="num">Rate</th><th>Unit</th><th>Status</th><th></th></tr></thead><tbody>${rules.map(r => `<tr><td>${esc(r.description)}<div class="small muted">${esc(r.service_key)} · ${esc(r.kind)}${r.conditions ? ' · ' + esc(r.conditions) : ''}</div></td>
          <td class="num">${money2(r.rate)}</td><td>${esc(unitLabel(r.unit))}</td><td>${esc(r.status)}${r.approved_by_name ? `<div class="small muted">${esc(r.approved_by_name)}</div>` : ''}</td>
          <td>${mgr ? (r.status === 'draft' ? `<button class="btn sm" data-act="wsRuleSet" data-id="${r.id}" data-s="approved">Approve</button>` : `<button class="btn ghost sm" data-act="wsRuleSet" data-id="${r.id}" data-s="retired">Retire</button>`) : ''}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted small">No pricing rules. Quote lines are priced by hand and marked that way until rules are approved.</p>'}</div>
      ${mgr ? `<div class="panel"><h3>Integrations <span class="tools"><button class="btn sm" data-act="wsInt">${P.icon('plus', 'sm')}Create a key</button></span></h3>
        <p class="small muted">The estimate request app sends requests to the estimate-intake endpoint with a key. Not connected until a key is created and configured in that app. See docs/ESTIMATE_INTAKE.md.</p>
        ${ints.length ? ints.map(i => `<div class="quote"><b>${esc(i.name)}</b> <span class="small muted">key ending ${esc(i.key_hint)} · ${i.active ? 'on' : 'off'} · ${i.max_per_hour}/hour · ${i.last_used_at ? 'last used ' + esc(P.dateTime(i.last_used_at)) : 'never used'}</span>
          <button class="btn ghost sm" data-act="wsIntToggle" data-id="${i.id}" data-on="${!i.active}">${i.active ? 'Turn off' : 'Turn on'}</button>
          ${i.recent.length ? `<ul class="small">${i.recent.map(e => `<li>${esc(P.dateTime(e.at))} · ${esc(e.outcome)}${e.detail ? ' · ' + esc(e.detail) : ''}</li>`).join('')}</ul>` : ''}</div>`).join('') : '<p class="muted small">No keys.</p>'}</div>` : ''}`;
  };
  P.act.wsBrand = () => { const w = P.ws(), b = w.branding || {};
    P.dialog({ title: 'Branding', ok: 'Save', fields: [{ name: 'display_name', label: 'Company name (on drafts)', value: b.display_name || '', required: true }, { name: 'short_name', label: 'Short name', value: b.short_name || '' },
      { name: 'phone', label: 'Phone on drafts', value: b.phone || '' }],
      onOk: async (v) => { P.state.ws = await P.rpc('update_workspace', { p_id: w.id, p: { branding: v } }); } }).then(v => { if (v) { P.renderShell(); P.route(); P.toast('Saved.'); } }); };
  P.act.wsSvc = (el) => P.busy(el, async () => { const s = P.state.catalog.services.find(x => x.key === el.dataset.key);
    await P.rpc('save_service', { p: { key: s.key, name: s.name, description: s.description, active: el.dataset.on === 'true' } }); P.route(); });
  P.act.wsRule = async () => { const cat = await catalog();
    P.dialog({ title: 'Propose a pricing rule', ok: 'Save as draft', fields: [
      { name: 'service_key', label: 'Service', type: 'select', options: cat.services.map(s => [s.key, s.name]) },
      { name: 'kind', label: 'Type', type: 'select', value: 'work', options: [['work', 'Work'], ['mobilization', 'Mobilization'], ['minimum_charge', 'Minimum charge'], ['after_hours', 'After hours'], ['access', 'Access'], ['scanning', 'Scanning'], ['removal', 'Removal'], ['disposal', 'Disposal']] },
      { name: 'description', label: 'Description', required: true, placeholder: 'Core 2 to 6 in, up to 12 in deep' }, { name: 'rate', label: 'Rate ($)', type: 'number', required: true },
      { name: 'unit', label: 'Per', type: 'select', value: 'ea', options: Object.entries(cat.units).map(([k, u]) => [k, u.label]) }, { name: 'conditions', label: 'When it applies' }],
      onOk: (v) => P.rpc('save_pricing_rule', { p: v }) }).then(v => v && P.route()); };
  P.act.wsRuleSet = (el) => P.busy(el, async () => { await P.rpc('save_pricing_rule', { p: { id: el.dataset.id, status: el.dataset.s } }); P.route(); });
  P.act.wsInt = () => P.dialog({ title: 'Create an integration key', ok: 'Create', fields: [{ name: 'name', label: 'Name', value: 'Estimate request app' }],
    onOk: async (v) => { const k = await P.rpc('create_integration', { p_name: v.name }); P.state.newKey = k.key; } })
    .then(v => v && P.dialog({ title: 'Copy the key now', ok: null, cancel: 'Done', body: `<p class="small">It is shown once and stored only as a hash.</p><pre class="draft">${esc(P.state.newKey)}</pre>
      <button class="btn sm" data-act="copyText" data-text="${esc(P.state.newKey)}">Copy</button>` }).then(() => { P.state.newKey = null; P.route(); }));
  P.act.wsIntToggle = (el) => P.busy(el, async () => { await P.rpc('set_integration_active', { p_id: el.dataset.id, p_active: el.dataset.on === 'true' }); P.route(); });
})();
