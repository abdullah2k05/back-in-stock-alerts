'use strict';

const { escapeHtml } = require('../lib/html');

function formatUtc(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function statusBadge(status) {
  return `<span class="status status--${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function pageLink({ page, q, status }) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return `/admin${query ? `?${query}` : ''}`;
}

function renderAdminPage({ stats, rows, q, status, page, pageCount, filteredTotal, storeName }) {
  const qValue = escapeHtml(q);
  const statusOptions = ['', 'pending', 'notified', 'failed']
    .map(
      (value) =>
        `<option value="${value}"${value === status ? ' selected' : ''}>${
          value ? value[0].toUpperCase() + value.slice(1) : 'All statuses'
        }</option>`
    )
    .join('');

  const bodyRows = rows.length
    ? rows
        .map(
          (row) => `<tr>
        <td data-label="Customer">
          <span class="email">${escapeHtml(row.email)}</span>
          <span class="sub">#${escapeHtml(row.id)}</span>
        </td>
        <td data-label="Product">
          <span class="sku">${escapeHtml(row.sku)}</span>
          ${row.product_name ? `<span class="sub">${escapeHtml(row.product_name)}</span>` : ''}
        </td>
        <td data-label="Status">${statusBadge(row.status)}</td>
        <td data-label="Requested"><span class="mono">${formatUtc(row.created_at)}</span></td>
        <td data-label="Notified"><span class="mono">${formatUtc(row.notified_at)}</span></td>
        <td data-label="Delivery">
          ${
            row.outbox_status
              ? `<span class="sub">${escapeHtml(row.outbox_status)} &middot; ${Number(row.attempts) || 0} attempt(s)</span>`
              : '<span class="sub">—</span>'
          }
          ${row.last_error ? `<span class="error" title="${escapeHtml(row.last_error)}">${escapeHtml(row.last_error)}</span>` : ''}
        </td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="6" class="empty">
        <strong>No requests found.</strong>
        <span>${q || status ? 'Try a different search or status filter.' : 'Requests will appear here as customers join a waitlist.'}</span>
      </td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="robots" content="noindex,nofollow">
<title>Back-in-stock dashboard — ${escapeHtml(storeName)}</title>
<link rel="stylesheet" href="/assets/admin.css">
</head>
<body>
<header class="topbar">
  <div class="wrap topbar-inner">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"></span>
      <span>
        <strong>${escapeHtml(storeName)}</strong>
        <small>Restock alerts</small>
      </span>
    </div>
    <span class="env">Live &middot; UTC</span>
  </div>
</header>

<main class="wrap">
  <div class="page-head">
    <div>
      <h1>Back-in-stock requests</h1>
      <p>Customers waiting for sold-out products and their notification status.</p>
    </div>
  </div>

  <section class="stats" aria-label="Summary">
    <div class="stat">
      <span class="stat-label">Total requests</span>
      <strong>${stats.total}</strong>
    </div>
    <div class="stat">
      <span class="stat-label">Pending</span>
      <strong>${stats.pending}</strong>
    </div>
    <div class="stat stat--ok">
      <span class="stat-label">Notified</span>
      <strong>${stats.notified}</strong>
    </div>
    <div class="stat stat--bad">
      <span class="stat-label">Failed</span>
      <strong>${stats.failed}</strong>
      <small>${stats.failedEmails} failed email attempt(s)</small>
    </div>
  </section>

  <section class="panel" aria-label="Requests">
    <form class="filters" method="get" action="/admin" role="search">
      <div class="search">
        <label class="sr-only" for="q">Search by email or SKU</label>
        <input id="q" name="q" type="search" value="${qValue}" placeholder="Search email or SKU" maxlength="100">
      </div>
      <div class="select">
        <label class="sr-only" for="status">Filter by status</label>
        <select id="status" name="status">${statusOptions}</select>
      </div>
      <button class="button" type="submit">Filter</button>
      ${q || status ? '<a class="reset" href="/admin">Reset</a>' : ''}
      <span class="result-count">${filteredTotal} result${filteredTotal === 1 ? '' : 's'}</span>
    </form>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Customer</th>
            <th scope="col">Product</th>
            <th scope="col">Status</th>
            <th scope="col">Requested</th>
            <th scope="col">Notified</th>
            <th scope="col">Delivery</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>

    ${
      pageCount > 1
        ? `<nav class="pagination" aria-label="Pagination">
      ${
        page > 1
          ? `<a class="page" href="${pageLink({ page: page - 1, q, status })}" rel="prev">&larr; Previous</a>`
          : '<span class="page page--disabled">&larr; Previous</span>'
      }
      <span class="page-info">Page ${page} of ${pageCount}</span>
      ${
        page < pageCount
          ? `<a class="page" href="${pageLink({ page: page + 1, q, status })}" rel="next">Next &rarr;</a>`
          : '<span class="page page--disabled">Next &rarr;</span>'
      }
    </nav>`
        : ''
    }
  </section>

  <footer class="footer">
    <span>Times shown in UTC.</span>
    <span>Protected by HTTP Basic authentication.</span>
  </footer>
</main>
</body>
</html>`;
}

module.exports = { renderAdminPage };
