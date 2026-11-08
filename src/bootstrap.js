'use strict';

const path = require('node:path');

const { openDb } = require('./db');
const { createApp } = require('./app');
const { createStockClient } = require('./services/stock');
const { createEmailClient } = require('./services/email');
const { createOutbox } = require('./services/outbox');
const { createWebhookProcessor } = require('./services/webhooks');
const { renderBackInStockEmail } = require('./views/email');

function createRuntime({ config, logger = console }) {
  const db = openDb(path.join(config.dataDir, 'app.db'));

  const stockClient = createStockClient({
    baseUrl: config.stockApiUrl,
    apiKey: config.stockApiKey,
    timeoutMs: config.httpTimeoutMs,
    catalogueTtlMs: config.catalogueTtlMs,
    logger,
  });

  const emailClient = createEmailClient({
    baseUrl: config.resendBaseUrl,
    apiKey: config.resendApiKey,
    from: config.emailFrom,
    timeoutMs: config.emailTimeoutMs,
  });

  const outbox = createOutbox({
    db,
    emailClient,
    config,
    renderEmail: renderBackInStockEmail,
    logger,
  });

  const webhookProcessor = createWebhookProcessor({ db, stockClient, outbox, logger });

  // A crash can leave rows in transient states. Emails are re-sent with the same
  // idempotency key, and webhooks are re-verified against the stock API.
  outbox.resetInterrupted();

  const app = createApp({ db, config, stockClient, outbox, webhookProcessor, logger });

  return { db, app, stockClient, emailClient, outbox, webhookProcessor };
}

module.exports = { createRuntime };
