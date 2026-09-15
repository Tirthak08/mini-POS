import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';

import Screen from '../components/Screen';
import Button from '../components/Button';
import TextField from '../components/TextField';
import EmptyState from '../components/EmptyState';
import FormModal from '../components/FormModal';
import Loading, { ErrorBanner } from '../components/Loading';
import { StatTile } from '../components/Card';
import { useCustomerStore } from '../store/customerStore';
import { useScrollTopOnFocus } from '../hooks/useScrollTopOnFocus';
import { confirm } from '../store/confirmStore';
import { toast } from '../store/uiStore';
import { formatINR, formatDate } from '../utils/money';

const EMPTY_FORM = { name: '', phone: '', note: '' };

/**
 * Who owes the shop money.
 *
 * The screen is built around one question a shopkeeper asks every day -- "who
 * still has to pay me?" -- so the total on the street is the first thing on it
 * and the list defaults to the people who owe. Everybody else is one tap away
 * behind "Show all", because a list of settled customers is a directory, and a
 * directory is not what anyone opens this for.
 *
 * Every balance here is computed by the server from receipts and repayments.
 * Nothing is cached to disk (see customerStore): a stale debt shown to somebody
 * standing at the counter is worse than no number at all.
 */
export default function CustomersScreen({ navigation }) {
  const { t } = useTranslation();

  const customers = useCustomerStore((s) => s.customers);
  const totals = useCustomerStore((s) => s.totals);
  const loading = useCustomerStore((s) => s.loading);
  const refreshing = useCustomerStore((s) => s.refreshing);
  const error = useCustomerStore((s) => s.error);
  const load = useCustomerStore((s) => s.load);
  const create = useCustomerStore((s) => s.create);
  const update = useCustomerStore((s) => s.update);
  const remove = useCustomerStore((s) => s.remove);

  const [search, setSearch] = useState('');
  const [owingOnly, setOwingOnly] = useState(true);
  const [modal, setModal] = useState(null); // null | {} | customer
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState({});
  const [saving, setSaving] = useState(false);

  const listRef = useScrollTopOnFocus();

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => {
    if (useCustomerStore.getState().loadedAt) load({ silent: true });
  }, [load]));

  const visible = customers.filter((c) => {
    if (owingOnly && c.balance <= 0) return false;
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return c.name.toLowerCase().includes(term) || (c.phone ?? '').toLowerCase().includes(term);
  }).sort((a, b) => (b.balance - a.balance) || a.name.localeCompare(b.name));

  const open = (customer) => {
    setForm(customer
      ? { name: customer.name, phone: customer.phone ?? '', note: customer.note ?? '' }
      : EMPTY_FORM);
    setFormError({});
    setModal(customer ?? {});
  };

  const submit = async () => {
    if (!form.name.trim()) return setFormError({ name: t('errors.required') });
    setSaving(true);
    const res = modal?._id
      ? await update(modal._id, { name: form.name.trim(), phone: form.phone.trim(), note: form.note.trim() })
      : await create({ name: form.name.trim(), phone: form.phone.trim(), note: form.note.trim() });
    setSaving(false);
    if (res.ok) { setModal(null); toast.success(t('common.save')); }
    else if (res.error?.status === 409) setFormError({ name: res.error.message });
    else toast.error(res.error?.message ?? t('errors.generic'));
  };

  /**
   * Deleting somebody who owes money is refused by the server, and the retry
   * offered here spells out what it means rather than repeating the word
   * "force": what is being asked is whether to write the debt off.
   */
  const askDelete = async (customer) => {
    const ok = await confirm({
      title: t('customers.deleteTitle', { name: customer.name }),
      message: customer.balance > 0
        ? t('customers.deleteOwing', { amount: formatINR(customer.balance) })
        : t('customers.deleteMessage'),
      confirmLabel: customer.balance > 0 ? t('customers.writeOff') : t('common.delete'),
      destructive: true,
    });
    if (!ok) return;

    const res = await remove(customer._id, { force: customer.balance > 0 });
    toast[res.ok ? 'success' : 'error'](res.ok ? t('common.delete') : res.error.message);
  };

  const renderRow = useCallback(({ item }) => {
    const owes = item.balance > 0;
    const inCredit = item.balance < 0;
    return (
      <Pressable
        onPress={() => navigation.navigate('CustomerLedger', { id: item._id, name: item.name })}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}, ${owes ? t('customers.owes', { amount: formatINR(item.balance) }) : t('customers.settled')}`}
        className={`mx-4 mb-2 rounded-2xl border p-3 active:bg-slate-50 ${owes ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}
      >
        <View className="flex-row items-center">
          <View className="flex-1 pr-3">
            <Text className="text-base font-bold text-slate-900" numberOfLines={1}>{item.name}</Text>
            <Text className="mt-0.5 text-xs text-slate-500" numberOfLines={1}>
              {item.phone ? `${item.phone} · ` : ''}
              {item.lastOrderAt ? t('customers.lastSale', { when: formatDate(item.lastOrderAt) }) : t('customers.noSales')}
            </Text>
          </View>

          <View className="items-end">
            <Text className={`text-base font-bold ${owes ? 'text-amber-700' : inCredit ? 'text-emerald-700' : 'text-slate-400'}`}>
              {owes ? formatINR(item.balance) : inCredit ? formatINR(-item.balance) : formatINR(0)}
            </Text>
            <Text className="text-[11px] text-slate-400">
              {owes ? t('customers.owesShort') : inCredit ? t('customers.inCreditShort') : t('customers.settled')}
            </Text>
          </View>

          <Pressable
            onPress={() => open(item)}
            hitSlop={8}
            className="ml-2 p-1.5"
            accessibilityRole="button"
            accessibilityLabel={`${t('common.edit')} ${item.name}`}
          >
            <Ionicons name="pencil" size={17} color="#2563EB" />
          </Pressable>
          <Pressable
            onPress={() => askDelete(item)}
            hitSlop={8}
            className="p-1.5"
            accessibilityRole="button"
            accessibilityLabel={`${t('common.delete')} ${item.name}`}
          >
            <Ionicons name="trash" size={17} color="#DC2626" />
          </Pressable>
        </View>
      </Pressable>
    );
  }, [navigation, t]);

  return (
    <Screen title={t('customers.title')}>
      <ErrorBanner message={error} onRetry={load} retryLabel={t('common.retry')} />

      {loading && !customers.length ? <Loading /> : (
        <FlatList
          ref={listRef}
          data={visible}
          keyExtractor={(c) => String(c._id)}
          renderItem={renderRow}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load({ silent: true })} />}
          contentContainerStyle={{ paddingBottom: 24 }}
          ListHeaderComponent={
            <View className="px-4 pb-1 pt-3">
              {/* The answer to the question the screen exists for, before any
                  list: how much of the shop's money is out on the street. */}
              <View className="mb-3 flex-row gap-2">
                <StatTile
                  className="flex-1"
                  label={t('customers.onTheStreet')}
                  value={formatINR(totals.owed)}
                  sub={t('customers.peopleOwing', { count: totals.owing })}
                  tone={totals.owed > 0 ? 'negative' : 'default'}
                />
                {totals.inCredit > 0 ? (
                  <StatTile
                    className="flex-1"
                    label={t('customers.inCredit')}
                    value={formatINR(totals.inCredit)}
                    sub={t('customers.inCreditHint')}
                  />
                ) : null}
              </View>

              <View className="mb-2 flex-row items-center rounded-xl border border-slate-300 bg-white px-3">
                <Ionicons name="search" size={16} color="#94A3B8" />
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  placeholder={t('customers.searchHint')}
                  placeholderTextColor="#94A3B8"
                  className="ml-2 h-10 flex-1 text-sm text-slate-900"
                />
                {search ? (
                  <Pressable onPress={() => setSearch('')} hitSlop={8} accessibilityLabel={t('common.clear')}>
                    <Ionicons name="close-circle" size={16} color="#94A3B8" />
                  </Pressable>
                ) : null}
              </View>

              <View className="mb-1 flex-row items-center justify-between">
                <Pressable
                  onPress={() => setOwingOnly((v) => !v)}
                  accessibilityRole="button"
                  aria-checked={owingOnly}
                  accessibilityState={{ checked: owingOnly }}
                  accessibilityLabel={owingOnly ? t('customers.showAll') : t('customers.showOwingOnly')}
                  className={`flex-row items-center rounded-full border px-3 py-1.5 ${owingOnly ? 'border-blue-600 bg-blue-50' : 'border-slate-300 bg-white'}`}
                >
                  <Ionicons name={owingOnly ? 'checkbox' : 'square-outline'} size={15} color={owingOnly ? '#2563EB' : '#64748B'} />
                  <Text className={`ml-1.5 text-xs font-semibold ${owingOnly ? 'text-blue-700' : 'text-slate-600'}`}>
                    {t('customers.owingOnly')}
                  </Text>
                </Pressable>

                <Button title={t('customers.add')} onPress={() => open(null)} size="sm" icon="person-add" />
              </View>
            </View>
          }
          ListEmptyComponent={
            customers.length === 0 ? (
              <EmptyState
                icon="people-outline"
                title={t('customers.none')}
                hint={t('customers.noneHint')}
                actionLabel={t('customers.add')}
                onAction={() => open(null)}
              />
            ) : (
              <EmptyState
                icon="checkmark-done-outline"
                title={owingOnly ? t('customers.nobodyOwes') : t('customers.noMatch')}
                hint={owingOnly ? t('customers.nobodyOwesHint') : t('common.search')}
              />
            )
          }
        />
      )}

      <FormModal
        visible={Boolean(modal)}
        title={modal?._id ? t('customers.edit') : t('customers.add')}
        onClose={() => setModal(null)}
        onSubmit={submit}
        submitLabel={t('common.save')}
        submitting={saving}
      >
        <TextField
          label={t('customers.name')}
          value={form.name}
          onChangeText={(name) => setForm((f) => ({ ...f, name }))}
          placeholder="Ramesh Bhai"
          error={formError.name}
        />
        <TextField
          label={t('customers.phone')}
          value={form.phone}
          onChangeText={(phone) => setForm((f) => ({ ...f, phone }))}
          placeholder="+91 98765 43210"
          hint={t('common.optional')}
        />
        <TextField
          label={t('customers.note')}
          value={form.note}
          onChangeText={(note) => setForm((f) => ({ ...f, note }))}
          placeholder={t('customers.notePlaceholder')}
          hint={t('common.optional')}
        />
      </FormModal>
    </Screen>
  );
}
