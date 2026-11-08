'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const {
  startStockMock,
  startEmailMock,
  createTestRuntime,
  subscribe,
  sendWebhook,
  webhookPayload,
  readJson,
  waitFor,
  sleep,
} = require('./support/helpers');

function addProduct(stock, sku, name) {
  stock.state.catalogue.push({ sku, name, price: 10, currency: 'GBP' });
  stock.setStock(sku, 0);
}

describe('POST /webhooks/stock', () => {
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

  it('rejects a missing webhook secret with 401', async () => {
    const payload = webhookPayload({ sku: 'TEE-ORG-WHT-M', event_id: 'evt_no_secret' });
    const response = await sendWebhook(app.base, payload, null);
    assert.equal(response.status, 401);
    assert.equal((await readJson(response)).error.code, 'unauthorized');
  });

  it('rejects an incorrect webhook secret with 401', async () => {
    const payload = webhookPayload({ sku: 'TEE-ORG-WHT-M', event_id: 'evt_bad_secret' });
    const response = await sendWebhook(app.base, payload, 'wrong-secret');
    assert.equal(response.status, 401);
  });

  it('rejects an invalid payload with 400', async () => {
    const response = await sendWebhook(app.base, { sku: 'TEE-ORG-WHT-M' });
    assert.equal(response.status, 400);
    assert.equal((await readJson(response)).error.code, 'validation_error');
  });

  it('notifies every waiting customer after a genuine restock', async () => {
    addProduct(stock, 'WH-GENUINE', 'Genuine Restock Product');
    await subscribe(app.base, 'genuine.one@example.com', 'WH-GENUINE');
    await subscribe(app.base, 'genuine.two@example.com', 'WH-GENUINE');
    stock.setStock('WH-GENUINE', 9);

    const payload = webhookPayload({ sku: 'WH-GENUINE', quantity: 9, event_id: 'evt_genuine' });
    const response = await sendWebhook(app.base, payload);
    assert.equal(response.status, 200);
    assert.equal((await readJson(response)).outcome, 'processed');

    await waitFor(
      () =>
        app.db
          .prepare("SELECT COUNT(*) AS count FROM requests WHERE sku = 'WH-GENUINE' AND status = 'notified'")
          .get().count === 2,
      { label: 'two notified requests' }
    );

    const recipients = email.state.emails
      .filter((message) => ['genuine.one@example.com', 'genuine.two@example.com'].includes(message.to[0]))
      .map((message) => message.to[0])
      .sort();
    assert.deepEqual(recipients, ['genuine.one@example.com', 'genuine.two@example.com']);

    const event = app.db.prepare("SELECT * FROM webhook_events WHERE event_id = 'evt_genuine'").get();
    assert.equal(event.status, 'completed');
    assert.match(event.detail, /queued 2 notification/);

    const sample = email.state.emails.find((message) => message.to[0] === 'genuine.one@example.com');
    assert.match(sample.subject, /Genuine Restock Product is back in stock/);
    assert.match(sample.html, /Genuine Restock Product/);
    assert.match(sample.html, /WH-GENUINE/);
    assert.ok(sample.text.length > 20);
  });

  it('treats a repeated event ID as a duplicate and sends nothing again', async () => {
    const before = email.state.emails.length;
    const payload = webhookPayload({ sku: 'WH-GENUINE', quantity: 9, event_id: 'evt_genuine' });

    const response = await sendWebhook(app.base, payload, undefined, { 'x-test': '1' });
    assert.equal(response.status, 200);
    assert.equal((await readJson(response)).outcome, 'duplicate');

    await sleep(120);
    assert.equal(email.state.emails.length, before);
    assert.equal(
      app.db.prepare("SELECT COUNT(*) AS count FROM webhook_events WHERE event_id = 'evt_genuine'").get().count,
      1
    );
  });

  it('handles two identical webhooks arriving concurrently', async () => {
    addProduct(stock, 'WH-CONCURRENT', 'Concurrent Webhook Product');
    await subscribe(app.base, 'concurrent@example.com', 'WH-CONCURRENT');
    stock.setStock('WH-CONCURRENT', 4);

    const payload = webhookPayload({ sku: 'WH-CONCURRENT', quantity: 4, event_id: 'evt_concurrent' });
    const before = email.state.emails.length;

    const [a, b] = await Promise.all([sendWebhook(app.base, payload), sendWebhook(app.base, payload)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);

    await waitFor(() => email.state.emails.length === before + 1, { label: 'exactly one email' });
    await sleep(150);
    assert.equal(email.state.emails.length, before + 1, 'a duplicate webhook must not send a second email');

    assert.equal(
      app.db.prepare("SELECT COUNT(*) AS count FROM webhook_events WHERE event_id = 'evt_concurrent'").get().count,
      1
    );
    assert.equal(
      app.db.prepare("SELECT substr(detail, 1, 6) AS d FROM webhook_events WHERE event_id = 'evt_concurrent'").get().d,
      'queued'
    );
  });

  it('does not notify for a phantom restock when the stock API still reports zero', async () => {
    addProduct(stock, 'WH-PHANTOM', 'Phantom Restock Product');
    await subscribe(app.base, 'phantom@example.com', 'WH-PHANTOM');
    const before = email.state.emails.length;

    const response = await sendWebhook(
      app.base,
      webhookPayload({ sku: 'WH-PHANTOM', quantity: 12, event_id: 'evt_phantom' })
    );
    assert.equal(response.status, 200);
    const body = await readJson(response);
    assert.equal(body.outcome, 'skipped');
    assert.equal(body.reason, 'not_in_stock');

    await sleep(120);
    assert.equal(email.state.emails.length, before);

    const request = app.db.prepare("SELECT status FROM requests WHERE email = 'phantom@example.com'").get();
    assert.equal(request.status, 'pending');

    const event = app.db.prepare("SELECT status, detail FROM webhook_events WHERE event_id = 'evt_phantom'").get();
    assert.equal(event.status, 'skipped');
    assert.equal(event.detail, 'stock_not_available');
  });

  it('does not notify on a sellout webhook', async () => {
    addProduct(stock, 'WH-SELLOUT', 'Sellout Product');
    await subscribe(app.base, 'sellout@example.com', 'WH-SELLOUT');
    stock.setStock('WH-SELLOUT', 3);
    const before = email.state.emails.length;

    const response = await sendWebhook(
      app.base,
      webhookPayload({ sku: 'WH-SELLOUT', quantity: 0, event_id: 'evt_sellout' })
    );
    assert.equal(response.status, 200);
    const body = await readJson(response);
    assert.equal(body.outcome, 'skipped');
    assert.equal(body.reason, 'not_in_stock');

    await sleep(120);
    assert.equal(email.state.emails.length, before);
  });

  it('skips an unknown SKU', async () => {
    const response = await sendWebhook(
      app.base,
      webhookPayload({ sku: 'WH-DOES-NOT-EXIST', quantity: 5, event_id: 'evt_unknown_sku' })
    );
    assert.equal(response.status, 200);
    const body = await readJson(response);
    assert.equal(body.outcome, 'skipped');
    assert.equal(body.reason, 'unknown_sku');
  });

  it('returns 503 when stock verification fails, then processes the retried event', async () => {
    addProduct(stock, 'WH-RETRY', 'Retryable Stock Product');
    await subscribe(app.base, 'retry@example.com', 'WH-RETRY');
    stock.setStock('WH-RETRY', 6);

    const payload = webhookPayload({ sku: 'WH-RETRY', quantity: 6, event_id: 'evt_retry_stock_api' });

    stock.state.fail = true;
    const failed = await sendWebhook(app.base, payload);
    assert.equal(failed.status, 503);
    assert.equal((await readJson(failed)).error.code, 'stock_unavailable');

    const eventAfterFailure = app.db
      .prepare("SELECT status FROM webhook_events WHERE event_id = 'evt_retry_stock_api'")
      .get();
    assert.equal(eventAfterFailure.status, 'failed');

    stock.state.fail = false;
    const retried = await sendWebhook(app.base, payload);
    assert.equal(retried.status, 200);
    assert.equal((await readJson(retried)).outcome, 'processed');

    await waitFor(
      () => app.db.prepare("SELECT status FROM requests WHERE email = 'retry@example.com'").get().status === 'notified',
      { label: 'notified after retry' }
    );
  });
});
