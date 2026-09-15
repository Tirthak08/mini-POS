import * as XLSX from 'xlsx';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { formatINR, formatDate } from './money';
import {
  orderTotals, itemTotals, expenseTotals, topProductTotals, summaryTotals,
} from './reportTotals';

/**
 * IMPORTANT -- expo-file-system 19 (SDK 54) API.
 * The old `FileSystem.writeAsStringAsync` / `FileSystem.cacheDirectory` helpers
 * still *exist* on the main import but are deprecated shims that THROW at
 * runtime. The supported API is the File/Paths classes used below. (The old
 * names do work if imported from 'expo-file-system/legacy'.)
 */

/** Creates (or replaces) a file in the cache directory and returns its uri. */
export function writeCacheFile(filename, content, { base64 = false } = {}) {
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

/**
 * Writes the file into a folder the shopkeeper picks, instead of handing it to
 * the share sheet.
 *
 * Sharing can already reach Files and Drive, so this is not a new capability --
 * but "Share" is the wrong word for what most people want, which is a copy on
 * the phone they can find again later, and several taps deep in a share sheet
 * is not where they look for it.
 *
 * Android only. The Storage Access Framework is what lets an app write outside
 * its own sandbox, and it exists only there; on iOS the Files app reaches the
 * same place through the share sheet, so that is what this falls back to
 * rather than pretending to have saved somewhere it has not.
 */
async function saveToDevice(uri, mimeType, filename, dialogTitle) {
  if (Platform.OS !== 'android') return share(uri, mimeType, dialogTitle);

  // Imported lazily and from the legacy entry point on purpose: SAF is not part
  // of the new File/Paths API, and the deprecated shims on the MAIN import
  // throw at runtime. Loading it only when a save is actually requested keeps
  // that decision out of the app's startup path.
  const legacy = await import('expo-file-system/legacy');
  const saf = legacy.StorageAccessFramework;

  const permission = await saf.requestDirectoryPermissionsAsync();
  if (!permission.granted) {
    // Not an error: declining a folder picker is a decision, not a failure.
    return null;
  }

  const target = await saf.createFileAsync(permission.directoryUri, filename, mimeType);
  const base64 = await new File(uri).base64();
  await legacy.writeAsStringAsync(target, base64, { encoding: 'base64' });
  return target;
}

/** One place that decides what happens to a finished file. */
export async function deliver(uri, { mimeType, filename, dialogTitle, mode = 'share' }) {
  return mode === 'save'
    ? saveToDevice(uri, mimeType, filename, dialogTitle)
    : share(uri, mimeType, dialogTitle);
}

/** Timestamped so repeated exports do not overwrite each other in the share sheet. */
export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export const slug = (s) => String(s || 'shop').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

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

export async function exportCsv(exportPayload, { mode = 'share' } = {}) {
  const { items = [], business, range } = exportPayload;
  if (!items.length) throw new Error('Nothing to export in this period');

  const t = itemTotals(items);
  // Keyed to match the item rows so the values land under the right columns.
  const totalsRow = {
    receiptNo: 'TOTAL',
    orderId: '',
    date: '',
    customer: `${t.count} lines`,
    product: '',
    qty: t.qty,
    unitPrice: '',
    discount: t.discount,
    lineTotal: t.lineTotal,
    unitCost: '',
    lineProfit: t.lineProfit,
  };

  const filename = `${slug(business?.name)}-sales-${stamp()}.csv`;
  const uri = writeCacheFile(filename, toCsv(items, undefined, totalsRow));
  return deliver(uri, {
    mimeType: 'text/csv',
    filename,
    dialogTitle: `Sales ${formatDate(range?.from)} - ${formatDate(range?.to)}`,
    mode,
  });
}

/* ------------------------------ Excel ------------------------------ */

export async function exportExcel(exportPayload, { mode = 'share' } = {}) {
  const { orders = [], items = [], expenses = [], totals, business, range } = exportPayload;
  if (!orders.length) throw new Error('Nothing to export in this period');

  const workbook = XLSX.utils.book_new();

  /**
   * Appends a TOTAL row beneath a sheet's data.
   *
   * `origin: -1` means "the row after the last one", so this stays correct
   * however many rows the period happens to hold. A blank row goes in first:
   * without it the total looks like one more order, and a reader scanning the
   * column sees the grand total as a transaction.
   */
  const appendTotals = (sheet, row) => {
    XLSX.utils.sheet_add_aoa(sheet, [[], row], { origin: -1 });
  };

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
  const ot = orderTotals(orders);
  appendTotals(orderSheet, [
    'TOTAL', `${ot.count} orders`, '', ot.items, ot.units,
    ot.subtotal, ot.discount, ot.extraCharges, ot.grandTotal, ot.cogs, ot.profit,
  ]);
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
  const lt = itemTotals(items);
  appendTotals(itemSheet, [
    'TOTAL', `${lt.count} lines`, '', '', lt.qty, '', lt.discount, lt.lineTotal, '', lt.lineProfit,
  ]);
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
    const et = expenseTotals(expenses);
    appendTotals(expenseSheet, ['TOTAL', `${et.count} entries`, et.amount]);
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

  return deliver(uri, {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename,
    dialogTitle: `Report ${formatDate(range?.from)} - ${formatDate(range?.to)}`,
    mode,
  });
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

  /**
   * Totals are computed over the FULL arrays, not the sliced ones rendered
   * below. A PDF that shows the first 200 orders must still total all of them,
   * or the bottom line silently understates the period.
   */
  const ordTotals = orderTotals(orders);
  const expTotals = expenseTotals(expenses);
  const tpTotals = topProductTotals(topProducts);

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
  /* The totals row. A top rule and a shaded ground separate it from the data
     above, so nobody reads the grand total as one more transaction. */
  tfoot td { border-top: 2px solid #CBD5E1; background: #F8FAFC; font-weight: 700; padding: 7px 8px; }
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
  <tbody>${top}</tbody>
  <tfoot><tr>
    <td></td><td>Total (${tpTotals.count})</td>
    <td class="num">${tpTotals.qty}</td>
    <td class="num">${esc(formatINR(tpTotals.revenue))}</td>
    <td class="num pos">${esc(formatINR(tpTotals.profit))}</td>
  </tr></tfoot></table>` : ''}

  ${expenseRows ? `<h2>Expenses</h2>
  <table><thead><tr><th>Date</th><th>Spent on</th><th class="num">Amount</th></tr></thead>
  <tbody>${expenseRows}</tbody>
  <tfoot><tr>
    <td></td><td>Total (${expTotals.count})</td>
    <td class="num neg">${esc(formatINR(expTotals.amount))}</td>
  </tr></tfoot></table>` : ''}

  ${rows ? `<h2>Orders</h2>
  <table><thead><tr><th>Date</th><th>Customer</th><th class="num">Units</th><th class="num">Discount</th><th class="num">Total</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr>
    <td></td><td>Total (${ordTotals.count} orders)</td>
    <td class="num">${ordTotals.units}</td>
    <td class="num">${esc(formatINR(ordTotals.discount))}</td>
    <td class="num">${esc(formatINR(ordTotals.grandTotal))}</td>
  </tr></tfoot></table>
  ${orders.length > 200 ? `<div class="foot">Showing the first 200 of ${orders.length} orders. Use the Excel export for the full list.</div>` : ''}` : ''}

  <div class="foot">Generated ${esc(formatDate(new Date(), { withTime: true }))} &middot; Vyapaar</div>
</body></html>`;
}

export async function exportPdf(payload, { mode = 'share' } = {}) {
  if (!payload?.orders?.length) throw new Error('Nothing to export in this period');

  const { uri } = await Print.printToFileAsync({
    html: buildReportHtml(payload),
    base64: false,
  });
  const filename = `${slug(payload.business?.name)}-report-${stamp()}.pdf`;
  return deliver(uri, {
    mimeType: 'application/pdf',
    filename,
    dialogTitle: `Report ${formatDate(payload.range?.from)} - ${formatDate(payload.range?.to)}`,
    mode,
  });
}

/**
 * The report's HTML, for showing on screen before it is sent anywhere.
 *
 * Exported so the preview renders the SAME markup the PDF is made from. A
 * preview built from a second implementation would eventually disagree with
 * the file it claims to preview, which is worse than no preview at all.
 */
export function reportHtml(payload) {
  return buildReportHtml(payload);
}

export const __test__ = { toCsv, csvCell, buildReportHtml, slug };
