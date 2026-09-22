/**
 * A local mock website used by the tests. It listens on 127.0.0.1 on a random
 * port and serves a variety of responses (HTML, CSS, images, redirects,
 * cookies, compression, errors, slow/large bodies). Every request is recorded
 * so tests can assert what the proxy actually sent upstream.
 */
import http from 'node:http';
import zlib from 'node:zlib';

// 1x1 transparent PNG
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

export const HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'">
<title>Mock site</title>
<link rel="stylesheet" href="/style.css" integrity="sha384-abc" crossorigin="anonymous">
<link rel="preconnect" href="https://fonts.example.net">
<link rel="icon" href="favicon.ico">
<script src="//cdn.test/js/app.js" integrity="sha384-def"></script>
<script src="https://analytics.blocked.example/track.js"></script>
<style>
body { background: url(/img/bg.png); }
.logo { background-image: url("../img/logo.png"); }
@import "print.css";
</style>
</head>
<body>
<a id="rel" href="page/sub/index.html">relative</a>
<a id="root" href="/about">root relative</a>
<a id="abs" href="http://site.test/contact?x=1&amp;y=2#frag">absolute same host</a>
<a id="cdn" href="http://cdn.test/file.zip">absolute allowed host</a>
<a id="proto" href="//cdn.test/proto.js">protocol relative</a>
<a id="ext" href="https://blocked.example/page">external blocked</a>
<a id="mail" href="mailto:someone@example.com">mail</a>
<a id="js" href="javascript:void(0)">js</a>
<a id="hash" href="#section">hash</a>
<a id="ping" href="/ping-target" ping="/ping-tracker">ping</a>
<img id="img" src="/img.png" srcset="/img.png 1x, http://cdn.test/img@2x.png 2x, //cdn.test/img@3x.png 3x" alt="">
<img id="data" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">
<div id="styled" style="background: url('/img/inline.png')"></div>
<form id="form" action="/search" method="get"><input name="q"><button formaction="/alt">go</button></form>
<iframe id="frame" src="/embed"></iframe>
<video poster="/poster.jpg"><source src="/video.mp4" type="video/mp4"></video>
<noscript><img src="/noscript.gif" alt=""></noscript>
<svg><image href="/vector.svg"/><use xlink:href="/sprite.svg#icon"/></svg>
<p>Body text with &lt;entities&gt; that must survive.</p>
</body>
</html>`;

export function createMockSite() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock.local');
    const record = { method: req.method, url: req.url, path: url.pathname, host: req.headers.host, headers: req.headers, body: null };
    requests.push(record);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      record.body = Buffer.concat(chunks);
      handle(req, res, url, record);
    });
  });

  function html(res, body, extraHeaders = {}) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...extraHeaders });
    res.end(body);
  }

  function handle(req, res, url, record) {
    const p = url.pathname;
    switch (true) {
      case p === '/':
        return html(res, HOME_HTML, {
          'content-security-policy': "default-src 'self'",
          'strict-transport-security': 'max-age=31536000',
          'x-frame-options': 'DENY',
          'x-custom': 'kept',
          'set-cookie': ['visited=1; Path=/'],
          'cache-control': 'private, max-age=60'
        });
      case p === '/page/sub/index.html':
        return html(res, '<html><head></head><body><a id="up" href="../up.html">up</a><a id="same" href="sibling.html">sib</a><img src="pic.png"></body></html>');
      case p === '/base':
        return html(res, '<html><head><base href="/deep/dir/"><link rel="stylesheet" href="s.css"></head><body><a id="rel" href="a.html">a</a></body></html>');
      case p === '/meta-refresh':
        return html(res, '<html><head><meta http-equiv="refresh" content="5; url=/next"></head><body></body></html>');
      case p === '/xhtml':
        res.writeHead(200, { 'content-type': 'application/xhtml+xml' });
        return res.end('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><a href="/x">x</a></body></html>');
      case p === '/no-head':
        return html(res, '<p>fragment</p><a href="/y">y</a>');
      case p === '/latin1': {
        const body = Buffer.from('<html><head><meta charset="windows-1252"></head><body><p>caf\xe9 \x80</p><a href="/l">l</a></body></html>', 'latin1');
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(body);
      }
      case p === '/style.css':
        res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'public, max-age=3600', etag: '"css-1"' });
        return res.end(`@import "reset.css";
@import url('/theme.css');
@font-face { src: url(/fonts/a.woff2) format("woff2"); }
.a { background: url("/img/a.png"); }
.b { background: url( 'img/b.png' ); }
.c { background: url(http://cdn.test/c.png); }
.d { background: url(https://blocked.example/d.png); }
.e { background: url(data:image/png;base64,AAAA); }
.f { background: url("//cdn.test/f.png"); }`);
      case p === '/img.png':
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length, 'cache-control': 'public, max-age=86400', etag: '"png-1"', 'accept-ranges': 'bytes' });
        return res.end(PNG);
      case p === '/gzip-html': {
        const gz = zlib.gzipSync(Buffer.from(HOME_HTML));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'content-length': gz.length, vary: 'Accept-Encoding' });
        return res.end(gz);
      }
      case p === '/br-html': {
        const br = zlib.brotliCompressSync(Buffer.from(HOME_HTML));
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'br' });
        return res.end(br);
      }
      case p === '/deflate-html': {
        const df = zlib.deflateSync(Buffer.from(HOME_HTML));
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'deflate' });
        return res.end(df);
      }
      case p === '/raw-deflate-html': {
        const df = zlib.deflateRawSync(Buffer.from(HOME_HTML));
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'deflate' });
        return res.end(df);
      }
      case p === '/gzip-image': {
        const gz = zlib.gzipSync(PNG);
        res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip', 'content-length': gz.length });
        return res.end(gz);
      }
      case p === '/js/app.js':
        res.writeHead(200, { 'content-type': 'application/javascript' });
        return res.end('fetch("/api/data"); document.title = "<script>";');
      case p === '/redirect/allowed':
        res.writeHead(302, { location: '/landing?from=redirect' });
        return res.end();
      case p === '/redirect/relative':
        res.writeHead(302, { location: 'landing' });
        return res.end();
      case p === '/redirect/absolute':
        res.writeHead(301, { location: 'http://other.test/landing' });
        return res.end();
      case p === '/redirect/blocked':
        res.writeHead(302, { location: 'http://blocked.example/secret' });
        return res.end('redirecting');
      case p === '/redirect/private':
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();
      case p === '/redirect/port':
        res.writeHead(302, { location: 'http://site.test:8443/admin' });
        return res.end();
      case p === '/redirect/mailto':
        res.writeHead(302, { location: 'mailto:a@b.test' });
        return res.end();
      // An ordinary username/password form: nothing to do with OAuth, so the
      // proxy must keep serving it (and relay the POST untouched).
      case p === '/login':
        if (req.method === 'POST') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ received: record.body.toString('utf8') }));
        }
        return html(res, '<html><body><h1>Sign in</h1><form method="post" action="/login"><input name="username"><input type="password" name="password"><button>Go</button></form></body></html>');
      case p === '/accounts':
        return html(res, '<html><body><h1>Your accounts</h1><a href="/landing">back</a></body></html>');
      // Ordinary page whose query happens to use the words code and state.
      case p === '/shipping':
        return html(res, '<html><body>shipping</body></html>');
      // The classic "sign in with Google" hop.
      case p === '/redirect/signin':
        res.writeHead(302, {
          location:
            'https://accounts.google.com/o/oauth2/v2/auth?client_id=123456789-abc.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fsite.test%2Fcallback&response_type=code&scope=openid%20email&state=Ky7dQ2bX9fLmT4pR'
        });
        return res.end();
      // Reached only if the proxy failed to stop an authentication flow.
      case p === '/oauth/authorize':
      case p === '/oauth/token':
      case p === '/callback':
        return html(res, '<html><body>UPSTREAM AUTH ENDPOINT REACHED</body></html>');
      case p === '/landing':
        return html(res, '<html><body>landed</body></html>');
      case p === '/set-cookie':
        res.writeHead(200, {
          'content-type': 'text/plain',
          'set-cookie': ['sid=abc123; Path=/; HttpOnly', 'pref=dark; Path=/; Max-Age=3600', 'other=1; Domain=other.test; Path=/']
        });
        return res.end('cookies set');
      case p === '/echo-cookies':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(req.headers.cookie || 'none');
      case p === '/echo-headers':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(req.headers));
      case p === '/echo-body':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ method: req.method, contentType: req.headers['content-type'] || null, body: record.body.toString('utf8'), length: record.body.length }));
      case p.startsWith('/status/'): {
        const code = Number(p.slice('/status/'.length));
        res.writeHead(code, { 'content-type': 'text/html', 'x-status-test': '1' });
        return res.end(`<html><body>status ${code}</body></html>`);
      }
      case p === '/big': {
        const size = Number(url.searchParams.get('size') || 1_000_000);
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        const chunk = Buffer.alloc(64 * 1024, 65);
        let sent = 0;
        const write = () => {
          while (sent < size) {
            const n = Math.min(chunk.length, size - sent);
            sent += n;
            if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
              res.once('drain', write);
              return;
            }
          }
          res.end();
        };
        return write();
      }
      case p === '/big-known': {
        const size = Number(url.searchParams.get('size') || 1_000_000);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size });
        return res.end(Buffer.alloc(size, 66));
      }
      case p === '/big-html': {
        const size = Number(url.searchParams.get('size') || 1_000_000);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<html><body>');
        const piece = '<p><a href="/x">link</a> ' + 'x'.repeat(1000) + '</p>\n';
        let sent = 0;
        const write = () => {
          while (sent < size) {
            sent += piece.length;
            if (!res.write(piece)) {
              res.once('drain', write);
              return;
            }
          }
          res.end('</body></html>');
        };
        return write();
      }
      case p === '/slow': {
        const ms = Number(url.searchParams.get('ms') || 5000);
        return setTimeout(() => {
          if (!res.destroyed) html(res, '<html><body>slow</body></html>');
        }, ms).unref();
      }
      case p === '/slow-body': {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('first');
        return setTimeout(() => {
          if (!res.destroyed) res.end('second');
        }, Number(url.searchParams.get('ms') || 5000)).unref();
      }
      case p === '/abort-body': {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 100 });
        res.write('partial');
        return setTimeout(() => res.destroy(), 20);
      }
      case p === '/no-content-type':
        res.writeHead(200, {});
        return res.end('bytes');
      case p === '/partial':
        res.writeHead(206, { 'content-type': 'text/html', 'content-range': 'bytes 0-4/100' });
        return res.end('<p>pa');
      case p === '/content-location':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-location': '/canonical' });
        return res.end('x');
      case p === '/uncacheable-html':
        res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        return res.end('<html><body>fresh</body></html>');
      case p === '/link-header':
        res.writeHead(200, { 'content-type': 'text/html', link: '</style.css>; rel=preload; as=style', 'alt-svc': 'h3=":443"' });
        return res.end('<html><body>link</body></html>');
      default:
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<html><body>mock 404</body></html>');
    }
  }

  return {
    server,
    requests,
    get port() {
      return server.address().port;
    },
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return this;
    },
    async stop() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
    reset() {
      requests.length = 0;
    },
    last() {
      return requests[requests.length - 1];
    }
  };
}
