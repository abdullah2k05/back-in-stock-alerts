'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../../src/config');
const { createRuntime } = require('../../src/bootstrap');

const CATALOGUE = [
  { sku: 'TEE-ORG-WHT-M', name: 'Organic Cotton Tee, White, M', price: 24, currency: 'GBP', image: 'https://example.com/tee.jpg' },
  { sku: 'MUG-STN-SAGE', name: 'Stoneware Mug, Sage', price: 18, currency: 'GBP', image: 'https://example.com/mug.jpg' },
  { sku: 'SOCK-MRN-3PK', name: 'Merino Socks, 3-pack', price: 19, currency: 'GBP', image: 'https://example.com/socks.jpg' },
  { sku: 'CAP-WAX-OLV', name: 'Waxed Canvas Cap, Olive', price: 32, currency: 'GBP', image: 'https://example.com/cap.jpg' },
];

const STOCK_KEY = 'test-stock-key';
const RESEND_KEY = 'test-resend-key';
const WEBHOOK_SECRET = 'whsec_test_secret';
const ADMIN_PASSWORD = 'admin-test-password';

const silentLogger = { log() {}, warn() {}, error() {} };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

async function startStockMock({ catalogue = CATALOGUE, stock = {} } = {}) {
  const state = {
    catalogue,
    stock: { ...stock },
    calls: [],
    fail: false,
    delayMs: 0,
  };

  const server = http.createServer((req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if ((req.headers.authorization || '') !== `Bearer ${STOCK_KEY}`) {
      return send(401, { error: 'unauthorized' });
    }
    if (state.fail) return send(500, { error: 'injected stock failure' });

    setTimeout(() => {
      const url = new URL(req.url, 'http://local');

      if (req.method === 'GET' && url.pathname === '/api/stock') {
        const products = state.catalogue.map((product) => {
          const quantity = state.stock[product.sku] ?? 0;
          return { ...product, quantity, in_stock: quantity > 0 };
        });
        return send(200, { products });
      }

      const match = url.pathname.match(/^\/api\/stock\/(.+)$/);
      if (req.method !== 'GET' || !match) return send(404, { error: 'not found' });

      const sku = decodeURIComponent(match[1]).toUpperCase();
      const product = state.catalogue.find((entry) => entry.sku === sku);
      const quantity = state.stock[sku] ?? 0;
      state.calls.push({ sku, quantity });

      if (!product) return send(200, { sku, quantity, in_stock: quantity > 0 });
      return send(200, { ...product, sku, quantity, in_stock: quantity > 0 });
    }, state.delayMs);
  });

  const url = await listen(server);
  const baseUrl = `${url}/api/stock`;

  return {
    server,
    url,
    baseUrl,
    state,
    setStock(sku, quantity) {
      state.stock[String(sku).toUpperCase()] = quantity;
    },
    close: () => closeServer(server),
  };
}

async function startEmailMock() {
  const state = {
    requests: [],
    emails: [],
    keys: [],
    failNext: 0,
    failAlways: false,
    delayMs: 0,
  };

  const server = http.createServer(async (req, res) => {
    const safeEnd = (status, body) => {
      try {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      } catch {
        /* client aborted (timeout tests) */
      }
    };

    if (req.method !== 'POST' || req.url !== '/emails') {
      try {
        res.writeHead(404);
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    if ((req.headers.authorization || '') !== `Bearer ${RESEND_KEY}`) {
      return safeEnd(401, { statusCode: 401, message: 'unauthorized' });
    }

    let raw = '';
    for await (const chunk of req) raw += chunk;
    let payload;
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      return safeEnd(400, { statusCode: 400, message: 'invalid json' });
    }

    const key = req.headers['idempotency-key'] || null;
    state.keys.push(key);
    state.requests.push({ key, payload });

    if (state.delayMs) await sleep(state.delayMs);

    if (state.failAlways || state.failNext > 0) {
      if (state.failNext > 0) state.failNext -= 1;
      return safeEnd(500, { statusCode: 500, name: 'application_error', message: 'injected failure' });
    }

    if (key) {
      const existing = state.emails.find((email) => email.idempotencyKey === key && email.status === 'accepted');
      if (existing) {
        return safeEnd(200, { id: existing.id });
      }
    }

    const record = {
      id: `email_${state.emails.length + 1}`,
      ...payload,
      idempotencyKey: key,
      status: 'accepted',
    };
    state.emails.push(record);

    return safeEnd(200, { id: record.id });
  });

  const url = await listen(server);

  return {
    server,
    url,
    state,
    close: () => closeServer(server),
  };
}

async function createTestRuntime({ dir, stock, email, env = {}, logger = silentLogger } = {}) {
  if (!stock || !email) throw new Error('createTestRuntime needs stock and email mocks');

  const dataDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'bis-test-'));
  const config = loadConfig({
    STOCK_API_URL: stock.baseUrl,
    STOCK_API_KEY: STOCK_KEY,
    RESEND_API_KEY: RESEND_KEY,
    RESEND_BASE_URL: email.url,
    WEBHOOK_SECRET,
    ADMIN_PASSWORD,
    DATA_DIR: dataDir,
    PORT: '0',
    EMAIL_FROM: 'Test Store <alerts@test.example>',
    STORE_NAME: 'Test Store',
    STORE_URL: 'https://shop.test.example',
    HTTP_TIMEOUT_MS: '2000',
    EMAIL_TIMEOUT_MS: '1000',
    OUTBOX_BACKOFF_MS: '30',
    OUTBOX_MAX_BACKOFF_MS: '60',
    OUTBOX_WORKER_MS: '600000',
    CATALOGUE_TTL_MS: '0',
    ...env,
  });

  const runtime = createRuntime({ config, logger });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    ...runtime,
    config,
    server,
    base,
    dir: dataDir,
    async close() {
      runtime.outbox.stop();
      await closeServer(server);
      try {
        runtime.db.close();
      } catch {
        /* already closed */
      }
    },
  };
}

async function postJson(base, pathname, body, headers = {}) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function subscribe(base, email, sku) {
  const response = await postJson(base, '/api/requests', { email, sku });
  return { response, body: await readJson(response) };
}

async function sendWebhook(base, payload, secret = WEBHOOK_SECRET, extraHeaders = {}) {
  return fetch(`${base}/webhooks/stock`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'x-webhook-secret': secret }),
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
}

function webhookPayload(overrides = {}) {
  return {
    event_id: `evt_${Math.random().toString(16).slice(2)}`,
    type: 'stock.updated',
    sku: 'TEE-ORG-WHT-M',
    quantity: 5,
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

function adminAuth(password = ADMIN_PASSWORD) {
  return `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
}

async function waitFor(check, { timeoutMs = 4000, intervalMs = 20, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

module.exports = {
  CATALOGUE,
  STOCK_KEY,
  RESEND_KEY,
  WEBHOOK_SECRET,
  ADMIN_PASSWORD,
  silentLogger,
  sleep,
  startStockMock,
  startEmailMock,
  createTestRuntime,
  postJson,
  readJson,
  subscribe,
  sendWebhook,
  webhookPayload,
  adminAuth,
  waitFor,
};
