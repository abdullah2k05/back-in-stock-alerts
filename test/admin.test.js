'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const {
  ADMIN_PASSWORD,
  startStockMock,
  startEmailMock,
  createTestRuntime,
  adminAuth,
} = require('./support/helpers');

function insertRequest(db, { email, sku = 'ADM-SKU', status = 'pending' }) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO requests (email, sku, status, created_at, notified_at) VALUES (?, ?, ?, ?, ?)'
  ).run(email, sku, status, now, status === 'notified' ? now : null);
}

async function getAdmin(base, query = '', password = ADMIN_PASSWORD) {
  const headers = password === null ? {} : { authorization: adminAuth(password) };
  return fetch(`${base}/admin${query}`, { headers });
}

describe('GET /admin', () => {
  let stock;
  let email;
  let app;

  before(async () => {
    stock = await startStockMock();
    email = await startEmailMock();
    app = await createTestRuntime({ stock, email });
  });

  after(async () => {
    await app.close();
    await stock.close();
    await email.close();
  });

  it('rejects unauthenticated requests without leaking data', async () => {
    const response = await getAdmin(app.base, '', null);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /Basic realm=/);
    const text = await response.text();
    assert.doesNotMatch(text, /@example\.com/);
  });

  it('rejects a wrong password', async () => {
    const response = await getAdmin(app.base, '', 'wrong-password');
    assert.equal(response.status, 401);
  });

  it('renders the dashboard with correct credentials', async () => {
    insertRequest(app.db, { email: 'dashboard@example.com', sku: 'ADM-SKU' });
    const response = await getAdmin(app.base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /Back-in-stock requests/);
    assert.match(html, /dashboard@example\.com/);
    assert.match(html, /ADM-SKU/);
    assert.match(html, /Total requests/);
  });

  it('paginates at 25 rows per page', async () => {
    app.db.prepare("DELETE FROM requests WHERE sku = 'ADM-SKU'").run();
    for (let index = 1; index <= 30; index += 1) {
      const suffix = String(index).padStart(2, '0');
      insertRequest(app.db, { email: `paginate${suffix}@example.com` });
    }

    const pageOne = await (await getAdmin(app.base, '?page=1')).text();
    assert.match(pageOne, /Page 1 of 2/);
    assert.match(pageOne, /paginate30@example\.com/);
    assert.doesNotMatch(pageOne, /paginate01@example\.com/);
    assert.match(pageOne, /30 results/);

    const pageTwo = await (await getAdmin(app.base, '?page=2')).text();
    assert.match(pageTwo, /Page 2 of 2/);
    assert.match(pageTwo, /paginate01@example\.com/);
    assert.doesNotMatch(pageTwo, /paginate30@example\.com/);
    assert.match(pageTwo, /rel="prev"/);
  });

  it('filters by email/SKU search', async () => {
    const html = await (await getAdmin(app.base, '?q=paginate30')).text();
    assert.match(html, /1 result/);
    assert.match(html, /paginate30@example\.com/);
    assert.doesNotMatch(html, /paginate01@example\.com/);
  });

  it('treats LIKE wildcards and SQL syntax as literal text', async () => {
    const wildcard = await (await getAdmin(app.base, '?q=%25')).text();
    assert.match(wildcard, /0 results/);

    const injection = await (await getAdmin(app.base, `?q=${encodeURIComponent("' OR 1=1 --")}`)).text();
    assert.match(injection, /0 results/);
  });

  it('filters by status', async () => {
    const target = app.db.prepare("SELECT id FROM requests WHERE email = 'paginate30@example.com'").get();
    app.db
      .prepare("UPDATE requests SET status = 'notified', notified_at = ? WHERE id = ?")
      .run(new Date().toISOString(), target.id);

    const notified = await (await getAdmin(app.base, '?q=paginate30&status=notified')).text();
    assert.match(notified, /1 result/);

    const pending = await (await getAdmin(app.base, '?q=paginate30&status=pending')).text();
    assert.match(pending, /0 results/);
  });

  it('escapes customer-supplied values in the dashboard', async () => {
    insertRequest(app.db, { email: '<script>alert(1)</script>@x.com', sku: 'XSS-SKU' });
    const html = await (await getAdmin(app.base, '?q=script')).text();
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;@x\.com/);
  });

  it('locks out an IP after repeated failures', async () => {
    const locked = await createTestRuntime({
      stock,
      email,
      env: { ADMIN_MAX_FAILURES: '2', ADMIN_LOCKOUT_MS: '60000' },
    });
    try {
      assert.equal((await getAdmin(locked.base, '', 'nope')).status, 401);
      assert.equal((await getAdmin(locked.base, '', 'nope-again')).status, 401);
      const blocked = await getAdmin(locked.base);
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    } finally {
      await locked.close();
    }
  });
});
