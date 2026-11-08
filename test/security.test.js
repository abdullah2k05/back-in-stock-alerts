'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const {
  startStockMock,
  startEmailMock,
  createTestRuntime,
  subscribe,
  readJson,
} = require('./support/helpers');

describe('HTTP security and conventions', () => {
  let stock;
  let email;
  let app;

  before(async () => {
    stock = await startStockMock();
    email = await startEmailMock();
    app = await createTestRuntime({ stock, email });
  });

  after(async () => {
    await app.close();
    await stock.close();
    await email.close();
  });

  it('does not advertise Express', async () => {
    const response = await fetch(`${app.base}/healthz`);
    assert.equal(response.headers.get('x-powered-by'), null);
  });

  it('reports health', async () => {
    const response = await fetch(`${app.base}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), { status: 'ok' });
  });

  it('allows the embed page to be framed and disallows framing elsewhere', async () => {
    const embed = await fetch(`${app.base}/embed?sku=TEE-ORG-WHT-M`);
    assert.match(embed.headers.get('content-security-policy'), /frame-ancestors \*/);
    assert.equal(embed.headers.get('x-frame-options'), null);
    assert.equal(embed.headers.get('x-content-type-options'), 'nosniff');

    const health = await fetch(`${app.base}/healthz`);
    assert.match(health.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
  });

  it('adds HSTS when behind TLS', async () => {
    const response = await fetch(`${app.base}/healthz`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(response.headers.get('strict-transport-security'), /max-age=31536000/);
  });

  it('sets permissive CORS only on the public subscription endpoint', async () => {
    const response = await fetch(`${app.base}/api/requests`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://shop.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');

    const other = await fetch(`${app.base}/webhooks/stock`, {
      method: 'OPTIONS',
      headers: { origin: 'https://shop.example' },
    });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });

  it('returns JSON 404s for unknown API paths', async () => {
    const api = await fetch(`${app.base}/api/nope`);
    assert.equal(api.status, 404);
    assert.equal((await readJson(api)).error.code, 'not_found');

    const hooks = await fetch(`${app.base}/webhooks/nope`, { method: 'POST' });
    assert.equal(hooks.status, 404);
    assert.equal(hooks.headers.get('content-type').includes('application/json'), true);
  });

  it('does not leak the webhook secret or stack traces on failure', async () => {
    const response = await fetch(`${app.base}/webhooks/stock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': 'wrong' },
      body: '{}',
    });
    const text = await response.text();
    assert.equal(response.status, 401);
    assert.doesNotMatch(text, /whsec_/);
    assert.doesNotMatch(text, /at .*\.js:\d+/);
  });

  it('rejects cross-origin admin reads without credentials', async () => {
    const response = await fetch(`${app.base}/admin`, { headers: { origin: 'https://evil.example' } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  it('normalizes and validates the subscription payload without trusting types', async () => {
    const numeric = await subscribe(app.base, 123456, 'TEE-ORG-WHT-M');
    assert.equal(numeric.response.status, 400);

    const objectEmail = await subscribe(app.base, { toString: 'x@example.com' }, 'TEE-ORG-WHT-M');
    assert.equal(objectEmail.response.status, 400);
  });
});
