// Companies: every contractor, developer and agency the portal has seen, with projects, awards, contacts and who is working them.
(() => {
  const P = window.P, esc = P.esc;
  const KIND = { contractor: 'Contractor', developer: 'Owner or developer', agency: 'Public agency' };
  const st = () => (P.state.coDir = P.state.coDir || { q: '', kind: '' });
  async function load(view) {
    const f = st(), body = view.querySelector('#co_body');
    body.innerHTML = P.skeleton(6);
    const rows = await P.rpc('company_directory', { p: f });
    if (P.state.page !== 'companies') return;
    body.innerHTML = rows.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th scope="col">Company</th><th scope="col" class="num">Projects</th><th scope="col" class="num">Awards</th>
        <th scope="col">Where</th><th scope="col">Contacts</th><th scope="col">Last contact</th><th scope="col">Working it</th></tr></thead><tbody>
      ${rows.map(c => `<tr class="click" data-company="${c.id}"><td><a class="cell-main" href="#/companies?company=${c.id}" data-company="${c.id}">${esc(c.name)}</a><div class="sub">${esc(KIND[c.kind] || c.kind || '')}${(c.aliases || []).length ? ` · also ${esc(c.aliases.slice(0, 2).join(', '))}` : ''}</div></td>
        <td class="num">${c.projects}</td><td class="num">${c.awards || '<span class="faint">0</span>'}</td>
        <td class="small">${esc((c.counties || []).slice(0, 3).join(', '))}${(c.counties || []).length > 3 ? ` +${c.counties.length - 3}` : ''}</td>
        <td class="small">${c.contacts ? `${c.contacts}${c.verified_contacts ? ` <span class="badge ok">${c.verified_contacts} verified</span>` : ''}` : '<span class="faint">None yet</span>'}</td>
        <td class="small">${c.last_contact ? esc(P.ago(c.last_contact)) : '<span class="faint">Never</span>'}</td>
        <td class="small">${(c.working || []).length ? esc(c.working.join(', ')) : c.active ? '' : '<span class="faint">Nobody</span>'}${c.won ? ` <span class="badge ok">${c.won} won</span>` : ''}</td></tr>`).join('')}</tbody></table></div>`
      : P.empty('No companies match', 'Try a shorter name.', '<button class="btn" data-act="coReset">Clear</button>');
  }
  P.views.companies = async (view) => {
    const f = st();
    P.setPage('Companies');
    view.innerHTML = P.pageHead({ title: 'Companies', sub: 'Contractors, developers and agencies across every project, with awards, contacts and who on the team already talks to them.' }) +
      `<div class="toolbar"><input type="search" data-co="q" placeholder="Company name" value="${esc(f.q)}" aria-label="Search companies" style="min-width:220px">
        <select data-co="kind" aria-label="Company type"><option value="">All types</option>${Object.entries(KIND).map(([k, v]) => `<option value="${k}" ${f.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div id="co_body"></div>`;
    let t;
    view.querySelectorAll('[data-co]').forEach(el => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
      clearTimeout(t); t = setTimeout(() => { f[el.dataset.co] = el.value; load(view); }, el.tagName === 'SELECT' ? 0 : 300);
    }));
    await load(view);
  };
  P.act.coReset = () => { P.state.coDir = null; P.views.companies(document.getElementById('view')); };
})();
