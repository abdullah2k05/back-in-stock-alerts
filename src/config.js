'use strict';

const path = require('node:path');

const REQUIRED = [
  'STOCK_API_URL',
  'STOCK_API_KEY',
  'RESEND_API_KEY',
  'RESEND_BASE_URL',
  'WEBHOOK_SECRET',
  'ADMIN_PASSWORD',
];

function int(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function httpUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`);
  }
  return value.replace(/\/+$/, '');
}

function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !env[key] || !String(env[key]).trim());
  if (missing.length) {
    const err = new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
    err.code = 'CONFIG';
    throw err;
  }

  const port = int(env.PORT, 3000, 1, 65535);

  return {
    port,
    dataDir: path.resolve(env.DATA_DIR || path.join(process.cwd(), 'data')),
    stockApiUrl: httpUrl(env.STOCK_API_URL, 'STOCK_API_URL'),
    stockApiKey: env.STOCK_API_KEY,
    resendBaseUrl: httpUrl(env.RESEND_BASE_URL, 'RESEND_BASE_URL'),
    resendApiKey: env.RESEND_API_KEY,
    webhookSecret: env.WEBHOOK_SECRET,
    adminPassword: env.ADMIN_PASSWORD,
    emailFrom: env.EMAIL_FROM || 'Back in Stock <alerts@example.com>',
    storeName: env.STORE_NAME || 'Our Store',
    storeUrl: env.STORE_URL ? httpUrl(env.STORE_URL, 'STORE_URL') : '',
    httpTimeoutMs: int(env.HTTP_TIMEOUT_MS, 8000, 500, 60000),
    emailTimeoutMs: int(env.EMAIL_TIMEOUT_MS, 10000, 500, 60000),
    outboxMaxAttempts: int(env.OUTBOX_MAX_ATTEMPTS, 8, 1, 50),
    outboxBackoffMs: int(env.OUTBOX_BACKOFF_MS, 3000, 50, 600000),
    outboxMaxBackoffMs: int(env.OUTBOX_MAX_BACKOFF_MS, 60000, 100, 3600000),
    outboxWorkerMs: int(env.OUTBOX_WORKER_MS, 5000, 50, 3600000),
    adminMaxFailures: int(env.ADMIN_MAX_FAILURES, 10, 1, 1000),
    adminLockoutMs: int(env.ADMIN_LOCKOUT_MS, 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    bodyLimit: env.BODY_LIMIT || '16kb',
    catalogueTtlMs: int(env.CATALOGUE_TTL_MS, 60000, 0, 3600000),
  };
}

module.exports = { loadConfig };
