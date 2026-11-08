'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const {
  startStockMock,
  startEmailMock,
  createTestRuntime,
  subscribe,
  postJson,
  readJson,
} = require('./support/helpers');

describe('POST /api/requests', () => {
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

  it('creates a subscription and normalizes email and SKU', async () => {
    const { response, body } = await subscribe(app.base, '  Alice.Smith@Example.COM ', 'tee-org-wht-m');

    assert.equal(response.status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.request.email, 'alice.smith@example.com');
    assert.equal(body.request.sku, 'TEE-ORG-WHT-M');
    assert.equal(body.request.status, 'pending');

    const row = app.db.prepare('SELECT * FROM requests WHERE id = ?').get(body.request.id);
    assert.equal(row.email, 'alice.smith@example.com');
    assert.equal(row.sku, 'TEE-ORG-WHT-M');
    assert.equal(row.status, 'pending');
    assert.ok(row.created_at.endsWith('Z'), 'timestamps are UTC ISO strings');
    assert.equal(row.notified_at, null);
  });

  it('rejects an invalid email with 400', async () => {
    const { response, body } = await subscribe(app.base, 'not-an-email', 'TEE-ORG-WHT-M');
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'validation_error');
  });

  it('rejects a missing SKU with 400', async () => {
    const { response, body } = await subscribe(app.base, 'missing.sku@example.com', undefined);
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'validation_error');
  });

  it('rejects an unknown product with 404', async () => {
    const { response, body } = await subscribe(app.base, 'unknown@example.com', 'NOT-A-REAL-SKU');
    assert.equal(response.status, 404);
    assert.equal(body.error.code, 'unknown_product');
    assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM requests WHERE email = 'unknown@example.com'").get().count, 0);
  });

  it('prevents a duplicate open request for the same email and SKU', async () => {
    const emailAddress = 'duplicate@example.com';
    const first = await subscribe(app.base, emailAddress, 'TEE-ORG-WHT-M');
    assert.equal(first.response.status, 201);

    const second = await subscribe(app.base, 'DUPLICATE@Example.com', 'tee-org-wht-m');
    assert.equal(second.response.status, 409);
    assert.equal(second.body.error.code, 'duplicate_request');

    const count = app.db
      .prepare("SELECT COUNT(*) AS count FROM requests WHERE email = ? AND sku = ? AND status = 'pending'")
      .get(emailAddress, 'TEE-ORG-WHT-M').count;
    assert.equal(count, 1);
  });

  it('allows the same email to request a different product', async () => {
    const emailAddress = 'multi@example.com';
    const first = await subscribe(app.base, emailAddress, 'TEE-ORG-WHT-M');
    const second = await subscribe(app.base, emailAddress, 'MUG-STN-SAGE');
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);
  });

  it('does not create a waitlist entry when the product is already in stock', async () => {
    stock.setStock('CAP-WAX-OLV', 7);
    try {
      const { response, body } = await subscribe(app.base, 'instock@example.com', 'CAP-WAX-OLV');
      assert.equal(response.status, 409);
      assert.equal(body.error.code, 'already_in_stock');
      const count = app.db
        .prepare("SELECT COUNT(*) AS count FROM requests WHERE email = 'instock@example.com'")
        .get().count;
      assert.equal(count, 0);
    } finally {
      stock.setStock('CAP-WAX-OLV', 0);
    }
  });

  it('rejects malformed JSON with 400', async () => {
    const response = await fetch(`${app.base}/api/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email": "broken"',
    });
    assert.equal(response.status, 400);
    assert.equal((await readJson(response)).error.code, 'invalid_json');
  });

  it('rejects an oversized body with 413', async () => {
    const response = await postJson(app.base, '/api/requests', {
      email: `${'a'.repeat(40_000)}@example.com`,
      sku: 'TEE-ORG-WHT-M',
    });
    assert.equal(response.status, 413);
    assert.equal((await readJson(response)).error.code, 'body_too_large');
  });

  it('accepts a JSON content type other than application/json', async () => {
    const response = await fetch(`${app.base}/api/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.api+json' },
      body: JSON.stringify({ email: 'vendor.type@example.com', sku: 'TEE-ORG-WHT-M' }),
    });
    assert.equal(response.status, 201);
  });

  it('serves the embed form with escaped product data', async () => {
    const response = await fetch(`${app.base}/embed?sku=TEE-ORG-WHT-M`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /Organic Cotton Tee/);
    assert.match(html, /TEE-ORG-WHT-M/);
    assert.match(html, /id="bis-form"/);
    assert.match(html, /id="email"/);
    assert.doesNotMatch(html, /<script>alert/);
  });

  it('returns 404 for an unknown product on the embed page', async () => {
    const response = await fetch(`${app.base}/embed?sku=NOPE-123`);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /couldn/i);
  });
});
