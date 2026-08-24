import * as XLSX from 'xlsx';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { formatINR, formatDate } from './money';

/**
 * IMPORTANT -- expo-file-system 19 (SDK 54) API.
 * The old `FileSystem.writeAsStringAsync` / `FileSystem.cacheDirectory` helpers
 * still *exist* on the main import but are deprecated shims that THROW at
 * runtime. The supported API is the File/Paths classes used below. (The old
 * names do work if imported from 'expo-file-system/legacy'.)
 */

/** Creates (or replaces) a file in the cache directory and returns its uri. */
function writeCacheFile(filename, content, { base64 = false } = {}) {
  const file = new File(Paths.cache, filename);
  if (file.exists) file.delete(); // overwrite a file from an earlier export
  file.create();
  file.write(content, base64 ? { encoding: 'base64' } : undefined);
  return file.uri;
}

async function share(uri, mimeType, dialogTitle) {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  await Sharing.shareAsync(uri, { mimeType, dialogTitle, UTI: mimeType });
  return uri;
}

/** Timestamped so repeated exports do not overwrite each other in the share sheet. */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const slug = (s) => String(s || 'shop').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ------------------------------- CSV ------------------------------- */

/** RFC 4180 quoting: fields containing a comma, quote or newline must be quoted. */
function csvCell(value) {
  if (value == null) return '';
  const s = value instanceof Date ? formatDate(value, { withTime: true }) : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, headers) {
  if (!rows?.length) return '';
  const cols = headers ?? Object.keys(rows[0]);
  const lines = [cols.map(csvCell).join(',')];
  for (const row of rows) lines.push(cols.map((c) => csvCell(row[c])).join(','));
  // \r\n keeps Excel on Windows happy; the BOM stops it mangling ₹ and Hindi text.
  return '﻿' + lines.join('\r\n');
}

export async function exportCsv(exportPayload) {
  const { items = [], business, range } = exportPayload;
  if (!items.length) throw new Error('Nothing to export in this period');

  const filename = `${slug(business?.name)}-sales-${stamp()}.csv`;
  const uri = writeCacheFile(filename, toCsv(items));
  return share(uri, 'text/csv', `Sales ${formatDate(range?.from)} - ${formatDate(range?.to)}`);
}

/* ------------------------------ Excel ------------------------------ */

export async function exportExcel(exportPayload) {
  const { orders = [], items = [], expenses = [], totals, business, range } = exportPayload;
  if (!orders.length) throw new Error('Nothing to export in this period');

  const workbook = XLSX.utils.book_new();

  // Sheet 1: one row per order
  const orderSheet = XLSX.utils.json_to_sheet(
    orders.map((o) => ({
      'Order ID': o.orderId,
      Date: formatDate(o.date, { withTime: true }),
      Customer: o.customer,
      Items: o.itemCount,
      Units: o.unitsSold,
      Subtotal: o.subtotal,
      Discount: o.discount,
      'Extra charges': o.extraCharges,
      Total: o.grandTotal,
      COGS: o.cogs,
      Profit: Math.round((o.grandTotal - o.cogs) * 100) / 100,
    }))
  );
  orderSheet['!cols'] = [
    { wch: 26 }, { wch: 20 }, { wch: 18 }, { wch: 7 }, { wch: 7 },
    { wch: 11 }, { wch: 10 }, { wch: 13 }, { wch: 11 }, { wch: 10 }, { wch: 10 },
  ];
  XLSX.utils.book_append_sheet(workbook, orderSheet, 'Orders');

  // Sheet 2: one row per line item, for pivoting by product
  const itemSheet = XLSX.utils.json_to_sheet(
    items.map((i) => ({
      'Order ID': i.orderId,
      Date: formatDate(i.date, { withTime: true }),
      Customer: i.customer,
      Product: i.product,
      Qty: i.qty,
      'Unit price': i.unitPrice,
      Discount: i.discount,
      'Line total': i.lineTotal,
      'Unit cost': i.unitCost,
      'Line profit': i.lineProfit,
    }))
  );
  itemSheet['!cols'] = [
    { wch: 26 }, { wch: 20 }, { wch: 18 }, { wch: 24 }, { wch: 6 },
    { wch: 11 }, { wch: 10 }, { wch: 11 }, { wch: 10 }, { wch: 11 },
  ];
  XLSX.utils.book_append_sheet(workbook, itemSheet, 'Line items');

  /* Sheet 3: expenses. Its own sheet rather than extra order rows -- an
     expense is not a sale, and mixing them would corrupt any pivot built on
     the Orders sheet. Omitted entirely when there are none, so a shop that
     does not track them is not handed an empty tab to wonder about. */
  if (expenses.length) {
    const expenseSheet = XLSX.utils.json_to_sheet(
      expenses.map((e) => ({
        Date: formatDate(e.date),
        'Spent on': e.note,
        Amount: e.amount,
      }))
    );
    expenseSheet['!cols'] = [{ wch: 20 }, { wch: 40 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(workbook, expenseSheet, 'Expenses');
  }

  /* Sheet 4: headline numbers. "Profit" is spelled out as gross and net,
     because this sheet is what gets forwarded to an accountant and a single
     ambiguous "Profit" row is exactly where rent and wages go missing. */
  const expenseTotal = totals?.expenses
    ?? Math.round(expenses.reduce((sum, e) => sum + (e.amount || 0), 0) * 100) / 100;
  const gross = totals?.grossProfit ?? totals?.profit ?? 0;

  const summarySheet = XLSX.utils.aoa_to_sheet([
    ['Business', business?.name ?? ''],
    ['From', formatDate(range?.from)],
    ['To', formatDate(range?.to)],
    [],
    ['Orders', totals?.orders ?? orders.length],
    ['Revenue', totals?.revenue ?? 0],
    ['Gross profit', gross],
    ['Expenses', expenseTotal],
    ['Net profit', totals?.netProfit ?? Math.round((gross - expenseTotal) * 100) / 100],
    [],
    ['Generated', formatDate(new Date(), { withTime: true })],
  ]);
  summarySheet['!cols'] = [{ wch: 18 }, { wch: 28 }];
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

  // base64 because React Native has no Node Buffer for a binary write.
  const base64 = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });
  const filename = `${slug(business?.name)}-report-${stamp()}.xlsx`;
  const uri = writeCacheFile(filename, base64, { base64: true });

  return share(
    uri,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    `Report ${formatDate(range?.from)} - ${formatDate(range?.to)}`
  );
}

/* -------------------------------- PDF -------------------------------- */

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildReportHtml({ business, range, totals, summary, orders = [], topProducts = [], expenses = [] }) {
  const rows = orders.slice(0, 200).map((o) => `
    <tr>
      <td>${esc(formatDate(o.date, { withTime: true }))}</td>
      <td>${esc(o.customer)}</td>
      <td class="num">${o.unitsSold}</td>
      <td class="num">${esc(formatINR(o.discount))}</td>
      <td class="num strong">${esc(formatINR(o.grandTotal))}</td>
    </tr>`).join('');

  const top = topProducts.slice(0, 10).map((p, i) => `
    <tr>
      <td class="num muted">${i + 1}</td>
      <td>${esc(p.name)}</td>
      <td class="num">${p.qty}</td>
      <td class="num strong">${esc(formatINR(p.revenue))}</td>
      <td class="num pos">${esc(formatINR(p.profit))}</td>
    </tr>`).join('');

  const kpi = (label, value, cls = '') =>
    `<div class="kpi"><div class="kpi-l">${esc(label)}</div><div class="kpi-v ${cls}">${esc(value)}</div></div>`;

  /* The bottom line, spelled out. A single "Profit" box that ignored rent and
     wages is the figure that would get quoted to a bank or an accountant. */
  const gross = summary?.grossProfit ?? summary?.profit ?? totals?.grossProfit ?? totals?.profit ?? 0;
  const expenseTotal = summary?.expenses ?? totals?.expenses
    ?? Math.round(expenses.reduce((sum, e) => sum + (e.amount || 0), 0) * 100) / 100;
  const net = summary?.netProfit ?? totals?.netProfit ?? Math.round((gross - expenseTotal) * 100) / 100;

  const expenseRows = expenses.slice(0, 200).map((e) => `
    <tr>
      <td>${esc(formatDate(e.date))}</td>
      <td>${esc(e.note)}</td>
      <td class="num strong neg">${esc(formatINR(e.amount))}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Roboto, 'Helvetica Neue', sans-serif; color: #0F172A; margin: 0; padding: 28px; }
  h1 { font-size: 22px; margin: 0; }
  .sub { color: #64748B; font-size: 12px; margin-top: 4px; }
  h2 { font-size: 14px; margin: 26px 0 8px; padding-bottom: 5px; border-bottom: 2px solid #E2E8F0; text-transform: uppercase; letter-spacing: .04em; color: #475569; }
  .kpis { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
  .kpi { flex: 1 1 30%; border: 1px solid #E2E8F0; border-radius: 10px; padding: 10px 12px; }
  .kpi-l { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #64748B; }
  .kpi-v { font-size: 17px; font-weight: 700; margin-top: 3px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { text-align: left; background: #F1F5F9; color: #475569; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; padding: 7px 8px; }
  td { padding: 6px 8px; border-bottom: 1px solid #F1F5F9; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .strong { font-weight: 700; }
  .muted { color: #94A3B8; }
  .pos { color: #16A34A; }
  .neg { color: #DC2626; }
  .foot { margin-top: 26px; font-size: 10px; color: #94A3B8; text-align: center; }
</style></head>
<body>
  <h1>${esc(business?.name ?? 'Business')}</h1>
  <div class="sub">Sales report &middot; ${esc(formatDate(range?.from))} to ${esc(formatDate(range?.to))}</div>

  <div class="kpis">
    ${kpi('Revenue', formatINR(summary?.revenue ?? totals?.revenue ?? 0))}
    ${kpi('Gross profit', formatINR(gross), gross >= 0 ? 'pos' : 'neg')}
    ${kpi('Expenses', formatINR(expenseTotal), expenseTotal > 0 ? 'neg' : '')}
    ${kpi(net < 0 ? 'Net loss' : 'Net profit', formatINR(net), net >= 0 ? 'pos' : 'neg')}
    ${kpi('Orders', String(summary?.orders ?? totals?.orders ?? 0))}
    ${kpi('Avg order', formatINR(summary?.averageOrderValue ?? 0))}
    ${kpi('Items sold', String(summary?.itemsSold ?? 0))}
    ${kpi('Margin', `${summary?.marginPercent ?? 0}%`)}
  </div>

  ${top ? `<h2>Top products</h2>
  <table><thead><tr><th>#</th><th>Product</th><th class="num">Qty</th><th class="num">Revenue</th><th class="num">Profit</th></tr></thead>
  <tbody>${top}</tbody></table>` : ''}

  ${expenseRows ? `<h2>Expenses</h2>
  <table><thead><tr><th>Date</th><th>Spent on</th><th class="num">Amount</th></tr></thead>
  <tbody>${expenseRows}</tbody></table>` : ''}

  ${rows ? `<h2>Orders</h2>
  <table><thead><tr><th>Date</th><th>Customer</th><th class="num">Units</th><th class="num">Discount</th><th class="num">Total</th></tr></thead>
  <tbody>${rows}</tbody></table>
  ${orders.length > 200 ? `<div class="foot">Showing the first 200 of ${orders.length} orders. Use the Excel export for the full list.</div>` : ''}` : ''}

  <div class="foot">Generated ${esc(formatDate(new Date(), { withTime: true }))} &middot; Vyapaar</div>
</body></html>`;
}

export async function exportPdf(payload) {
  if (!payload?.orders?.length) throw new Error('Nothing to export in this period');

  const { uri } = await Print.printToFileAsync({
    html: buildReportHtml(payload),
    base64: false,
  });
  return share(uri, 'application/pdf', `Report ${formatDate(payload.range?.from)} - ${formatDate(payload.range?.to)}`);
}

export const __test__ = { toCsv, csvCell, buildReportHtml, slug };
