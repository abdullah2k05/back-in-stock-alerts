'use strict';

const express = require('express');
const { renderEmbedPage } = require('../views/embed');
const { skuSchema } = require('../lib/validate');

function createEmbedRouter({ stockClient, config, logger }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    res.set('Cache-Control', 'no-store');

    const rawSku = typeof req.query.sku === 'string' ? req.query.sku.trim() : '';
    const base = { storeName: config.storeName };

    if (rawSku) {
      const parsed = skuSchema.safeParse(rawSku);
      if (!parsed.success) {
        return res
          .status(400)
          .send(renderEmbedPage({ ...base, sku: rawSku, notFound: true }));
      }

      try {
        const product = await stockClient.getProduct(parsed.data);
        if (!product) {
          return res
            .status(404)
            .send(renderEmbedPage({ ...base, sku: parsed.data, notFound: true }));
        }
        return res.send(renderEmbedPage({ ...base, product, sku: parsed.data }));
      } catch (error) {
        logger.warn(`Embed stock lookup failed for ${parsed.data}: ${error.message}`);
        return res.send(
          renderEmbedPage({ ...base, sku: parsed.data, stockError: true })
        );
      }
    }

    try {
      const products = await stockClient.getCatalogue();
      return res.send(renderEmbedPage({ ...base, products }));
    } catch (error) {
      logger.warn(`Embed catalogue lookup failed: ${error.message}`);
      return res.send(renderEmbedPage({ ...base, products: null, stockError: true }));
    }
  });

  return router;
}

module.exports = { createEmbedRouter };
