/**
 * Process entry point: load configuration, build the app, listen, and shut
 * down gracefully on SIGTERM/SIGINT (Docker stop / Ctrl-C).
 */
import { existsSync } from 'node:fs';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

// Local development convenience: values already present in the environment win.
if (existsSync('.env')) {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* ignore unreadable .env */
  }
}

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

// Building the app validates the environment-defined lists (authorized
// scope, blacklist, site shortcuts, search provider) — report those as
// configuration errors too instead of a stack trace.
let app;
try {
  app = await buildApp({ config });
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

if (config.generatedSessionSecret) {
  app.log.warn('SESSION_SECRET is not set: using a random secret for this run (sessions will not survive a restart)');
}
if (!config.admin.enabled) {
  app.log.warn('ADMIN_USERNAME / ADMIN_PASSWORD are not set: the /admin area is disabled');
}
if (config.allowedDomains.length === 0 && app.allowlist.size === 0) {
  app.log.warn('PROXY_ALLOWED_DOMAINS is not set and no domain was added by an administrator: the authorized scope is empty, so no website can be opened yet');
} else if (app.allowlist.allowsAll) {
  app.log.warn('PROXY_ALLOWED_DOMAINS contains "*": every website is authorized (the blacklist and the network safety checks still apply). Replace it with the domains you are authorized to proxy.');
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err, 'failed to start');
  process.exit(1);
}
app.log.info({ allowedDomains: app.allowlist.size, admin: config.admin.enabled, env: config.nodeEnv }, 'anonview proxy started');

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const timer = setTimeout(() => {
    app.log.warn('forced exit after shutdown timeout');
    process.exit(1);
  }, 10_000);
  timer.unref();
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error(err, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled promise rejection');
});
