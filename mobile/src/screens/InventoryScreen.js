import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import Screen from '../components/Screen';
import Button from '../components/Button';
import Select from '../components/Select';
import TextField from '../components/TextField';
import FormModal from '../components/FormModal';
import EmptyState from '../components/EmptyState';
import ProductImage, { ImagePickerTile } from '../components/ProductImage';
import ProductPreview from '../components/ProductPreview';
import Loading, { ErrorBanner, StaleBanner } from '../components/Loading';
import { Badge, StatTile } from '../components/Card';
import { useInventoryStore } from '../store/inventoryStore';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { toast } from '../store/uiStore';
import { confirm, promptNumber } from '../store/confirmStore';
import { pickAndUploadImage, deleteImage } from '../utils/imageUpload';
import { formatINR, round2, relativeAge } from '../utils/money';
import { chartPalette } from '../theme';

const EMPTY_PRODUCT = { name: '', categoryId: '', price: '', cost: '', stock: '', imageId: null, imageUrl: null, localUri: null };

export default function InventoryScreen() {
  const { t } = useTranslation();
  const [tab, setTab] = useState('products');

  const {
    categories, products, loading, refreshing, error,
    loadAll, createCategory, updateCategory, deleteCategory,
    createProduct, updateProduct, deleteProduct, adjustStock,
  } = useInventoryStore();

  const business = useAuthStore((s) => s.business);
  const lowStockThreshold = useSettingsStore((s) => s.lowStockThreshold);

  const [catModal, setCatModal] = useState(null); // null | {} | category
  const [catForm, setCatForm] = useState({ name: '', color: chartPalette[0] });
  const [prodModal, setProdModal] = useState(null);
  const [prodForm, setProdForm] = useState(EMPTY_PRODUCT);
  const [formError, setFormError] = useState({});
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  // Same filtering affordances as the Sell tab, so the two screens behave alike.
  const [activeCategory, setActiveCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [preview, setPreview] = useState(null);

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


  /**
   * "1 products" is the kind of thing an operator notices immediately.
   * i18next's count support is deliberately unused app-wide (Hermes can ship
   * without full Intl.PluralRules), so the form is picked explicitly.
   */
  const countLabel = useCallback(
    (n, oneKey, manyKey) => `${n} ${t(n === 1 ? oneKey : manyKey)}`,
    [t]
  );

  const categoryById = useMemo(
    () => new Map(categories.map((c) => [String(c._id), c])),
    [categories]
  );

  const visibleProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return products.filter((p) => {
      if (activeCategory !== 'all' && String(p.categoryId) !== activeCategory) return false;
      if (term && !p.name.toLowerCase().includes(term)) return false;
      if (lowOnly && p.stock > lowStockThreshold) return false;
      return true;
    });
  }, [products, activeCategory, search, lowOnly, lowStockThreshold]);

  /**
   * What the shop is holding RIGHT NOW. This used to sit on the Reports tab
   * next to period sales figures, which made "Investment" ambiguous -- readers
   * could not tell whether it meant money currently on the shelf or money spent
   * over the reporting window. It is a stock fact, so it lives with the stock,
   * and Reports carries the period counterpart ("Stock sold (at cost)").
   *
   * Computed from the same array the list below renders, so the numbers cannot
   * disagree with the rows on screen, and they move the instant stock changes.
   */
  const stockSummary = useMemo(() => {
    // Scoped to the current category/search so a filtered view answers
    // "how much do I have tied up in THIS category?".
    const scope = products.filter((p) => {
      if (activeCategory !== 'all' && String(p.categoryId) !== activeCategory) return false;
      const term = search.trim().toLowerCase();
      if (term && !p.name.toLowerCase().includes(term)) return false;
      return true;
    });
    let atCost = 0, atPrice = 0, units = 0, out = 0, low = 0;
    for (const p of scope) {
      const stock = Number(p.stock) || 0;
      atCost += (Number(p.cost) || 0) * stock;
      atPrice += (Number(p.price) || 0) * stock;
      units += stock;
      if (stock <= 0) out += 1;
      else if (stock <= lowStockThreshold) low += 1;
    }
    return {
      items: scope.length,
      units,
      atCost: round2(atCost),
      atPrice: round2(atPrice),
      potentialProfit: round2(atPrice - atCost),
      out,
      low,
      needsAttention: low + out,
    };
  }, [products, activeCategory, search, lowStockThreshold]);

  const categoryPills = useMemo(
    () => [{ _id: 'all', name: t('pos.allItems'), color: '#64748B' }, ...categories],
    [categories, t]
  );

  /** Shown under each option: a category holding nothing is worth knowing. */
  const productCountByCategory = useMemo(() => {
    const counts = new Map();
    for (const p of products) {
      const key = String(p.categoryId);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [products]);

  /* ------------------------- categories ------------------------- */

  const openCategory = (category) => {
    setCatForm(category ? { name: category.name, color: category.color } : { name: '', color: chartPalette[0] });
    setFormError({});
    setCatModal(category ?? {});
  };

  const submitCategory = async () => {
    if (!catForm.name.trim()) return setFormError({ name: t('errors.required') });
    setSaving(true);
    const editing = catModal?._id;
    const res = editing
      ? await updateCategory(editing, { name: catForm.name.trim(), color: catForm.color })
      : await createCategory(catForm.name.trim(), catForm.color);
    setSaving(false);

    if (res.ok) {
      setCatModal(null);
      toast.success(t('common.save'));
    } else {
      setFormError({ name: res.error.message });
    }
  };

  const confirmDeleteCategory = async (category) => {
    const ok = await confirm({
      title: t('inventory.deleteCategoryConfirm'),
      message: category.name,
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!ok) return;

    const res = await deleteCategory(category._id);
    if (res.ok) return toast.success(t('common.delete'));

    // 409 means products still reference it -- offer the cascade explicitly.
    if (res.error?.status === 409) {
      const count = res.error.details?.productCount ?? 0;
      const cascade = await confirm({
        title: t('inventory.categoryHasProducts'),
        message: `${category.name}${count ? ` — ${count} ${t('inventory.productsTab')}` : ''}`,
        confirmLabel: t('inventory.deleteAnyway'),
        destructive: true,
      });
      if (!cascade) return;
      const forced = await deleteCategory(category._id, { force: true });
      toast[forced.ok ? 'success' : 'error'](forced.ok ? t('common.delete') : forced.error.message);
      return;
    }
    toast.error(res.error.message);
  };

  /* -------------------------- products -------------------------- */

  const openProduct = (product) => {
    setProdForm(
      product
        ? {
            name: product.name,
            categoryId: String(product.categoryId ?? ''),
            price: String(product.price ?? ''),
            cost: String(product.cost ?? ''),
            stock: String(product.stock ?? ''),
            imageId: product.imageId ?? null,
            imageUrl: product.imageUrl ?? null,
            localUri: null,
          }
        : { ...EMPTY_PRODUCT, categoryId: categories.length === 1 ? String(categories[0]._id) : '' }
    );
    setFormError({});
    setProdModal(product ?? {});
  };

  const submitProduct = async () => {
    const errors = {};
    if (!prodForm.name.trim()) errors.name = t('errors.required');
    if (!prodForm.categoryId) errors.categoryId = t('inventory.selectCategory');
    if (prodForm.price === '' || Number(prodForm.price) < 0) errors.price = t('errors.required');
    if (Object.keys(errors).length) return setFormError(errors);

    const payload = {
      name: prodForm.name.trim(),
      categoryId: prodForm.categoryId,
      price: Number(prodForm.price),
      cost: prodForm.cost === '' ? 0 : Number(prodForm.cost),
      stock: prodForm.stock === '' ? 0 : Number(prodForm.stock),
      // Always sent, so clearing a photo (null) is as explicit as setting one.
      imageId: prodForm.imageId,
    };

    setSaving(true);
    const res = prodModal?._id
      ? await updateProduct(prodModal._id, payload)
      : await createProduct(payload);
    setSaving(false);

    if (res.ok) {
      setProdModal(null);
      toast.success(t('common.save'));
    } else {
      setFormError({ name: res.error.message });
    }
  };

  /**
   * Uploads as soon as the photo is chosen rather than at save time: the operator
   * sees it immediately, and a slow upload never blocks the Save button.
   */
  const choosePhoto = async (source) => {
    setUploadingPhoto(true);
    try {
      const result = await pickAndUploadImage(source, { productId: prodModal?._id });
      if (!result) return; // backed out of the picker
      setProdForm((f) => ({ ...f, imageId: result.imageId, imageUrl: result.url, localUri: result.localUri }));
    } catch (err) {
      toast.error(err.message || t('inventory.photoFailed'));
    } finally {
      setUploadingPhoto(false);
    }
  };

  const removePhoto = async () => {
    const { imageId } = prodForm;
    setProdForm((f) => ({ ...f, imageId: null, imageUrl: null, localUri: null }));
    // Reclaim the bytes; the product row is updated when the form is saved.
    try { await deleteImage(imageId); } catch { /* the form state is what matters */ }
  };

  const confirmDeleteProduct = async (product) => {
    const ok = await confirm({
      title: t('inventory.deleteProductConfirm'),
      message: product.name,
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!ok) return;
    const res = await deleteProduct(product._id);
    toast[res.ok ? 'success' : 'error'](res.ok ? t('common.delete') : res.error.message);
  };

  /** Quick restock without opening the full edit form. */
  const promptRestock = async (product) => {
    const delta = await promptNumber({
      title: t('inventory.restock'),
      message: `${product.name} — ${t('inventory.stock')}: ${product.stock}`,
      label: t('inventory.addStockAmount'),
      confirmLabel: t('common.add'),
    });
    if (!delta) return;
    const res = await adjustStock(product._id, { delta });
    toast[res.ok ? 'success' : 'error'](res.ok ? `+${delta}` : res.error.message);
  };

  /* --------------------------- renderers --------------------------- */

  const renderCategory = useCallback(({ item }) => (
    <View className="mx-4 mb-2 flex-row items-center rounded-2xl border border-slate-200 bg-white p-3">
      <View className="h-9 w-9 rounded-xl" style={{ backgroundColor: item.color || '#2563EB' }} />
      <View className="ml-3 flex-1">
        <Text className="text-base font-semibold text-slate-900">{item.name}</Text>
        <Text className="text-xs text-slate-500">
          {item.productCount ?? 0} {t('inventory.productsTab')}
        </Text>
      </View>
      <Pressable
        onPress={() => openCategory(item)} hitSlop={8} className="p-2"
        accessibilityRole="button" accessibilityLabel={`${t('common.edit')} ${item.name}`}
      >
        <Ionicons name="pencil" size={18} color="#2563EB" />
      </Pressable>
      <Pressable
        onPress={() => confirmDeleteCategory(item)} hitSlop={8} className="p-2"
        accessibilityRole="button" accessibilityLabel={`${t('common.delete')} ${item.name}`}
      >
        <Ionicons name="trash" size={18} color="#DC2626" />
      </Pressable>
    </View>
  ), [t, categories]);

  const renderProduct = useCallback(({ item }) => {
    const category = categoryById.get(String(item.categoryId));
    const out = item.stock <= 0;
    const low = !out && item.stock <= lowStockThreshold;

    return (
      <View className="mx-4 mb-2 rounded-2xl border border-slate-200 bg-white p-3">
        <View className="flex-row items-start">
          <Pressable
            onPress={() => setPreview({ ...item, category: category?.name ?? null })}
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, ${formatINR(item.price)}`}
            className="mr-3"
          >
            <ProductImage imageUrl={item.imageUrl} size={52} rounded="rounded-xl" />
          </Pressable>
          <View className="flex-1">
            <View className="flex-row items-center">
              <View className="mr-1.5 h-2.5 w-2.5 rounded-full" style={{ backgroundColor: category?.color || '#CBD5E1' }} />
              <Text className="flex-1 text-base font-semibold text-slate-900" numberOfLines={1}>{item.name}</Text>
            </View>
            <Text className="mt-0.5 text-xs text-slate-500">{category?.name ?? '--'}</Text>
          </View>
          <Pressable
            onPress={() => openProduct(item)} hitSlop={8} className="p-1.5"
            accessibilityRole="button" accessibilityLabel={`${t('common.edit')} ${item.name}`}
          >
            <Ionicons name="pencil" size={17} color="#2563EB" />
          </Pressable>
          <Pressable
            onPress={() => confirmDeleteProduct(item)} hitSlop={8} className="p-1.5"
            accessibilityRole="button" accessibilityLabel={`${t('common.delete')} ${item.name}`}
          >
            <Ionicons name="trash" size={17} color="#DC2626" />
          </Pressable>
        </View>

        <View className="mt-3 flex-row items-center justify-between">
          <View className="flex-row items-baseline">
            <Text className="text-lg font-bold text-slate-900">{formatINR(item.price)}</Text>
            {item.cost > 0 ? (
              <Text className="ml-2 text-xs text-slate-400">
                {t('inventory.margin')} {formatINR(item.price - item.cost)}
              </Text>
            ) : null}
          </View>

          <View className="flex-row items-center">
            {out ? <Badge label={t('inventory.outOfStock')} tone="danger" />
              : low ? <Badge label={`${item.stock} ${t('pos.left')}`} tone="warning" />
              : <Badge label={`${item.stock}`} tone="success" />}
            <Pressable
              onPress={() => promptRestock(item)} hitSlop={8} className="ml-2 p-1"
              accessibilityRole="button" accessibilityLabel={`${t('inventory.restock')} ${item.name}`}
            >
              <Ionicons name="add-circle" size={22} color="#16A34A" />
            </Pressable>
          </View>
        </View>
      </View>
    );
  }, [categoryById, lowStockThreshold, t]);

  const isCategories = tab === 'categories';
  const data = isCategories ? categories : visibleProducts;

  const scopeLabel = activeCategory === 'all'
    ? t('inventory.stockOnHandHint')
    : `${categoryById.get(activeCategory)?.name ?? ''} — ${t('inventory.stockOnHandHint')}`;

  /** Scrolls with the list rather than pinning four tiles above it forever. */
  const stockHeader = !products.length ? null : (
    <View className="mb-3 px-4">
      <View className="mb-2 flex-row items-center">
        <Ionicons name="cube-outline" size={15} color="#475569" />
        <Text className="ml-1.5 text-sm font-semibold text-slate-700">{t('inventory.stockOnHand')}</Text>
      </View>
      <Text className="mb-2 text-xs text-slate-400">{scopeLabel}</Text>

      <View className="flex-row gap-2">
        <StatTile
          className="flex-1"
          label={t('inventory.investedNow')}
          value={formatINR(stockSummary.atCost)}
          sub={`${countLabel(stockSummary.units, 'inventory.unitOne', 'inventory.unitsInStock')} · ${countLabel(stockSummary.items, 'inventory.productOne', 'inventory.itemsCounted')}`}
        />
        <StatTile
          className="flex-1"
          label={t('inventory.retailValue')}
          value={formatINR(stockSummary.atPrice)}
        />
      </View>
      <View className="mt-2 flex-row gap-2">
        <StatTile
          className="flex-1"
          label={t('inventory.potentialProfit')}
          value={formatINR(stockSummary.potentialProfit)}
          tone={stockSummary.potentialProfit >= 0 ? 'positive' : 'negative'}
        />
        {/* Tappable, because a count of items running low is only useful if it
            gets you to the list of them. */}
        <Pressable
          className="flex-1"
          onPress={() => setLowOnly((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={t('inventory.runningLow')}
          accessibilityState={{ selected: lowOnly }}
        >
          <StatTile
            label={t('inventory.runningLow')}
            value={String(stockSummary.needsAttention)}
            sub={`${stockSummary.out} ${t('inventory.outOfStockShort')}`}
            tone={stockSummary.needsAttention > 0 ? 'negative' : 'default'}
            className={lowOnly ? 'border-red-500' : ''}
          />
        </Pressable>
      </View>

      {lowOnly ? (
        <Pressable
          onPress={() => setLowOnly(false)}
          accessibilityRole="button"
          accessibilityLabel={t('common.clear')}
          className="mt-2 self-start rounded-full bg-red-50 px-3 py-1.5"
        >
          <Text className="text-xs font-semibold text-red-600">
            {t('inventory.runningLow')} · {t('common.clear')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );

  return (
    <Screen
      title={t('inventory.title')}
      subtitle={business?.name}
    >
      <View className="flex-row gap-2 px-4 py-3">
        {[
          { key: 'products', label: `${t('inventory.productsTab')} (${products.length})` },
          { key: 'categories', label: `${t('inventory.categoriesTab')} (${categories.length})` },
        ].map(({ key, label }) => (
          <Pressable
            key={key}
            onPress={() => setTab(key)}
            className={`flex-1 items-center rounded-xl border py-2.5 ${tab === key ? 'border-blue-600 bg-blue-600' : 'border-slate-300 bg-white'}`}
          >
            <Text className={`text-sm font-semibold ${tab === key ? 'text-white' : 'text-slate-600'}`}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {/* Category filter + search, matching the Sell tab */}
      {!isCategories && products.length ? (
        <>
          <View className="px-4">
            <TextField
              value={search}
              onChangeText={setSearch}
              placeholder={t('common.search')}
              className="mb-2"
            />
          </View>
          <View className="px-4">
            {/* Dropdown rather than a scrolling row of chips: with more than
                three or four categories the rest were off-screen, and long
                names were clipped inside their pill. */}
            <Select
              className="mb-2"
              label={t('inventory.category')}
              value={activeCategory}
              options={categoryPills.map((c) => ({
                value: String(c._id),
                label: c.name,
                color: c._id === 'all' ? undefined : c.color,
                sub: c._id === 'all'
                  ? undefined
                  : countLabel(productCountByCategory.get(String(c._id)) ?? 0, 'inventory.productOne', 'inventory.itemsCounted'),
              }))}
              onChange={setActiveCategory}
            />
          </View>
        </>
      ) : null}

      {/* Cached rows are labelled, never passed off as live. When the cache is
          what is on screen the red error is suppressed: "no connection" is not
          an error the operator can act on, and the amber line already says so. */}
      <StaleBanner message={staleMessage} onRetry={loadAll} retryLabel={t('offline.refresh')} />
      <ErrorBanner
        message={servingCache ? null : error}
        onRetry={loadAll}
        retryLabel={t('common.retry')}
      />

      {loading && !data.length ? (
        <Loading label={t('common.loading')} />
      ) : (
        <FlatList
          data={data}
          keyExtractor={(item) => String(item._id)}
          renderItem={isCategories ? renderCategory : renderProduct}
          ListHeaderComponent={isCategories ? null : stockHeader}
          contentContainerStyle={{ paddingBottom: 120, paddingTop: 4 }}
          refreshing={refreshing}
          onRefresh={() => loadAll({ silent: true })}
          ListEmptyComponent={
            isCategories ? (
              <EmptyState
                icon="pricetags-outline"
                title={t('inventory.noCategories')}
                hint={t('inventory.noCategoriesHint')}
                actionLabel={t('inventory.addCategory')}
                onAction={() => openCategory(null)}
              />
            ) : products.length ? (
              // Products exist, but the current filter or search hides them all.
              <EmptyState icon="search-outline" title={t('inventory.noProducts')} hint={t('common.search')} />
            ) : (
              <EmptyState
                icon="cube-outline"
                title={t('inventory.noProducts')}
                hint={categories.length ? t('inventory.noProductsHint') : t('inventory.noCategoriesHint')}
                actionLabel={categories.length ? t('inventory.addProduct') : t('inventory.addCategory')}
                onAction={() => (categories.length ? openProduct(null) : openCategory(null))}
              />
            )
          }
        />
      )}

      {/* Floating add button */}
      {data.length ? (
        <View className="absolute bottom-5 right-5">
          <Button
            icon="add"
            title={isCategories ? t('inventory.addCategory') : t('inventory.addProduct')}
            onPress={() => (isCategories ? openCategory(null) : openProduct(null))}
            size="md"
          />
        </View>
      ) : null}

      {/* Read-only preview: the Stock tab edits through the form, not the cart. */}
      <ProductPreview product={preview} onClose={() => setPreview(null)} />

      {/* -------- category form -------- */}
      <FormModal
        visible={Boolean(catModal)}
        onClose={() => setCatModal(null)}
        title={catModal?._id ? t('inventory.editCategory') : t('inventory.addCategory')}
        submitLabel={t('common.save')}
        onSubmit={submitCategory}
        submitting={saving}
        cancelLabel={t('common.cancel')}
      >
        <TextField
          label={t('inventory.categoryName')}
          value={catForm.name}
          onChangeText={(name) => setCatForm((f) => ({ ...f, name }))}
          placeholder="Beverages"
          error={formError.name}
          autoFocus
        />
        <Text className="mb-2 text-sm font-medium text-slate-700">{t('inventory.colour')}</Text>
        <View className="mb-4 flex-row flex-wrap gap-2">
          {chartPalette.map((color) => (
            <Pressable
              key={color}
              onPress={() => setCatForm((f) => ({ ...f, color }))}
              accessibilityLabel={color}
              className={`h-10 w-10 items-center justify-center rounded-xl ${catForm.color === color ? 'border-2 border-slate-900' : ''}`}
              style={{ backgroundColor: color }}
            >
              {catForm.color === color ? <Ionicons name="checkmark" size={18} color="#fff" /> : null}
            </Pressable>
          ))}
        </View>
      </FormModal>

      {/* -------- product form -------- */}
      <FormModal
        visible={Boolean(prodModal)}
        onClose={() => setProdModal(null)}
        title={prodModal?._id ? t('inventory.editProduct') : t('inventory.addProduct')}
        submitLabel={t('common.save')}
        onSubmit={submitProduct}
        submitting={saving}
        cancelLabel={t('common.cancel')}
      >
        <ImagePickerTile
          label={t('inventory.photo')}
          imageUrl={prodForm.imageUrl}
          localUri={prodForm.localUri}
          uploading={uploadingPhoto}
          uploadingLabel={t('inventory.uploadingPhoto')}
          cameraLabel={t('inventory.takePhoto')}
          galleryLabel={t('inventory.choosePhoto')}
          removeLabel={t('inventory.removePhoto')}
          onCamera={() => choosePhoto('camera')}
          onGallery={() => choosePhoto('gallery')}
          onRemove={removePhoto}
        />

        <TextField
          label={t('inventory.productName')}
          value={prodForm.name}
          onChangeText={(name) => setProdForm((f) => ({ ...f, name }))}
          placeholder="Masala Chai"
          error={formError.name}
        />

        {/* Dropdown: wrapping chips reflowed the whole form every time a
            category was added, and a long name pushed the price fields down
            the sheet. A field of fixed height keeps the form stable. */}
        <Select
          label={t('inventory.category')}
          value={prodForm.categoryId}
          placeholder={t('inventory.selectCategory')}
          options={categories.map((c) => ({
            value: String(c._id),
            label: c.name,
            color: c.color,
          }))}
          onChange={(categoryId) => {
            setProdForm((f) => ({ ...f, categoryId }));
            // Clear the error the moment it stops being true.
            setFormError((e) => ({ ...e, categoryId: undefined }));
          }}
          error={formError.categoryId}
        />

        <View className="flex-row gap-3">
          <View className="flex-1">
            <TextField
              label={t('inventory.price')}
              value={prodForm.price}
              onChangeText={(price) => setProdForm((f) => ({ ...f, price }))}
              mode="money"
              prefix="₹"
              placeholder="0"
              error={formError.price}
            />
          </View>
          <View className="flex-1">
            <TextField
              label={t('inventory.cost')}
              value={prodForm.cost}
              onChangeText={(cost) => setProdForm((f) => ({ ...f, cost }))}
              mode="money"
              prefix="₹"
              placeholder="0"
              hint={t('common.optional')}
            />
          </View>
        </View>

        <TextField
          label={t('inventory.stock')}
          value={prodForm.stock}
          onChangeText={(stock) => setProdForm((f) => ({ ...f, stock }))}
          mode="integer"
          placeholder="0"
        />
      </FormModal>
    </Screen>
  );
}
