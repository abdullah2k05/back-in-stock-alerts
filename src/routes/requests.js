'use strict';

const express = require('express');
const { requestSchema, issueMessage } = require('../lib/validate');
const { nowIso, truncate } = require('../lib/time');

function fail(res, status, code, message, extra) {
  return res.status(status).json({ ok: false, error: { code, message, ...(extra || {}) } });
}

function publicCors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
}

function createRequestsRouter({ db, stockClient, outbox, config, logger }) {
  const router = express.Router();

  router.options('/requests', publicCors);
  router.post(
    '/requests',
    publicCors,
    express.json({ limit: config.bodyLimit, type: ['application/json', 'application/*+json'] }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');

      const parsed = requestSchema.safeParse(req.body);
      if (!parsed.success) {
        return fail(res, 400, 'validation_error', issueMessage(parsed.error));
      }

      const { email, sku } = parsed.data;

      let product;
      try {
        product = await stockClient.getProduct(sku);
      } catch (error) {
        logger.warn(`Stock check failed while creating a request for ${sku}: ${error.message}`);
        return fail(res, 503, 'stock_unavailable', 'We could not check stock right now. Please try again shortly.');
      }

      if (!product) {
        return fail(res, 404, 'unknown_product', 'That product could not be found.');
      }

      if (product.quantity > 0) {
        return fail(res, 409, 'already_in_stock', 'This product is in stock right now — no need to wait.', {
          product: { name: product.name, sku: product.sku, in_stock: true },
        });
      }

      let created;
      try {
        const at = nowIso();
        const result = db
          .prepare("INSERT INTO requests (email, sku, product_name, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
          .run(email, sku, product.name, at);
        created = {
          id: Number(result.lastInsertRowid),
          email,
          sku,
          product_name: product.name,
          status: 'pending',
          created_at: at,
        };
      } catch (error) {
        if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
          return fail(res, 409, 'duplicate_request', 'You are already on the list for this product.');
        }
        logger.error('Could not create request:', error);
        return fail(res, 500, 'internal_error', 'Something went wrong. Please try again.');
      }

      // Close the race between the first stock check and the insert: if the item
      // came back in between, queue the notification instead of making the
      // customer wait for a webhook that already happened.
      let availableNow = false;
      try {
        const latest = await stockClient.getProduct(sku);
        if (latest && latest.quantity > 0) {
          availableNow = outbox.enqueueForSku(sku, latest.name) > 0;
          if (availableNow) {
            setImmediate(() => {
              outbox.process().catch((error) => logger.error('Outbox run after signup failed:', error));
            });
          }
        }
      } catch (error) {
        logger.warn(`Post-signup stock re-check failed for ${sku}: ${truncate(error.message, 200)}`);
      }

      return res.status(201).json({
        ok: true,
        request: created,
        available_now: availableNow,
        message: availableNow
          ? 'Good news — this item is available now. We are emailing you the details.'
          : 'You are on the list. We will email you when this item is back in stock.',
      });
    }
  );

  return router;
}

module.exports = { createRequestsRouter };
