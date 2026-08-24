import { Order, Product, Category, Expense } from '../models/index.js';
import { parseDateRange, round2 } from '../utils/validators.js';

// Indian businesses close at ~10pm IST; grouping in UTC would push evening
// sales into the next day. All day-buckets use this zone.
const TZ = process.env.REPORT_TIMEZONE || 'Asia/Kolkata';

/** Matches the app's default "running low" threshold. */
const LOW_STOCK = Number(process.env.LOW_STOCK_THRESHOLD) || 5;

/** COGS for one order = sum(item.cost * item.qty), from the frozen snapshot. */
const COGS_EXPR = {
  $sum: {
    $map: { input: '$items', as: 'it', in: { $multiply: ['$$it.cost', '$$it.qty'] } },
  },
};

/** "2026-08-17" / "2026-08" for a Date, in the report timezone -- must match $dateToString exactly. */
const PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
function periodKey(date, groupBy) {
  const p = Object.fromEntries(PARTS_FMT.formatToParts(date).map((x) => [x.type, x.value]));
  return groupBy === 'month' ? `${p.year}-${p.month}` : `${p.year}-${p.month}-${p.day}`;
}

/** GET /api/reports/summary?from=&to= -- the KPI row. */
export async function summary(req, res) {
  const { from, to } = parseDateRange(req.query);
  const match = { businessId: req.businessId, timestamp: { $gte: from, $lte: to } };

  const [agg] = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        orders: { $sum: 1 },
        revenue: { $sum: '$grandTotal' },
        // subtotal is now gross, so this is sales at list price.
        grossSales: { $sum: '$subtotal' },
        extraCharges: { $sum: '$extraCharges' },
        discounts: { $sum: { $ifNull: ['$discountTotal', 0] } },
        cogs: { $sum: COGS_EXPR },
        itemsSold: { $sum: { $sum: { $map: { input: '$items', as: 'it', in: '$$it.qty' } } } },
      },
    },
  ]);

  const [stock] = await Product.aggregate([
    { $match: { businessId: req.businessId } },
    {
      $group: {
        _id: null,
        products: { $sum: 1 },
        stockUnits: { $sum: '$stock' },
        stockValueAtCost: { $sum: { $multiply: ['$cost', '$stock'] } },
        stockValueAtPrice: { $sum: { $multiply: ['$price', '$stock'] } },
        outOfStock: { $sum: { $cond: [{ $lte: ['$stock', 0] }, 1, 0] } },
        lowStock: {
          $sum: { $cond: [{ $and: [{ $gt: ['$stock', 0] }, { $lte: ['$stock', LOW_STOCK] }] }, 1, 0] },
        },
      },
    },
  ]);

  const revenue = round2(agg?.revenue || 0);
  const cogs = round2(agg?.cogs || 0);

  /**
   * Operating expenses for the same window -- rent, wages, electricity.
   *
   * This is why `profit` below is now explicitly GROSS and `netProfit` is the
   * new bottom line. Renaming rather than silently redefining matters: a
   * shopkeeper has been reading "Profit" as what they earned, and quietly
   * subtracting expenses from that same label would make yesterday's figure
   * disagree with today's for no visible reason.
   */
  const [exp] = await Expense.aggregate([
    { $match: { businessId: req.businessId, spentAt: { $gte: from, $lte: to } } },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  const expenses = round2(exp?.total || 0);
  const grossProfit = round2(revenue - cogs);

  res.json({
    ok: true,
    range: { from, to },
    sales: {
      orders: agg?.orders || 0,
      revenue,
      grossSales: round2(agg?.grossSales || 0),
      // Kept under the old name for anything still reading it.
      productSales: round2((agg?.grossSales || 0) - (agg?.discounts || 0)),
      extraCharges: round2(agg?.extraCharges || 0),
      discountsGiven: round2(agg?.discounts || 0),
      cogs,
      // Revenue minus the cost of what sold. Kept under the old name so nothing
      // reading `profit` breaks, but the app now labels it "Gross profit".
      profit: grossProfit,
      grossProfit,
      expenses,
      expenseCount: exp?.count || 0,
      /**
       * The real bottom line. Can legitimately be negative -- a month of rent
       * against a slow week IS a loss, and rounding that up to zero would be a
       * lie the shop makes decisions on.
       */
      netProfit: round2(grossProfit - expenses),
      marginPercent: revenue ? round2((grossProfit / revenue) * 100) : 0,
      netMarginPercent: revenue ? round2(((grossProfit - expenses) / revenue) * 100) : 0,
      itemsSold: agg?.itemsSold || 0,
      averageOrderValue: agg?.orders ? round2(revenue / agg.orders) : 0,
    },
    inventory: {
      products: stock?.products || 0,
      stockUnits: stock?.stockUnits || 0,
      // What the shop currently has tied up in unsold stock.
      investment: round2(stock?.stockValueAtCost || 0),
      // What it is worth if it all sells at the current asking price.
      retailValue: round2(stock?.stockValueAtPrice || 0),
      potentialProfit: round2((stock?.stockValueAtPrice || 0) - (stock?.stockValueAtCost || 0)),
      outOfStock: stock?.outOfStock || 0,
      lowStock: stock?.lowStock || 0,
      // Retained under the old names so nothing depending on them breaks.
      stockValueAtCost: round2(stock?.stockValueAtCost || 0),
      stockValueAtPrice: round2(stock?.stockValueAtPrice || 0),
    },
  });
}

/**
 * GET /api/reports/sales-trend?from=&to=&groupBy=day|month
 * Feeds the line chart AND the revenue-vs-profit chart (PRD 6, screen 3).
 * Gap-filled, so the chart has no missing x-axis points on zero-sale days.
 */
export async function salesTrend(req, res) {
  const { from, to } = parseDateRange(req.query);
  const groupBy = req.query.groupBy === 'month' ? 'month' : 'day';
  const format = groupBy === 'month' ? '%Y-%m' : '%Y-%m-%d';

  const rows = await Order.aggregate([
    { $match: { businessId: req.businessId, timestamp: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: { $dateToString: { format, date: '$timestamp', timezone: TZ } },
        orders: { $sum: 1 },
        revenue: { $sum: '$grandTotal' },
        cogs: { $sum: COGS_EXPR },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const byKey = new Map(rows.map((r) => [r._id, r]));
  const buckets = [];
  const seen = new Set();
  const cursor = new Date(from);

  while (cursor <= to) {
    const key = periodKey(cursor, groupBy);
    if (!seen.has(key)) {
      seen.add(key);
      const hit = byKey.get(key);
      const revenue = round2(hit?.revenue || 0);
      const cogs = round2(hit?.cogs || 0);
      buckets.push({ period: key, orders: hit?.orders || 0, revenue, cogs, profit: round2(revenue - cogs) });
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  res.json({ ok: true, groupBy, timezone: TZ, range: { from, to }, trend: buckets });
}

/** GET /api/reports/by-category -- the pie/donut chart. */
export async function byCategory(req, res) {
  const { from, to } = parseDateRange(req.query);

  const rows = await Order.aggregate([
    { $match: { businessId: req.businessId, timestamp: { $gte: from, $lte: to } } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.productId',
        revenue: { $sum: '$items.lineTotal' },
        qty: { $sum: '$items.qty' },
        cogs: { $sum: { $multiply: ['$items.cost', '$items.qty'] } },
      },
    },
    { $lookup: { from: Product.collection.name, localField: '_id', foreignField: '_id', as: 'product' } },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: '$product.categoryId', // null once a product has been deleted
        revenue: { $sum: '$revenue' },
        qty: { $sum: '$qty' },
        cogs: { $sum: '$cogs' },
      },
    },
    { $lookup: { from: Category.collection.name, localField: '_id', foreignField: '_id', as: 'category' } },
    { $unwind: { path: '$category', preserveNullAndEmptyArrays: true } },
    { $sort: { revenue: -1 } },
  ]);

  const total = rows.reduce((s, r) => s + (r.revenue || 0), 0);

  res.json({
    ok: true,
    range: { from, to },
    categories: rows.map((r) => ({
      categoryId: r._id || null,
      name: r.category?.name || 'Uncategorised / deleted',
      color: r.category?.color || '#9CA3AF',
      revenue: round2(r.revenue),
      profit: round2(r.revenue - r.cogs),
      qty: r.qty,
      sharePercent: total ? round2((r.revenue / total) * 100) : 0,
    })),
  });
}

/** GET /api/reports/top-products?limit=10 */
export async function topProducts(req, res) {
  const { from, to } = parseDateRange(req.query);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));

  const rows = await Order.aggregate([
    { $match: { businessId: req.businessId, timestamp: { $gte: from, $lte: to } } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.productId',
        name: { $last: '$items.name' },
        qty: { $sum: '$items.qty' },
        revenue: { $sum: '$items.lineTotal' },
        cogs: { $sum: { $multiply: ['$items.cost', '$items.qty'] } },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: limit },
  ]);

  res.json({
    ok: true,
    range: { from, to },
    products: rows.map((r) => ({
      productId: r._id,
      name: r.name,
      qty: r.qty,
      revenue: round2(r.revenue),
      profit: round2(r.revenue - r.cogs),
    })),
  });
}

/** GET /api/reports/low-stock?threshold=5 */
export async function lowStock(req, res) {
  const threshold = Math.max(0, Number(req.query.threshold) || 5);
  const products = await Product.find({ businessId: req.businessId, stock: { $lte: threshold } })
    .populate('categoryId', 'name color')
    .sort({ stock: 1 })
    .lean();

  res.json({
    ok: true,
    threshold,
    products: products.map((p) => ({
      _id: p._id, name: p.name, stock: p.stock, price: p.price,
      category: p.categoryId?.name ?? null,
    })),
  });
}

/**
 * GET /api/reports/export?from=&to= -- one flat payload the app turns into
 * CSV / XLSX / PDF on-device (PRD 2: xlsx + expo-print). Doing the shaping
 * here keeps the export logic identical across all three formats.
 */
export async function exportData(req, res) {
  const { from, to } = parseDateRange(req.query);
  const orders = await Order.find({ businessId: req.businessId, timestamp: { $gte: from, $lte: to } })
    .sort({ timestamp: 1 })
    .lean();

  const orderRows = orders.map((o) => ({
    receiptNo: `INV-${String(o.orderNumber ?? 0).padStart(6, '0')}`,
    orderId: String(o._id),
    date: o.timestamp,
    customer: o.customerName,
    itemCount: o.items.length,
    unitsSold: o.items.reduce((s, i) => s + i.qty, 0),
    subtotal: round2(o.subtotal),
    discount: round2(o.discountTotal ?? o.items.reduce((s, i) => s + i.discount, 0)),
    extraCharges: round2(o.extraCharges),
    grandTotal: round2(o.grandTotal),
    cogs: round2(o.items.reduce((s, i) => s + i.cost * i.qty, 0)),
  }));

  const itemRows = orders.flatMap((o) =>
    o.items.map((i) => ({
      receiptNo: `INV-${String(o.orderNumber ?? 0).padStart(6, '0')}`,
      orderId: String(o._id),
      date: o.timestamp,
      customer: o.customerName,
      product: i.name,
      qty: i.qty,
      unitPrice: round2(i.price),
      discount: round2(i.discount),
      lineTotal: round2(i.lineTotal),
      unitCost: round2(i.cost),
      lineProfit: round2(i.lineTotal - i.cost * i.qty),
    }))
  );

  /**
   * Expenses ride along in the export for the same reason they appear in the
   * summary: an exported "Profit" column that ignored rent and wages would be
   * the one figure the shopkeeper takes to their accountant, and it would be
   * wrong. They are a separate list because they are not orders -- joining them
   * into the order rows would invent transactions that never happened.
   */
  const expenses = await Expense.find({
    businessId: req.businessId,
    spentAt: { $gte: from, $lte: to },
  })
    .sort({ spentAt: 1 })
    .lean();

  const expenseRows = expenses.map((e) => ({
    expenseId: String(e._id),
    date: e.spentAt,
    note: e.note,
    amount: round2(e.amount),
  }));

  const revenue = round2(orderRows.reduce((s, r) => s + r.grandTotal, 0));
  const grossProfit = round2(orderRows.reduce((s, r) => s + (r.grandTotal - r.cogs), 0));
  const expenseTotal = round2(expenseRows.reduce((s, r) => s + r.amount, 0));

  res.json({
    ok: true,
    business: { businessId: req.businessId, name: req.businessName },
    range: { from, to },
    generatedAt: new Date(),
    totals: {
      orders: orderRows.length,
      revenue,
      // `profit` stays GROSS so an older client reading it means what it always
      // meant; the honest bottom line is netProfit beside it.
      profit: grossProfit,
      grossProfit,
      expenses: expenseTotal,
      expenseCount: expenseRows.length,
      netProfit: round2(grossProfit - expenseTotal),
    },
    orders: orderRows,
    items: itemRows,
    expenses: expenseRows,
  });
}
