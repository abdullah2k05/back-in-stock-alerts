'use strict';

const { safeHttpUrl } = require('../lib/html');

function createStockClient({
  baseUrl,
  apiKey,
  timeoutMs = 8000,
  catalogueTtlMs = 60000,
  logger = console,
}) {
  let catalogueCache = { at: 0, products: null };

  async function request(pathname) {
    let response;
    try {
      response = await fetch(`${baseUrl}${pathname}`, {
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error.name === 'TimeoutError' ? 'timed out' : error.message;
      throw new Error(`Stock API request failed: ${reason}`);
    }

    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Stock API returned HTTP ${response.status}`);

    try {
      return await response.json();
    } catch {
      throw new Error('Stock API returned invalid JSON');
    }
  }

  async function getCatalogue() {
    const fresh = catalogueCache.products && Date.now() - catalogueCache.at < catalogueTtlMs;
    if (fresh) return catalogueCache.products;

    try {
      const data = await request('');
      const products = Array.isArray(data) ? data : Array.isArray(data && data.products) ? data.products : [];
      catalogueCache = { at: Date.now(), products };
      return products;
    } catch (error) {
      if (catalogueCache.products) {
        logger.warn(`Stock catalogue refresh failed, using cached copy: ${error.message}`);
        return catalogueCache.products;
      }
      throw error;
    }
  }

  async function getProduct(sku) {
    const data = await request(`/${encodeURIComponent(sku)}`);
    if (!data || typeof data !== 'object' || !data.name) return null;

    const quantity = Number(data.quantity) || 0;
    return {
      sku: data.sku || sku,
      name: String(data.name),
      price: data.price == null ? null : Number(data.price),
      currency: data.currency || null,
      image: safeHttpUrl(data.image),
      quantity,
      in_stock: data.in_stock === true || quantity > 0,
    };
  }

  return { getCatalogue, getProduct };
}

module.exports = { createStockClient };
