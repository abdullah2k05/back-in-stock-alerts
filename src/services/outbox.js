'use strict';

const { nowIso, truncate } = require('../lib/time');

function createOutbox({ db, emailClient, config, renderEmail, logger = console }) {
  const enqueue = db.transaction((sku, productName) => {
    const at = nowIso();
    const requests = db
      .prepare("SELECT id, email FROM requests WHERE sku = ? AND status = 'pending' ORDER BY id")
      .all(sku);

    const insert = db.prepare(`
      INSERT OR IGNORE INTO outbox
        (request_id, idempotency_key, recipient, sku, product_name, status, attempts,
         next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `);

    let queued = 0;
    for (const request of requests) {
      const result = insert.run(
        request.id,
        `bis-request-${request.id}`,
        request.email,
        sku,
        productName,
        at,
        at,
        at
      );
      queued += result.changes;
    }
    return queued;
  });

  function enqueueForSku(sku, productName) {
    return enqueue(sku, productName || null);
  }

  function resetInterrupted() {
    const at = nowIso();
    const result = db
      .prepare("UPDATE outbox SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE status = 'sending'")
      .run(at, at);
    if (result.changes > 0) logger.warn(`Recovered ${result.changes} interrupted email(s) from a previous run`);
    return result.changes;
  }

  let processing = false;

  async function process() {
    if (processing) return { skipped: true };
    processing = true;
    const summary = { claimed: 0, sent: 0, retried: 0, failed: 0 };

    try {
      const due = db
        .prepare(`
          SELECT * FROM outbox
          WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY id LIMIT 50
        `)
        .all(nowIso());

      for (const row of due) {
        const claimed = db
          .prepare("UPDATE outbox SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'")
          .run(nowIso(), row.id);
        if (!claimed.changes) continue;

        summary.claimed += 1;
        const attempts = row.attempts + 1;

        try {
          const message = renderEmail({
            productName: row.product_name || row.sku,
            sku: row.sku,
            storeName: config.storeName,
            storeUrl: config.storeUrl,
          });

          await emailClient.send({
            to: row.recipient,
            subject: message.subject,
            html: message.html,
            text: message.text,
            idempotencyKey: row.idempotency_key,
          });

          const sentAt = nowIso();
          db.transaction(() => {
            db.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, updated_at = ?, last_error = NULL WHERE id = ?")
              .run(sentAt, sentAt, row.id);
            db.prepare("UPDATE requests SET status = 'notified', notified_at = ?, last_error = NULL WHERE id = ?")
              .run(sentAt, row.request_id);
          })();
          summary.sent += 1;
        } catch (error) {
          const message = truncate(error.message || String(error), 500);
          const permanent = error.permanent === true;
          const exhausted = permanent || attempts >= config.outboxMaxAttempts;

          if (exhausted) {
            db.transaction(() => {
              db.prepare("UPDATE outbox SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
                .run(message, nowIso(), row.id);
              db.prepare("UPDATE requests SET status = 'failed', last_error = ? WHERE id = ?")
                .run(message, row.request_id);
            })();
            summary.failed += 1;
            logger.error(`Email permanently failed for request ${row.request_id} after ${attempts} attempt(s): ${message}`);
          } else {
            const delay = Math.min(
              config.outboxBackoffMs * 2 ** (attempts - 1),
              config.outboxMaxBackoffMs
            );
            const nextAttempt = new Date(Date.now() + delay).toISOString();
            db.prepare("UPDATE outbox SET status = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
              .run(nextAttempt, message, nowIso(), row.id);
            summary.retried += 1;
            logger.warn(`Email attempt ${attempts} failed for request ${row.request_id}; retrying at ${nextAttempt}: ${message}`);
          }
        }
      }
    } finally {
      processing = false;
    }

    return summary;
  }

  let timer = null;

  function start() {
    if (timer) return;
    const tick = () => {
      process().catch((error) => logger.error('Outbox worker error:', error));
    };
    tick();
    timer = setInterval(tick, config.outboxWorkerMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { enqueueForSku, resetInterrupted, process, start, stop };
}

module.exports = { createOutbox };
