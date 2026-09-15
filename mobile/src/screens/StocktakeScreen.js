import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import Screen from '../components/Screen';
import EmptyState from '../components/EmptyState';
import Button from '../components/Button';
import { useInventoryStore } from '../store/inventoryStore';
import { useStocktakeStore } from '../store/stocktakeStore';
import { productApi } from '../api/endpoints';
import { confirm } from '../store/confirmStore';
import { toast } from '../store/uiStore';
import { formatINR } from '../utils/money';
import { rowState, summarise, buildPayload, changedRows } from '../utils/stocktake';
import { allowsFraction, sanitiseQty, formatQty, DEFAULT_UNIT } from '../utils/units';

/**
 * Walk the shelves, type what is actually there, apply it all at once.
 *
 * WHY THIS IS NOT THE PRODUCT EDIT FORM
 * -------------------------------------
 * Correcting stock one product at a time through the edit form works, and for
 * one product it is the right tool. For a whole shop it is four taps and a
 * round trip per item, with no way to see how far you have got, no record that
 * a count happened, and nothing to show for it at the end except a catalogue
 * that has quietly changed. Counting is a different job from editing: it has a
 * beginning, a middle you can be interrupted in, and a total worth looking at.
 *
 * THE ONE RULE THE WHOLE SCREEN TURNS ON
 * --------------------------------------
 * An empty field is a shelf nobody has reached yet. It is never sent, never
 * read as zero, and the count of what is still outstanding is on screen the
 * whole time. Typing 0 is a real count -- it says you looked and there were
 * none -- and that is why the two cannot be conflated.
 *
 * The draft lives in a persisted store rather than in this component's state,
 * because a count outlasts the screen: the phone goes in a pocket, a customer
 * arrives, and Android is free to kill the app. See stocktakeStore.
 */
export default function StocktakeScreen({ navigation }) {
  const { t } = useTranslation();

  const products = useInventoryStore((s) => s.products);
  const categories = useInventoryStore((s) => s.categories);
  const loadAll = useInventoryStore((s) => s.loadAll);

  const counts = useStocktakeStore((s) => s.counts);
  const note = useStocktakeStore((s) => s.note);
  const setCount = useStocktakeStore((s) => s.setCount);
  const reset = useStocktakeStore((s) => s.reset);
  const ensureOwner = useStocktakeStore((s) => s.ensureOwner);

  const [activeCategory, setActiveCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => { ensureOwner(); }, [ensureOwner]);

  const categoryPills = useMemo(
    () => [{ _id: 'all', name: t('pos.allItems'), color: '#64748B' }, ...categories],
    [categories, t]
  );

  /**
   * The rows on screen. Sorted by category then name so walking the list
   * matches walking the shop, rather than jumping between shelves.
   */
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return products
      .filter((p) => {
        if (activeCategory !== 'all' && String(p.categoryId) !== activeCategory) return false;
        if (term && !p.name.toLowerCase().includes(term)) return false;
        if (pendingOnly && counts[String(p._id)] !== undefined) return false;
        return true;
      })
      .sort((a, b) =>
        (a.category ?? '').localeCompare(b.category ?? '') || a.name.localeCompare(b.name));
  }, [products, activeCategory, search, pendingOnly, counts]);

  /**
   * Summarised over the WHOLE catalogue, not the filtered view.
   *
   * The filter is a way of working through the shop a shelf at a time; the
   * totals are about the count as a whole. A progress figure that reset every
   * time the operator changed category would be worse than useless -- it would
   * say the job was finished when one aisle was.
   */
  const totals = useMemo(() => summarise(products, counts), [products, counts]);

  const apply = useCallback(async () => {
    const payload = buildPayload(products, counts, note);
    if (!payload.counts.length) {
      toast.error(t('stocktake.nothingCounted'));
      return;
    }

    const changed = changedRows(products, counts);
    const ok = await confirm({
      title: t('stocktake.applyTitle'),
      message: [
        changed.length
          ? t('stocktake.applyMessage', { changed: changed.length, counted: payload.counts.length })
          : t('stocktake.applyNoChanges', { counted: payload.counts.length }),
        // Singular picked explicitly rather than through i18next's count
        // support: Hermes can ship without full Intl.PluralRules, so the whole
        // app chooses the form itself (see i18n/index.js).
        totals.pending
          ? t(totals.pending === 1 ? 'stocktake.applyPendingOne' : 'stocktake.applyPending',
              { n: totals.pending })
          : '',
      ].filter(Boolean).join(' '),
      confirmLabel: t('stocktake.apply'),
    });
    if (!ok) return;

    setApplying(true);
    try {
      const res = await productApi.stocktake(payload);
      // Refetch rather than patching rows locally: a count can touch hundreds of
      // products, and the server is the one that decided which of them moved.
      await loadAll({ silent: true });
      reset();
      setResult(res.summary ?? null);
      toast.success(t('stocktake.applied', { corrected: res.summary?.corrected ?? 0 }));
    } catch (err) {
      toast.error(err.message || t('errors.generic'));
    } finally {
      setApplying(false);
    }
  }, [products, counts, note, totals.pending, loadAll, reset, t]);

  const discard = useCallback(async () => {
    const ok = await confirm({
      title: t('stocktake.discardTitle'),
      message: t('stocktake.discardMessage', { counted: totals.counted }),
      confirmLabel: t('stocktake.discard'),
      destructive: true,
    });
    if (ok) { reset(); setResult(null); }
  }, [reset, totals.counted, t]);

  /* ------------------------------ one row ------------------------------ */
  const renderRow = useCallback(({ item }) => {
    const raw = counts[String(item._id)] ?? '';
    const state = rowState(item, raw);

    const tone =
      state.status === 'match' ? 'border-emerald-300 bg-emerald-50'
        : state.status === 'short' ? 'border-red-300 bg-red-50'
          : state.status === 'over' ? 'border-amber-300 bg-amber-50'
            : 'border-slate-200 bg-white';

    return (
      <View className={`mx-4 mb-2 flex-row items-center rounded-2xl border p-3 ${tone}`}>
        <View className="flex-1 pr-3">
          <Text className="text-sm font-semibold text-slate-900" numberOfLines={1}>{item.name}</Text>
          <Text className="mt-0.5 text-xs text-slate-500">
            {item.category ? `${item.category} · ` : ''}
            {t('stocktake.recorded', { stock: formatQty(state.recorded, item.unit) })}
          </Text>
          {state.status !== 'pending' && state.variance !== 0 ? (
            <Text className={`mt-1 text-xs font-semibold ${state.variance < 0 ? 'text-red-600' : 'text-amber-600'}`}>
              {state.variance > 0 ? '+' : ''}{formatQty(state.variance, item.unit)} · {formatINR(state.value)}
            </Text>
          ) : null}
        </View>

        {/* A bare TextInput rather than the shared TextField: this one sits
            inline in a dense list, needs no label of its own, and must stay the
            same height whether or not a variance line has appeared beneath the
            name. */}
        <TextInput
          value={raw}
          onChangeText={(text) => setCount(item._id, sanitiseQty(text, item.unit))}
          keyboardType={allowsFraction(item.unit) ? 'decimal-pad' : 'number-pad'}
          placeholder="—"
          placeholderTextColor="#94A3B8"
          maxLength={9}
          selectTextOnFocus
          accessibilityLabel={t('stocktake.countedFor', { name: item.name })}
          className="h-11 w-20 rounded-xl border border-slate-300 bg-white px-2 text-center text-base font-semibold text-slate-900"
        />

        {raw !== '' ? (
          <Pressable
            onPress={() => setCount(item._id, '')}
            hitSlop={8}
            className="ml-1 p-1.5"
            accessibilityRole="button"
            accessibilityLabel={t('common.clear')}
          >
            <Ionicons name="close-circle" size={18} color="#94A3B8" />
          </Pressable>
        ) : (
          /* Keeps the row the same width whether or not the clear button is
             there, so the inputs stay in a straight column down the list. */
          <View className="ml-1 h-7 w-7" />
        )}
      </View>
    );
  }, [counts, setCount, t]);

  /* ------------------------------ the result ------------------------------ */
  if (result) {
    return (
      <Screen
        title={t('stocktake.title')}
        onBack={() => navigation.goBack()}
        showSettings={false}
        showLogout={false}
        includeBottomInset
      >
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <View className="items-center rounded-2xl border border-emerald-200 bg-emerald-50 p-6">
            <Ionicons name="checkmark-circle" size={44} color="#059669" />
            <Text className="mt-3 text-lg font-bold text-slate-900">{t('stocktake.doneTitle')}</Text>
            <Text className="mt-1 text-center text-sm text-slate-600">
              {t('stocktake.doneMessage', {
                corrected: result.corrected ?? 0,
                unchanged: result.unchanged ?? 0,
              })}
            </Text>
          </View>

          <View className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
            <ResultLine label={t('stocktake.unitsLost')} value={String(result.unitsLost ?? 0)} tone="negative" />
            <ResultLine label={t('stocktake.unitsGained')} value={String(result.unitsGained ?? 0)} />
            <ResultLine
              label={t('stocktake.valueImpact')}
              value={formatINR(result.varianceValue ?? 0)}
              tone={(result.varianceValue ?? 0) < 0 ? 'negative' : 'default'}
              last
            />
          </View>

          <Text className="mt-3 px-2 text-xs text-slate-500">{t('stocktake.doneHint')}</Text>

          <Button
            className="mt-5"
            title={t('stocktake.doneCta')}
            onPress={() => { setResult(null); navigation.goBack(); }}
            fullWidth
          />
        </ScrollView>
      </Screen>
    );
  }

  /* ------------------------------ the count ------------------------------ */
  return (
    <Screen
      title={t('stocktake.title')}
      subtitle={t('stocktake.progress', { counted: totals.counted, total: totals.total })}
      onBack={() => navigation.goBack()}
      showSettings={false}
      showLogout={false}
      includeBottomInset
    >
      {/* Search + category, the same affordances as Stock and Sell */}
      <View className="px-4 pt-3">
        <View className="flex-row items-center rounded-xl border border-slate-300 bg-white px-3">
          <Ionicons name="search" size={16} color="#94A3B8" />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={t('common.search')}
            placeholderTextColor="#94A3B8"
            className="ml-2 h-10 flex-1 text-sm text-slate-900"
          />
          {search ? (
            <Pressable onPress={() => setSearch('')} hitSlop={8} accessibilityLabel={t('common.clear')}>
              <Ionicons name="close-circle" size={16} color="#94A3B8" />
            </Pressable>
          ) : null}
        </View>
      </View>

      <View className="py-2">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
          {categoryPills.map((c) => {
            const active = activeCategory === String(c._id);
            return (
              <Pressable
                key={String(c._id)}
                onPress={() => setActiveCategory(String(c._id))}
                accessibilityRole="button"
                aria-selected={active}
                accessibilityState={{ selected: active }}
                className={`rounded-full border px-3 py-1.5 ${active ? 'border-blue-600 bg-blue-600' : 'border-slate-300 bg-white'}`}
              >
                <Text className={`text-xs font-semibold ${active ? 'text-white' : 'text-slate-600'}`}>{c.name}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* The one filter that matters during a count: what is still outstanding.
          Without it, finishing a large count means scrolling the whole list
          hunting for the rows you skipped. */}
      <View className="flex-row items-center justify-between px-4 pb-2">
        <Pressable
          onPress={() => setPendingOnly((v) => !v)}
          accessibilityRole="button"
          /* Spelled out rather than left to the contents: the icon beside the
             text is a glyph, and a screen reader would read it aloud as part of
             the name. */
          accessibilityLabel={t('stocktake.notCountedYet', { n: totals.pending })}
          aria-pressed={pendingOnly}
          accessibilityState={{ selected: pendingOnly }}
          className={`flex-row items-center rounded-full border px-3 py-1.5 ${pendingOnly ? 'border-blue-600 bg-blue-50' : 'border-slate-300 bg-white'}`}
        >
          <Ionicons
            name={pendingOnly ? 'checkbox' : 'square-outline'}
            size={15}
            color={pendingOnly ? '#2563EB' : '#64748B'}
          />
          <Text className={`ml-1.5 text-xs font-semibold ${pendingOnly ? 'text-blue-700' : 'text-slate-600'}`}>
            {t('stocktake.notCountedYet', { n: totals.pending })}
          </Text>
        </Pressable>

        {totals.counted > 0 ? (
          <Pressable
            onPress={discard}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={t('stocktake.discard')}
          >
            <Text className="text-xs font-semibold text-red-600">{t('stocktake.discard')}</Text>
          </Pressable>
        ) : null}
      </View>

      <FlatList
        data={visible}
        keyExtractor={(p) => String(p._id)}
        renderItem={renderRow}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 8, paddingTop: 2 }}
        ListEmptyComponent={
          products.length === 0 ? (
            <EmptyState icon="cube-outline" title={t('inventory.noProducts')} hint={t('stocktake.addFirst')} />
          ) : (
            <EmptyState
              icon={pendingOnly ? 'checkmark-done-outline' : 'search-outline'}
              title={pendingOnly ? t('stocktake.allCounted') : t('inventory.noProducts')}
              hint={pendingOnly ? t('stocktake.allCountedHint') : t('common.search')}
            />
          )
        }
      />

      {/* The running total, pinned. The number a shopkeeper is waiting for is
          the money one, so it gets the large type. */}
      <View className="border-t border-slate-200 bg-white px-4 pb-3 pt-3">
        <View className="mb-2 flex-row items-end justify-between">
          <View className="flex-1 pr-3">
            <Text className="text-xs text-slate-500">
              {t('stocktake.summary', {
                counted: totals.counted,
                total: totals.total,
                differences: totals.differences,
              })}
            </Text>
            <Text
              className={`mt-0.5 text-xl font-bold ${totals.varianceValue < 0 ? 'text-red-600' : totals.varianceValue > 0 ? 'text-amber-600' : 'text-slate-900'}`}
            >
              {formatINR(totals.varianceValue)}
            </Text>
            <Text className="text-[11px] text-slate-400">{t('stocktake.atCost')}</Text>
          </View>

          <Button
            title={t('stocktake.apply')}
            onPress={apply}
            loading={applying}
            disabled={totals.counted === 0}
            icon="checkmark-done"
          />
        </View>

        {totals.pending > 0 && totals.counted > 0 ? (
          <Text className="text-[11px] text-slate-500">
            {t(totals.pending === 1 ? 'stocktake.pendingWarningOne' : 'stocktake.pendingWarning',
              { n: totals.pending })}
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}

function ResultLine({ label, value, tone = 'default', last = false }) {
  const colour = tone === 'negative' ? 'text-red-600' : 'text-slate-900';
  return (
    <View className={`flex-row items-center justify-between py-2 ${last ? '' : 'border-b border-slate-100'}`}>
      <Text className="text-sm text-slate-600">{label}</Text>
      <Text className={`text-sm font-bold ${colour}`}>{value}</Text>
    </View>
  );
}
