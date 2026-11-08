'use strict';

const path = require('node:path');
const express = require('express');

const { createEmbedRouter } = require('./routes/embed');
const { createRequestsRouter } = require('./routes/requests');
const { createWebhooksRouter } = require('./routes/webhooks');
const { createAdminRouter } = require('./routes/admin');
const { createAdminAuth } = require('./services/adminAuth');

const EMBED_CSP = [
  "default-src 'self'",
  'img-src * data:',
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors *",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const APP_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');

  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  const embeddable =
    req.path === '/embed' || req.path.startsWith('/embed/') || req.path.startsWith('/assets/');

  if (embeddable) {
    res.set('Content-Security-Policy', EMBED_CSP);
  } else {
    res.set('Content-Security-Policy', APP_CSP);
    res.set('X-Frame-Options', 'DENY');
  }

  next();
}

function errorPage(title, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f2;color:#1d211c;
font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}main{max-width:420px;padding:32px;text-align:center}
h1{font-size:1.4rem;margin:0 0 8px}p{margin:0;color:#5b635a}a{color:#275c43}</style></head>
<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

function createApp({ db, config, stockClient, outbox, webhookProcessor, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(securityHeaders);
  app.use(
    '/assets',
    express.static(path.join(__dirname, '..', 'public', 'assets'), {
      maxAge: '1h',
      etag: true,
      fallthrough: false,
    })
  );

  app.get('/healthz', (req, res) => {
    try {
      db.prepare('SELECT 1 AS ok').get();
      res.status(200).json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.get('/', (req, res) => res.redirect(302, '/embed'));

  app.use('/embed', createEmbedRouter({ stockClient, config, logger }));

  app.use(
    '/api',
    createRequestsRouter({ db, stockClient, outbox, config, logger })
  );

  app.use(
    '/webhooks',
    createWebhooksRouter({ webhookProcessor, config, logger })
  );

  const adminAuth = createAdminAuth({
    password: config.adminPassword,
    maxFailures: config.adminMaxFailures,
    lockoutMs: config.adminLockoutMs,
  });

  app.use('/admin', createAdminRouter({ db, config, adminAuth }));

  app.use((req, res) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/webhooks')) {
      return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'Not found.' } });
    }
    return res.status(404).send(errorPage('Page not found', 'The page you were looking for does not exist.'));
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    if (error.type === 'entity.too.large') {
      return res.status(413).json({ ok: false, error: { code: 'body_too_large', message: 'Request body is too large.' } });
    }
    if (error.type === 'entity.parse.failed' || (error instanceof SyntaxError && error.status === 400)) {
      return res.status(400).json({ ok: false, error: { code: 'invalid_json', message: 'Request body must be valid JSON.' } });
    }

    logger.error('Unhandled request error:', error);

    if (req.path.startsWith('/api') || req.path.startsWith('/webhooks')) {
      return res.status(500).json({ ok: false, error: { code: 'internal_error', message: 'Something went wrong.' } });
    }
    return res.status(500).send(errorPage('Something went wrong', 'Please try again in a moment.'));
  });

  return app;
}

module.exports = { createApp };
