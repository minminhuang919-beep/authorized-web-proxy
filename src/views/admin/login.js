import { html, layout } from '../layout.js';

export function loginPage({ error = '' } = {}) {
  const body = html`
<section class="card narrow">
  <h1>Administrator login</h1>
  <form method="post" action="/admin/login" class="stack">
    <label>Username <input name="username" type="text" autocomplete="username" required autofocus></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
    <p class="form-error${error ? '' : ' hidden'}" role="alert">${error}</p>
    <button type="submit">Log in</button>
  </form>
</section>`;
  return layout({ title: 'Admin login', body, admin: true });
}
