import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { formatINR, formatDate, round2 } from './money';

/**
 * A customer-facing receipt for ONE sale (the aggregate Reports PDF is a
 * different document for a different reader).
 *
 * Styled like the thermal slips Indian shops already hand over -- narrow
 * column, dashed rules, the grand total as the loudest line -- so it reads as a
 * receipt and not as a letter. All labels go through t(), so a shop running in
 * Hindi or Gujarati hands its customers a receipt in that language.
 *
 * Money is re-derived from the order's own fields (which the server recomputes
 * on every write) rather than re-added here: the receipt must show the numbers
 * that were charged, not a second opinion of them.
 */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** One line item: name, qty x unit, its discount if any, and the line's value. */
function lineRows(line, t) {
  const gross = round2((line.qty || 0) * (line.price || 0));
  const discount = Math.min(line.discount || 0, gross);
  const main = `
    <tr>
      <td class="name">${esc(line.name)}</td>
      <td class="amt">${formatINR(gross)}</td>
    </tr>
    <tr>
      <td class="sub">${line.qty} × ${formatINR(line.price)}</td>
      <td></td>
    </tr>`;
  if (!discount) return main;
  return main + `
    <tr>
      <td class="sub discount">${esc(t('pos.itemDiscount'))}</td>
      <td class="amt discount">− ${formatINR(discount)}</td>
    </tr>`;
}

export function buildReceiptHtml({ order, businessName, t }) {
  const receiptNo = order.receiptNo ?? `INV-${String(order.orderNumber ?? 0).padStart(6, '0')}`;
  const when = formatDate(order.timestamp ?? order.createdAt ?? Date.now(), { withTime: true });
  const discountTotal = order.discountTotal || 0;
  const extraCharges = order.extraCharges || 0;

  const totals = [
    [t('pos.subtotal'), formatINR(order.subtotal), ''],
    ...(discountTotal > 0 ? [[t('pos.discount'), `− ${formatINR(discountTotal)}`, 'discount']] : []),
    ...(extraCharges > 0 ? [[t('pos.extraCharges'), `+ ${formatINR(extraCharges)}`, '']] : []),
  ].map(([label, value, cls]) => `
    <tr class="${cls}"><td class="name">${esc(label)}</td><td class="amt">${value}</td></tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  /* System fonts, because they are what carry Devanagari and Gujarati glyphs
     on every platform this can print from. */
  * { margin: 0; padding: 0; box-sizing: border-box;
      font-family: -apple-system, Roboto, 'Segoe UI', 'Noto Sans', sans-serif; }
  body { display: flex; justify-content: center; padding: 16px; color: #111; }
  .slip { width: 300px; }
  .center { text-align: center; }
  .shop { font-size: 18px; font-weight: 800; }
  .meta { font-size: 12px; color: #444; margin-top: 2px; }
  .rule { border: 0; border-top: 1px dashed #999; margin: 10px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { font-size: 13px; padding: 1px 0; vertical-align: top; }
  td.name { text-align: left; padding-right: 8px; }
  td.amt { text-align: right; white-space: nowrap; }
  td.sub { font-size: 11px; color: #666; padding-bottom: 4px; }
  .discount td, td.discount { color: #15803d; }
  .grand td { font-size: 16px; font-weight: 800; padding-top: 6px; }
  .edited { font-size: 11px; color: #92400e; text-align: center; margin-top: 6px; }
  .thanks { font-size: 12px; color: #444; text-align: center; margin-top: 10px; }
</style>
</head>
<body>
  <div class="slip">
    <div class="center">
      <div class="shop">${esc(businessName)}</div>
      <div class="meta">${esc(receiptNo)}</div>
      <div class="meta">${esc(when)}</div>
      ${order.customerName ? `<div class="meta">${esc(t('pos.customerName'))}: ${esc(order.customerName)}</div>` : ''}
    </div>

    <hr class="rule" />
    <table>${(order.items || []).map((l) => lineRows(l, t)).join('')}</table>
    <hr class="rule" />

    <table>
      ${totals}
      <tr class="grand"><td class="name">${esc(t('pos.grandTotal'))}</td><td class="amt">${formatINR(order.grandTotal)}</td></tr>
    </table>

    ${order.editCount > 0 ? `<div class="edited">${esc(t('sales.edited'))} (${order.editCount})</div>` : ''}
    <div class="thanks">${esc(t('receipt.thankYou'))}</div>
  </div>
</body>
</html>`;
}

/**
 * Renders the receipt to a PDF and opens the OS share sheet (WhatsApp is how
 * these actually reach customers). Where a PDF file cannot be produced --
 * expo-print has no printToFileAsync on web -- it falls back to the print
 * dialog, which still gets a paper or PDF copy into the customer's hands.
 */
export async function shareReceipt({ order, businessName, t }) {
  const html = buildReceiptHtml({ order, businessName, t });
  const receiptNo = order.receiptNo ?? `INV-${String(order.orderNumber ?? 0).padStart(6, '0')}`;

  if (typeof Print.printToFileAsync === 'function') {
    try {
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          dialogTitle: `${t('receipt.share')} — ${receiptNo}`,
          UTI: 'application/pdf',
        });
        return { ok: true, uri };
      }
    } catch {
      // fall through to the print dialog
    }
  }
  await Print.printAsync({ html });
  return { ok: true, uri: null };
}
