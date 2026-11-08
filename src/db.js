'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL CHECK (email = lower(email)),
  sku           TEXT    NOT NULL CHECK (sku = upper(sku)),
  product_name  TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'notified', 'failed')),
  created_at    TEXT    NOT NULL,
  notified_at   TEXT,
  last_error    TEXT
);

-- One open request per customer + product. Notified or failed requests are closed,
-- so a customer may subscribe again after a later sell-out.
CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_open
  ON requests (email, sku) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_requests_sku_status ON requests (sku, status);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests (created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id     TEXT PRIMARY KEY,
  sku          TEXT    NOT NULL,
  quantity     INTEGER NOT NULL,
  type         TEXT,
  occurred_at  TEXT,
  status       TEXT    NOT NULL
                       CHECK (status IN ('processing', 'completed', 'skipped', 'failed')),
  detail       TEXT,
  received_at  TEXT    NOT NULL,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id      INTEGER NOT NULL UNIQUE REFERENCES requests (id),
  idempotency_key TEXT    NOT NULL UNIQUE,
  recipient       TEXT    NOT NULL,
  sku             TEXT    NOT NULL,
  product_name    TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  sent_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox (status, next_attempt_at);
`;

function openDb(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
