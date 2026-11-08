'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const {
  startStockMock,
  startEmailMock,
  createTestRuntime,
  subscribe,
  sendWebhook,
  webhookPayload,
  waitFor,
  sleep,
} = require('./support/helpers');

function addProduct(stock, sku, name) {
  stock.state.catalogue.push({ sku, name, price: 10, currency: 'GBP' });
  stock.setStock(sku, 0);
}

describe('email delivery reliability', () => {
  let stock;
  let email;
  let app;

  before(async () => {
    stock = await startStockMock();
    email = await startEmailMock();
    app = await createTestRuntime({
      stock,
      email,
      env: {
        EMAIL_TIMEOUT_MS: '500',
        OUTBOX_MAX_ATTEMPTS: '2',
        OUTBOX_BACKOFF_MS: '50',
        OUTBOX_MAX_BACKOFF_MS: '100',
      },
    });
  });

  after(async () => {
    await app.close();
    await stock.close();
    await email.close();
  });

  it('retries a 500 from the email API without duplicating the message', async () => {
    addProduct(stock, 'EM-RETRY', 'Retry Product');
    await subscribe(app.base, 'retry@example.com', 'EM-RETRY');
    stock.setStock('EM-RETRY', 4);
    email.state.failNext = 1;

    const response = await sendWebhook(
      app.base,
      webhookPayload({ sku: 'EM-RETRY', quantity: 4, event_id: 'evt_email_retry' })
    );
    assert.equal(response.status, 200);

    await waitFor(
      () => {
        const row = app.db.prepare("SELECT status, attempts FROM outbox WHERE sku = 'EM-RETRY'").get();
        return row && row.status === 'pending' && row.attempts === 1;
      },
      { label: 'first attempt pending' }
    );

    await sleep(80);
    await app.outbox.process();

    await waitFor(
      () => app.db.prepare("SELECT status FROM requests WHERE email = 'retry@example.com'").get().status === 'notified',
      { label: 'notified after retry' }
    );

    const attempts = email.state.requests
      .filter((request) => request.payload.to[0] === 'retry@example.com')
      .map((request) => request.key);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0], attempts[1], 'the same idempotency key is reused across retries');

    const messages = email.state.emails.filter((message) => message.to[0] === 'retry@example.com');
    assert.equal(messages.length, 1);
    const request = app.db.prepare("SELECT id FROM requests WHERE email = 'retry@example.com'").get();
    assert.equal(messages[0].idempotencyKey, `bis-request-${request.id}`);
    assert.equal(messages[0].from, 'Test Store <alerts@test.example>');
  });

  it('retries after an email API timeout', async () => {
    addProduct(stock, 'EM-TIMEOUT', 'Timeout Product');
    await subscribe(app.base, 'timeout@example.com', 'EM-TIMEOUT');
    stock.setStock('EM-TIMEOUT', 2);
    email.state.delayMs = 900;

    const response = await sendWebhook(
      app.base,
      webhookPayload({ sku: 'EM-TIMEOUT', quantity: 2, event_id: 'evt_email_timeout' })
    );
    assert.equal(response.status, 200);

    await waitFor(
      () => {
        const row = app.db.prepare("SELECT status, attempts, last_error FROM outbox WHERE sku = 'EM-TIMEOUT'").get();
        return row && row.status === 'pending' && row.attempts === 1;
      },
      { label: 'timeout recorded as retryable' }
    );

    const failedRow = app.db.prepare("SELECT last_error FROM outbox WHERE sku = 'EM-TIMEOUT'").get();
    assert.match(failedRow.last_error, /timed out/i);

    email.state.delayMs = 0;
    await sleep(80);
    await app.outbox.process();

    await waitFor(
      () => app.db.prepare("SELECT status FROM requests WHERE email = 'timeout@example.com'").get().status === 'notified',
      { label: 'notified after timeout retry' }
    );
    assert.equal(email.state.emails.filter((message) => message.to[0] === 'timeout@example.com').length, 1);
  });

  it('stops retrying after the maximum attempts and marks the request failed', async () => {
    addProduct(stock, 'EM-DEAD', 'Dead Letter Product');
    await subscribe(app.base, 'dead@example.com', 'EM-DEAD');
    stock.setStock('EM-DEAD', 1);
    email.state.failAlways = true;

    await sendWebhook(app.base, webhookPayload({ sku: 'EM-DEAD', quantity: 1, event_id: 'evt_email_dead' }));

    await waitFor(
      () => {
        const row = app.db.prepare("SELECT status, attempts FROM outbox WHERE sku = 'EM-DEAD'").get();
        return row && row.status === 'pending' && row.attempts === 1;
      },
      { label: 'first failed attempt' }
    );
    await sleep(80);
    await app.outbox.process();

    const failed = await waitFor(
      () => {
        const row = app.db.prepare("SELECT status, attempts, last_error FROM outbox WHERE sku = 'EM-DEAD'").get();
        return row && row.status === 'failed' ? row : null;
      },
      { label: 'outbox exhausted' }
    );
    assert.equal(failed.attempts, 2);
    assert.match(failed.last_error, /HTTP 500/);

    const request = app.db.prepare("SELECT status, last_error FROM requests WHERE email = 'dead@example.com'").get();
    assert.equal(request.status, 'failed');
    assert.match(request.last_error, /HTTP 500/);

    email.state.failAlways = false;
    await app.outbox.process();
    await sleep(120);
    assert.equal(email.state.emails.filter((message) => message.to[0] === 'dead@example.com').length, 0);
  });

  it('does not send a second email when another restock event arrives for an already-notified request', async () => {
    addProduct(stock, 'EM-ONCE', 'Only Once Product');
    await subscribe(app.base, 'once@example.com', 'EM-ONCE');
    stock.setStock('EM-ONCE', 3);

    await sendWebhook(app.base, webhookPayload({ sku: 'EM-ONCE', quantity: 3, event_id: 'evt_once_a' }));
    await waitFor(
      () => app.db.prepare("SELECT status FROM requests WHERE email = 'once@example.com'").get().status === 'notified',
      { label: 'first notification' }
    );

    const response = await sendWebhook(
      app.base,
      webhookPayload({ sku: 'EM-ONCE', quantity: 3, event_id: 'evt_once_b' })
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).outcome, 'processed');

    await sleep(150);
    assert.equal(email.state.emails.filter((message) => message.to[0] === 'once@example.com').length, 1);
  });

  it('resumes a pending outbox row after a restart and recovers interrupted sends', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bis-restart-'));
    addProduct(stock, 'EM-RESTART', 'Restart Product');

    // A separate mail sink keeps idempotency keys from colliding with other
    // tests' databases, which reuse request IDs.
    const isolatedEmail = await startEmailMock();
    const first = await createTestRuntime({ stock, email: isolatedEmail, dir });
    const created = await subscribe(first.base, 'restart@example.com', 'EM-RESTART');
    assert.equal(created.response.status, 201);

    const requestId = created.body.request.id;
    first.outbox.enqueueForSku('EM-RESTART', 'Restart Product');
    first.db.prepare("UPDATE outbox SET status = 'sending', attempts = 1 WHERE request_id = ?").run(requestId);
    await first.close();

    const before = isolatedEmail.state.emails.filter((message) => message.to[0] === 'restart@example.com').length;

    const second = await createTestRuntime({ stock, email: isolatedEmail, dir });
    try {
      const recovered = second.db.prepare('SELECT status FROM outbox WHERE request_id = ?').get(requestId);
      assert.equal(recovered.status, 'pending', 'interrupted sends return to the queue on boot');

      await second.outbox.process();

      await waitFor(
        () => second.db.prepare('SELECT status FROM requests WHERE id = ?').get(requestId).status === 'notified',
        { label: 'notified after restart' }
      );
      assert.equal(isolatedEmail.state.emails.filter((message) => message.to[0] === 'restart@example.com').length, before + 1);
      assert.equal(
        isolatedEmail.state.emails.find((message) => message.to[0] === 'restart@example.com').idempotencyKey,
        `bis-request-${requestId}`
      );
    } finally {
      await second.close();
      await isolatedEmail.close();
    }
  });
});
