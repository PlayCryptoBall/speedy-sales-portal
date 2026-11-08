/* Boot, sign-in, first-time password and first-manager setup. */
(function () {
  const { esc } = P;
  const root = () => document.getElementById('root');
  const authCard = (inner) => `<div class="auth">
      <div class="auth-brand"><img src="assets/logo-dark.png" alt="Speedy Concrete Cutting, Inc.">
        <div><h2>The Florida sales pipeline for the Orlando team.</h2><p>Claim leads, log every call, and keep follow-ups and bid deadlines in one place.</p></div>
        <div class="since">Speedy Concrete Cutting · Since 1988</div></div>
      <main class="auth-main"><div class="auth-card"><img class="mlogo" src="assets/logo.png" alt="Speedy Concrete Cutting, Inc.">${inner}</div></main></div>`;

  function signInScreen(msg) {
    document.title = 'Sign in · Speedy Sales';
    root().innerHTML = authCard(`
      <h1>Sign in</h1><p class="lede">Speedy Sales Portal</p>
      ${msg ? `<div class="alert ${msg.kind || 'info'}">${esc(msg.text)}</div>` : ''}
      <form id="si" novalidate>
        <label class="field"><span>Email</span><input type="email" name="email" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
        <div class="alert error hidden" role="alert" id="si_err"></div>
        <button class="btn primary block" type="submit">Sign in</button>
      </form>
      <div class="foot">${P.cfg.selfServiceReset ? '<button class="linkbtn" data-act="forgot">Forgot your password?</button>' : 'Forgot your password? Ask your manager for a reset link.'}<br>New here? Your manager sends you a one-time link to set your password.</div>`);
    document.getElementById('si').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target), btn = e.target.querySelector('button'), err = document.getElementById('si_err');
      const email = String(f.get('email')).trim(), password = String(f.get('password'));
      if (!email || !password) { err.textContent = 'Enter your email and password.'; err.classList.remove('hidden'); return; }
      btn.disabled = true; btn.innerHTML = '<span class="spin" aria-hidden="true"></span>Signing in…'; err.classList.add('hidden');
      const { error } = await P.sb.auth.signInWithPassword({ email, password });
      if (error) {
        err.textContent = /invalid login/i.test(error.message) ? 'Email or password is wrong.' : /banned/i.test(error.message) ? 'This account is turned off. Ask your manager.' : P.friendly(error);
        err.classList.remove('hidden'); btn.disabled = false; btn.textContent = 'Sign in'; return;
      }
      location.hash = '#/today';
      start();
    };
  }
  P.act.forgot = async () => {
    const v = await P.dialog({ title: 'Reset your password', ok: 'Send reset email', fields: [{ name: 'email', label: 'Your email', type: 'email', required: true }] });
    if (!v) return;
    const { error } = await P.sb.auth.resetPasswordForEmail(v.email, { redirectTo: location.origin + location.pathname + '#/welcome?type=recovery' });
    P.toast(error ? P.friendly(error) : 'If that email has an account, a reset link is on its way.', error ? 'error' : undefined);
  };

  async function welcome(params) {
    document.title = 'Set your password · Speedy Sales';
    const type = params.type === 'recovery' ? 'recovery' : 'invite';
    if (params.token_hash) {
      root().innerHTML = authCard('<h1>Checking your link…</h1>');
      const { error } = await P.sb.auth.verifyOtp({ token_hash: params.token_hash, type });
      history.replaceState(null, '', location.pathname + '#/welcome?type=' + type + '&checked=1');
      if (error) {
        root().innerHTML = authCard(`<h1>This link no longer works</h1><p class="lede">Links work once and expire after a short time. Ask your manager for a new one.</p><a class="btn" href="#/">Go to sign in</a>`);
        return;
      }
    }
    const { data: { session } } = await P.sb.auth.getSession();
    if (!session) { signInScreen({ text: 'Open the newest link your manager sent you to set a password.', kind: 'warn' }); return; }
    root().innerHTML = authCard(`
      <h1>${type === 'invite' ? 'Welcome. Choose a password' : 'Choose a new password'}</h1>
      <p class="lede">For ${esc(session.user.email)}. Use at least 10 characters; a short phrase is easiest to remember.</p>
      <form id="pw" novalidate>
        <label class="field"><span>New password</span><input type="password" name="pw" autocomplete="new-password" minlength="10" required></label>
        <label class="field"><span>Type it again</span><input type="password" name="pw2" autocomplete="new-password" required></label>
        <div class="alert error hidden" role="alert" id="pw_err"></div>
        <button class="btn primary block" type="submit">Save password and open the portal</button>
      </form>`);
    document.getElementById('pw').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target), err = document.getElementById('pw_err'), btn = e.target.querySelector('button');
      const pw = String(f.get('pw')), pw2 = String(f.get('pw2'));
      const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
      if (pw.length < 10) return fail('Use at least 10 characters.');
      if (pw !== pw2) return fail('The two passwords do not match.');
      btn.disabled = true;
      const { error } = await P.sb.auth.updateUser({ password: pw });
      if (error) { btn.disabled = false; return fail(P.friendly(error)); }
      location.hash = '#/today';
      start();
    };
  }

  function setup() {
    document.title = 'First-time setup · Speedy Sales';
    root().innerHTML = authCard(`
      <h1>First-time setup</h1>
      <p class="lede">Creates the first manager account. It works only once, while the portal has no manager, and needs the setup code from the person who installed it.</p>
      <form id="su">
        <label class="field"><span>Setup code</span><input type="text" name="code" required autocomplete="off"></label>
        <label class="field"><span>Your name</span><input type="text" name="name" required autocomplete="name"></label>
        <label class="field"><span>Your email</span><input type="email" name="email" required autocomplete="email"></label>
        <div class="alert error hidden" role="alert" id="su_err"></div>
        <button class="btn primary block" type="submit">Create my manager account</button>
      </form>`);
    document.getElementById('su').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target), err = document.getElementById('su_err'), btn = e.target.querySelector('button');
      btn.disabled = true; err.classList.add('hidden');
      try {
        const r = await P.fn('admin-users', { action: 'bootstrap', setup_code: f.get('code'), full_name: f.get('name'), email: f.get('email') });
        location.href = r.link;
        location.reload();
      } catch (x) { err.textContent = x.message; err.classList.remove('hidden'); btn.disabled = false; }
    };
  }

  // a background refresh redraws the page only when the person is not in the middle of something
  const idle = () => !document.querySelector('dialog[open]') && !document.querySelector('.pop') && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  let started = false;
  async function start() {
    let me;
    try { me = await P.rpc('me'); }
    catch (e) { root().innerHTML = authCard(`<h1>Could not reach the portal</h1><p class="lede">${esc(e.message)}</p><button class="btn" onclick="location.reload()">Try again</button>`); return; }
    if (!me) { await P.sb.auth.signOut(); return signInScreen({ text: 'Your account was not found. Ask your manager for an invite.', kind: 'warn' }); }
    if (!me.active) {
      root().innerHTML = authCard(`<h1>Your account is not active</h1><p class="lede">Ask your manager to turn it on in People and access.</p><button class="btn" data-act="signOut">Sign out</button>`);
      return;
    }
    P.state.me = me;
    P.renderShell();
    if (!started) {
      started = true;
      window.addEventListener('hashchange', () => { if (P.state.me) P.route(); });
      // keep data current across devices: when the app comes back to the front, and every 2 minutes while open
      const refresh = async () => {
        if (document.visibilityState !== 'visible' || !P.state.me) return;
        const n = await P.rpc('me').catch(() => null);
        if (n) { P.state.me = { ...P.state.me, ...n }; P.setUnread(n.unread); }
        await P.loadBoard(true).catch(() => {});
        if (idle() && ['today', 'pool', 'mine', 'gov', 'all'].includes(P.state.page)) P.state.rerender?.();
      };
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { P.invalidate(); refresh(); } });
      setInterval(refresh, 120000);
      P.sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') { P.state.me = null; signInScreen({ text: 'You are signed out.' }); } });
    }
    if (['welcome', 'setup', ''].includes(P.parseHash().name) || !location.hash) location.hash = '#/today';
    P.route();
  }

  async function boot() {
    if (!P.cfg.supabaseUrl || /YOUR-PROJECT/.test(P.cfg.supabaseUrl)) {
      root().innerHTML = authCard('<h1>Not set up yet</h1><p class="lede">The portal is missing its database address (config.js).</p>'); return;
    }
    const r = P.parseHash();
    if (r.name === 'welcome') return welcome(r.params);
    if (r.name === 'setup') return setup();
    const { data: { session } } = await P.sb.auth.getSession();
    if (!session) return signInScreen();
    start();
  }
  boot();
})();
