import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, cookieHeader, ADMIN_PASSWORD } from './helpers/app.js';
import { Allowlist } from '../src/allowlist.js';

const ADMIN_ENV = { ADMIN_USERNAME: 'root', ADMIN_PASSWORD };

function csrfFrom(html) {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  return m ? m[1] : null;
}

describe('admin', () => {
  let ctx;
  before(async () => {
    ctx = await createTestApp({ env: ADMIN_ENV });
  });
  after(() => ctx.close());

  async function login() {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `username=root&password=${encodeURIComponent(ADMIN_PASSWORD)}`
    });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/admin');
    const cookie = cookieHeader(res);
    assert.match(cookie, /^pxy_admin=/);
    const setCookie = [].concat(res.headers['set-cookie']).join(';');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    return cookie;
  }

  test('the dashboard requires authentication', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/admin' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/admin/login');
    const post = await ctx.app.inject({ method: 'POST', url: '/admin/domains', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'domain=x.example' });
    assert.equal(post.statusCode, 302);
    assert.equal(ctx.app.allowlist.isAllowed('x.example'), false);
  });

  test('wrong credentials are rejected without detail', async () => {
    for (const payload of ['username=root&password=wrong-password-1', 'username=nobody&password=' + encodeURIComponent(ADMIN_PASSWORD), 'username=&password=']) {
      const res = await ctx.app.inject({ method: 'POST', url: '/admin/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload });
      assert.equal(res.statusCode, 401);
      assert.match(res.body, /Invalid username or password/);
      assert.equal(res.headers['set-cookie'], undefined);
    }
  });

  test('login, view, add and remove domains, log out', async () => {
    const cookie = await login();
    let dash = await ctx.app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
    assert.equal(dash.statusCode, 200);
    assert.equal(dash.headers['cache-control'], 'no-store');
    assert.match(dash.body, /Blacklisted domain/);
    assert.match(dash.body, /Authorized scope/);
    assert.match(dash.body, /Proxy status/);
    assert.match(dash.body, /Recent configuration changes/);
    assert.match(dash.body, /href="\/admin\/blacklist"/);
    assert.match(dash.body, /href="\/admin\/settings"/);
    const csrf = csrfFrom(dash.body);
    assert.ok(csrf);
    dash = await ctx.app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } });
    assert.equal(dash.statusCode, 200);
    assert.match(dash.body, /<code class="domain">site\.test<\/code>/);
    assert.match(dash.body, /environment/);
    assert.match(dash.body, /Configuration/);

    // add
    let res = await ctx.app.inject({ method: 'POST', url: '/admin/domains', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}&domain=New.Example` });
    assert.equal(res.statusCode, 303);
    assert.equal(ctx.app.allowlist.isAllowed('new.example'), true);
    dash = await ctx.app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } });
    assert.match(dash.body, /new\.example was added to the authorized scope/);
    assert.match(dash.body, /<code class="domain">new\.example<\/code>/);
    // persisted to disk
    const file = JSON.parse(await fs.readFile(path.join(ctx.dataDir, 'allowlist.json'), 'utf8'));
    assert.deepEqual(file.domains.map((d) => d.pattern), ['new.example']);
    // and immediately usable by the proxy (host resolves through the fake DNS? no → 502, not 403)
    const proxied = await ctx.app.inject({ method: 'GET', url: '/p/http/new.example/' });
    assert.notEqual(proxied.statusCode, 403);

    // invalid + duplicate
    await ctx.app.inject({ method: 'POST', url: '/admin/domains', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}&domain=10.0.0.1` });
    dash = await ctx.app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } });
    assert.match(dash.body, /Enter a valid hostname/);
    await ctx.app.inject({ method: 'POST', url: '/admin/domains', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}&domain=new.example` });
    dash = await ctx.app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } });
    assert.match(dash.body, /already on the allowlist/);

    // env entries are locked
    res = await ctx.app.inject({ method: 'POST', url: '/admin/domains/remove', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}&domain=site.test` });
    assert.equal(res.statusCode, 303);
    assert.equal(ctx.app.allowlist.isAllowed('site.test'), true);
    dash = await ctx.app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } });
    assert.match(dash.body, /can only be removed by changing the environment/);

    // remove admin entry
    res = await ctx.app.inject({ method: 'POST', url: '/admin/domains/remove', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}&domain=new.example` });
    assert.equal(res.statusCode, 303);
    assert.equal(ctx.app.allowlist.isAllowed('new.example'), false);

    // logout
    res = await ctx.app.inject({ method: 'POST', url: '/admin/logout', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}` });
    assert.equal(res.statusCode, 303);
    dash = await ctx.app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
    assert.equal(dash.statusCode, 302, 'session destroyed server-side');
  });

  test('state-changing requests require a valid CSRF token', async () => {
    const cookie = await login();
    for (const payload of ['domain=csrf.example', '_csrf=wrong&domain=csrf.example']) {
      const res = await ctx.app.inject({ method: 'POST', url: '/admin/domains', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload });
      assert.equal(res.statusCode, 403);
    }
    assert.equal(ctx.app.allowlist.isAllowed('csrf.example'), false);
  });

  test('login attempts are rate limited', async () => {
    const limited = await createTestApp({ env: { ...ADMIN_ENV, ADMIN_RATE_LIMIT: '2' }, withMock: false });
    try {
      const attempt = () => limited.app.inject({ method: 'POST', url: '/admin/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'username=root&password=nope-nope-nope' });
      assert.equal((await attempt()).statusCode, 401);
      assert.equal((await attempt()).statusCode, 401);
      assert.equal((await attempt()).statusCode, 429);
    } finally {
      await limited.close();
    }
  });

  test('the admin area is disabled without credentials', async () => {
    const off = await createTestApp({ withMock: false });
    try {
      for (const url of ['/admin', '/admin/', '/admin/login', '/admin/domains', '/admin/blacklist', '/admin/settings']) {
        const res = await off.app.inject({ method: 'GET', url });
        assert.equal(res.statusCode, 404, url);
      }
    } finally {
      await off.close();
    }
  });
});

describe('allowlist persistence', () => {
  test('admin-added domains survive a restart and env entries always win', async () => {
    const dir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'anonview-allow-'));
    const file = path.join(dir, 'allowlist.json');
    try {
      const a = await new Allowlist({ envDomains: ['env.example'], filePath: file }).load();
      assert.deepEqual((await a.add('*.added.example')).ok, true);
      assert.deepEqual((await a.add('env.example')).ok, false);
      const b = await new Allowlist({ envDomains: ['env.example', 'second.example'], filePath: file }).load();
      assert.equal(b.isAllowed('x.added.example'), true);
      assert.equal(b.isAllowed('second.example'), true);
      assert.deepEqual(
        b.list().map((e) => [e.pattern, e.source]),
        [
          ['env.example', 'env'],
          ['second.example', 'env'],
          ['*.added.example', 'admin']
        ]
      );
      await fs.writeFile(file, '{not json');
      await assert.rejects(new Allowlist({ envDomains: [], filePath: file }).load(), /not valid JSON/);
      await fs.writeFile(file, JSON.stringify({ domains: ['ok.example', '10.0.0.1', { pattern: 'obj.example', addedAt: '2026-01-01T00:00:00.000Z' }] }));
      const c = await new Allowlist({ envDomains: [], filePath: file }).load();
      assert.deepEqual(c.patterns(), ['ok.example', 'obj.example']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
