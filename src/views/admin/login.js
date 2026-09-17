import { html, icons, layout } from '../layout.js';

export function loginPage({ error = '' } = {}) {
  const body = html`
<section class="auth-card rise" aria-labelledby="login-title">
  <div class="auth-brand">${icons.mark}<span>AnonView</span></div>
  <h1 id="login-title">Administrator sign in</h1>
  <p class="muted">Manage the authorized scope and the blacklist.</p>
  <form method="post" action="/admin/login" class="stack">
    <label class="field">
      <span>Username</span>
      <input name="username" type="text" autocomplete="username" required autofocus>
    </label>
    <label class="field">
      <span>Password</span>
      <input name="password" type="password" autocomplete="current-password" required>
    </label>
    <p class="form-error${error ? '' : ' hidden'}" role="alert">${error}</p>
    <button type="submit" class="btn btn-primary btn-block">Sign in</button>
  </form>
</section>`;
  return layout({ title: 'Sign in', body, bodyClass: 'page-auth' });
}
