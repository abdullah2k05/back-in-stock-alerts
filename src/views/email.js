'use strict';

const { escapeHtml, safeHttpUrl } = require('../lib/html');

function renderBackInStockEmail({ productName, sku, storeName, storeUrl }) {
  const name = String(productName || sku);
  const brand = String(storeName || 'Our Store');
  const subject = `${name} is back in stock`;
  const shopUrl = storeUrl ? safeHttpUrl(storeUrl) : null;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f2;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Good news — ${escapeHtml(name)} is available again.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f2;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e6df;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr>
          <td style="padding:22px 30px;border-bottom:1px solid #eef0ea;">
            <span style="font-size:15px;font-weight:700;letter-spacing:-0.01em;color:#1d211c;">${escapeHtml(brand)}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:38px 30px 10px 30px;">
            <p style="margin:0 0 14px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#2f6b4f;">Back in stock</p>
            <h1 style="margin:0 0 14px;font-size:28px;line-height:1.2;letter-spacing:-0.02em;color:#1d211c;">Good news — it&rsquo;s back.</h1>
            <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#5b635a;">The item you asked us to watch is available again. Stock can move quickly, so don&rsquo;t wait too long.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 30px 30px 30px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7f8f5;border:1px solid #e5e8e1;border-radius:12px;">
              <tr>
                <td style="padding:20px 22px;">
                  <p style="margin:0 0 6px;font-size:17px;font-weight:700;line-height:1.35;color:#1d211c;">${escapeHtml(name)}</p>
                  <p style="margin:0;font-family:ui-monospace,'SFMono-Regular',Consolas,monospace;font-size:12px;letter-spacing:0.04em;color:#6a7269;">SKU ${escapeHtml(sku)}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        ${
          shopUrl
            ? `<tr>
          <td style="padding:0 30px 32px 30px;">
            <a href="${escapeHtml(shopUrl)}" style="display:inline-block;background:#275c43;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:13px 24px;border-radius:999px;">Shop now</a>
          </td>
        </tr>`
            : ''
        }
        <tr>
          <td style="padding:22px 30px;border-top:1px solid #eef0ea;">
            <p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:#788076;">You&rsquo;re receiving this email because you asked ${escapeHtml(brand)} to let you know when this item was available again.</p>
            <p style="margin:0;font-size:13px;line-height:1.6;color:#788076;">&copy; ${new Date().getUTCFullYear()} ${escapeHtml(brand)}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    `Good news — ${name} is back in stock.`,
    '',
    name,
    `SKU: ${sku}`,
    '',
    shopUrl ? `Shop now: ${shopUrl}` : '',
    '',
    `You're receiving this email because you asked ${brand} to let you know when this item was available again.`,
    `© ${new Date().getUTCFullYear()} ${brand}`,
  ]
    .filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== ''))
    .join('\n');

  return { subject, html, text };
}

module.exports = { renderBackInStockEmail };
