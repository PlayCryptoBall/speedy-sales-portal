// Early signals: private projects found before the permit (property sales, rezonings, site and design plans),
// with the companies and people behind each one. Tracking a signal turns it into a lead in the tracker's pipeline.
(() => {
  const P = window.P, esc = P.esc;
  const TYPE = { land_sale: 'Property sale', rezoning: 'Rezoning or land use', site_plan: 'Site or design plan', permit: 'Permit' };
  const STAGE = { land: 'Land acquired', planning: 'Entitlement', design: 'Design and site plan' };
  const ROLE = { owner: 'Owner', buyer: 'Buyer', seller: 'Seller', applicant: 'Contact', developer: 'Developer', engineer: 'Civil engineer',
    architect: 'Architect', contractor: 'Contractor', agency_contact: 'County or city planner' };
  const ENTITY = /\b(llc|l\.l\.c|inc|corp\w*|company|lp|l\.p|ltd|llp|trust|partners\w*|holdings?|properties|development|ventures?|group|investments?|fund)\b/i;
  // Florida's company registry (Sunbiz) blocks automated lookups, so these open the official search in the salesperson's own browser.
  const sunbiz = (name) => {
    const n = name.toUpperCase().replace(/[^A-Z0-9 &]/g, ' ').replace(/\s+/g, ' ').trim();
    return `https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults?inquiryType=EntityName&searchNameOrder=${encodeURIComponent(n.replace(/\s/g, ''))}&searchTerm=${encodeURIComponent(n)}`;
  };
  const parcelUrl = (id, county) => id && county === 'Orange' ? `https://ocpaweb.ocpafl.org/parcelsearch/Parcel%20ID/${encodeURIComponent(String(id).replace(/\D/g, ''))}` : null;

  P.peopleHtml = (list) => {
    if (!list || !list.length) return '';
    return `<ul class="people">${list.map(s => `<li><span class="role">${esc(ROLE[s.role] || s.role)}</span><span class="who"><b>${esc(s.name)}</b>
        ${s.phone ? ` · <a href="tel:${esc(s.phone.replace(/[^\d+]/g, ''))}">${esc(s.phone)}</a>` : ''}${s.email ? ` · <a href="mailto:${esc(s.email)}">${esc(s.email)}</a>` : ''}
        ${s.address ? `<span class="sub">${esc(s.address)}</span>` : ''}
        ${ENTITY.test(s.name) && s.role !== 'agency_contact' ? `<a class="sub" href="${sunbiz(s.name)}" target="_blank" rel="noopener">Officers and registered agent on Sunbiz${P.icon('ext', 'sm')}</a>` : ''}
        ${s.role === 'contractor' ? `<a class="sub" href="https://www.myfloridalicense.com/wl11.asp?mode=0&SID=" target="_blank" rel="noopener">Check the license (DBPR)${P.icon('ext', 'sm')}</a>` : ''}</span></li>`).join('')}</ul>
      <p class="small muted" style="margin-top:6px">From public records: the property appraiser, the city or county case file, and the permit. Phone numbers and emails appear only when the record lists them.</p>`;
  };
  P.peopleSection = async (projectId, el) => {
    try {
      const r = await P.rpc('project_people', { p_project: projectId });
      const pu = parcelUrl(r.parcel_id, r.county);
      const related = (r.related || []).map(x => `<li><span class="badge">${esc(TYPE[x.signal_type] || P.PSTAGE[x.stage] || x.stage)}</span> ${x.opp ? `<a href="#/lead/${x.opp}" data-lead="${x.opp}">${esc(x.title)}</a>` : esc(x.title)}
          <span class="sub">${esc(x.source_name || '')}, found ${esc(P.date(x.found_at))}</span></li>`).join('');
      el.innerHTML = (r.stakeholders || []).length || related || pu ? `<div class="panel"><h3>People and companies</h3>${P.peopleHtml(r.stakeholders) || '<p class="muted small">No names on the public record yet.</p>'}
        ${pu || r.acreage ? `<p class="small" style="margin-top:8px">${r.acreage ? `${esc(String(r.acreage))} acres. ` : ''}${pu ? `<a href="${pu}" target="_blank" rel="noopener">Property record (parcel ${esc(r.parcel_id)})${P.icon('ext', 'sm')}</a>` : ''}</p>` : ''}
        ${related ? `<h3 style="margin-top:14px">Same property, other records</h3><ul class="plain-list">${related}</ul>` : ''}</div>` : '';
    } catch (e) { el.innerHTML = ''; }
  };

  // ---------------------------------------------------------------- page
  const st = () => (P.state.sig = P.state.sig || { type: '', days: 90, tracked: 'untracked', region: '', q: '' });
  async function load(view) {
    const f = st();
    const body = view.querySelector('#sig_body');
    if (body) body.innerHTML = P.skeleton(6);
    const r = await P.rpc('early_signals', { p: f });
    if (P.state.page !== 'signals') return;
    const c = r.counts || {}, total = Object.values(c).reduce((a, b) => a + b, 0);
    view.querySelector('#sig_types').innerHTML = [['', `All <span class="n">${total}</span>`], ...Object.keys(TYPE).filter(k => k !== 'permit').map(k => [k, `${TYPE[k]} <span class="n">${c[k] || 0}</span>`])]
      .map(([k, t]) => `<button type="button" class="chip" aria-pressed="${f.type === k}" data-act="sigType" data-k="${k}">${t}</button>`).join('');
    view.querySelector('#sig_body').innerHTML = r.items.length ? `<div class="sig-list">${r.items.map(item).join('')}</div>`
      : P.empty('Nothing matches', f.tracked === 'untracked' ? 'Every signal in this view is already being worked, or none came in for these filters.' : 'No early signals for these filters yet.',
        '<button class="btn" data-act="sigReset">Clear filters</button>');
  }
  function item(x) {
    const o = x.opportunity;
    const people = (x.stakeholders || []).filter(s => s.role !== 'agency_contact').slice(0, 3)
      .map(s => `<span class="pchip"><span class="muted">${esc(ROLE[s.role] || s.role)}:</span> ${esc(s.name)}</span>`).join('');
    const facts = [x.size_note, x.value_label].filter(Boolean).join(' · ');
    return `<article class="lcard sig">
      <div class="row" style="justify-content:space-between;gap:8px;flex-wrap:nowrap"><span class="badge ${x.stage === 'land' ? '' : 'warm'}">${esc(STAGE[x.stage] || x.stage)}</span>
        <span class="small muted nowrap">${esc(TYPE[x.signal_type] || '')} · ${esc(P.date(x.published_at || x.found_at))}</span></div>
      <h3 class="sig-t">${esc(x.title)}</h3>
      <div class="facts"><span>${P.icon('pin')}<span class="ell">${esc(x.location_text || P.place(x))}</span></span>${facts ? `<span class="ell">${esc(facts)}</span>` : ''}</div>
      ${x.summary ? `<p class="small sig-sum">${esc(x.summary)}</p>` : ''}
      ${people ? `<div class="pchips">${people}</div>` : ''}
      ${x.relevance === 'high' || x.relevance === 'potential' ? `<div class="small"><span class="muted">Speedy fit:</span> ${esc((x.services || []).slice(0, 4).join(', ') || 'possible')}${x.relevance === 'potential' ? ' (inferred)' : ''}</div>` : ''}
      ${x.same_parcel ? `<div class="small muted">${x.same_parcel} other record${x.same_parcel === 1 ? '' : 's'} on this property</div>` : ''}
      <div class="foot"><a class="small" href="${P.url(x.source_url)}" target="_blank" rel="noopener">${esc(x.source_name || 'Source')}${P.icon('ext', 'sm')}</a>
        ${o ? `<a class="btn sm" href="#/lead/${o.id}" data-lead="${o.id}">${o.mine ? 'Your lead' : o.owner ? esc(o.owner) + "'s lead" : 'Open lead'} ${esc(o.ref || '')}</a>`
            : `<button class="btn primary sm" data-act="sigTrack" data-id="${x.id}">${P.icon('plus', 'sm')}Track</button>`}</div></article>`;
  }

  P.views.signals = async (view) => {
    const f = st();
    P.setPage('Early signals');
    view.innerHTML = P.pageHead({ title: 'Early signals', sub: 'Who is planning to build in Central Florida, before the permit: land bought by companies, rezonings, and site and design plans. Track one to make it your lead.' }) +
      `<div class="toolbar sig-tools"><div class="chips" id="sig_types" role="group" aria-label="Signal type"></div>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <input type="search" data-sig="q" placeholder="Company, address, keyword" value="${esc(f.q)}" aria-label="Search early signals" style="min-width:200px">
          <select data-sig="days" aria-label="Found in the last">${[[30, 'Last 30 days'], [90, 'Last 90 days'], [180, 'Last 6 months'], [365, 'Last year']].map(([v, t]) => `<option value="${v}" ${+f.days === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <select data-sig="tracked" aria-label="Tracking">${[['untracked', 'Not tracked yet'], ['tracked', 'Being worked'], ['all', 'All']].map(([v, t]) => `<option value="${v}" ${f.tracked === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </div></div>
      <div id="sig_body">${P.skeleton(6)}</div>
      <p class="small muted" style="margin-top:14px">Coverage today: City of Orlando planning applications, Orange County development and zoning cases, and Orange County property sales of $1.5M and up. Signals show intent, not confirmed Speedy scope.</p>`;
    let tmr;
    view.querySelectorAll('[data-sig]').forEach(el => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
      clearTimeout(tmr); tmr = setTimeout(() => { f[el.dataset.sig] = el.value; load(view); }, el.tagName === 'SELECT' ? 0 : 300);
    }));
    await load(view);
  };
  P.act.sigType = (el) => { st().type = el.dataset.k; load(document.getElementById('view')); };
  P.act.sigReset = () => { P.state.sig = null; P.views.signals(document.getElementById('view')); };
  P.act.sigTrack = (el) => P.busy(el, async () => {
    const r = await P.rpc('track_signal', { p_project: el.dataset.id });
    P.invalidate?.();
    P.toast(r.existing ? 'Someone already tracks this. Opening the lead.' : r.claimed ? 'Tracked. It is in your pipeline.' : (r.message || 'Tracked. It is in Available.'));
    await load(document.getElementById('view'));
    P.openLead?.(r.id);
  });
})();
