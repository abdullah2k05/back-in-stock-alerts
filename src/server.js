'use strict';

const { loadConfig } = require('./config');
const { createRuntime } = require('./bootstrap');

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}

const logger = console;
const runtime = createRuntime({ config, logger });

const server = runtime.app.listen(config.port, () => {
  logger.log(`Back-in-stock app listening on port ${config.port}`);
});

server.requestTimeout = 30_000;
server.headersTimeout = 35_000;
server.keepAliveTimeout = 5_000;

runtime.outbox.start();

runtime.webhookProcessor
  .recover()
  .catch((error) => logger.error('Webhook recovery failed:', error));

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.log(`${signal} received, shutting down`);

  runtime.outbox.stop();

  const force = setTimeout(() => {
    logger.error('Shutdown timed out, exiting');
    process.exit(1);
  }, 10_000);
  force.unref();

  server.close(() => {
    try {
      runtime.db.close();
    } catch (error) {
      logger.error('Error closing database:', error);
    }
    clearTimeout(force);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  shutdown('uncaughtException');
});
