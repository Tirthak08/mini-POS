import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { LineChart } from 'react-native-chart-kit';
import { Ionicons } from '@expo/vector-icons';
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

/** Six or fewer categories keep their own hue; the rest fold into "Other". */
const MAX_CATEGORY_SLICES = 6;

export default function ReportsScreen() {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();

  // A resolved {from,to,groupBy,apiRange} rather than a day count, so the
  // presets ("last month") and a custom span go through one code path.
  const [range, setRange] = useState(() => resolveRange(DEFAULT_PRESET));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyExport, setBusyExport] = useState(null); // 'csv' | 'excel' | 'pdf'

  const load = useCallback(async () => {
    setLoading(true);
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
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const runExport = async (kind) => {
    setBusyExport(kind);
    try {
      const payload = await reportApi.exportData(range.apiRange);
      if (!payload.orders?.length) {
        toast.error(t('reports.noData'));
        return;
      }
      if (kind === 'csv') await exportCsv(payload);
      else if (kind === 'excel') await exportExcel(payload);
      else {
        await exportPdf({
          ...payload,
          summary: data?.summary?.sales,
          topProducts: data?.top?.products ?? [],
        });
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyExport(null);
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

  return (
    <Screen title={t('reports.title')}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Period filter. Reports and Sales share it, so the two tabs cannot
            disagree about what "this month" means. */}
        <DateRangePicker value={range} onChange={setRange} />

        <ErrorBanner message={error} onRetry={load} retryLabel={t('common.retry')} />

        {loading ? <Loading label={t('common.loading')} /> : null}

        {loading ? null : !hasSales ? (
          <EmptyState icon="bar-chart-outline" title={t('reports.noData')} hint={t('reports.noDataHint')} />
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
                  />
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
                  />
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
                  <Text className="mb-3 text-sm font-semibold text-slate-800">{t('reports.byCategory')}</Text>
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
                  <Text className="mb-3 text-sm font-semibold text-slate-800">{t('reports.topProducts')}</Text>
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
    </Screen>
  );
}
