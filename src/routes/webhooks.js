'use strict';

const express = require('express');
const { webhookSchema, issueMessage, safeEqual } = require('../lib/validate');

function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, error: { code, message } });
}

function createWebhooksRouter({ webhookProcessor, config, logger }) {
  const router = express.Router();

  router.post(
    '/stock',
    (req, res, next) => {
      const supplied = req.get('x-webhook-secret') || '';
      if (!safeEqual(supplied, config.webhookSecret)) {
        return fail(res, 401, 'unauthorized', 'Invalid webhook secret.');
      }
      return next();
    },
    express.json({ limit: config.bodyLimit, type: ['application/json', 'application/*+json'] }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');

      const parsed = webhookSchema.safeParse(req.body);
      if (!parsed.success) {
        return fail(res, 400, 'validation_error', issueMessage(parsed.error));
      }

      try {
        const result = await webhookProcessor.process(parsed.data);

        if (result.outcome === 'error') {
          return fail(res, 503, 'stock_unavailable', 'Could not verify current stock. Please retry.');
        }

        return res.status(200).json({
          ok: true,
          outcome: result.outcome,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(typeof result.queued === 'number' ? { queued: result.queued } : {}),
        });
      } catch (error) {
        logger.error('Webhook processing failed:', error);
        return fail(res, 500, 'internal_error', 'Could not process this webhook.');
      }
    }
  );

  return router;
}

module.exports = { createWebhooksRouter };
