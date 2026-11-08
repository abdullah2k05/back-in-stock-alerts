'use strict';

const { escapeHtml } = require('../lib/html');

function money(price, currency) {
  if (typeof price !== 'number' || !Number.isFinite(price)) return '';
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: currency || 'GBP',
      maximumFractionDigits: 2,
    }).format(price);
  } catch {
    return `${currency || ''} ${price}`.trim();
  }
}

function badge(inStock) {
  return inStock
    ? '<span class="badge badge--in"><span class="dot"></span>In stock</span>'
    : '<span class="badge badge--out"><span class="dot"></span>Sold out</span>';
}

function productCard(product) {
  const image = product.image
    ? `<img class="product-image" src="${escapeHtml(product.image)}" alt="" width="96" height="96" loading="lazy" referrerpolicy="no-referrer">`
    : '<div class="product-image product-image--empty" aria-hidden="true">' +
      `<span>${escapeHtml((product.name || '?').slice(0, 2).toUpperCase())}</span></div>`;

  const price = money(product.price, product.currency);

  return `<section class="product" aria-label="Product">
    ${image}
    <div class="product-copy">
      <p class="eyebrow">Restock alert</p>
      <h1 class="product-name">${escapeHtml(product.name)}</h1>
      <p class="product-meta">SKU ${escapeHtml(product.sku)}${price ? ` &middot; ${escapeHtml(price)}` : ''}</p>
      ${badge(product.in_stock)}
    </div>
  </section>`;
}

function emailField() {
  return `<div class="field">
    <label for="email">Email address</label>
    <input id="email" name="email" type="email" inputmode="email" autocomplete="email"
      placeholder="you@example.com" maxlength="254" required aria-describedby="email-hint">
    <p class="hint" id="email-hint">We&rsquo;ll only email you about this item.</p>
  </div>`;
}

function skuField(products) {
  const options = products
    .map(
      (product) =>
        `<option value="${escapeHtml(product.sku)}"${
          product.in_stock ? ' data-in-stock="true"' : ''
        }>${escapeHtml(product.name)}${product.in_stock ? ' (in stock now)' : ''}</option>`
    )
    .join('');

  return `<div class="field">
    <label for="sku">Product</label>
    <select id="sku" name="sku" required aria-describedby="sku-hint">${options}</select>
    <p class="hint" id="sku-hint">Choose the item you&rsquo;re waiting for.</p>
  </div>`;
}

function skuTextFallback() {
  return `<div class="field">
    <label for="sku">Product SKU</label>
    <input id="sku" name="sku" type="text" maxlength="64" placeholder="e.g. TEE-ORG-WHT-M"
      required autocomplete="off" spellcheck="false" aria-describedby="sku-hint">
    <p class="hint" id="sku-hint">Enter the product code from this page.</p>
  </div>`;
}

function form({ sku, products, disabled }) {
  return `<form id="bis-form" class="form" novalidate>
    ${emailField()}
    ${sku ? `<input type="hidden" name="sku" value="${escapeHtml(sku)}">` : products ? skuField(products) : skuTextFallback()}
    <button class="button" id="bis-submit" type="submit"${disabled ? ' disabled' : ''}>
      <span class="button-label">Notify me when it&rsquo;s back</span>
      <span class="spinner" aria-hidden="true" hidden></span>
    </button>
    <p class="form-status" id="form-status" role="status" aria-live="polite" tabindex="-1"></p>
  </form>`;
}

function page({ title, description, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#f4f5f2">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="stylesheet" href="/assets/embed.css">
</head>
<body>
<main class="embed">
${body}
</main>
<script src="/assets/embed.js" defer></script>
</body>
</html>`;
}

function renderEmbedPage({ product, products, sku, notFound, stockError, storeName }) {
  const brand = storeName || 'Our Store';
  const heading = product ? `${product.name} — ${brand}` : `Restock alerts — ${brand}`;

  if (product && product.in_stock) {
    return page({
      title: heading,
      description: `Get notified when sold-out items return to ${brand}.`,
      body: `<div class="card">
        <p class="brand">${escapeHtml(brand)}</p>
        ${productCard(product)}
        <div class="notice notice--ok" role="status">
          <strong>This item is available right now.</strong>
          <p>There&rsquo;s no need to join a waitlist &mdash; order it while stock lasts.</p>
        </div>
      </div>`,
    });
  }

  if (product) {
    return page({
      title: heading,
      description: `Get an email when ${product.name} is back in stock at ${brand}.`,
      body: `<div class="card">
        <p class="brand">${escapeHtml(brand)}</p>
        ${productCard(product)}
        <div class="form-head">
          <h2>Get notified when it&rsquo;s back</h2>
          <p>Leave your email and we&rsquo;ll send you one message the moment it returns.</p>
        </div>
        ${form({ sku: product.sku, disabled: false })}
        <p class="privacy">No spam. Just this product&rsquo;s restock.</p>
      </div>`,
    });
  }

  if (sku && stockError) {
    return page({
      title: heading,
      description: `Get notified when sold-out items return to ${brand}.`,
      body: `<div class="card">
        <p class="brand">${escapeHtml(brand)}</p>
        <div class="form-head form-head--top">
          <p class="eyebrow">Restock alert</p>
          <h1>Get notified when it&rsquo;s back.</h1>
          <p>We couldn&rsquo;t load live stock right now, but you can still join the waitlist.</p>
        </div>
        <div class="notice notice--warn" role="status">
          <strong>Live stock is temporarily unavailable.</strong>
          <p>We&rsquo;ll verify the product is in stock before sending any email.</p>
        </div>
        ${form({ sku, disabled: false })}
      </div>`,
    });
  }

  if (sku || notFound) {
    return page({
      title: heading,
      description: `Get notified when sold-out items return to ${brand}.`,
      body: `<div class="card">
        <p class="brand">${escapeHtml(brand)}</p>
        <div class="notice notice--error" role="alert">
          <strong>We couldn&rsquo;t find that product.</strong>
          <p>Check the link or product code, then try again.</p>
        </div>
      </div>`,
    });
  }

  const list = Array.isArray(products) ? products : [];
  const hasProducts = list.length > 0;

  return page({
    title: heading,
    description: `Get notified when sold-out items return to ${brand}.`,
    body: `<div class="card">
      <p class="brand">${escapeHtml(brand)}</p>
      <div class="form-head form-head--top">
        <p class="eyebrow">Waitlist</p>
        <h1>Never miss a restock.</h1>
        <p>Pick a product that&rsquo;s sold out and we&rsquo;ll email you once it&rsquo;s available again.</p>
      </div>
      ${stockError ? '<div class="notice notice--warn" role="status"><strong>Live stock is temporarily unavailable.</strong><p>You can still join the waitlist; we&rsquo;ll check stock before emailing you.</p></div>' : ''}
      ${form({ sku: '', products: hasProducts ? list : null, disabled: false })}
      <p class="privacy">One email per restock. No marketing.</p>
    </div>`,
  });
}

module.exports = { renderEmbedPage };
