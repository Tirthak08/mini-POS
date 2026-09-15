import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { LineChart } from 'react-native-chart-kit';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';

import Screen from '../components/Screen';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import Loading, { ErrorBanner } from '../components/Loading';
import { Card, StatTile } from '../components/Card';
import { reportApi } from '../api/endpoints';
import { toast } from '../store/uiStore';
import DateRangePicker from '../components/DateRangePicker';
import { formatINR, formatDate } from '../utils/money';
import { resolveRange, DEFAULT_PRESET, describeRange } from '../utils/dateRange';
import { exportCsv, exportExcel, exportPdf } from '../utils/exports';
import { chartConfig, chartPalette, colors, seriesColors, otherColor, rgba } from '../theme';
import { useScrollTopOnFocus } from '../hooks/useScrollTopOnFocus';
import ReportPreview from '../components/ReportPreview';
import DetailModal from '../components/DetailModal';
import ChartTooltip from '../components/ChartTooltip';
import { topProductTotals, categoryTotals } from '../utils/reportTotals';
import { bucketLabel } from '../utils/chartTooltip';

/** Six or fewer categories keep their own hue; the rest fold into "Other". */
const MAX_CATEGORY_SLICES = 6;


/**
 * A card heading with an action on the right.
 *
 * Both report sections show a truncated list, and until now nothing said so --
 * "Top products" looked like the whole answer when it was the first eight rows
 * of it. The hint states the truncation and the action undoes it.
 */
function SectionHeader({ title, hint, onDetails, detailsLabel }) {
  return (
    <View className="mb-3 flex-row items-start justify-between">
      <View className="flex-1 pr-2">
        <Text className="text-sm font-semibold text-slate-800">{title}</Text>
        {hint ? <Text className="mt-0.5 text-xs text-slate-400">{hint}</Text> : null}
      </View>
      <Pressable
        onPress={onDetails}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`${detailsLabel} — ${title}`}
        className="flex-row items-center rounded-lg px-2 py-1 active:bg-slate-100"
      >
        <Text className="text-xs font-semibold text-blue-700">{detailsLabel}</Text>
        <Ionicons name="chevron-forward" size={14} color="#1D4ED8" />
      </Pressable>
    </View>
  );
}

export default function ReportsScreen() {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();

  // A resolved {from,to,groupBy,apiRange} rather than a day count, so the
  // presets ("last month") and a custom span go through one code path.
  const [range, setRange] = useState(() => resolveRange(DEFAULT_PRESET));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [busyExport, setBusyExport] = useState(null); // 'csv' | 'excel' | 'pdf'
  // 'share' hands the file to the OS sheet; 'save' writes it into a folder the
  // shopkeeper picks. Remembered across exports because it is a habit, not a
  // per-file decision.
  const [exportMode, setExportMode] = useState('share');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPayload, setPreviewPayload] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const [detail, setDetail] = useState(null); // null | 'categories' | 'products'
  const [allProducts, setAllProducts] = useState(null);
  const [tooltip, setTooltip] = useState(null); // { chart, index, x, y }
  const scrollRef = useScrollTopOnFocus();

  /**
   * `silent` keeps the figures on screen while they are re-fetched, instead of
   * swapping the whole tab for a spinner. Pulling to refresh a report you are
   * reading should not make it disappear -- and the old numbers are the right
   * thing to show until the new ones land.
   */
  const load = useCallback(async ({ silent = false } = {}) => {
    silent ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      // One round trip per card, in parallel.
      const q = range.apiRange;
      const [summary, trend, byCategory, top] = await Promise.all([
        reportApi.summary(q),
        reportApi.salesTrend({ ...q, groupBy: range.groupBy }),
        reportApi.byCategory(q),
        reportApi.topProducts({ ...q, limit: 8 }),
      ]);
      setData({ summary, trend, byCategory, top });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  /**
   * Come back to this tab after ringing up a sale and the totals should already
   * include it -- the Sales and Stock tabs both behave that way.
   *
   * The ref dance matters here more than it does on those tabs. This screen
   * fires FOUR requests per load, and a focus effect that depended on `load`
   * would re-run whenever the period changed -- firing all four again on top of
   * the four the period change itself triggers, and four more on first mount.
   * Reading the latest `load` through a ref keeps the effect's deps empty, so
   * it runs on genuine focus changes and nothing else.
   */
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);

  const firstFocus = useRef(true);
  useFocusEffect(useCallback(() => {
    // The mount load is already in flight; refreshing on top of it would double
    // every request for no new information.
    if (firstFocus.current) {
      firstFocus.current = false;
      return;
    }
    loadRef.current({ silent: true });
  }, []));

  /**
   * The export payload is a separate, heavier request than the four the screen
   * already makes -- it carries every order and line item in the period. It is
   * fetched once and reused by the preview and by all three formats, and thrown
   * away when the period changes so a stale month can never be exported under a
   * new heading.
   */
  const fetchExportPayload = useCallback(async () => {
    if (previewPayload) return previewPayload;
    const raw = await reportApi.exportData(range.apiRange);
    const payload = {
      ...raw,
      summary: data?.summary?.sales,
      topProducts: data?.top?.products ?? [],
    };
    setPreviewPayload(payload);
    return payload;
  }, [previewPayload, range, data]);

  useEffect(() => { setPreviewPayload(null); setAllProducts(null); }, [range]);

  const openPreview = async () => {
    setPreparing(true);
    try {
      const payload = await fetchExportPayload();
      if (!payload.orders?.length) {
        toast.error(t('reports.noData'));
        return;
      }
      setPreviewOpen(true);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setPreparing(false);
    }
  };

  const runExport = async (kind) => {
    setBusyExport(kind);
    try {
      const payload = await fetchExportPayload();
      if (!payload.orders?.length) {
        toast.error(t('reports.noData'));
        return;
      }
      const opts = { mode: exportMode };
      const written = kind === 'csv' ? await exportCsv(payload, opts)
        : kind === 'excel' ? await exportExcel(payload, opts)
          : await exportPdf(payload, opts);

      // saveToDevice returns null when the folder picker was dismissed. That is
      // a choice, not a failure, so it gets no error -- but it must not claim
      // to have saved either.
      if (exportMode === 'save' && written) toast.success(t('reports.saved'));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyExport(null);
    }
  };

  /**
   * The detail list needs more products than the eight the card shows. Fetched
   * only when the detail is actually opened -- most sessions never ask.
   */
  const openProductDetail = async () => {
    setDetail('products');
    if (allProducts) return;
    try {
      const res = await reportApi.topProducts({ ...range.apiRange, limit: 50 });
      setAllProducts(res.products ?? []);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const sales = data?.summary?.sales;
  const trend = data?.trend?.trend ?? [];
  const hasSales = (sales?.orders ?? 0) > 0;

  /**
   * `profit` is the server's GROSS figure and keeps that meaning; grossProfit,
   * expenses and netProfit were added beside it. The fallbacks are not
   * decoration -- a phone can be running against an older API than the one it
   * was built for, and reading `undefined` here would render "₹NaN" where the
   * profit used to be.
   */
  const grossProfit = sales?.grossProfit ?? sales?.profit ?? 0;
  const expenses = sales?.expenses ?? 0;
  const netProfit = sales?.netProfit ?? grossProfit - expenses;
  /**
   * Absent on a server that predates payment methods, so the card simply does
   * not render rather than showing an empty box or a zero that looks like a
   * shop that took no money.
   */
  const payments = data?.summary?.payments ?? [];
  /**
   * Deliberately NOT part of the period figures above it: a debt is outstanding
   * until it is paid, and a number that shrank every time the date filter
   * narrowed would mean something nobody asked for.
   */
  const receivables = data?.summary?.receivables ?? null;
  const hasReceivables = Boolean(receivables && (receivables.owed > 0 || receivables.owing > 0));

  /**
   * Rendered in both branches below, because it is the one figure on this
   * screen that the date filter does not own. A shop with nothing sold
   * yesterday still has money on the street today, and hiding the tile behind
   * the "no sales in this period" empty state made the amount owed disappear
   * on a filter that has nothing to do with it.
   */
  const receivablesTile = hasReceivables ? (
    <View className="mt-3 flex-row gap-2">
      <StatTile
        className="flex-1"
        label={t('reports.onTheStreet')}
        value={formatINR(receivables.owed)}
        sub={t('reports.onTheStreetHint', { count: receivables.owing })}
        tone={receivables.owed > 0 ? 'negative' : 'default'}
      />
    </View>
  ) : null;

  const chartWidth = width - 56; // screen minus card padding, with room for the last x label

  /** Blank out most x labels so 30 buckets do not overlap into mush. */
  const labels = useMemo(() => {
    if (!trend.length) return [];
    const step = Math.max(1, Math.ceil(trend.length / 5));
    return trend.map((b, i) => {
      // Only evenly spaced buckets get a label. Forcing one onto the final
      // bucket pushed it half a label-width past the right edge of the plot.
      if (i % step !== 0) return '';
      const parts = b.period.split('-');
      // Unpadded d/m keeps the last label from overflowing the plot edge.
      return parts.length === 3
        ? `${Number(parts[2])}/${Number(parts[1])}`
        : `${Number(parts[1])}/${String(parts[0]).slice(2)}`;
    });
  }, [trend]);

  const categorySlices = useMemo(() => {
    const all = data?.byCategory?.categories ?? [];
    if (all.length <= MAX_CATEGORY_SLICES) {
      return all.map((c, i) => ({ ...c, tint: chartPalette[i] ?? otherColor }));
    }
    const head = all.slice(0, MAX_CATEGORY_SLICES).map((c, i) => ({ ...c, tint: chartPalette[i] }));
    const tail = all.slice(MAX_CATEGORY_SLICES);
    return [
      ...head,
      {
        categoryId: 'other',
        name: `Other (${tail.length})`,
        tint: otherColor,
        revenue: tail.reduce((s, c) => s + c.revenue, 0),
        profit: tail.reduce((s, c) => s + c.profit, 0),
        qty: tail.reduce((s, c) => s + c.qty, 0),
        sharePercent: tail.reduce((s, c) => s + c.sharePercent, 0),
      },
    ];
  }, [data]);

  const maxCategoryRevenue = Math.max(1, ...categorySlices.map((c) => c.revenue));

  const allCategories = data?.byCategory?.categories ?? [];
  const labelFor = (bucket) => bucketLabel(bucket, formatDate);

  return (
    <Screen title={t('reports.title')}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{ paddingBottom: 40, flexGrow: 1 }}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load({ silent: true })}
            colors={[colors.brand]}
            tintColor={colors.brand}
          />
        )}
      >
        {/* Period filter. Reports and Sales share it, so the two tabs cannot
            disagree about what "this month" means. */}
        <DateRangePicker value={range} onChange={setRange} />

        {/* Silent only when there is something on screen to keep. A retry with
            nothing behind it needs the spinner, or the tap appears to do
            nothing at all. */}
        <ErrorBanner
          message={error}
          onRetry={() => load({ silent: Boolean(data) })}
          retryLabel={t('common.retry')}
        />

        {loading ? <Loading label={t('common.loading')} /> : null}

        {loading ? null : !hasSales ? (
          <>
            {receivablesTile ? <View className="mt-1 px-4">{receivablesTile}</View> : null}
            <EmptyState icon="bar-chart-outline" title={t('reports.noData')} hint={t('reports.noDataHint')} />
          </>
        ) : (
          <>
            {/* -------------------- KPI tiles -------------------- */}
            <View className="mt-4 px-4">
              <View className="flex-row gap-2">
                <StatTile className="flex-1" label={t('reports.revenue')} value={formatINR(sales.revenue)} tone="brand" />
                {/* Explicitly GROSS. It is the same number this tile has always
                    shown; only the label changed, because calling it "Profit"
                    while rent and wages were missing from it was the half-truth
                    that expenses exist to fix. */}
                <StatTile
                  className="flex-1"
                  label={t('reports.grossProfit')}
                  value={formatINR(grossProfit)}
                  sub={`${sales.marginPercent}% ${t('reports.margin')}`}
                  tone={grossProfit >= 0 ? 'positive' : 'negative'}
                />
              </View>

              {/* Expenses and what they leave behind. Shown even at zero: a net
                  profit that silently equals gross would let a shop believe its
                  outgoings were already accounted for. */}
              <View className="mt-2 flex-row gap-2">
                <StatTile
                  className="flex-1"
                  label={t('reports.expenses')}
                  value={formatINR(expenses)}
                  sub={t('reports.expensesHint')}
                  tone={expenses > 0 ? 'negative' : 'default'}
                />
                <StatTile
                  className="flex-1"
                  label={netProfit < 0 ? t('reports.netLoss') : t('reports.netProfit')}
                  /* A loss is shown AS a loss. Flooring it at zero, or dropping
                     the sign, would turn the one number a shopkeeper must act on
                     into a reassuring blank. */
                  value={formatINR(netProfit)}
                  sub={`${sales.netMarginPercent ?? 0}% ${t('reports.netMargin')}`}
                  tone={netProfit >= 0 ? 'positive' : 'negative'}
                />
              </View>
              {receivablesTile}

              {/* How the takings actually arrived.
                  Directly under the money tiles because it answers a question
                  the tiles above provoke and cannot settle: revenue of ₹8,000
                  does not tell you what should be in the drawer tonight. */}
              {payments.length ? (
                <View className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
                  <Text className="text-xs font-semibold text-slate-600">{t('reports.paidBy')}</Text>
                  {/* Spelled out because it is NOT revenue: a sale on credit
                      contributes only what was handed over, and a customer
                      settling an old debt contributes money that belongs to no
                      sale in this period. */}
                  <Text className="mb-2 text-[11px] text-slate-400">
                    {t('reports.paidByHint', { amount: formatINR(data?.summary?.received ?? 0) })}
                  </Text>
                  {payments.map((p, i) => (
                    <View
                      key={p.method}
                      className={`flex-row items-center justify-between py-1.5 ${i === payments.length - 1 ? '' : 'border-b border-slate-100'}`}
                    >
                      <View className="flex-row items-center">
                        <Text className="text-sm text-slate-700">{t(`pos.pay_${p.method}`)}</Text>
                        <Text className="ml-2 text-xs text-slate-400">
                          {t('reports.ordersShort', { count: p.orders })}
                          {p.repayments ? ` + ${t('reports.repaymentsShort', { count: p.repayments })}` : ''}
                        </Text>
                      </View>
                      <View className="flex-row items-baseline">
                        <Text className="text-sm font-bold text-slate-900">{formatINR(p.amount)}</Text>
                        <Text className="ml-2 text-xs text-slate-400">{p.sharePercent}%</Text>
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}

              <View className="mt-2 flex-row gap-2">
                <StatTile className="flex-1" label={t('reports.orders')} value={String(sales.orders)} />
                <StatTile className="flex-1" label={t('reports.avgOrder')} value={formatINR(sales.averageOrderValue)} />
              </View>
              <View className="mt-2 flex-row gap-2">
                <StatTile className="flex-1" label={t('reports.itemsSold')} value={String(sales.itemsSold)} />
                <StatTile
                  className="flex-1"
                  label={t('reports.discountsGiven')}
                  value={formatINR(sales.discountsGiven)}
                />
              </View>
              {/* The period figure people mean by "investment": what the goods
                  that actually sold in this window cost. Money still sitting on
                  the shelf is a different number and lives on the Stock tab. */}
              <View className="mt-2 flex-row gap-2">
                <StatTile
                  className="flex-1"
                  label={t('reports.cogs')}
                  value={formatINR(sales.cogs)}
                  sub={t('reports.cogsHint')}
                />
              </View>
              <Text className="mt-2 text-xs text-slate-400">{t('reports.inventoryMovedHint')}</Text>
              {expenses === 0 ? (
                <Text className="mt-1 text-xs text-slate-400">{t('reports.addExpensesHint')}</Text>
              ) : null}
            </View>

            {/* ---------------- sales trend (one series, so no legend) ---------------- */}
            {trend.length > 1 ? (
              <View className="mt-4 px-4">
                <Card className="px-1 py-3">
                  <Text className="mb-1 px-3 text-sm font-semibold text-slate-800">{t('reports.salesTrend')}</Text>
                  <Text className="mb-2 px-3 text-xs text-slate-400">
                    {describeRange(range, t, formatDate)}
                  </Text>
                  {/* The chart and its tooltip share a positioning context, so
                      the callout can sit over the exact point that was tapped. */}
                  <View>
                    <LineChart
                      data={{ labels, datasets: [{ data: trend.map((b) => b.revenue), color: rgba(seriesColors.revenue) }] }}
                      width={chartWidth}
                      height={210}
                      chartConfig={chartConfig}
                      bezier
                      withInnerLines
                      withVerticalLines={false}
                      yAxisLabel="₹"
                      fromZero
                      style={{ borderRadius: 8, paddingRight: 44 }}
                      onDataPointClick={({ index, x, y }) => setTooltip((cur) => (
                        // Tapping the same point again dismisses it, so there is
                        // a way to clear the callout without hunting for one.
                        cur?.chart === 'trend' && cur.index === index
                          ? null
                          : { chart: 'trend', index, x, y }
                      ))}
                    />
                    {tooltip?.chart === 'trend' && trend[tooltip.index] ? (
                      <ChartTooltip
                        x={tooltip.x}
                        y={tooltip.y}
                        chartWidth={chartWidth}
                        label={labelFor(trend[tooltip.index])}
                        value={formatINR(trend[tooltip.index].revenue)}
                        sub={t('reports.revenue')}
                      />
                    ) : null}
                  </View>
                </Card>
              </View>
            ) : null}

            {/* ------- revenue vs profit: two series, ONE axis (both in rupees) ------- */}
            {trend.length > 1 ? (
              <View className="mt-3 px-4">
                <Card className="px-1 py-3">
                  <Text className="mb-1 px-3 text-sm font-semibold text-slate-800">{t('reports.revenueVsProfit')}</Text>

                  {/* Legend is mandatory with 2+ series, so identity is never colour-alone */}
                  <View className="mb-2 flex-row px-3">
                    {[
                      { label: t('reports.revenue'), color: seriesColors.revenue, value: formatINR(sales.revenue) },
                      { label: t('reports.profit'), color: seriesColors.profit, value: formatINR(sales.profit) },
                    ].map((s) => (
                      <View key={s.label} className="mr-4 flex-row items-center">
                        <View className="mr-1.5 h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color }} />
                        <Text className="text-xs text-slate-500">{s.label}</Text>
                        <Text className="ml-1 text-xs font-semibold text-slate-700">{s.value}</Text>
                      </View>
                    ))}
                  </View>

                  <View>
                  <LineChart
                    data={{
                      labels,
                      datasets: [
                        { data: trend.map((b) => b.revenue), color: rgba(seriesColors.revenue) },
                        { data: trend.map((b) => b.profit), color: rgba(seriesColors.profit) },
                      ],
                    }}
                    width={chartWidth}
                    height={210}
                    chartConfig={chartConfig}
                    withInnerLines
                    withVerticalLines={false}
                    yAxisLabel="₹"
                    fromZero
                    style={{ borderRadius: 8, paddingRight: 44 }}
                    onDataPointClick={({ index, x, y }) => setTooltip((cur) => (
                      cur?.chart === 'rvp' && cur.index === index ? null : { chart: 'rvp', index, x, y }
                    ))}
                  />
                  {tooltip?.chart === 'rvp' && trend[tooltip.index] ? (
                    <ChartTooltip
                      x={tooltip.x}
                      y={tooltip.y}
                      chartWidth={chartWidth}
                      label={labelFor(trend[tooltip.index])}
                      value={formatINR(trend[tooltip.index].revenue)}
                      sub={`${t('reports.profit')} ${formatINR(trend[tooltip.index].profit)}`}
                    />
                  ) : null}
                  </View>
                </Card>
              </View>
            ) : null}

            {/* -------- category distribution: horizontal bars, directly labelled --------
                A pie was the obvious choice here but it compares close values badly and
                cannot carry long Hindi/Gujarati category names. Bars sort, label and
                scale honestly on a narrow screen. */}
            {categorySlices.length ? (
              <View className="mt-3 px-4">
                <Card>
                  <SectionHeader
                    title={t('reports.byCategory')}
                    onDetails={() => setDetail('categories')}
                    detailsLabel={t('reports.details')}
                    hint={allCategories.length > categorySlices.length
                      ? t('reports.showingTop', { n: categorySlices.length, of: allCategories.length })
                      : null}
                  />
                  {categorySlices.map((c) => (
                    <View key={String(c.categoryId)} className="mb-3">
                      <View className="mb-1 flex-row items-center justify-between">
                        <View className="flex-1 flex-row items-center pr-2">
                          <View className="mr-2 h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c.tint }} />
                          <Text className="flex-1 text-sm text-slate-700" numberOfLines={1}>{c.name}</Text>
                        </View>
                        <Text className="text-sm font-semibold text-slate-900">{formatINR(c.revenue)}</Text>
                        <Text className="ml-2 w-11 text-right text-xs text-slate-400">{c.sharePercent}%</Text>
                      </View>
                      <View className="h-2 overflow-hidden rounded-full bg-slate-100">
                        <View
                          className="h-2 rounded-full"
                          style={{
                            width: `${Math.max(2, (c.revenue / maxCategoryRevenue) * 100)}%`,
                            backgroundColor: c.tint,
                          }}
                        />
                      </View>
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}

            {/* -------------------- top products -------------------- */}
            {data?.top?.products?.length ? (
              <View className="mt-3 px-4">
                <Card>
                  <SectionHeader
                    title={t('reports.topProducts')}
                    onDetails={openProductDetail}
                    detailsLabel={t('reports.details')}
                    hint={t('reports.showingTopProducts', { n: data.top.products.length })}
                  />
                  {data.top.products.map((p, i) => (
                    <View
                      key={String(p.productId ?? i)}
                      className={`flex-row items-center py-2 ${i > 0 ? 'border-t border-slate-100' : ''}`}
                    >
                      <Text className="w-6 text-xs text-slate-400">{i + 1}</Text>
                      <View className="flex-1 pr-2">
                        <Text className="text-sm text-slate-800" numberOfLines={1}>{p.name}</Text>
                        <Text className="text-xs text-slate-400">× {p.qty}</Text>
                      </View>
                      <View className="items-end">
                        <Text className="text-sm font-semibold text-slate-900">{formatINR(p.revenue)}</Text>
                        <Text className="text-xs" style={{ color: colors.success }}>+{formatINR(p.profit)}</Text>
                      </View>
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}
          </>
        )}

        {/* -------------------- exports -------------------- */}
        <View className="mt-4 px-4">
          <Card>
            <Text className="mb-3 text-sm font-semibold text-slate-800">{t('reports.exportTitle')}</Text>

            {/* Preview first and full width. Sending a file you have not seen
                to an accountant is how one export becomes three. */}
            <Button
              title={t('reports.preview')}
              icon="eye-outline"
              onPress={openPreview}
              loading={preparing}
              disabled={Boolean(busyExport) || preparing}
              fullWidth
            />

            {/* Share hands the file to the OS sheet; Save writes it into a
                folder. Both were previously "Share", which is the wrong word
                for the thing most people want -- a copy they can find later. */}
            <View className="mb-3 mt-3 flex-row gap-2">
              {[
                { key: 'share', label: t('reports.share'), icon: 'share-social-outline' },
                { key: 'save', label: t('reports.saveToDevice'), icon: 'download-outline' },
              ].map(({ key, label, icon }) => {
                const active = exportMode === key;
                return (
                  <Pressable
                    key={key}
                    onPress={() => setExportMode(key)}
                    accessibilityRole="button"
                    aria-selected={active}
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={label}
                    className={`flex-1 flex-row items-center justify-center rounded-xl border py-2.5 ${
                      active ? 'border-blue-600 bg-blue-600' : 'border-slate-300 bg-white'
                    }`}
                  >
                    <Ionicons name={icon} size={15} color={active ? '#FFFFFF' : '#475569'} />
                    <Text
                      className={`ml-1.5 text-sm font-semibold ${active ? 'text-white' : 'text-slate-600'}`}
                      numberOfLines={1}
                      style={{ lineHeight: 20 }}
                    >
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View className="flex-row gap-2">
              <View className="flex-1">
                <Button
                  title={t('reports.exportCsv')}
                  icon="document-text-outline"
                  variant="secondary"
                  onPress={() => runExport('csv')}
                  loading={busyExport === 'csv'}
                  disabled={Boolean(busyExport)}
                  fullWidth
                />
              </View>
              <View className="flex-1">
                <Button
                  title={t('reports.exportExcel')}
                  icon="grid-outline"
                  variant="secondary"
                  onPress={() => runExport('excel')}
                  loading={busyExport === 'excel'}
                  disabled={Boolean(busyExport)}
                  fullWidth
                />
              </View>
              <View className="flex-1">
                <Button
                  title={t('reports.exportPdf')}
                  icon="print-outline"
                  variant="secondary"
                  onPress={() => runExport('pdf')}
                  loading={busyExport === 'pdf'}
                  disabled={Boolean(busyExport)}
                  fullWidth
                />
              </View>
            </View>
            <Text className="mt-2 text-xs text-slate-400">
              {describeRange(range, t, formatDate)}
            </Text>
          </Card>
        </View>
      </ScrollView>

      <ReportPreview
        visible={previewOpen}
        onClose={() => setPreviewOpen(false)}
        payload={previewPayload}
        businessName={previewPayload?.business?.name}
        range={range}
        busy={busyExport}
        mode={exportMode}
        onModeChange={setExportMode}
        onExport={runExport}
      />

      {/* Every category, not the six the chart has room for -- including the
          ones folded into "Other", which is exactly where a category quietly
          losing money ends up. */}
      <DetailModal
        visible={detail === 'categories'}
        onClose={() => setDetail(null)}
        title={t('reports.byCategory')}
        subtitle={describeRange(range, t, formatDate)}
        columns={[
          { key: 'name', label: t('inventory.category'), flex: 2.4 },
          { key: 'qty', label: t('reports.qty'), align: 'right', width: 44 },
          { key: 'revenue', label: t('reports.revenue'), align: 'right', flex: 1.4 },
          { key: 'profit', label: t('reports.profit'), align: 'right', flex: 1.3, tone: 'auto' },
          { key: 'share', label: '%', align: 'right', width: 48 },
        ]}
        rows={allCategories.map((c) => ({
          __key: String(c.categoryId ?? c.name),
          name: c.name,
          qty: c.qty,
          revenue: c.revenue, revenueDisplay: formatINR(c.revenue),
          profit: c.profit, profitDisplay: formatINR(c.profit),
          share: `${c.sharePercent}%`,
        }))}
        totals={(() => {
          const ct = categoryTotals(allCategories);
          return {
            qty: ct.qty,
            revenue: ct.revenue, revenueDisplay: formatINR(ct.revenue),
            profit: ct.profit, profitDisplay: formatINR(ct.profit),
            share: `${ct.sharePercent}%`,
          };
        })()}
        totalsLabel={t('common.total')}
        emptyLabel={t('reports.noData')}
      />

      <DetailModal
        visible={detail === 'products'}
        onClose={() => setDetail(null)}
        title={t('reports.topProducts')}
        subtitle={describeRange(range, t, formatDate)}
        columns={[
          { key: 'rank', label: '#', width: 26 },
          { key: 'name', label: t('inventory.productName'), flex: 2.6 },
          { key: 'qty', label: t('reports.qty'), align: 'right', width: 44 },
          { key: 'revenue', label: t('reports.revenue'), align: 'right', flex: 1.4 },
          { key: 'profit', label: t('reports.profit'), align: 'right', flex: 1.3, tone: 'auto' },
        ]}
        rows={(allProducts ?? data?.top?.products ?? []).map((p, i) => ({
          __key: String(p.productId ?? i),
          rank: i + 1,
          name: p.name,
          qty: p.qty,
          revenue: p.revenue, revenueDisplay: formatINR(p.revenue),
          profit: p.profit, profitDisplay: formatINR(p.profit),
        }))}
        totals={(() => {
          const tt = topProductTotals(allProducts ?? data?.top?.products ?? []);
          return {
            qty: tt.qty,
            revenue: tt.revenue, revenueDisplay: formatINR(tt.revenue),
            profit: tt.profit, profitDisplay: formatINR(tt.profit),
          };
        })()}
        totalsLabel={t('common.total')}
        emptyLabel={t('reports.noData')}
        footnote={t('reports.productDetailNote')}
      />
    </Screen>
  );
}
