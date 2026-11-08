/* Excel export in Flip's workbook format, phone PDF view, and workbook import. */
(function () {
  const { esc } = P;
  const EXCELJS = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
  let loading;
  const loadExcel = () => window.ExcelJS ? Promise.resolve() : (loading = loading || new Promise((ok, bad) => {
    const s = document.createElement('script'); s.src = EXCELJS; s.onload = ok; s.onerror = () => bad(new Error('Could not load the Excel tool. Check your connection.'));
    document.head.appendChild(s);
  }));

  // Excel has no time zones: write Eastern wall-clock time.
  function etWall(iso) {
    if (!iso) return null;
    if (iso.length === 10) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso)).map(x => [x.type, x.value]));
    return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute));
  }
  const stamp = (iso) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
  const contactsOf = (r) => (r.contacts || []).concat((r.pocs || []).map(c => ({ ...c, agency: true })));
  const people = (r) => contactsOf(r).map(c => [c.name, c.title].filter(Boolean).join(', ') + (c.verified ? ' (verified)' : '') + (c.agency ? ' (agency)' : '')).filter(Boolean).join('\n');
  const phones = (r) => contactsOf(r).map(c => c.phone).filter(Boolean).join('\n');
  const emails = (r) => contactsOf(r).map(c => c.email).filter(Boolean).join('\n');
  const isGov = (r) => r.kind === 'gov_bid';

  const C = { navy: 'FF1F3A5F', head: 'FF1F3A5F', yellow: 'FFFFF2CC', yellowHead: 'FFBF9000', band: 'FFF5F7F9', red: 'FFF8D7DA', amber: 'FFFCE8C8', grey: 'FFE7E6E6', region: 'FFDCE6F0' };
  const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  const thin = { style: 'thin', color: { argb: 'FFD0D7DE' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };

  P.buildWorkbook = async (data) => {
    await loadExcel();
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Speedy Sales Portal'; wb.created = new Date(data.generated_at);
    const rows = data.rows, gen = stamp(data.generated_at), team = data.scope === 'team';
    const stageList = (P.state.me.stages || []).map(s => s.label);
    const note = `Made from the Speedy Sales Portal on ${gen}${team ? '' : ' for ' + (data.generated_by || 'you')}. This file is a snapshot: anything changed later shows up in the portal, not here.`;

    // tabs in Flip's order; the first two are filled after the data tabs
    const wh = wb.addWorksheet('Start Here', { views: [{ showGridLines: false }] });
    const wt = wb.addWorksheet('This Week', { views: [{ showGridLines: false }] });

    // ---------------- sheet helper
    function sheet(name, cols, list, rowFn, editable, opts = {}) {
      const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, xSplit: opts.xSplit || 0 }] });
      ws.columns = cols.map(([h, w]) => ({ header: h, key: h, width: w }));
      const hr = ws.getRow(1); hr.height = 30;
      hr.eachCell((c) => {
        const ed = editable.includes(c.value);
        c.font = { bold: true, color: { argb: ed ? 'FF000000' : 'FFFFFFFF' }, name: 'Arial', size: 10 };
        c.fill = fill(ed ? C.yellowHead : C.head); c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; c.border = border;
      });
      list.forEach((r, i) => {
        const row = ws.addRow(rowFn(r, i + 2));
        row.eachCell({ includeEmpty: true }, (c, ci) => {
          const h = cols[ci - 1][0];
          c.font = { name: 'Arial', size: 10 }; c.alignment = { vertical: 'top', wrapText: true }; c.border = border;
          if (editable.includes(h)) c.fill = fill(C.yellow); else if (i % 2) c.fill = fill(C.band);
        });
        (opts.after || (() => {}))(row, r);
      });
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, list.length + 1), column: cols.length } };
      return ws;
    }
    const dateCell = (row, col, iso, fmt) => { const c = row.getCell(col); if (iso) { c.value = etWall(iso); c.numFmt = fmt; } };
    const statusDV = (row, col) => { row.getCell(col).dataValidation = { type: 'list', allowBlank: true, formulae: ['"' + stageList.join(',') + '"'], showErrorMessage: true, errorTitle: 'Status', error: 'Pick a status from the list.' }; };
    const link = (row, col, url, text) => { if (url) { const c = row.getCell(col); c.value = { text, hyperlink: url }; c.font = { name: 'Arial', size: 10, color: { argb: 'FF0563C1' }, underline: true }; } };

    // ---------------- Sales Leads
    const leads = rows.filter(r => !isGov(r));
    const L = [['Opp ID', 10], ['Priority', 9], ['Region', 13], ['Lead Type', 16], ['Contractor', 28], ['Project', 40], ['Job Site', 22], ['Project Cost ($)', 15], ['Cost Note', 18],
      ['Project Status', 28], ['Contact Person', 26], ['Phone', 16], ['Email', 28], ['Website', 24], ['What to Pitch', 50], ['Speedy Services', 30], ['Source', 9], ['Owner', 14],
      ['Recent Portal Notes', 40], ['Status', 15], ['Last Contact', 12], ['Next Follow-up', 13], ['Notes', 40]];
    const EDIT = ['Status', 'Last Contact', 'Next Follow-up', 'Notes', 'Done?'];
    const li = (h) => L.findIndex(x => x[0] === h) + 1;
    sheet('Sales Leads', L, leads, (r) => [r.ref, r.priority, r.region, P.KIND[r.kind], r.company_name || r.project_owner, r.project_title, r.location_text, r.project_value || null,
      r.value_label || '', [P.PSTAGE[r.project_stage], r.status_text].filter(Boolean).join(': '), people(r), phones(r), emails(r), r.company_website || '', r.speedy_scope || r.next_action || '',
      (r.services_confirmed?.length ? r.services_confirmed : r.services || []).join(', '), null, r.owner_name || 'Available', r.recent_notes || '', r.stage_label, null, null, null], EDIT, {
      xSplit: 5,
      after: (row, r) => {
        row.getCell(li('Project Cost ($)')).numFmt = '$#,##0';
        link(row, li('Source'), r.source_url, 'Open');
        dateCell(row, li('Last Contact'), r.last_activity_at, 'm/d/yyyy');
        dateCell(row, li('Next Follow-up'), r.next_action_due, 'm/d/yyyy');
        statusDV(row, li('Status'));
        const p = row.getCell(li('Priority'));
        if (r.priority === 'Hot') { p.fill = fill(C.red); p.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF9C0006' } }; }
        else if (r.priority === 'Warm') p.fill = fill(C.amber);
      },
    });

    // ---------------- Gov Contracts
    const gov = rows.filter(isGov).sort((a, b) => String(a.deadline || '9').localeCompare(String(b.deadline || '9')));
    const G = [['Opp ID', 10], ['Bid Status', 17], ['Days Left', 8], ['Deadline (ET)', 17], ['Deadline Note', 28], ['Region', 13], ['Level', 10], ['Job', 40], ['Location', 22], ['Agency', 26],
      ['Size / Value', 18], ['Set-aside / Rules', 24], ["Speedy's Role", 24], ['Why It Fits Speedy', 46], ['Speedy Services', 30], ['Next Step', 46], ['Winner / Low Bidder', 30],
      ['Contact Person', 26], ['Email', 28], ['Phone', 15], ['Solicitation #', 18], ['Bid Notice', 10], ['Owner', 14], ['Recent Portal Notes', 40], ['Status', 15], ['Last Contact', 12], ['Next Follow-up', 13], ['Notes', 40]];
    const gi = (h) => G.findIndex(x => x[0] === h) + 1;
    sheet('Gov Contracts', G, gov, (r, n) => {
      const open = ['bidding', 'upcoming'].includes(r.project_stage) && r.deadline;
      const D = `D${n}`;
      return [r.ref, open ? { formula: `IF(${D}<NOW(),"Closed: find winner",IF(${D}-NOW()<=7,"Due this week","Open"))` } : (P.PSTAGE[r.project_stage] || ''),
        open ? { formula: `IF(${D}<NOW(),"",INT(${D}-NOW()))` } : null, null, r.deadline_note || '', r.region, r.level, r.project_title, r.location_text, r.project_owner,
        r.size_note || r.value_label || (r.project_value ? P.money(r.project_value) : ''), r.set_aside || '', (P.APPROACH[r.approach] || [r.approach])[0] + (r.approach_note ? '. ' + r.approach_note : ''),
        r.speedy_scope || r.source_summary || '', (r.services || []).join(', '), r.next_action || '',
        r.winner_name ? `${r.winner_name}${r.winner_amount ? ', ' + P.money(r.winner_amount) : ''} (${r.winner_status === 'low_bidder' ? 'apparent low bid, not final' : r.winner_status === 'intended' ? 'intended award' : 'awarded'})` : '',
        people(r), emails(r), phones(r), r.solicitation_no || '', null, r.owner_name || 'Available', r.recent_notes || '', r.stage_label, null, null, null];
    }, EDIT, {
      after: (row, r) => {
        dateCell(row, gi('Deadline (ET)'), r.deadline, r.deadline_is_date ? 'mmm d, yyyy' : 'ddd mmm d, h:mm AM/PM');
        link(row, gi('Bid Notice'), r.source_url, 'Open');
        dateCell(row, gi('Last Contact'), r.last_activity_at, 'm/d/yyyy');
        dateCell(row, gi('Next Follow-up'), r.next_action_due, 'm/d/yyyy');
        statusDV(row, gi('Status'));
      },
    });

    // ---------------- This Week
    [14, 30, 44, 20, 30, 52, 14, 9].forEach((w, i) => { wt.getColumn(i + 1).width = w; });
    wt.getCell('A1').value = team ? 'This Week: Orlando Sales Team' : `This Week: ${data.generated_by || 'My pipeline'}`;
    wt.getCell('A1').font = { name: 'Arial', size: 16, bold: true, color: { argb: C.navy } };
    wt.getCell('A2').value = note; wt.getCell('A2').font = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF59606B' } }; wt.mergeCells('A2:H2');
    let r0 = 4;
    const heads = ['Region', 'Company / agency', 'Job', 'Date', 'Phone / email', 'What to do', 'Owner', 'Done?'];
    const section = (title, sub, list, dateOf) => {
      wt.getCell(`A${r0}`).value = `${title} (${list.length})`; wt.getCell(`A${r0}`).font = { name: 'Arial', size: 12, bold: true, color: { argb: C.navy } };
      wt.getCell(`A${r0 + 1}`).value = sub; wt.getCell(`A${r0 + 1}`).font = { name: 'Arial', size: 9, italic: true, color: { argb: 'FF59606B' } }; wt.mergeCells(`A${r0 + 1}:H${r0 + 1}`);
      const hr = wt.getRow(r0 + 2);
      heads.forEach((h, i) => { const c = hr.getCell(i + 1); c.value = h; c.font = { name: 'Arial', size: 10, bold: true, color: { argb: h === 'Done?' ? 'FF000000' : 'FFFFFFFF' } }; c.fill = fill(h === 'Done?' ? C.yellowHead : C.head); c.border = border; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
      r0 += 3;
      if (!list.length) { wt.getCell(`A${r0}`).value = 'Nothing this week.'; wt.getCell(`A${r0}`).font = { name: 'Arial', size: 10, italic: true }; r0 += 2; return; }
      list.forEach((r, i) => {
        const row = wt.getRow(r0);
        const vals = [r.region, r.company_name || r.project_owner, r.project_title, null, [phones(r), emails(r)].filter(Boolean).join('\n') || 'See source', r.next_action || '', r.owner_name || 'Available', null];
        vals.forEach((v, k) => { const c = row.getCell(k + 1); c.value = v; c.font = { name: 'Arial', size: 10 }; c.border = border; c.alignment = { vertical: 'top', wrapText: true }; if (k === 7) c.fill = fill(C.yellow); else if (i % 2) c.fill = fill(C.band); });
        const d = dateOf(r); if (d) { const c = row.getCell(4); c.value = etWall(d); c.numFmt = d.length === 10 ? 'mmm d, yyyy' : 'ddd mmm d, h:mm AM/PM'; }
        r0++;
      });
      r0 += 1;
    };
    const now = Date.now(), soon = (iso, days) => iso && new Date(iso) >= now && new Date(iso) <= now + days * 86400000;
    const today = P.todayET();
    section('1. Follow-ups due this week', 'Owned leads with a follow-up date in the next 7 days or overdue.',
      rows.filter(r => P.ACTIVE.includes(r.stage) && r.next_action_due && r.next_action_due <= P.addDays(7)).sort((a, b) => a.next_action_due.localeCompare(b.next_action_due)), r => r.next_action_due);
    section('2. Bids closing in the next 14 days', 'Call the contractors bidding these jobs, or bid directly where it says so, before the deadline.',
      rows.filter(r => ['bidding', 'upcoming'].includes(r.project_stage) && soon(r.deadline, 14)).sort((a, b) => a.deadline.localeCompare(b.deadline)), r => r.deadline);
    section('3. Bids that just closed: call the winner', 'Apparent low bidders and new awards. Call before they lock in their subs. A low bid is not a final award.',
      rows.filter(r => r.approach === 'approach_prime' && ['low_bidder', 'intent_to_award', 'awarded'].includes(r.project_stage) && ['available', 'claimed', 'contacted'].includes(r.stage) && r.winner_name)
        .sort((a, b) => P.REGIONS.indexOf(a.region) - P.REGIONS.indexOf(b.region)), r => null);
    section('4. Hot leads', 'Strong fit and good timing. Ask for the estimator or project manager.',
      rows.filter(r => r.priority === 'Hot' && !P.CLOSED.includes(r.stage)).sort((a, b) => P.REGIONS.indexOf(a.region) - P.REGIONS.indexOf(b.region)), r => null);

    // ---------------- Start Here
    wh.getColumn(1).width = 24; wh.getColumn(2).width = 100;
    wh.getCell('A1').value = 'Speedy Florida Pipeline: Sales Workbook'; wh.getCell('A1').font = { name: 'Arial', size: 16, bold: true, color: { argb: C.navy } };
    wh.getCell('A2').value = note; wh.getCell('A2').font = { name: 'Arial', size: 10, italic: true }; wh.mergeCells('A2:B2');
    const how = [
      ['This Week tab', 'Start here: follow-ups due, bids closing in 14 days, winners to call, and Hot leads.'],
      ['Sales Leads tab', 'Contractors and private projects to call. Contact Person, Phone and Email come from research unless marked verified.'],
      ['Gov Contracts tab', "Public bids. Speedy's Role says whether to bid directly, call plan holders, quote the bidders, or approach the winner."],
      ['What you edit', 'Only the yellow columns: Status, Last Contact, Next Follow-up and Notes. Write new notes only; earlier notes are kept in the portal.'],
      ['Opp ID', 'Do not change the Opp ID column. It is how the portal matches your notes when this file is imported back.'],
      ['Bringing notes back', 'Upload this file on the portal page "Excel and PDF". You see every change before it is saved, and nothing newer in the portal is overwritten.'],
      ['Project value', 'Project Cost is the whole project, not what Speedy would bill.'],
      ['Counts in this file', `${rows.length} opportunities: ${leads.length} sales leads, ${gov.length} government bids, ${rows.filter(r => r.priority === 'Hot').length} Hot.`],
    ];
    how.forEach(([a, b], i) => { const row = wh.getRow(4 + i); row.getCell(1).value = a; row.getCell(1).font = { name: 'Arial', size: 10, bold: true }; row.getCell(2).value = b; row.getCell(2).font = { name: 'Arial', size: 10 }; row.getCell(2).alignment = { wrapText: true, vertical: 'top' }; });
    const cl = wh.getRow(4 + how.length + 1);
    cl.getCell(1).value = 'Example'; cl.getCell(1).font = { name: 'Arial', size: 10, bold: true };
    cl.getCell(2).value = 'Status: Contacted. Last Contact: ' + new Date().toLocaleDateString('en-US') + '. Notes: Spoke to estimator, sending core pricing Friday.'; cl.getCell(2).fill = fill(C.yellow);

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Speedy Pipeline ${team ? 'Team' : (data.generated_by || 'Mine')} ${P.todayET()}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return blob;
  };

  // ---------------------------------------------------------------- phone PDF (print view)
  P.printHtml = (data) => {
    const rows = data.rows, team = data.scope === 'team';
    if (!rows.length) return P.empty(team ? 'Nothing to print' : 'You have no claimed leads yet', team ? '' : 'Claim leads first, then print your pipeline.');
    const item = (r) => {
      const cts = contactsOf(r).filter(c => c.phone || c.email || c.name).slice(0, 3)
        .map(c => [c.name, c.phone, c.email].filter(Boolean).map(esc).join(', ') + (c.verified ? ' (verified)' : '')).join('<br>');
      return `<div class="item"><div class="row" style="justify-content:space-between"><b>${esc(r.company_name || r.project_owner || r.title)}</b><span>${P.prioTag(r.priority)} <span class="small">${esc(r.ref)}</span></span></div>
        <div class="l">${esc(r.project_title)}</div>
        <div class="l small muted">${esc(r.region || '')}${r.city ? ', ' + esc(r.city) : ''}. ${esc(r.status_text || P.PSTAGE[r.project_stage] || '')}</div>
        ${r.deadline && ['bidding', 'upcoming'].includes(r.project_stage) ? `<div class="l"><b>Deadline:</b> ${esc(P.deadline(r))}</div>` : ''}
        ${r.winner_name ? `<div class="l"><b>${r.winner_status === 'low_bidder' ? 'Apparent low bidder (not final)' : r.winner_status === 'intended' ? 'Intended award' : 'Awarded'}:</b> ${esc(r.winner_name)}</div>` : ''}
        <div class="l"><b>Owner:</b> ${esc(r.owner_name || 'Available')}, ${esc(r.stage_label)}${r.next_action_due ? `. Follow up ${esc(P.date(r.next_action_due))}` : ''}</div>
        ${r.next_action ? `<div class="l"><b>Next:</b> ${esc(r.next_action)}</div>` : ''}
        ${r.approach && (r.kind === 'gov_bid') ? `<div class="l"><b>How:</b> ${esc((P.APPROACH[r.approach] || [r.approach])[0])}</div>` : ''}
        <div class="l"><b>Call:</b> ${cts || 'No phone on file; see source'}</div>
        ${r.recent_notes ? `<div class="l small"><b>Notes:</b> ${esc(r.recent_notes.split('\n')[0])}</div>` : ''}
        <div class="l small muted">Source: ${r.source_url ? `<a href="${P.url(r.source_url)}">${esc(r.source_url)}</a>` : 'not recorded'}. Last verified: ${r.last_verified_at ? esc(P.date(r.last_verified_at)) : 'not re-checked yet'}.</div></div>`;
    };
    const used = new Set(), take = (list) => list.filter(r => !used.has(r.id) && used.add(r.id));
    const now = Date.now();
    const due = take(rows.filter(r => P.ACTIVE.includes(r.stage) && r.next_action_due && r.next_action_due <= P.addDays(7)).sort((a, b) => a.next_action_due.localeCompare(b.next_action_due)));
    const bids = take(rows.filter(r => ['bidding', 'upcoming'].includes(r.project_stage) && r.deadline && new Date(r.deadline) >= now && new Date(r.deadline) <= now + 14 * 86400000).sort((a, b) => a.deadline.localeCompare(b.deadline)));
    const winners = take(rows.filter(r => r.approach === 'approach_prime' && ['low_bidder', 'intent_to_award', 'awarded'].includes(r.project_stage) && !P.CLOSED.includes(r.stage)));
    const byP = (p) => take(rows.filter(r => r.priority === p && !P.CLOSED.includes(r.stage)).sort((a, b) => P.REGIONS.indexOf(a.region) - P.REGIONS.indexOf(b.region)));
    const hot = byP('Hot'), warm = byP('Warm'), later = byP('Later');
    const sec = (t, sub, list) => list.length ? `<h2>${esc(t)} <span class="muted small">${list.length}</span></h2>${sub ? `<p class="small muted">${esc(sub)}</p>` : ''}${list.map(item).join('')}` : '';
    return `<div class="print">
      <h1>Speedy Florida Pipeline</h1>
      <p>${team ? 'Orlando sales team, all of Florida' : esc(data.generated_by || 'My pipeline')}. Made ${esc(stamp(data.generated_at))}.</p>
      <p class="small muted">Snapshot from the Speedy Sales Portal. Anything changed after this time shows in the portal, not in this PDF. Confirm dates on the bid notice before quoting.</p>
      ${sec('Follow-ups due this week', '', due)}
      ${sec('Bids closing in the next 14 days', 'Call the bidders (or bid directly where it says so) before the deadline. Times are Eastern.', bids)}
      ${sec('Call the winner', 'Apparent low bidders and new awards. A low bid is not a final award.', winners)}
      ${sec('Hot leads', 'Strong fit and timing.', hot)}${sec('Warm leads', '', warm)}${sec('Later', '', later)}
    </div>`;
  };

  // ---------------------------------------------------------------- import
  const text = (v) => {
    if (v == null) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') return v.text ?? (v.richText ? v.richText.map(t => t.text).join('') : v.result ?? '');
    return String(v);
  };
  const asDate = (v) => {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = text(v).trim();
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
  };
  let lastRows = null, lastFile = null;
  P.importPreview = async (file) => {
    const out = document.getElementById('imp_out');
    if (!file) return;
    out.innerHTML = '<p class="muted">Reading the workbook…</p>';
    try {
      await loadExcel();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      const rows = [];
      for (const name of ['Sales Leads', 'Gov Contracts']) {
        const ws = wb.getWorksheet(name);
        if (!ws) continue;
        const head = {};
        ws.getRow(1).eachCell((c, i) => { head[text(c.value).trim()] = i; });
        ws.eachRow((row, n) => {
          if (n === 1) return;
          const g = (h) => head[h] ? row.getCell(head[h]).value : null;
          const r = { row: n, sheet: name, ref: text(g('Opp ID')).trim(), company: text(g('Contractor')).trim(), project: text(g('Project') ?? g('Job')).trim(),
            solicitation_no: text(g('Solicitation #')).trim(), status: text(g('Status')).trim(), last_contact: asDate(g('Last Contact')),
            next_follow_up: asDate(g('Next Follow-up')), notes: text(g('Notes')).trim() };
          if (name === 'Gov Contracts' && !r.project) r.project = text(g('Job')).trim();
          if (r.status || r.notes || r.next_follow_up || r.last_contact) rows.push(r);
        });
      }
      if (!rows.length) { out.innerHTML = '<div class="alert warn">No filled-in yellow columns found. The file needs a Sales Leads or Gov Contracts tab with Status, Last Contact, Next Follow-up or Notes filled in.</div>'; return; }
      const plan = await P.rpc('import_preview', { p_rows: rows });
      lastRows = rows; lastFile = file.name;
      const applying = plan.filter(p => !p.skip && p.changes.some(c => c.apply));
      const quiet = plan.filter(p => p.skip && /nothing new/i.test(p.skip)), loud = plan.filter(p => !quiet.includes(p));
      const table = (list) => `<div class="tablewrap" style="margin-top:10px"><table class="tbl"><thead><tr><th scope="col">Row</th><th scope="col">Lead</th><th scope="col">Matched by</th><th scope="col">Proposed changes</th></tr></thead><tbody>
        ${list.map(p => `<tr><td class="small nowrap">${esc(p.sheet)} ${p.row}</td><td>${p.ref ? `<a href="#/lead/${p.opportunity_id}" data-lead="${p.opportunity_id}">${esc(p.ref)}</a> ` : ''}<span class="small">${esc(p.title || '')}</span></td><td class="small">${esc(p.match || '')}</td>
          <td>${p.skip ? `<span class="muted small">${esc(p.skip)}</span>` : p.changes.map(c => `<div class="small">${c.apply ? '<span class="badge ok">Save</span>' : '<span class="badge later">Skip</span>'} ${esc(c.field === 'note' ? 'Note: ' + String(c.to).slice(0, 120) : c.field === 'stage' ? `Status ${c.from} to ${c.to}` : `Follow-up ${c.from || 'none'} to ${c.to}`)} <span class="muted">${esc(c.reason)}</span></div>`).join('')}</td></tr>`).join('')}
        </tbody></table></div>`;
      out.innerHTML = `<div class="alert ${applying.length ? 'info' : 'warn'}">${applying.length} ${applying.length === 1 ? 'row has' : 'rows have'} changes to save. Nothing is saved until you press Save.</div>
        ${loud.length ? table(loud) : ''}
        ${quiet.length ? `<details class="plain" style="margin-top:10px"><summary>${P.plural(quiet.length, 'row')} with nothing new</summary>${table(quiet)}</details>` : ''}
        ${applying.length ? '<button class="btn primary" style="margin-top:12px" data-act="importApply">Save these changes</button>' : ''}`;
    } catch (e) { out.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
  };
  P.act.importApply = (btn) => P.busy(btn, async () => {
    const r = await P.rpc('import_apply', { p_rows: lastRows, p_file: lastFile });
    document.getElementById('imp_out').innerHTML = `<div class="alert ok">Saved: ${r.notes_added} notes added, ${r.stages_changed} statuses changed, ${r.follow_ups_set} follow-up dates set. ${r.skipped} rows skipped. Importing the same file again adds nothing.</div>`;
    P.invalidate();
  });
})();
