import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';

import Screen from '../components/Screen';
import QueueBanner from '../components/QueueBanner';
import Button from '../components/Button';
import TextField from '../components/TextField';
import EmptyState from '../components/EmptyState';
import Loading, { ErrorBanner } from '../components/Loading';
import { Card, StatTile, Badge } from '../components/Card';
import QuantityStepper from '../components/QuantityStepper';
import { orderApi, returnApi } from '../api/endpoints';
import { useAuthStore } from '../store/authStore';
import { useInventoryStore } from '../store/inventoryStore';
import { toast } from '../store/uiStore';
import { confirm } from '../store/confirmStore';
import DateRangePicker from '../components/DateRangePicker';
import ExpensesPanel from '../components/ExpensesPanel';
import { formatINR, formatDate, round2 } from '../utils/money';
import { PAYMENT_METHODS } from '../utils/payments';
import { allowsFraction } from '../utils/units';
import { shareReceipt } from '../utils/receipt';
import { resolveRange, DEFAULT_PRESET } from '../utils/dateRange';
import { colors } from '../theme';
import { useScrollTopOnFocus } from '../hooks/useScrollTopOnFocus';

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
  const listRef = useScrollTopOnFocus();
  const [orders, setOrders] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  /**
   * What was typed, and what has actually been sent.
   *
   * Separated so every keystroke does not become a request. `query` follows the
   * field; `term` catches up 350ms later and is what `load` depends on, which is
   * also what stops a half-typed "ram" from racing the finished "ramesh" and
   * landing after it.
   */
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setTerm(query.trim()), 350);
    return () => clearTimeout(id);
  }, [query]);
  const searching = term.length > 0;

  const [selected, setSelected] = useState(null); // receipt being viewed
  const [editing, setEditing] = useState(null);   // draft being edited
  const [saving, setSaving] = useState(false);

  const PAGE = 50;

  const load = useCallback(async ({ silent = false } = {}) => {
    silent ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      /**
       * The window is sent either way, and the SERVER ignores it when there is
       * a search -- somebody hunting for a receipt is hunting precisely because
       * it is not in front of them.
       *
       * Dropping it here instead would look equivalent and is not: the server
       * defaults to the last thirty days when no range arrives, so a client
       * that omitted it would silently narrow every search to a month the
       * moment the server stopped ignoring the window. Sending it means the
       * rule lives in exactly one place, and a test can see it working.
       */
      const res = await orderApi.list({
        ...range.apiRange, limit: PAGE, page: 1, ...(searching && { q: term }),
      });
      setOrders(res.orders ?? []);
      setPagination(res.pagination ?? null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [range, term, searching]);

  /**
   * The next page, appended.
   *
   * The list used to ask for 100 rows and stop there, with nothing on screen to
   * say that it had. A shop past its hundredth sale simply could not reach the
   * older ones.
   */
  const loadMore = useCallback(async () => {
    if (loadingMore || loading) return;
    const next = (pagination?.page ?? 1) + 1;
    if (next > (pagination?.pages ?? 1)) return;
    setLoadingMore(true);
    try {
      const res = await orderApi.list({
        ...range.apiRange, limit: PAGE, page: next, ...(searching && { q: term }),
      });
      /* Concatenated by id rather than blindly: a sale made while you were
         reading shifts every row down one, and the same receipt would
         otherwise arrive twice with the same key. */
      setOrders((prev) => {
        const seen = new Set(prev.map((o) => String(o._id)));
        return [...prev, ...(res.orders ?? []).filter((o) => !seen.has(String(o._id)))];
      });
      setPagination(res.pagination ?? null);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, loading, pagination, range, term, searching]);

  useEffect(() => { load(); }, [load]);

  // A sale rung up on the POS tab should be here the moment you switch over.
  useFocusEffect(useCallback(() => { load({ silent: true }); }, [load]));

  const totals = useMemo(() => ({
    count: orders.length,
    revenue: round2(orders.reduce((sum, o) => sum + (o.grandTotal || 0), 0)),
    units: orders.reduce((sum, o) => sum + o.items.reduce((n, i) => n + i.qty, 0), 0),
  }), [orders]);

  /** How many there are altogether, as against how many have been fetched. */
  const matchCount = pagination?.total ?? orders.length;
  const partial = orders.length < matchCount;

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

  /* ------------------------------- returns ------------------------------- */

  /**
   * The receipt list does NOT carry how much of each line has already come
   * back -- that is a second collection, and putting it on every row of every
   * listing would be a join per sale for a figure almost no row needs. So the
   * full receipt is fetched when one is opened, and the row's own copy stands
   * in until it lands.
   */
  const openReceipt = useCallback(async (order) => {
    setSelected(order);
    try {
      const res = await orderApi.get(order._id);
      // Ignore a reply that arrives after the operator has closed it or moved on.
      setSelected((cur) => (cur && cur._id === order._id ? { ...cur, ...res.order } : cur));
    } catch { /* the row's own copy is enough to read the receipt */ }
  }, []);

  const [returning, setReturning] = useState(null); // { order, lines, method, reason }
  const [returnSaving, setReturnSaving] = useState(false);

  const startReturn = (order) => {
    const lines = (order.items ?? [])
      .map((l) => ({
        productId: l.productId,
        name: l.name,
        unit: l.unit,
        /* What was actually charged per unit, which is the line's total over
           its quantity -- a discounted line refunds at the discounted rate. */
        each: round2((l.lineTotal ?? round2(l.price * l.qty - (l.discount || 0))) / l.qty),
        max: l.returnable ?? l.qty,
        returned: l.returned ?? 0,
        include: false,
        qty: '',
      }))
      .filter((l) => l.max > 0);

    if (!lines.length) {
      toast.error(t('returns.nothingLeft'));
      return;
    }
    setReturning({
      order,
      lines,
      /* Somebody with a running khata does not get handed cash and then asked
         for it back the same afternoon, so their account is the default. */
      method: order.customerId ? 'credit' : 'cash',
      reason: '',
    });
  };

  const patchReturnLine = (productId, changes) => setReturning((d) => ({
    ...d,
    lines: d.lines.map((l) => (l.productId === productId ? { ...l, ...changes } : l)),
  }));

  const toggleReturnLine = (line) => patchReturnLine(line.productId, line.include
    ? { include: false, qty: '' }
    // Pre-filled with everything that is left, because "all of it" is the
    // common case and retyping a number is a chance to get it wrong.
    : { include: true, qty: String(line.max) });

  const returnTotals = useMemo(() => {
    if (!returning) return { refund: 0, count: 0, invalid: null };
    let refund = 0, count = 0, invalid = null;
    for (const l of returning.lines) {
      if (!l.include) continue;
      const qty = Number(l.qty);
      if (!l.qty || !Number.isFinite(qty) || qty <= 0) { invalid = invalid ?? l; continue; }
      if (qty > l.max) { invalid = invalid ?? l; continue; }
      if (!allowsFraction(l.unit) && !Number.isInteger(qty)) { invalid = invalid ?? l; continue; }
      refund = round2(refund + qty * l.each);
      count += 1;
    }
    return { refund, count, invalid };
  }, [returning]);

  const submitReturn = async () => {
    const items = returning.lines
      .filter((l) => l.include && Number(l.qty) > 0)
      .map((l) => ({ productId: l.productId, qty: Number(l.qty) }));
    if (!items.length) return;

    setReturnSaving(true);
    try {
      const res = await returnApi.create(returning.order._id, {
        items,
        refundMethod: returning.method,
        reason: returning.reason.trim(),
      });
      setReturning(null);
      setSelected(null);
      toast.success(t('returns.done', {
        note: res.return?.creditNoteNo ?? '',
        amount: formatINR(res.return?.refundTotal ?? 0),
      }));
      await load({ silent: true });
      reloadInventory({ silent: true }); // the goods are back on the shelf
    } catch (err) {
      toast.error(err.message ?? t('errors.generic'));
    } finally {
      setReturnSaving(false);
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
        // What the catalogue said on the day of the sale. Older receipts
        // predate the field, so the charged price stands in for it.
        listPrice: i.listPrice ?? i.price,
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
        // price is always sent on an edit: these lines already have a settled
        // price, and omitting it would let the server fall back to today's
        // catalogue figure and silently reprice a past sale.
        items: editing.lines.map((l) => ({
          productId: l.productId, qty: l.qty, price: l.price, discount: l.discount || 0,
        })),
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
        onPress={() => openReceipt(item)}
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
  }, [t, openReceipt]);

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
      {/* Also here, because this is the screen someone opens to ask "did that
          sale go through?" — and a receipt that is not in the list yet has to
          be explained on the list's own screen. */}
      <QueueBanner className="mt-3" />
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
              /* aria-selected as well as accessibilityState: react-native-web
                 drops accessibilityState on a Pressable entirely, so which of
                 the two was chosen existed only as a colour. */
              aria-selected={active}
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

      {/* The search box sits ABOVE the period filter, and only on the sales
          half: it overrides the filter rather than narrowing it, so it has to
          read as the outer control. */}
      {segment === 'sales' ? (
        <View className="px-4 pt-3">
          <TextField
            value={query}
            onChangeText={setQuery}
            placeholder={t('sales.searchPlaceholder')}
            accessibilityLabel={t('sales.searchLabel')}
            className="mb-0"
          />
        </View>
      ) : null}

      {searching ? (
        /* Said plainly, because the period filter is still on screen and is no
           longer deciding anything. Silently ignoring a control the operator
           can see is how a screen earns a reputation for lying. */
        <View className="mx-4 mt-2 flex-row items-center rounded-xl border border-blue-200 bg-blue-50 px-3 py-2">
          <Ionicons name="search" size={14} color={colors.brand} />
          <Text className="ml-2 flex-1 text-xs text-slate-600">{t('sales.searchingAllTime')}</Text>
          <Pressable
            onPress={() => { setQuery(''); setTerm(''); }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('sales.clearSearch')}
          >
            <Text className="text-xs font-bold text-blue-700">{t('sales.clearSearch')}</Text>
          </Pressable>
        </View>
      ) : null}

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
          ref={listRef}
          data={orders}
          keyExtractor={(item) => String(item._id)}
          renderItem={renderOrder}
          refreshing={refreshing}
          onRefresh={() => load({ silent: true })}
          contentContainerStyle={{ paddingBottom: 40 }}
          ListHeaderComponent={
            orders.length ? (
              <View className="mb-3 px-4">
                <View className="flex-row gap-2">
                  {/* The count is the SERVER's, not the number of rows fetched:
                      the list pages, and a tile that counted what had been
                      scrolled to would fall behind the truth. */}
                  <StatTile
                    className="flex-1"
                    label={searching ? t('sales.matches') : t('sales.orderCount')}
                    value={String(matchCount)}
                    tone="brand"
                  />
                  {/* Money and units CANNOT be totalled beyond what has been
                      loaded, so when there is more to come the tiles say which
                      rows they are about instead of quietly under-reporting. */}
                  <StatTile
                    className="flex-1"
                    label={t('sales.totalSales')}
                    value={formatINR(totals.revenue)}
                    sub={partial ? t('sales.ofLoaded', { n: orders.length }) : undefined}
                  />
                  <StatTile
                    className="flex-1"
                    label={t('reports.itemsSold')}
                    value={String(totals.units)}
                    sub={partial ? t('sales.ofLoaded', { n: orders.length }) : undefined}
                  />
                </View>
              </View>
            ) : null
          }
          ListFooterComponent={
            partial ? (
              <View className="px-4 pb-6 pt-1">
                <Button
                  title={t('sales.loadMore', { n: matchCount - orders.length })}
                  onPress={loadMore}
                  loading={loadingMore}
                  variant="secondary"
                  fullWidth
                />
              </View>
            ) : null
          }
          ListEmptyComponent={
            searching ? (
              <EmptyState
                icon="search-outline"
                title={t('sales.noMatches', { q: term })}
                hint={t('sales.noMatchesHint')}
              />
            ) : (
              <EmptyState icon="receipt-outline" title={t('sales.noSales')} hint={t('sales.noSalesHint')} />
            )
          }
        />
      )}
      </>
      )}

      {/* ------------------------- receipt detail ------------------------- */}
      <Modal visible={Boolean(selected) && !editing && !returning} animationType="slide" onRequestClose={() => setSelected(null)}>
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
                      {/* A line sold off-list is called out, so the receipt
                          explains itself months later. Receipts written before
                          listPrice existed have nothing to compare against. */}
                      {line.listPrice != null && round2(line.listPrice) !== round2(line.price) ? (
                        <Text className="mt-0.5 text-xs text-amber-600">
                          {t('pos.listPrice')} {formatINR(line.listPrice)}
                        </Text>
                      ) : null}
                      {/* Said on the line itself, not only in a total: a
                          receipt where half of one item came back looks
                          completely untouched otherwise. */}
                      {line.returned > 0 ? (
                        <Text className="mt-0.5 text-xs font-semibold text-purple-700">
                          {t('returns.lineReturned', { qty: line.returned, of: line.qty })}
                        </Text>
                      ) : null}
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
                    {selected.returnedTotal > 0 ? (
                      <>
                        <Row
                          label={t('returns.refunded')}
                          value={`− ${formatINR(selected.returnedTotal)}`}
                          tone="discount"
                        />
                        {/* What the sale was actually worth once the goods that
                            came back are taken off it. */}
                        <Row
                          label={t('returns.netOfReturns')}
                          value={formatINR(round2(selected.grandTotal - selected.returnedTotal))}
                          bold
                        />
                      </>
                    ) : null}
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
                {/* Returning sits with the corrective actions but above them:
                    it is the one that happens days later and to a sale that was
                    perfectly correct, which is a different thing from fixing a
                    mistake or cancelling one. */}
                <Button
                  className="mt-2"
                  title={t('returns.action')}
                  icon="arrow-undo-outline"
                  variant="secondary"
                  onPress={() => startReturn(selected)}
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

      {/* --------------------------- return items --------------------------- */}
      <Modal visible={Boolean(returning)} animationType="slide" onRequestClose={() => setReturning(null)}>
        <SafeAreaView className="flex-1 bg-slate-50" edges={['top', 'left', 'right']}>
          {returning ? (
            <>
              <View className="flex-row items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
                <View className="flex-1">
                  <Text className="text-lg font-bold text-slate-900">{t('returns.title')}</Text>
                  <Text className="text-xs text-slate-500">{receiptLabel(returning.order)}</Text>
                </View>
                <Pressable
                  onPress={() => setReturning(null)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.close')}
                >
                  <Ionicons name="close" size={24} color="#64748B" />
                </Pressable>
              </View>

              <ScrollView className="flex-1 px-4 pt-3" keyboardShouldPersistTaps="handled">
                <Text className="mb-2 px-1 text-xs text-slate-500">{t('returns.pickHint')}</Text>

                {returning.lines.map((line) => {
                  const qty = Number(line.qty);
                  const over = line.include && line.qty !== '' && qty > line.max;
                  const fraction = line.include && line.qty !== ''
                    && !allowsFraction(line.unit) && Number.isFinite(qty) && !Number.isInteger(qty);
                  return (
                    <Card key={String(line.productId)} className="mb-2">
                      <Pressable
                        onPress={() => toggleReturnLine(line)}
                        accessibilityRole="checkbox"
                        /* aria-checked, not accessibilityState alone:
                           react-native-web drops the latter on a Pressable, so
                           whether a line was selected existed only as a tick. */
                        aria-checked={line.include}
                        accessibilityState={{ checked: line.include }}
                        accessibilityLabel={line.name}
                        className="flex-row items-center"
                      >
                        <Ionicons
                          name={line.include ? 'checkbox' : 'square-outline'}
                          size={22}
                          color={line.include ? colors.brand : '#94A3B8'}
                        />
                        <View className="ml-2.5 flex-1">
                          <Text className="text-sm font-bold text-slate-900" numberOfLines={1}>{line.name}</Text>
                          <Text className="mt-0.5 text-xs text-slate-500">
                            {t('returns.canReturn', { qty: line.max, unit: line.unit })}
                            {' · '}
                            {t('returns.each', { amount: formatINR(line.each) })}
                          </Text>
                          {line.returned > 0 ? (
                            <Text className="mt-0.5 text-xs text-purple-700">
                              {t('returns.alreadyBack', { qty: line.returned })}
                            </Text>
                          ) : null}
                        </View>
                      </Pressable>

                      {line.include ? (
                        <View className="mt-2 flex-row items-end gap-3">
                          <View className="flex-1">
                            <TextField
                              label={t('returns.howMany')}
                              value={line.qty}
                              onChangeText={(v) => patchReturnLine(line.productId, { qty: v })}
                              mode="money"
                              accessibilityLabel={`${t('returns.howMany')} ${line.name}`}
                              error={over ? t('returns.tooMany', { qty: line.max })
                                : fraction ? t('returns.wholeOnly', { unit: line.unit })
                                  : undefined}
                            />
                          </View>
                          <View className="pb-3">
                            <Text className="text-xs text-slate-500">{t('returns.refundLine')}</Text>
                            <Text className="text-base font-bold text-slate-900">
                              {formatINR(over || fraction || !(qty > 0) ? 0 : round2(qty * line.each))}
                            </Text>
                          </View>
                        </View>
                      ) : null}
                    </Card>
                  );
                })}

                <Text className="mb-1.5 mt-2 px-1 text-sm font-medium text-slate-700">
                  {t('returns.howRefunded')}
                </Text>
                <View className="mb-1 flex-row flex-wrap gap-2" accessibilityRole="radiogroup">
                  {[
                    ...PAYMENT_METHODS,
                    // Only offered when there IS an account to credit. Without a
                    // customer on the sale the server refuses it, and offering a
                    // choice that cannot work is worse than not offering it.
                    ...(returning.order.customerId ? ['credit'] : []),
                  ].map((m) => {
                    const active = returning.method === m;
                    const label = m === 'credit' ? t('returns.offTheirDebt') : t(`pos.pay_${m}`);
                    return (
                      <Pressable
                        key={m}
                        onPress={() => setReturning((d) => ({ ...d, method: m }))}
                        accessibilityRole="radio"
                        accessibilityLabel={label}
                        aria-checked={active}
                        accessibilityState={{ checked: active }}
                        className={`min-w-[30%] flex-1 items-center rounded-xl border py-2.5 ${
                          active ? 'border-blue-600 bg-blue-50' : 'border-slate-300 bg-white'
                        }`}
                      >
                        <Text className={`text-xs font-bold ${active ? 'text-blue-700' : 'text-slate-600'}`}>
                          {label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                {returning.method === 'credit' ? (
                  <Text className="mb-2 px-1 text-xs text-slate-500">
                    {t('returns.creditHint', { name: returning.order.customerName })}
                  </Text>
                ) : null}

                <TextField
                  label={t('returns.reason')}
                  value={returning.reason}
                  onChangeText={(v) => setReturning((d) => ({ ...d, reason: v }))}
                  placeholder={t('returns.reasonPlaceholder')}
                  hint={t('common.optional')}
                />
                <View className="h-6" />
              </ScrollView>

              <View className="border-t border-slate-200 bg-white px-4 pb-6 pt-3">
                <View className="mb-2 flex-row items-center justify-between">
                  <Text className="text-sm text-slate-600">{t('returns.refundTotal')}</Text>
                  <Text className="text-2xl font-bold text-slate-900">{formatINR(returnTotals.refund)}</Text>
                </View>
                <Button
                  title={t('returns.confirm')}
                  icon="arrow-undo-outline"
                  onPress={submitReturn}
                  loading={returnSaving}
                  /* Nothing chosen, or something typed that cannot be returned:
                     either way there is no return to make, and a button that
                     submits an impossible one just produces a server error the
                     operator has to read. */
                  disabled={returnTotals.count === 0 || Boolean(returnTotals.invalid)}
                  fullWidth
                />
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

                      {/* The unit price, editable -- this is how a mis-keyed
                          amount gets corrected after the sale. patchLine
                          re-clamps the discount, because lowering the price can
                          leave a discount bigger than the line is now worth. */}
                      <View className="mt-2 flex-row items-center">
                        <Text className="mr-2 w-[76px] text-xs text-slate-500">
                          {t('pos.unitPrice')}
                        </Text>
                        <View className="flex-1">
                          <TextField
                            value={String(line.price)}
                            onChangeText={(v) => patchLine(line.productId, {
                              price: Math.max(0, Number(v) || 0),
                            })}
                            mode="money"
                            prefix="₹"
                            className="mb-0"
                            accessibilityLabel={`${t('pos.unitPrice')} ${line.name}`}
                          />
                        </View>
                        {line.listPrice != null && round2(line.listPrice) !== round2(line.price) ? (
                          <Text className="ml-2 text-xs text-amber-600">
                            {t('pos.listPrice')} {formatINR(line.listPrice)}
                          </Text>
                        ) : null}
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
