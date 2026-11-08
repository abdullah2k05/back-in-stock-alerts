'use strict';

const { safeEqual } = require('../lib/validate');

function createAdminAuth({ password, maxFailures = 10, lockoutMs = 15 * 60 * 1000 }) {
  const failures = new Map();

  function clientKey(req) {
    return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  }

  function lockedUntil(key) {
    const record = failures.get(key);
    if (!record) return 0;
    if (Date.now() - record.firstAt > lockoutMs) {
      failures.delete(key);
      return 0;
    }
    return record.count >= maxFailures ? record.firstAt + lockoutMs : 0;
  }

  function recordFailure(key) {
    const now = Date.now();
    const record = failures.get(key);
    if (!record || now - record.firstAt > lockoutMs) {
      failures.set(key, { count: 1, firstAt: now });
    } else {
      record.count += 1;
    }
  }

  return function adminAuth(req, res, next) {
    const key = clientKey(req);
    const until = lockedUntil(key);

    if (until) {
      const retryAfter = Math.max(1, Math.ceil((until - Date.now()) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).type('text/plain').send('Too many failed sign-in attempts. Try again later.');
    }

    const header = req.get('authorization') || '';
    const match = /^Basic\s+(.+)$/i.exec(header);
    let supplied = '';

    if (match) {
      try {
        const decoded = Buffer.from(match[1], 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        supplied = separator >= 0 ? decoded.slice(separator + 1) : '';
      } catch {
        supplied = '';
      }
    }

    if (match && safeEqual(supplied, password)) {
      failures.delete(key);
      return next();
    }

    recordFailure(key);
    res.set('WWW-Authenticate', 'Basic realm="Back in Stock Admin", charset="UTF-8"');
    return res.status(401).type('text/plain').send('Authentication required.');
  };
}

module.exports = { createAdminAuth };
