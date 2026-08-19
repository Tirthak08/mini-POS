import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';

import Screen from '../components/Screen';
import Button from '../components/Button';
import Select from '../components/Select';
import TextField from '../components/TextField';
import EmptyState from '../components/EmptyState';
import ProductImage from '../components/ProductImage';
import QuantityStepper from '../components/QuantityStepper';
import ProductPreview from '../components/ProductPreview';
import Loading, { ErrorBanner, StaleBanner } from '../components/Loading';
import { useInventoryStore } from '../store/inventoryStore';
import {
  useCartStore, selectItemCount, selectGross, selectGrandTotal, selectTotalDiscount, lineGross,
} from '../store/cartStore';
import { useAuthStore } from '../store/authStore';
import { orderApi } from '../api/endpoints';
import { toast } from '../store/uiStore';
import { formatINR, relativeAge } from '../utils/money';
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
    setPlacing(true);
    try {
      const res = await orderApi.checkout(cart.toOrderPayload());
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
            {formatINR(item.price)} × {item.qty} = {formatINR(lineGross(item))}
          </Text>
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
          <Text className="mx-3 min-w-[24px] text-center text-base font-bold text-slate-900">{item.qty}</Text>
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
          <Text className="ml-2 text-xs text-slate-400">/ {item.stock}</Text>
        </View>

        {/* Gross for this line. The discount is deducted once, in the summary. */}
        <Text className="text-base font-bold text-slate-900">{formatINR(lineGross(item))}</Text>
      </View>

      {/* Per-item discount (PRD 6, screen 2). Clamped in the store, so the
          line total can never render negative. */}
      <View className="mt-2 flex-row items-center">
        <Text className="mr-2 text-xs text-slate-500">{t('pos.itemDiscount')}</Text>
        <View className="flex-1">
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
        {item.discount > 0 ? (
          <Text className="ml-2 text-xs font-semibold text-green-600">-{formatINR(item.discount)}</Text>
        ) : null}
      </View>
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
    <Screen title={t('pos.title')} subtitle={business?.name}>
      {/* Cached rows are labelled, never passed off as live. When the cache is
          what is on screen the red error is suppressed: "no connection" is not
          an error the operator can act on, and the amber line already says so. */}
      <StaleBanner message={staleMessage} onRetry={loadAll} retryLabel={t('offline.refresh')} />
      <ErrorBanner
        message={servingCache ? null : error}
        onRetry={loadAll}
        retryLabel={t('common.retry')}
      />

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
                <TextField
                  label={t('pos.customerName')}
                  value={cart.customerName}
                  onChangeText={cart.setCustomerName}
                  placeholder={t('pos.walkIn')}
                />
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
    </Screen>
  );
}
