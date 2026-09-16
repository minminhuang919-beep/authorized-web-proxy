import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Allowlist } from '../src/allowlist.js';
import { createUrlRewriter } from '../src/rewrite/url.js';
import { rewriteCss } from '../src/rewrite/css.js';
import { createHtmlRewriter, safeJsonForScript } from '../src/rewrite/html.js';
import { parseUserUrl, splitProxyPath, toProxyPath } from '../src/security/target.js';
import { sniffHtmlCharset, charsetFromContentType } from '../src/rewrite/charset.js';

const allowlist = new Allowlist({ envDomains: ['site.test', 'cdn.test', '*.wild.test'] });
const base = new URL('http://site.test/dir/page.html?q=1');

test('url rewriter: relative, root-relative, absolute, protocol-relative', () => {
  const { rewrite } = createUrlRewriter({ allowlist });
  assert.equal(rewrite('img/a.png', base), '/p/http/site.test/dir/img/a.png');
  assert.equal(rewrite('../up.html', base), '/p/http/site.test/up.html');
  assert.equal(rewrite('/about', base), '/p/http/site.test/about');
  assert.equal(rewrite('?page=2', base), '/p/http/site.test/dir/page.html?page=2');
  assert.equal(rewrite('http://site.test/x?y=1#z', base), '/p/http/site.test/x?y=1#z');
  assert.equal(rewrite('HTTPS://CDN.test/lib.js', base), '/p/https/cdn.test/lib.js');
  assert.equal(rewrite('//cdn.test/lib.js', base), '/p/http/cdn.test/lib.js');
  assert.equal(rewrite('http://a.wild.test/', base), '/p/http/a.wild.test/');
  assert.equal(rewrite('  /spaced  ', base), '/p/http/site.test/spaced');
});

test('url rewriter: untouched schemes and fragments', () => {
  const { rewrite } = createUrlRewriter({ allowlist });
  for (const v of ['#top', 'javascript:void(0)', 'mailto:a@b.c', 'data:image/png;base64,AAAA', 'blob:http://site.test/uuid', 'tel:+123', 'about:blank', '']) {
    assert.equal(rewrite(v, base), v, v);
  }
});

test('url rewriter: unlisted hosts stay direct by default, proxied in proxy mode', () => {
  const direct = createUrlRewriter({ allowlist, mode: 'direct' });
  const proxied = createUrlRewriter({ allowlist, mode: 'proxy' });
  assert.equal(direct.rewrite('https://blocked.example/x', base), 'https://blocked.example/x');
  assert.equal(direct.rewrite('//blocked.example/x', base), 'http://blocked.example/x');
  assert.equal(proxied.rewrite('https://blocked.example/x', base), '/p/https/blocked.example/x');
  // ports / credentials / IPs can never be proxied
  assert.equal(direct.rewrite('http://site.test:8080/x', base), 'http://site.test:8080/x');
  assert.equal(proxied.rewrite('http://127.0.0.1/x', base), 'http://127.0.0.1/x');
  assert.equal(proxied.rewrite('http://user:pw@site.test/x', base), 'http://user:pw@site.test/x');
});

test('srcset rewriting keeps descriptors', () => {
  const { rewriteSrcset } = createUrlRewriter({ allowlist });
  assert.equal(rewriteSrcset('/a.png 1x, http://cdn.test/b.png 2x,//cdn.test/c.png 400w', base), '/p/http/site.test/a.png 1x, /p/http/cdn.test/b.png 2x, /p/http/cdn.test/c.png 400w');
  assert.equal(rewriteSrcset('img.png', base), '/p/http/site.test/dir/img.png');
  assert.equal(rewriteSrcset('', base), '');
});

test('css rewriting handles url() forms and @import', () => {
  const rewriter = createUrlRewriter({ allowlist });
  const css = `@import "reset.css";\n@import url('/t.css');\n.a{background:url("/a.png")}.b{background:url( 'b.png' )}.c{background:url(http://cdn.test/c.png)}.d{background:url(data:image/png;base64,AAAA)}.e{background:url(https://blocked.example/e.png)}.f{src:url(/f.woff2) format("woff2")}`;
  const out = rewriteCss(css, base, rewriter);
  assert.match(out, /@import "\/p\/http\/site\.test\/dir\/reset\.css";/);
  assert.match(out, /@import url\("\/p\/http\/site\.test\/t\.css"\);/);
  assert.match(out, /\.a\{background:url\("\/p\/http\/site\.test\/a\.png"\)\}/);
  assert.match(out, /\.b\{background:url\("\/p\/http\/site\.test\/dir\/b\.png"\)\}/);
  assert.match(out, /\.c\{background:url\("\/p\/http\/cdn\.test\/c\.png"\)\}/);
  assert.match(out, /url\(data:image\/png;base64,AAAA\)/, 'data URIs untouched');
  assert.match(out, /url\(https:\/\/blocked\.example\/e\.png\)/, 'unlisted stays direct and unquoted');
  assert.match(out, /url\("\/p\/http\/site\.test\/f\.woff2"\) format\("woff2"\)/);
});

async function runHtml(input, opts = {}) {
  const rw = createHtmlRewriter({ pageUrl: base, urlRewriter: createUrlRewriter({ allowlist }), headSnippet: '<script>HEAD</script>', bodySnippet: '<div>BODY</div>', ...opts });
  let out = '';
  rw.on('data', (d) => (out += d));
  const done = new Promise((resolve, reject) => {
    rw.on('end', resolve);
    rw.on('error', reject);
  });
  // feed in awkward chunks to exercise streaming boundaries
  for (let i = 0; i < input.length; i += 7) rw.write(input.slice(i, i + 7));
  rw.end();
  await done;
  return out;
}

test('html rewriter: attributes, base, meta, injection, raw text', async () => {
  const input = `<!DOCTYPE html><html manifest="/m.appcache"><head><meta charset="latin1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><meta http-equiv="refresh" content="3; url=/next"><link rel="preconnect" href="https://x.test"><link rel="stylesheet" href="s.css" integrity="sha256-x" crossorigin><style>.x{background:url(/bg.png)}</style></head><body><a href="/a" ping="/p">a</a><img srcset="/1.png 1x" src="/1.png"><div style="background:url('/d.png')"></div><noscript><img src="/ns.gif"></noscript><p>keep &amp; text</p></body></html>`;
  const out = await runHtml(input);
  assert.match(out, /^<!DOCTYPE html><html><head><script>HEAD<\/script>/);
  assert.match(out, /<meta charset="utf-8">/);
  assert.doesNotMatch(out, /Content-Security-Policy/);
  assert.match(out, /<meta http-equiv="refresh" content="3; url=\/p\/http\/site\.test\/next">/);
  assert.doesNotMatch(out, /preconnect/);
  assert.match(out, /<link rel="stylesheet" href="\/p\/http\/site\.test\/dir\/s\.css">/);
  assert.match(out, /<style>\.x\{background:url\("\/p\/http\/site\.test\/bg\.png"\)\}<\/style>/);
  assert.match(out, /<body><div>BODY<\/div><a href="\/p\/http\/site\.test\/a">a<\/a>/);
  assert.match(out, /<img srcset="\/p\/http\/site\.test\/1\.png 1x" src="\/p\/http\/site\.test\/1\.png">/);
  assert.match(out, /style="background:url\(&quot;\/p\/http\/site\.test\/d\.png&quot;\)"/);
  assert.match(out, /<noscript><img src="\/p\/http\/site\.test\/ns\.gif"><\/noscript>/);
  assert.match(out, /<p>keep &amp; text<\/p>/, 'text is passed through raw');
  assert.doesNotMatch(out, /ping=/);
  assert.doesNotMatch(out, /integrity=/);
});

test('html rewriter: <base> changes subsequent resolution and is itself rewritten', async () => {
  const out = await runHtml('<html><head><base href="sub/"><link href="x.css" rel="stylesheet"></head><body><a href="y.html">y</a></body></html>');
  assert.match(out, /<base href="\/p\/http\/site\.test\/dir\/sub\/">/);
  assert.match(out, /href="\/p\/http\/site\.test\/dir\/sub\/x\.css"/);
  assert.match(out, /href="\/p\/http\/site\.test\/dir\/sub\/y\.html"/);
});

test('html rewriter: injects into documents without <head>/<body>', async () => {
  const out = await runHtml('<p>hi</p><a href="/z">z</a>');
  assert.match(out, /<script>HEAD<\/script>/);
  assert.match(out, /<div>BODY<\/div>/);
  assert.match(out, /href="\/p\/http\/site\.test\/z"/);
});

test('safeJsonForScript cannot break out of a script block', () => {
  const s = safeJsonForScript({ a: '</script><script>alert(1)</script>' });
  assert.doesNotMatch(s, /<\/script>/i);
  assert.equal(JSON.parse(s).a, '</script><script>alert(1)</script>');
});

test('target helpers', () => {
  assert.equal(toProxyPath(new URL('https://site.test/a b/c?d=1#e')), '/p/https/site.test/a%20b/c?d=1#e');
  assert.deepEqual(splitProxyPath('/p/https/site.test'), { scheme: 'https', host: 'site.test', rest: '/' });
  assert.deepEqual(splitProxyPath('/p/https/site.test?x=1'), { scheme: 'https', host: 'site.test', rest: '/?x=1' });
  assert.deepEqual(splitProxyPath('/p/https/site.test/a/b?x=1'), { scheme: 'https', host: 'site.test', rest: '/a/b?x=1' });
  assert.equal(splitProxyPath('/p/ftp/site.test/'), null);
  assert.equal(splitProxyPath('/p/https'), null);
  assert.equal(splitProxyPath('/p/https//x'), null);
  assert.equal(splitProxyPath('/other'), null);
  assert.equal(parseUserUrl('site.test/path', allowlist).href, 'https://site.test/path');
  assert.equal(parseUserUrl('//cdn.test', allowlist).href, 'https://cdn.test/');
  assert.equal(parseUserUrl('HTTP://SITE.TEST:80/x', allowlist).href, 'http://site.test/x');
});

test('charset sniffing', () => {
  assert.equal(charsetFromContentType('text/html; charset=ISO-8859-1'), 'iso-8859-1');
  assert.equal(charsetFromContentType('text/html'), null);
  assert.equal(sniffHtmlCharset(Buffer.from('<meta charset="windows-1252">'), null), 'windows-1252');
  assert.equal(sniffHtmlCharset(Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=shift_jis">'), null), 'shift_jis');
  assert.equal(sniffHtmlCharset(Buffer.from([0xef, 0xbb, 0xbf, 0x3c]), 'windows-1252'), 'utf-8', 'BOM wins');
  assert.equal(sniffHtmlCharset(Buffer.from('<html>'), 'bogus-charset'), 'utf-8');
  assert.equal(sniffHtmlCharset(Buffer.from('<html>'), 'iso-8859-2'), 'iso-8859-2');
});
