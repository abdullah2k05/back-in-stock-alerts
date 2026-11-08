'use strict';

const { nowIso, truncate } = require('../lib/time');

function createWebhookProcessor({ db, stockClient, outbox, logger = console }) {
  function mark(eventId, status, detail, processed) {
    db.prepare('UPDATE webhook_events SET status = ?, detail = ?, processed_at = ? WHERE event_id = ?')
      .run(status, detail, processed ? nowIso() : null, eventId);
  }

  async function process(payload) {
    const eventId = payload.event_id;
    const sku = payload.sku;
    const quantity = Number(payload.quantity);
    const existing = db.prepare('SELECT status FROM webhook_events WHERE event_id = ?').get(eventId);

    if (existing) {
      if (existing.status === 'completed' || existing.status === 'skipped') {
        return { outcome: 'duplicate', status: existing.status };
      }
      if (existing.status === 'processing') {
        return { outcome: 'in_progress' };
      }
      db.prepare("UPDATE webhook_events SET status = 'processing', detail = NULL, received_at = ? WHERE event_id = ?")
        .run(nowIso(), eventId);
    } else {
      try {
        db.prepare(`
          INSERT INTO webhook_events
            (event_id, sku, quantity, type, occurred_at, status, detail, received_at)
          VALUES (?, ?, ?, ?, ?, 'processing', NULL, ?)
        `).run(eventId, sku, quantity, payload.type || null, payload.occurred_at || null, nowIso());
      } catch (error) {
        if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
          return { outcome: 'duplicate' };
        }
        throw error;
      }
    }

    if (quantity <= 0) {
      mark(eventId, 'skipped', 'reported_out_of_stock', true);
      return { outcome: 'skipped', reason: 'not_in_stock' };
    }

    let product;
    try {
      product = await stockClient.getProduct(sku);
    } catch (error) {
      mark(eventId, 'failed', `stock_api_error: ${truncate(error.message, 200)}`, true);
      return { outcome: 'error', reason: 'stock_api_unavailable' };
    }

    if (!product) {
      mark(eventId, 'skipped', 'unknown_sku', true);
      return { outcome: 'skipped', reason: 'unknown_sku' };
    }

    if (!(product.quantity > 0) || product.in_stock === false) {
      mark(eventId, 'skipped', 'stock_not_available', true);
      return { outcome: 'skipped', reason: 'not_in_stock' };
    }

    const queued = outbox.enqueueForSku(sku, product.name);
    mark(eventId, 'completed', `queued ${queued} notification(s)`, true);

    if (queued > 0) {
      setImmediate(() => {
        outbox.process().catch((error) => logger.error('Outbox run after webhook failed:', error));
      });
    }

    return { outcome: 'processed', queued };
  }

  async function recover() {
    const rows = db
      .prepare("SELECT * FROM webhook_events WHERE status IN ('processing', 'failed') ORDER BY received_at LIMIT 100")
      .all();

    for (const row of rows) {
      try {
        await process(row);
      } catch (error) {
        logger.error(`Could not recover webhook ${row.event_id}:`, error);
      }
    }

    if (rows.length > 0) logger.warn(`Recovered ${rows.length} interrupted webhook(s)`);
    return rows.length;
  }

  return { process, recover };
}

module.exports = { createWebhookProcessor };
