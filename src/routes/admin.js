'use strict';

const express = require('express');
const { renderAdminPage } = require('../views/admin');
const { escapeLike } = require('../lib/validate');

const PAGE_SIZE = 25;
const STATUSES = new Set(['pending', 'notified', 'failed']);

function createAdminRouter({ db, config, adminAuth }) {
  const router = express.Router();

  router.use(adminAuth);

  router.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store');

    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const status = typeof req.query.status === 'string' && STATUSES.has(req.query.status) ? req.query.status : '';
    let page = Number.parseInt(req.query.page, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;

    const stats = db
      .prepare(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(status = 'pending'), 0) AS pending,
               COALESCE(SUM(status = 'notified'), 0) AS notified,
               COALESCE(SUM(status = 'failed'), 0) AS failed
        FROM requests
      `)
      .get();
    stats.failedEmails = db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status = 'failed'").get().count;

    const where = [];
    const params = [];

    if (q) {
      where.push("(r.email LIKE ? ESCAPE '\\' OR r.sku LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(q)}%`;
      params.push(pattern, pattern);
    }
    if (status) {
      where.push('r.status = ?');
      params.push(status);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const filteredTotal = db
      .prepare(`SELECT COUNT(*) AS count FROM requests r ${clause}`)
      .get(...params).count;

    const pageCount = Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE));
    if (page > pageCount) page = pageCount;

    const rows = db
      .prepare(`
        SELECT r.*, o.status AS outbox_status, o.attempts
        FROM requests r
        LEFT JOIN outbox o ON o.request_id = r.id
        ${clause}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ? OFFSET ?
      `)
      .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);

    res.send(
      renderAdminPage({
        stats,
        rows,
        q,
        status,
        page,
        pageCount,
        filteredTotal,
        storeName: config.storeName,
      })
    );
  });

  return router;
}

module.exports = { createAdminRouter };
