import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import DataTable from './DataTable';
import Button from './Button';
import { formatINR, formatDate } from '../utils/money';
import {
  orderTotals, itemTotals, expenseTotals, topProductTotals, summaryTotals,
} from '../utils/reportTotals';

/** How many rows of each table the preview renders before saying "and N more". */
const PREVIEW_ROWS = 50;

/**
 * What the export contains, shown before it is sent anywhere.
 *
 * Exporting used to be a leap of faith: three buttons that opened a share sheet
 * with a file whose contents you discovered on a laptop later. For a report
 * that goes to an accountant, seeing the period, the rows and the bottom line
 * BEFORE sending is the difference between one export and three.
 *
 * The tables here are built from the same payload and the same totals helpers
 * as the PDF and the spreadsheet, so what is on screen is what lands in the
 * file. A preview assembled separately would drift from the thing it previews,
 * which is worse than showing nothing.
 */
export default function ReportPreview({
  visible, onClose, payload, businessName, range, busy, onExport, mode, onModeChange,
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  if (!payload) return null;

  const orders = payload.orders ?? [];
  const items = payload.items ?? [];
  const expenses = payload.expenses ?? [];
  const top = payload.topProducts ?? [];

  const ot = orderTotals(orders);
  const it = itemTotals(items);
  const et = expenseTotals(expenses);
  const tt = topProductTotals(top);
  const st = summaryTotals({ totals: payload.totals, expenses });

  const money = (n) => formatINR(n);

  const Section = ({ title, children, count }) => (
    <View className="mb-4">
      <View className="mb-1.5 flex-row items-baseline justify-between px-1">
        <Text className="text-sm font-bold text-slate-800">{title}</Text>
        {count != null ? (
          <Text className="text-xs text-slate-400">{count}</Text>
        ) : null}
      </View>
      <View className="rounded-2xl border border-slate-200 bg-white p-3">{children}</View>
    </View>
  );

  const truncated = (rows, total) => (total > rows
    ? <Text className="mt-2 text-xs text-slate-400">{t('reports.andMore', { n: total - rows })}</Text>
    : null);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View className="flex-1 bg-slate-50" style={{ paddingTop: insets.top }}>
        <View className="flex-row items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
          <View className="flex-1 pr-2">
            <Text className="text-lg font-bold text-slate-900" numberOfLines={1} accessibilityRole="header">
              {t('reports.previewTitle')}
            </Text>
            <Text className="mt-0.5 text-xs text-slate-500" numberOfLines={1}>
              {businessName} · {formatDate(range?.from)} – {formatDate(range?.to)}
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.close')}>
            <Ionicons name="close" size={24} color="#64748B" />
          </Pressable>
        </View>

        <ScrollView className="flex-1" contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
          {/* The bottom line first. It is the reason the report exists, and
              burying it under three tables makes it the last thing seen. */}
          <Section title={t('reports.summaryTitle')}>
            <DataTable
              columns={[
                { key: 'label', label: t('reports.figure'), flex: 2 },
                { key: 'value', label: t('common.total'), align: 'right', flex: 1, tone: 'auto' },
              ]}
              rows={[
                { __key: 'rev', label: t('reports.revenue'), value: st.revenue, valueDisplay: money(st.revenue) },
                { __key: 'gp', label: t('reports.grossProfit'), value: st.grossProfit, valueDisplay: money(st.grossProfit) },
                { __key: 'exp', label: t('reports.expenses'), value: -st.expenses, valueDisplay: money(st.expenses) },
                { __key: 'ord', label: t('reports.orders'), value: st.orders, valueDisplay: String(st.orders) },
              ]}
              totals={{
                label: st.netProfit < 0 ? t('reports.netLoss') : t('reports.netProfit'),
                value: st.netProfit,
                valueDisplay: money(st.netProfit),
              }}
            />
          </Section>

          {top.length ? (
            <Section title={t('reports.topProducts')} count={`${tt.count}`}>
              <DataTable
                columns={[
                  { key: 'name', label: t('inventory.productName'), flex: 3 },
                  { key: 'qty', label: t('reports.qty'), align: 'right', width: 44 },
                  { key: 'revenue', label: t('reports.revenue'), align: 'right', flex: 1.4 },
                  { key: 'profit', label: t('reports.profit'), align: 'right', flex: 1.4, tone: 'auto' },
                ]}
                rows={top.slice(0, PREVIEW_ROWS).map((p, i) => ({
                  __key: String(p.productId ?? i),
                  name: p.name,
                  qty: p.qty,
                  revenue: p.revenue, revenueDisplay: money(p.revenue),
                  profit: p.profit, profitDisplay: money(p.profit),
                }))}
                totals={{
                  qty: tt.qty,
                  revenue: tt.revenue, revenueDisplay: money(tt.revenue),
                  profit: tt.profit, profitDisplay: money(tt.profit),
                }}
                totalsLabel={t('common.total')}
              />
              {truncated(PREVIEW_ROWS, top.length)}
            </Section>
          ) : null}

          {expenses.length ? (
            <Section title={t('expenses.title')} count={`${et.count}`}>
              <DataTable
                columns={[
                  { key: 'date', label: t('expenses.date'), flex: 1.2 },
                  { key: 'note', label: t('expenses.note'), flex: 2 },
                  { key: 'amount', label: t('expenses.amount'), align: 'right', flex: 1.2, tone: 'negative' },
                ]}
                rows={expenses.slice(0, PREVIEW_ROWS).map((e, i) => ({
                  __key: String(e.expenseId ?? i),
                  date: formatDate(e.date),
                  note: e.note,
                  amount: e.amount, amountDisplay: money(e.amount),
                }))}
                totals={{ amount: et.amount, amountDisplay: money(et.amount) }}
                totalsLabel={t('common.total')}
              />
              {truncated(PREVIEW_ROWS, expenses.length)}
            </Section>
          ) : null}

          <Section title={t('sales.title')} count={`${ot.count}`}>
            <DataTable
              columns={[
                { key: 'date', label: t('expenses.date'), flex: 1.5 },
                { key: 'customer', label: t('pos.customerName'), flex: 1.6 },
                { key: 'units', label: t('reports.qty'), align: 'right', width: 44 },
                { key: 'total', label: t('common.total'), align: 'right', flex: 1.4 },
              ]}
              rows={orders.slice(0, PREVIEW_ROWS).map((o, i) => ({
                __key: String(o.orderId ?? i),
                date: formatDate(o.date),
                customer: o.customer,
                units: o.unitsSold,
                total: o.grandTotal, totalDisplay: money(o.grandTotal),
              }))}
              totals={{
                units: ot.units,
                total: ot.grandTotal, totalDisplay: money(ot.grandTotal),
              }}
              totalsLabel={t('common.total')}
              emptyLabel={t('reports.noData')}
            />
            {truncated(PREVIEW_ROWS, orders.length)}
          </Section>

          <Text className="px-1 text-xs text-slate-400">
            {t('reports.previewNote', { lines: it.count })}
          </Text>
        </ScrollView>

        {/* The actions stay pinned: the point of a preview is deciding whether
            to send, and scrolling back up to act would undo that. */}
        <View
          className="border-t border-slate-200 bg-white px-4 pt-3"
          style={{ paddingBottom: 12 + insets.bottom }}
        >
          <View className="mb-2.5 flex-row gap-2">
            {[
              { key: 'share', label: t('reports.share'), icon: 'share-social-outline' },
              { key: 'save', label: t('reports.saveToDevice'), icon: 'download-outline' },
            ].map(({ key, label, icon }) => {
              const active = mode === key;
              return (
                <Pressable
                  key={key}
                  onPress={() => onModeChange(key)}
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
            {[
              { kind: 'csv', label: t('reports.exportCsv'), icon: 'document-text-outline' },
              { kind: 'excel', label: t('reports.exportExcel'), icon: 'grid-outline' },
              { kind: 'pdf', label: t('reports.exportPdf'), icon: 'print-outline' },
            ].map(({ kind, label, icon }) => (
              <View key={kind} className="flex-1">
                <Button
                  title={label}
                  icon={icon}
                  variant="secondary"
                  onPress={() => onExport(kind)}
                  loading={busy === kind}
                  disabled={Boolean(busy)}
                  fullWidth
                />
              </View>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}
