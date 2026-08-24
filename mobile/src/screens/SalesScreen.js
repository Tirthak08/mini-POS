import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';

import Screen from '../components/Screen';
import Button from '../components/Button';
import TextField from '../components/TextField';
import EmptyState from '../components/EmptyState';
import Loading, { ErrorBanner } from '../components/Loading';
import { Card, StatTile, Badge } from '../components/Card';
import QuantityStepper from '../components/QuantityStepper';
import { orderApi } from '../api/endpoints';
import { useAuthStore } from '../store/authStore';
import { useInventoryStore } from '../store/inventoryStore';
import { toast } from '../store/uiStore';
import { confirm } from '../store/confirmStore';
import DateRangePicker from '../components/DateRangePicker';
import ExpensesPanel from '../components/ExpensesPanel';
import { formatINR, formatDate, round2 } from '../utils/money';
import { shareReceipt } from '../utils/receipt';
import { resolveRange, DEFAULT_PRESET } from '../utils/dateRange';
import { colors } from '../theme';

/** The server sends receiptNo; this is the fallback so text and labels agree. */
const receiptLabel = (order) =>
  order.receiptNo ?? `INV-${String(order.orderNumber ?? 0).padStart(6, '0')}`;

/**
 * Every completed sale, with the ability to correct or cancel one.
 *
 * Corrections send the COMPLETE desired item set and the server works out the
 * stock delta, so lowering a quantity returns exactly the difference rather than
 * unwinding and re-taking the whole line.
 */
export default function SalesScreen() {
  const { t } = useTranslation();
  const business = useAuthStore((s) => s.business);
  const reloadInventory = useInventoryStore((s) => s.loadAll);

  // Same resolved-range object the Reports tab uses, from the same helper.
  const [range, setRange] = useState(() => resolveRange(DEFAULT_PRESET));
  // 'sales' | 'expenses'. One period filter serves both, so the two halves of
  // the same month can never disagree about which month they mean.
  const [segment, setSegment] = useState('sales');
  const [orders, setOrders] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const [selected, setSelected] = useState(null); // receipt being viewed
  const [editing, setEditing] = useState(null);   // draft being edited
  const [saving, setSaving] = useState(false);

  const load = useCallback(async ({ silent = false } = {}) => {
    silent ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const res = await orderApi.list({ ...range.apiRange, limit: 100 });
      setOrders(res.orders ?? []);
      setPagination(res.pagination ?? null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  // A sale rung up on the POS tab should be here the moment you switch over.
  useFocusEffect(useCallback(() => { load({ silent: true }); }, [load]));

  const totals = useMemo(() => ({
    count: orders.length,
    revenue: round2(orders.reduce((sum, o) => sum + (o.grandTotal || 0), 0)),
    units: orders.reduce((sum, o) => sum + o.items.reduce((n, i) => n + i.qty, 0), 0),
  }), [orders]);

  /* ----------------------------- the receipt ----------------------------- */

  const [sharing, setSharing] = useState(false);
  /** Any past sale can be re-shared -- "send me that bill again" is routine. */
  const shareSaleReceipt = async (order) => {
    setSharing(true);
    try {
      await shareReceipt({ order, businessName: business?.name, t });
    } catch {
      toast.error(t('receipt.failed'));
    } finally {
      setSharing(false);
    }
  };

  /* ------------------------------- voiding ------------------------------- */

  const voidSale = async (order) => {
    const ok = await confirm({
      title: `${t('sales.voidOrder')} — ${receiptLabel(order)}`,
      message: t('sales.voidWarning'),
      confirmLabel: t('sales.voidOrder'),
      destructive: true,
    });
    if (!ok) return;

    try {
      await orderApi.void(order._id);
      toast.success(t('sales.voided'));
      setSelected(null);
      await load({ silent: true });
      reloadInventory({ silent: true }); // stock came back
    } catch (err) {
      toast.error(err.message);
    }
  };

  /* ------------------------------- editing ------------------------------- */

  const startEdit = (order) => {
    setEditing({
      _id: order._id,
      receiptNo: receiptLabel(order),
      customerName: order.customerName === 'Walk-in' ? '' : order.customerName,
      extraCharges: order.extraCharges ? String(order.extraCharges) : '',
      lines: order.items.map((i) => ({
        productId: String(i.productId),
        name: i.name,
        price: i.price,
        qty: i.qty,
        discount: i.discount || 0,
      })),
    });
  };

  const draftTotals = useMemo(() => {
    if (!editing) return null;
    const gross = round2(editing.lines.reduce((sum, l) => sum + round2(l.qty * l.price), 0));
    const discount = round2(editing.lines.reduce((sum, l) => {
      const lineGross = round2(l.qty * l.price);
      return sum + Math.min(l.discount || 0, lineGross);
    }, 0));
    const extra = Number(editing.extraCharges) || 0;
    return { gross, discount, extra, grandTotal: round2(Math.max(0, gross - discount + extra)) };
  }, [editing]);

  /**
   * Any change to a line re-clamps its discount, because lowering the quantity
   * can leave a previously valid discount larger than the line is now worth.
   * The cart store does the same on decrement (cartStore's clampDiscount).
   *
   * Without this the operator saw ₹50 off in the field, the server clamped it
   * to ₹10 on save, and nothing said the two disagreed.
   */
  const patchLine = (productId, changes) => setEditing((d) => ({
    ...d,
    lines: d.lines.map((l) => {
      if (l.productId !== productId) return l;
      const next = { ...l, ...changes };
      return { ...next, discount: Math.min(next.discount || 0, round2(next.qty * next.price)) };
    }),
  }));

  const removeLine = (productId) => setEditing((d) => ({
    ...d,
    lines: d.lines.filter((l) => l.productId !== productId),
  }));

  const saveEdit = async () => {
    if (!editing.lines.length) {
      toast.error(t('sales.noSales'));
      return;
    }
    setSaving(true);
    try {
      const res = await orderApi.update(editing._id, {
        customerName: editing.customerName.trim() || undefined,
        extraCharges: Number(editing.extraCharges) || 0,
        items: editing.lines.map((l) => ({ productId: l.productId, qty: l.qty, discount: l.discount || 0 })),
      });
      toast.success(`${t('sales.saved')} — ${formatINR(res.order.grandTotal)}`);
      setEditing(null);
      setSelected(null);
      await load({ silent: true });
      reloadInventory({ silent: true }); // quantities moved stock either way
    } catch (err) {
      // 409 means the extra units are not available.
      const short = err.details?.outOfStock?.[0];
      toast.error(short ? `${short.name}: ${t('pos.notEnoughStock')}` : err.message);
    } finally {
      setSaving(false);
    }
  };

  /* ------------------------------ renderers ------------------------------ */

  const renderOrder = useCallback(({ item }) => {
    const units = item.items.reduce((n, i) => n + i.qty, 0);
    return (
      <Pressable
        onPress={() => setSelected(item)}
        accessibilityRole="button"
        accessibilityLabel={`${receiptLabel(item)}, ${formatINR(item.grandTotal)}`}
        className="mx-4 mb-2 rounded-2xl border border-slate-200 bg-white p-3 active:bg-slate-50"
      >
        <View className="flex-row items-start">
          <View className="mr-3 h-10 w-10 items-center justify-center rounded-xl bg-blue-50">
            <Ionicons name="receipt-outline" size={19} color={colors.brand} />
          </View>

          <View className="flex-1">
            <View className="flex-row items-center">
              <Text className="text-sm font-bold text-slate-900">{receiptLabel(item)}</Text>
              {item.editCount > 0 ? (
                <View className="ml-2"><Badge label={t('sales.edited')} tone="warning" /></View>
              ) : null}
            </View>
            <Text className="mt-0.5 text-sm text-slate-700" numberOfLines={1}>{item.customerName}</Text>
            <Text className="mt-0.5 text-xs text-slate-400">
              {formatDate(item.timestamp, { withTime: true })} · {units} {t('sales.items')}
            </Text>
          </View>

          <View className="items-end">
            <Text className="text-base font-bold text-slate-900">{formatINR(item.grandTotal)}</Text>
            <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
          </View>
        </View>
      </Pressable>
    );
  }, [t]);

  const Row = ({ label, value, bold, tone }) => (
    <View className="flex-row items-center justify-between py-1">
      <Text className={bold ? 'text-base font-bold text-slate-900' : 'text-sm text-slate-600'}>{label}</Text>
      <Text
        className={`${bold ? 'text-xl font-bold' : 'text-sm font-semibold'} ${tone === 'discount' ? 'text-green-600' : 'text-slate-900'}`}
      >
        {value}
      </Text>
    </View>
  );

  return (
    <Screen title={t('sales.title')}>
      {/* Money in / money out. The segment sits ABOVE the period filter because
          it decides what you are looking at; the filter then narrows it. */}
      <View className="flex-row gap-2 px-4 pt-3">
        {[
          { key: 'sales', label: t('expenses.salesTab'), icon: 'receipt-outline' },
          { key: 'expenses', label: t('expenses.tab'), icon: 'cash-outline' },
        ].map(({ key, label, icon }) => {
          const active = segment === key;
          return (
            <Pressable
              key={key}
              onPress={() => setSegment(key)}
              /* Deliberately "button", not "tab": the bottom bar already owns
                 the tab role and one of its tabs is also called Sales, so a
                 second tab of the same name makes both ambiguous to a screen
                 reader (and to any automation driving the app). */
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={label}
              className={`flex-1 flex-row items-center justify-center rounded-xl border py-2.5 ${
                active ? 'border-blue-600 bg-blue-600' : 'border-slate-300 bg-white'
              }`}
            >
              <Ionicons name={icon} size={16} color={active ? '#FFFFFF' : '#475569'} />
              {/* Explicit lineHeight and one line: Android measures Gujarati
                  narrower than it draws it, which clipped the descenders. */}
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

      <DateRangePicker value={range} onChange={setRange} />

      {segment === 'expenses' ? (
        <ExpensesPanel range={range} />
      ) : (
      <>
      <ErrorBanner message={error} onRetry={load} retryLabel={t('common.retry')} />

      {loading ? (
        <Loading label={t('common.loading')} />
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => String(item._id)}
          renderItem={renderOrder}
          refreshing={refreshing}
          onRefresh={() => load({ silent: true })}
          contentContainerStyle={{ paddingBottom: 40 }}
          ListHeaderComponent={
            orders.length ? (
              <View className="mb-3 flex-row gap-2 px-4">
                <StatTile className="flex-1" label={t('sales.orderCount')} value={String(totals.count)} tone="brand" />
                <StatTile className="flex-1" label={t('sales.totalSales')} value={formatINR(totals.revenue)} />
                <StatTile className="flex-1" label={t('reports.itemsSold')} value={String(totals.units)} />
              </View>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState icon="receipt-outline" title={t('sales.noSales')} hint={t('sales.noSalesHint')} />
          }
        />
      )}
      </>
      )}

      {/* ------------------------- receipt detail ------------------------- */}
      <Modal visible={Boolean(selected) && !editing} animationType="slide" onRequestClose={() => setSelected(null)}>
        <SafeAreaView className="flex-1 bg-slate-50" edges={['top', 'left', 'right']}>
          {selected ? (
            <>
              <View className="flex-row items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
                <View className="flex-1">
                  <Text className="text-lg font-bold text-slate-900">{receiptLabel(selected)}</Text>
                  <Text className="text-xs text-slate-500">
                    {formatDate(selected.timestamp, { withTime: true })}
                  </Text>
                </View>
                <Pressable onPress={() => setSelected(null)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.close')}>
                  <Ionicons name="close" size={24} color="#64748B" />
                </Pressable>
              </View>

              <ScrollView className="flex-1 px-4 pt-3">
                <Card className="mb-3">
                  <Text className="text-xs text-slate-400">{t('pos.customerName')}</Text>
                  <Text className="mt-0.5 text-base font-semibold text-slate-900">{selected.customerName}</Text>
                  {selected.editCount > 0 ? (
                    <Text className="mt-2 text-xs text-amber-600">
                      {t('sales.edited')} · {formatDate(selected.editedAt, { withTime: true })}
                    </Text>
                  ) : null}
                </Card>

                <Card className="mb-3">
                  {selected.items.map((line, i) => (
                    <View key={`${line.productId}-${i}`} className={`py-2 ${i > 0 ? 'border-t border-slate-100' : ''}`}>
                      <View className="flex-row items-start justify-between">
                        <Text className="flex-1 pr-2 text-sm font-semibold text-slate-900" numberOfLines={1}>{line.name}</Text>
                        {/* Gross for the line; discounts are totalled below. */}
                        <Text className="text-sm font-bold text-slate-900">{formatINR(round2(line.price * line.qty))}</Text>
                      </View>
                      <Text className="mt-0.5 text-xs text-slate-500">
                        {formatINR(line.price)} × {line.qty}
                        {line.discount > 0 ? ` · ${t('pos.discount')} ${formatINR(line.discount)}` : ''}
                      </Text>
                    </View>
                  ))}

                  <View className="mt-2 border-t border-slate-200 pt-2">
                    <Row label={t('pos.subtotal')} value={formatINR(selected.subtotal)} />
                    {selected.discountTotal > 0 ? (
                      <Row label={t('pos.discount')} value={`− ${formatINR(selected.discountTotal)}`} tone="discount" />
                    ) : null}
                    {selected.extraCharges > 0 ? (
                      <Row label={t('pos.extraCharges')} value={`+ ${formatINR(selected.extraCharges)}`} />
                    ) : null}
                    <Row label={t('pos.grandTotal')} value={formatINR(selected.grandTotal)} bold />
                  </View>
                </Card>

                <Text className="mb-4 px-1 text-xs text-slate-400">{t('sales.addItemsHint')}</Text>
              </ScrollView>

              <View className="border-t border-slate-200 bg-white px-4 pb-6 pt-3">
                {/* The common action gets the full-width row; the two
                    corrective ones share the line below it. */}
                <Button
                  title={t('receipt.share')}
                  icon="share-social-outline"
                  onPress={() => shareSaleReceipt(selected)}
                  loading={sharing}
                  fullWidth
                />
                <View className="mt-2 flex-row gap-3">
                  <View className="flex-1">
                    <Button
                      title={t('sales.editOrder')}
                      icon="create-outline"
                      variant="secondary"
                      onPress={() => startEdit(selected)}
                      fullWidth
                    />
                  </View>
                  <View className="flex-1">
                    <Button
                      title={t('sales.voidOrder')}
                      icon="close-circle-outline"
                      variant="danger"
                      onPress={() => voidSale(selected)}
                      fullWidth
                    />
                  </View>
                </View>
              </View>
            </>
          ) : null}
        </SafeAreaView>
      </Modal>

      {/* ---------------------------- edit sale ---------------------------- */}
      <Modal visible={Boolean(editing)} animationType="slide" onRequestClose={() => setEditing(null)}>
        <SafeAreaView className="flex-1 bg-slate-50" edges={['top', 'left', 'right']}>
          {editing ? (
            <>
              <View className="flex-row items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
                <Text className="text-lg font-bold text-slate-900">
                  {t('sales.editOrder')} · {editing.receiptNo}
                </Text>
                <Pressable onPress={() => setEditing(null)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.close')}>
                  <Ionicons name="close" size={24} color="#64748B" />
                </Pressable>
              </View>

              <ScrollView className="flex-1 px-4 pt-3" keyboardShouldPersistTaps="handled">
                <TextField
                  label={t('pos.customerName')}
                  value={editing.customerName}
                  onChangeText={(customerName) => setEditing((d) => ({ ...d, customerName }))}
                  placeholder={t('pos.walkIn')}
                />

                {editing.lines.map((line) => {
                  const gross = round2(line.qty * line.price);
                  return (
                    <View key={line.productId} className="mb-2 rounded-2xl border border-slate-200 bg-white p-3">
                      <View className="flex-row items-start">
                        <View className="flex-1 pr-2">
                          <Text className="text-sm font-semibold text-slate-900" numberOfLines={1}>{line.name}</Text>
                          <Text className="mt-0.5 text-xs text-slate-500">
                            {formatINR(line.price)} × {line.qty} = {formatINR(gross)}
                          </Text>
                        </View>
                        <Pressable
                          onPress={() => removeLine(line.productId)}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={`${t('sales.removeLine')} ${line.name}`}
                          className="p-1"
                        >
                          <Ionicons name="close-circle" size={20} color="#94A3B8" />
                        </Pressable>
                      </View>

                      <View className="mt-2 flex-row items-center">
                        <View style={{ width: 130 }}>
                          <QuantityStepper
                            qty={line.qty}
                            itemLabel={line.name}
                            addLabel={t('pos.addToCart')}
                            onIncrement={() => patchLine(line.productId, { qty: line.qty + 1 })}
                            onDecrement={() => (line.qty > 1
                              ? patchLine(line.productId, { qty: line.qty - 1 })
                              : removeLine(line.productId))}
                          />
                        </View>
                        <View className="ml-3 flex-1">
                          <TextField
                            value={line.discount ? String(line.discount) : ''}
                            onChangeText={(v) => patchLine(line.productId, {
                              discount: Math.min(Math.max(0, Number(v) || 0), gross),
                            })}
                            mode="money"
                            prefix="₹"
                            placeholder={t('pos.itemDiscount')}
                            className="mb-0"
                            // One "Discount" box per line is ambiguous to a
                            // screen reader and to automation; name the line.
                            accessibilityLabel={`${t('pos.itemDiscount')} ${line.name}`}
                          />
                        </View>
                      </View>
                    </View>
                  );
                })}

                <TextField
                  label={t('pos.extraCharges')}
                  value={editing.extraCharges}
                  onChangeText={(extraCharges) => setEditing((d) => ({ ...d, extraCharges }))}
                  mode="money"
                  prefix="₹"
                  placeholder="0"
                />

                <View className="mb-6 rounded-2xl border border-slate-200 bg-white p-4">
                  <Row label={t('pos.subtotal')} value={formatINR(draftTotals.gross)} />
                  {draftTotals.discount > 0 ? (
                    <Row label={t('pos.discount')} value={`− ${formatINR(draftTotals.discount)}`} tone="discount" />
                  ) : null}
                  {draftTotals.extra > 0 ? (
                    <Row label={t('pos.extraCharges')} value={`+ ${formatINR(draftTotals.extra)}`} />
                  ) : null}
                  <View className="my-2 h-px bg-slate-200" />
                  <Row label={t('pos.grandTotal')} value={formatINR(draftTotals.grandTotal)} bold />
                </View>
              </ScrollView>

              <View className="border-t border-slate-200 bg-white px-4 pb-6 pt-3">
                <Button
                  title={`${t('sales.saveChanges')} — ${formatINR(draftTotals.grandTotal)}`}
                  onPress={saveEdit}
                  loading={saving}
                  disabled={!editing.lines.length}
                  variant="success"
                  size="lg"
                  icon="checkmark-circle"
                  fullWidth
                />
              </View>
            </>
          ) : null}
        </SafeAreaView>
      </Modal>
    </Screen>
  );
}
