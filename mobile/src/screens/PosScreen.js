import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';

import Screen from '../components/Screen';
import Button from '../components/Button';
import Select from '../components/Select';
import TextField from '../components/TextField';
import EmptyState from '../components/EmptyState';
import FormModal from '../components/FormModal';
import ProductImage from '../components/ProductImage';
import { useScrollTopOnFocus } from '../hooks/useScrollTopOnFocus';
import QuantityStepper from '../components/QuantityStepper';
import ProductPreview from '../components/ProductPreview';
import Loading, { ErrorBanner, StaleBanner } from '../components/Loading';
import { useInventoryStore } from '../store/inventoryStore';
import { useQueueStore } from '../store/queueStore';
import { useCustomerStore } from '../store/customerStore';
import QueueBanner from '../components/QueueBanner';
import { makeClientRef, classifyFailure } from '../utils/salesQueue';
import {
  useCartStore, selectItemCount, selectGross, selectGrandTotal, selectTotalDiscount, lineGross,
  unitPrice, isRepriced,
} from '../store/cartStore';
import { useAuthStore } from '../store/authStore';
import { orderApi } from '../api/endpoints';
import { toast } from '../store/uiStore';
import { formatINR, relativeAge, round2 } from '../utils/money';
import { allowsFraction, formatQty, sanitiseQty, DEFAULT_UNIT } from '../utils/units';
import { PAYMENT_METHODS } from '../utils/payments';
import { shareReceipt } from '../utils/receipt';
import { confirm } from '../store/confirmStore';

export default function PosScreen() {
  const { t } = useTranslation();

  const { categories, products, loading, refreshing, error, loadAll, applySoldItems } = useInventoryStore();
  const business = useAuthStore((s) => s.business);

  const cart = useCartStore();
  const itemCount = useCartStore(selectItemCount);
  const gross = useCartStore(selectGross);
  const grandTotal = useCartStore(selectGrandTotal);
  const totalDiscount = useCartStore(selectTotalDiscount);

  const [activeCategory, setActiveCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [cartOpen, setCartOpen] = useState(false);
  const [customerPicker, setCustomerPicker] = useState(false);

  /**
   * Loaded once, not on every cart open: the picker is a convenience and the
   * balances on it are advisory. The number that decides anything -- what the
   * customer owes after this sale -- comes from the server when the ledger is
   * next read.
   */
  const ledgerCustomers = useCustomerStore((s) => s.customers);
  const loadCustomers = useCustomerStore((s) => s.load);
  useEffect(() => { loadCustomers({ silent: true }); }, [loadCustomers]);
  // The product grid. The cart list lives in a modal and is short-lived, so it
  // has no stale offset to reset.
  const gridRef = useScrollTopOnFocus();
  const [placing, setPlacing] = useState(false);
  const [preview, setPreview] = useState(null); // the product being inspected

  useEffect(() => { loadAll(); }, [loadAll]);
  // The staleness banner's text, assembled through i18n because Hindi and
  // Gujarati word these time units differently.
  const servingCache = useInventoryStore((s) => s.servingCache);
  const cacheLoadedAt = useInventoryStore((s) => s.loadedAt);
  const staleMessage = useMemo(() => {
    if (!servingCache) return null;
    const age = relativeAge(cacheLoadedAt);
    const base = age
      ? t('offline.stale', { when: t(age.key, { n: age.n }) })
      : t('offline.staleNoTime');
    return `${base}. ${t('offline.stockMayHaveChanged')}.`;
  }, [servingCache, cacheLoadedAt, t]);


  // Products added in the Stock tab should appear here without a manual pull.
  useFocusEffect(
    useCallback(() => {
      if (useInventoryStore.getState().loadedAt) loadAll({ silent: true });
      /**
       * Coming back to the till is the moment to try again. The operator has
       * usually just walked somewhere with signal, and a queue that only
       * drained when somebody remembered to press a button would mostly not
       * drain at all.
       */
      useQueueStore.getState().sync().then((res) => {
        if (res?.synced) loadAll({ silent: true });
      });
    }, [loadAll])
  );

  const cartQtyById = useMemo(
    () => new Map(cart.items.map((i) => [i.productId, i.qty])),
    [cart.items]
  );

  const visibleProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return products.filter((p) => {
      if (activeCategory !== 'all' && String(p.categoryId) !== activeCategory) return false;
      if (term && !p.name.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [products, activeCategory, search]);

  /**
   * An odd product count leaves one card alone on the last row, where `flex-1`
   * makes it span the full width and its square photo tile balloon to twice the
   * size of every other card. An invisible spacer keeps the grid honest.
   */
  const SPACER = '__spacer__';
  const gridData = useMemo(
    () => (visibleProducts.length % 2 === 1
      ? [...visibleProducts, { _id: SPACER }]
      : visibleProducts),
    [visibleProducts]
  );

  const addToCart = (product) => {
    const res = cart.addItem(product);
    if (res && res.ok === false) toast.error(`${product.name}: ${t('pos.notEnoughStock')}`);
  };

  const checkout = async () => {
    if (!cart.items.length) return;
    /**
     * Minted BEFORE the first attempt, not after a failure.
     *
     * A request that timed out may well have been applied -- it is the REPLY
     * that got lost -- so the retry has to be recognisable as the same sale.
     * Generating the ref only when queueing would leave exactly that case
     * unprotected, and it is the case that charges a customer twice.
     */
    const payload = { ...cart.toOrderPayload(), clientRef: makeClientRef() };
    const queuedTotal = grandTotal;

    setPlacing(true);
    try {
      const res = await orderApi.checkout(payload);
      applySoldItems(res.order.items);
      cart.clear();
      setCartOpen(false);
      toast.success(`${t('pos.orderPlaced')} · ${t('pos.receipt')} ${res.order.receiptNo} — ${formatINR(res.order.grandTotal)}`);

      // The moment the customer is standing at the counter is the moment a
      // receipt is useful -- a toast that fades in three seconds is not a
      // receipt. Offered, not forced: plenty of ₹20 sales don't want one.
      const wantsReceipt = await confirm({
        title: `${t('receipt.saleComplete')} — ${res.order.receiptNo}`,
        message: `${formatINR(res.order.grandTotal)} · ${t('receipt.sharePrompt')}`,
        confirmLabel: t('receipt.share'),
        cancelLabel: t('receipt.done'),
      });
      if (wantsReceipt) {
        try {
          await shareReceipt({ order: res.order, businessName: business?.name, t });
        } catch {
          toast.error(t('receipt.failed'));
        }
      }
    } catch (err) {
      /**
       * The phone could not reach the server. The customer is standing there
       * and the sale is real, so it is taken, kept on disk, and sent later --
       * which is the whole reason this app is usable on a shop's data plan and
       * against a backend that sleeps after fifteen minutes.
       */
      if (classifyFailure(err) === 'queue') {
        const queued = useQueueStore.getState().enqueue(payload, { total: queuedTotal });
        if (!queued.ok) {
          toast.error(t('queue.full'));
          return;
        }
        // The grid has to reflect what left the shelf, or the next customer is
        // sold stock that is already in a bag by the door.
        applySoldItems(payload.items);
        cart.clear();
        setCartOpen(false);
        toast.success(`${t('queue.savedOffline')} — ${formatINR(queuedTotal)}`);
        return;
      }

      // 409 means someone else sold the stock first; resync so the grid is honest.
      if (err.status === 409) {
        const names = (err.details?.outOfStock ?? []).map((o) => o.name).filter(Boolean).join(', ');
        toast.error(names ? `${t('pos.notEnoughStock')}: ${names}` : err.message);
        loadAll({ silent: true });
      } else {
        toast.error(err.message);
      }
    } finally {
      setPlacing(false);
    }
  };

  /* ------------------------------ catalogue ------------------------------ */

  const renderProduct = useCallback(({ item }) => {
    // Occupies a column without drawing anything.
    if (item._id === '__spacer__') return <View className="m-1 flex-1" pointerEvents="none" />;

    const inCart = cartQtyById.get(item._id) ?? 0;
    const out = item.stock <= 0;

    return (
      <View
        className={`m-1 flex-1 rounded-2xl border p-2.5 ${out ? 'border-slate-200 bg-slate-100' : 'border-slate-200 bg-white'}`}
      >
        {/* Tapping the card INSPECTS the product. Only the control below sells
            it -- otherwise there is no way to look at a photo without also
            ringing up a sale. */}
        <Pressable
          onPress={() => setPreview(item)}
          accessibilityRole="button"
          accessibilityLabel={`${item.name}, ${formatINR(item.price)}`}
          className={out ? 'opacity-60' : ''}
        >
          <ProductImage imageUrl={item.imageUrl} fill rounded="rounded-xl" className="mb-2 aspect-square w-full" />

          <View className="min-h-[36px]">
            <Text className="text-sm font-semibold text-slate-900" numberOfLines={2}>{item.name}</Text>
          </View>

          <View className="mt-1 flex-row items-center justify-between">
            <Text className="text-base font-bold text-blue-600">{formatINR(item.price)}</Text>
            <Text className={`text-xs ${out ? 'text-red-600' : item.stock <= 5 ? 'text-amber-600' : 'text-slate-400'}`}>
              {out ? t('pos.outOfStock') : `${item.stock} ${t('pos.left')}`}
            </Text>
          </View>
        </Pressable>

        <View className="mt-2">
          <QuantityStepper
            qty={inCart}
            addLabel={t('pos.addToCart')}
            itemLabel={item.name}
            disabled={out}
            compact
            onAdd={() => addToCart(item)}
            onIncrement={() => {
              const res = cart.increment(item._id);
              if (res && res.ok === false) toast.error(`${item.name}: ${t('pos.notEnoughStock')}`);
            }}
            onDecrement={() => cart.decrement(item._id)}
          />
        </View>
      </View>
    );
  }, [cartQtyById, cart, t]);

  const categoryPills = useMemo(
    () => [{ _id: 'all', name: t('pos.allItems'), color: '#64748B' }, ...categories],
    [categories, t]
  );

  /* -------------------------------- cart -------------------------------- */

  const renderCartRow = useCallback(({ item }) => (
    <View className="mb-2 rounded-2xl border border-slate-200 bg-white p-3">
      <View className="flex-row items-start">
        <ProductImage imageUrl={item.imageUrl} size={44} rounded="rounded-lg" className="mr-2.5" />
        <View className="flex-1 pr-2">
          <Text className="text-sm font-semibold text-slate-900" numberOfLines={1}>{item.name}</Text>
          <Text className="mt-0.5 text-xs text-slate-500">
            {formatINR(unitPrice(item))} × {item.qty} = {formatINR(lineGross(item))}
          </Text>
          {/* When the price has been changed by hand, say what the shelf says
              too. Otherwise a repriced line is indistinguishable from a
              mis-priced product, and nobody notices until the report. */}
          {isRepriced(item) ? (
            <Text className="mt-0.5 text-xs text-amber-600">
              {t('pos.listPrice')} {formatINR(item.price)}
            </Text>
          ) : null}
        </View>
        <Pressable onPress={() => cart.removeItem(item.productId)} hitSlop={8} className="p-1" accessibilityLabel={t('common.remove')}>
          <Ionicons name="close-circle" size={20} color="#94A3B8" />
        </Pressable>
      </View>

      <View className="mt-2 flex-row items-center justify-between">
        <View className="flex-row items-center">
          <Pressable
            onPress={() => cart.decrement(item.productId)}
            className="h-9 w-9 items-center justify-center rounded-lg border border-slate-300 bg-white active:bg-slate-100"
            accessibilityLabel="minus"
          >
            <Ionicons name="remove" size={18} color="#334155" />
          </Pressable>
          {allowsFraction(item.unit) ? (
            /* Typed, not tapped. Reaching 1.75 kg with a ±1 step is seven taps
               and a rounding argument; for anything sold by weight the number
               itself has to be the control. */
            <TextInput
              value={String(item.qty)}
              onChangeText={(v) => {
                const cleaned = sanitiseQty(v, item.unit);
                const res = cart.setQty(item.productId, cleaned);
                if (res && res.ok === false && res.reason === 'stock') {
                  toast.error(t('pos.notEnoughStock'));
                }
              }}
              keyboardType="decimal-pad"
              selectTextOnFocus
              maxLength={9}
              accessibilityLabel={`${t('pos.quantity')} ${item.name}`}
              className="mx-2 h-9 w-20 rounded-lg border border-slate-300 bg-white text-center text-base font-bold text-slate-900"
            />
          ) : (
            <Text className="mx-3 min-w-[24px] text-center text-base font-bold text-slate-900">{item.qty}</Text>
          )}
          <Pressable
            onPress={() => {
              const res = cart.increment(item.productId);
              if (res && res.ok === false) toast.error(t('pos.notEnoughStock'));
            }}
            className="h-9 w-9 items-center justify-center rounded-lg border border-slate-300 bg-white active:bg-slate-100"
            accessibilityLabel="plus"
          >
            <Ionicons name="add" size={18} color="#334155" />
          </Pressable>
          <Text className="ml-2 text-xs text-slate-400">
            {item.unit && item.unit !== DEFAULT_UNIT ? `${item.unit} ` : ''}/ {item.stock}
          </Text>
        </View>

        {/* Gross for this line. The discount is deducted once, in the summary. */}
        <Text className="text-base font-bold text-slate-900">{formatINR(lineGross(item))}</Text>
      </View>

      {/* Price and discount side by side.
          The price box is for the sale in front of you, not the catalogue: a
          haggled rate, a damaged tin, or simply collecting more than the shelf
          says. Leaving it empty charges the catalogue price, so the common
          case needs no interaction at all. Editing the product instead would
          rewrite the price for every future sale. */}
      <View className="mt-2 flex-row items-end gap-2">
        <View className="flex-1">
          <Text className="mb-1 text-xs text-slate-500">{t('pos.unitPrice')}</Text>
          <TextField
            value={item.priceOverride != null ? String(item.priceOverride) : ''}
            onChangeText={(v) => cart.setPriceOverride(item.productId, v)}
            mode="money"
            prefix="₹"
            // The catalogue price as the placeholder: it shows what will be
            // charged if nothing is typed, without pre-filling a value the
            // operator then has to clear.
            placeholder={String(item.price)}
            className="mb-0"
            accessibilityLabel={`${t('pos.unitPrice')} ${item.name}`}
          />
        </View>
        <View className="flex-1">
          <Text className="mb-1 text-xs text-slate-500">{t('pos.itemDiscount')}</Text>
          <TextField
            value={item.discount ? String(item.discount) : ''}
            onChangeText={(v) => cart.setDiscount(item.productId, v)}
            mode="money"
            prefix="₹"
            placeholder="0"
            className="mb-0"
            // "Discount Chai" rather than a third anonymous "0" box, so this
            // row's field is distinguishable from extra charges and from the
            // other lines' discounts.
            accessibilityLabel={`${t('pos.itemDiscount')} ${item.name}`}
          />
        </View>
      </View>

      {isRepriced(item) || item.discount > 0 ? (
        <View className="mt-1.5 flex-row items-center justify-end gap-3">
          {isRepriced(item) ? (
            <Text className="text-xs font-semibold text-amber-600">
              {unitPrice(item) > item.price ? '+' : ''}
              {formatINR(round2(unitPrice(item) - item.price))} / {t('pos.perUnit')}
            </Text>
          ) : null}
          {item.discount > 0 ? (
            <Text className="text-xs font-semibold text-green-600">-{formatINR(item.discount)}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  ), [cart, t]);

  const TotalRow = ({ label, value, bold = false, tone = 'default' }) => (
    <View className="flex-row items-center justify-between py-1">
      <Text className={`${bold ? 'text-base font-bold text-slate-900' : 'text-sm text-slate-600'}`}>{label}</Text>
      <Text
        className={`${bold ? 'text-xl font-bold' : 'text-sm font-semibold'} ${tone === 'discount' ? 'text-green-600' : 'text-slate-900'}`}
      >
        {value}
      </Text>
    </View>
  );

  return (
    <Screen title={t('pos.title')}>
      {/* Cached rows are labelled, never passed off as live. When the cache is
          what is on screen the red error is suppressed: "no connection" is not
          an error the operator can act on, and the amber line already says so. */}
      <StaleBanner message={staleMessage} onRetry={loadAll} retryLabel={t('offline.refresh')} />
      <ErrorBanner
        message={servingCache ? null : error}
        onRetry={loadAll}
        retryLabel={t('common.retry')}
      />

      {/* Above the grid, not buried in Sales: money the shop has taken and the
          records do not know about belongs where the selling happens. */}
      <QueueBanner className="mt-2" />

      {loading && !products.length ? (
        <Loading label={t('common.loading')} />
      ) : !products.length ? (
        <EmptyState icon="basket-outline" title={t('pos.noProducts')} hint={t('pos.noProductsHint')} />
      ) : (
        <>
          <View className="px-3 pt-3">
            <TextField
              value={search}
              onChangeText={setSearch}
              placeholder={t('common.search')}
              className="mb-2"
            />
          </View>

          {/* Category filter. A dropdown for the same reason as the Stock tab:
              categories past the fourth were scrolled off the right edge, so a
              shop with eight of them could not see most of its own filters. */}
          <View className="px-4">
            <Select
              className="mb-2"
              label={t('inventory.category')}
              value={activeCategory}
              options={categoryPills.map((c) => ({
                value: String(c._id),
                label: c.name,
                color: c._id === 'all' ? undefined : c.color,
              }))}
              onChange={setActiveCategory}
            />
          </View>

          {/* Product grid */}
          <FlatList
            ref={gridRef}
            data={gridData}
            keyExtractor={(item) => String(item._id)}
            renderItem={renderProduct}
            numColumns={2}
            columnWrapperStyle={{ paddingHorizontal: 8 }}
            contentContainerStyle={{ paddingBottom: itemCount ? 96 : 24, paddingTop: 4 }}
            refreshing={refreshing}
            onRefresh={() => loadAll({ silent: true })}
            ListEmptyComponent={
              <EmptyState icon="search-outline" title={t('pos.noProducts')} hint={t('common.search')} />
            }
          />
        </>
      )}

      {/* Sticky cart bar */}
      {itemCount > 0 ? (
        <View className="absolute inset-x-0 bottom-0 border-t border-slate-200 bg-white px-4 pb-4 pt-3">
          <Pressable
            onPress={() => setCartOpen(true)}
            className="flex-row items-center justify-between rounded-xl bg-blue-600 px-4 py-3 active:bg-blue-700"
            accessibilityRole="button"
            // Without this the bar announces itself as "3 items ₹450", which
            // changes with the cart and tells a screen reader nothing about
            // what tapping it does.
            accessibilityLabel={t('pos.viewCart')}
          >
            <View className="flex-row items-center">
              <Ionicons name="cart" size={20} color="#fff" />
              <Text className="ml-2 text-sm font-semibold text-white">
                {itemCount} {t('pos.items')}
              </Text>
            </View>
            <View className="flex-row items-center">
              <Text className="mr-2 text-lg font-bold text-white">{formatINR(grandTotal)}</Text>
              <Ionicons name="chevron-forward" size={18} color="#fff" />
            </View>
          </Pressable>
        </View>
      ) : null}

      <ProductPreview
        product={preview}
        qty={preview ? (cartQtyById.get(preview._id) ?? 0) : 0}
        onClose={() => setPreview(null)}
        onAdd={() => preview && addToCart(preview)}
        onIncrement={() => {
          const res = cart.increment(preview._id);
          if (res && res.ok === false) toast.error(t('pos.notEnoughStock'));
        }}
        onDecrement={() => cart.decrement(preview._id)}
      />

      {/* ------------------------- cart / checkout ------------------------- */}
      <Modal visible={cartOpen} animationType="slide" onRequestClose={() => setCartOpen(false)}>
        <SafeAreaView className="flex-1 bg-slate-50" edges={['top', 'left', 'right']}>
          <View className="flex-row items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
            <Text className="text-lg font-bold text-slate-900">{t('pos.cart')}</Text>
            <View className="flex-row items-center">
              {cart.items.length ? (
                <Pressable
                  onPress={cart.clear}
                  hitSlop={8}
                  className="mr-3 flex-row items-center p-1"
                  accessibilityRole="button"
                  accessibilityLabel={t('pos.clearCart')}
                >
                  <Ionicons name="trash-outline" size={16} color="#DC2626" />
                  <Text className="ml-1 text-xs font-semibold text-red-600">{t('pos.clearCart')}</Text>
                </Pressable>
              ) : null}
              {/* Every other close in the app carries the role; without it this
                  one is invisible to a screen reader's button rotor. */}
              <Pressable
                onPress={() => setCartOpen(false)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t('common.close')}
              >
                <Ionicons name="close" size={24} color="#64748B" />
              </Pressable>
            </View>
          </View>

          {!cart.items.length ? (
            <EmptyState icon="cart-outline" title={t('pos.cartEmpty')} hint={t('pos.cartEmptyHint')} />
          ) : (
            /* A FlatList, not a ScrollView + map (PRD 6, "Lists"): the cart is
               unbounded -- a wholesale order can run to dozens of lines, each
               with its own text input -- and only the list virtualises. The
               customer-name field and the invoice summary ride along as the
               list's header and footer so there is still exactly one scroll
               container, which is what a FlatList nested in a ScrollView would
               have broken. */
            <FlatList
              data={cart.items}
              keyExtractor={(item) => String(item.productId)}
              renderItem={renderCartRow}
              className="flex-1"
              contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12 }}
              keyboardShouldPersistTaps="handled"
              ListHeaderComponent={
                /**
                 * A ledger customer REPLACES the free-text name rather than
                 * sitting beside it. Two name fields on one receipt is an
                 * invitation to file a sale under "Ramesh" while the debt goes
                 * to a different Ramesh, which is the exact failure a customer
                 * record exists to prevent.
                 */
                cart.customer ? (
                  <View className="mb-3 flex-row items-center rounded-xl border border-blue-300 bg-blue-50 p-3">
                    <Ionicons name="person" size={18} color="#1D4ED8" />
                    <View className="ml-2 flex-1">
                      <Text className="text-sm font-bold text-slate-900" numberOfLines={1}>
                        {cart.customer.name}
                      </Text>
                      {cart.customer.balance > 0 ? (
                        <Text className="mt-0.5 text-xs font-semibold text-amber-700">
                          {t('customers.owesAlready', { amount: formatINR(cart.customer.balance) })}
                        </Text>
                      ) : null}
                    </View>
                    <Pressable
                      onPress={() => cart.setCustomer(null)}
                      hitSlop={8}
                      className="p-1.5"
                      accessibilityRole="button"
                      accessibilityLabel={t('pos.clearCustomer')}
                    >
                      <Ionicons name="close-circle" size={20} color="#64748B" />
                    </Pressable>
                  </View>
                ) : (
                  <>
                    <TextField
                      label={t('pos.customerName')}
                      value={cart.customerName}
                      onChangeText={cart.setCustomerName}
                      placeholder={t('pos.walkIn')}
                    />
                    {ledgerCustomers.length ? (
                      <Pressable
                        onPress={() => setCustomerPicker(true)}
                        accessibilityRole="button"
                        accessibilityLabel={t('pos.chooseCustomer')}
                        className="mb-3 flex-row items-center justify-center rounded-xl border border-slate-300 bg-white py-2.5 active:bg-slate-100"
                      >
                        <Ionicons name="people-outline" size={16} color="#334155" />
                        <Text className="ml-1.5 text-xs font-bold text-slate-700">
                          {t('pos.chooseCustomer')}
                        </Text>
                      </Pressable>
                    ) : null}
                  </>
                )
              }
              ListFooterComponent={
                <>
                  <TextField
                    label={t('pos.extraCharges')}
                    value={cart.extraCharges ? String(cart.extraCharges) : ''}
                    onChangeText={cart.setExtraCharges}
                    mode="money"
                    prefix="₹"
                    placeholder="0"
                    hint={t('common.optional')}
                  />

                  {/* Part payment, only when there is somebody to owe it.
                      Hidden entirely for a walk-in, because a field that can
                      only produce a 400 is worse than no field. */}
                  {cart.customer ? (
                    <View className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-3">
                      <Text className="mb-1.5 text-xs font-semibold text-slate-700">
                        {t('pos.paidNow')}
                      </Text>
                      <TextField
                        value={cart.amountPaid == null ? '' : String(cart.amountPaid)}
                        onChangeText={cart.setAmountPaid}
                        mode="money"
                        prefix="₹"
                        // The full total as the placeholder: leaving it empty
                        // charges nothing to the ledger, which is the common
                        // case even for a customer who has an account.
                        placeholder={String(grandTotal)}
                        className="mb-0"
                        accessibilityLabel={t('pos.paidNow')}
                      />
                      {cart.amountPaid != null && cart.amountPaid < grandTotal ? (
                        <Text className="mt-2 text-xs font-bold text-amber-700">
                          {t('pos.goesOnCredit', {
                            amount: formatINR(round2(grandTotal - cart.amountPaid)),
                            name: cart.customer.name,
                          })}
                        </Text>
                      ) : (
                        <Text className="mt-2 text-xs text-slate-500">{t('pos.paidInFullHint')}</Text>
                      )}
                    </View>
                  ) : null}

                  {/* How the money is coming in. Above the total rather than
                      below it, because it is a decision taken WITH the customer
                      standing there, and anything under the total reads as a
                      footnote to a sale already made. */}
                  <View className="mb-3">
                    <Text className="mb-1.5 text-xs font-semibold text-slate-600">{t('pos.paidBy')}</Text>
                    {/* Radios, not buttons. These are four mutually exclusive
                        choices, and `accessibilityState={{selected}}` on a
                        button is dropped entirely by react-native-web -- a
                        screen reader user could hear the four options and not
                        which one was chosen. role=radio emits aria-checked. */}
                    <View className="flex-row gap-2" accessibilityRole="radiogroup">
                      {PAYMENT_METHODS.map((m) => {
                        const active = cart.paymentMethod === m;
                        return (
                          <Pressable
                            key={m}
                            onPress={() => cart.setPaymentMethod(m)}
                            accessibilityRole="radio"
                            accessibilityLabel={t(`pos.pay_${m}`)}
                            /* Both spellings. react-native-web drops
                               accessibilityState on a Pressable entirely, so
                               the chosen method was visible only as a colour --
                               invisible to a screen reader. `aria-checked` is a
                               first-class React Native prop these days and is
                               the one that actually reaches the DOM. */
                            aria-checked={active}
                            accessibilityState={{ checked: active, selected: active }}
                            className={`flex-1 items-center rounded-xl border py-2.5 ${active ? 'border-blue-600 bg-blue-50' : 'border-slate-300 bg-white'}`}
                          >
                            <Text className={`text-xs font-bold ${active ? 'text-blue-700' : 'text-slate-600'}`}>
                              {t(`pos.pay_${m}`)}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>

                  {/* Reads as an invoice: gross, minus discount, plus charges, total. */}
                  <View className="mb-6 rounded-2xl border border-slate-200 bg-white p-4">
                    <TotalRow label={t('pos.subtotal')} value={formatINR(gross)} />
                    {totalDiscount > 0 ? (
                      <TotalRow label={t('pos.discount')} value={`− ${formatINR(totalDiscount)}`} tone="discount" />
                    ) : null}
                    {cart.extraCharges > 0 ? (
                      <TotalRow label={t('pos.extraCharges')} value={`+ ${formatINR(cart.extraCharges)}`} />
                    ) : null}
                    <View className="my-2 h-px bg-slate-200" />
                    <TotalRow label={t('pos.grandTotal')} value={formatINR(grandTotal)} bold />
                  </View>
                </>
              }
            />
          )}

          {cart.items.length ? (
            <View className="border-t border-slate-200 bg-white px-4 pb-6 pt-3">
              <Button
                title={`${t('pos.completeOrder')} — ${formatINR(grandTotal)}`}
                onPress={checkout}
                loading={placing}
                variant="success"
                size="lg"
                icon="checkmark-circle"
                fullWidth
              />
            </View>
          ) : null}
        </SafeAreaView>
      </Modal>

      {/* Picking who the sale is for. A dialog rather than a screen: it is one
          decision taken mid-sale, and pushing a screen would put the cart
          behind a back button with a customer waiting. */}
      <FormModal
        visible={customerPicker}
        title={t('pos.chooseCustomer')}
        onClose={() => setCustomerPicker(false)}
        cancelLabel={t('common.close')}
      >
        {ledgerCustomers.length === 0 ? (
          <Text className="py-4 text-center text-sm text-slate-500">{t('customers.none')}</Text>
        ) : ledgerCustomers.map((c) => (
          <Pressable
            key={String(c._id)}
            onPress={() => { cart.setCustomer(c); setCustomerPicker(false); }}
            accessibilityRole="button"
            accessibilityLabel={c.name}
            className="mb-2 flex-row items-center rounded-xl border border-slate-200 bg-white p-3 active:bg-slate-50"
          >
            <View className="flex-1">
              <Text className="text-sm font-bold text-slate-900" numberOfLines={1}>{c.name}</Text>
              {c.phone ? <Text className="mt-0.5 text-xs text-slate-500">{c.phone}</Text> : null}
            </View>
            {c.balance > 0 ? (
              <Text className="text-xs font-bold text-amber-700">{formatINR(c.balance)}</Text>
            ) : null}
          </Pressable>
        ))}
      </FormModal>
    </Screen>
  );
}
