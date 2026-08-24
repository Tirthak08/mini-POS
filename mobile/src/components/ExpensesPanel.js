import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';

import Button from './Button';
import TextField from './TextField';
import DateField from './DateField';
import FormModal from './FormModal';
import EmptyState from './EmptyState';
import Loading, { ErrorBanner } from './Loading';
import { StatTile } from './Card';
import { expenseApi } from '../api/endpoints';
import { toast } from '../store/uiStore';
import { confirm } from '../store/confirmStore';
import { formatINR, formatDate, toApiDate } from '../utils/money';
import { startOfDay } from '../utils/dateRange';

const emptyForm = () => ({ amount: '', note: '', spentAt: startOfDay(new Date()) });

/**
 * Money out that is not stock: rent, wages, electricity, a repair.
 *
 * It lives inside the Sales tab rather than as a fifth tab because it is the
 * other half of the same question. A shopkeeper checking the day's takings is
 * exactly the person who remembers they paid the electricity bill this morning,
 * and a segmented control keeps both under one period filter -- so "this month"
 * can never mean two different months on two different screens.
 *
 * There are no categories. Presets would make a tidier report, but they are one
 * more decision at the moment of entry, and for a shop this size a free-text
 * note carries the same information. Notes can be grouped later without a
 * migration; a category list, once shipped, cannot be taken back.
 */
export default function ExpensesPanel({ range }) {
  const { t } = useTranslation();

  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({ total: 0, count: 0, truncated: false });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const [editing, setEditing] = useState(null); // null | { _id? } while the form is open
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async ({ silent = false } = {}) => {
    silent ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const res = await expenseApi.list({ ...range.apiRange, limit: 200 });
      setRows(res.expenses ?? []);
      // The total comes from the server's aggregate over the WHOLE range, not
      // from summing this page -- a busy month can exceed the page limit, and a
      // total that quietly excluded the overflow would understate spending.
      setSummary({ total: res.total ?? 0, count: res.count ?? 0, truncated: Boolean(res.truncated) });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load({ silent: true }); }, [load]));

  /* ------------------------------- the form ------------------------------ */

  const openAdd = () => {
    setForm(emptyForm());
    setFormError(null);
    setEditing({});
  };

  const openEdit = (row) => {
    setForm({
      amount: String(row.amount),
      note: row.note,
      spentAt: startOfDay(new Date(row.spentAt)),
    });
    setFormError(null);
    setEditing(row);
  };

  const submit = async () => {
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setFormError(t('expenses.amountRequired'));
      return;
    }
    const note = form.note.trim();
    if (!note) {
      setFormError(t('expenses.noteRequired'));
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      // A plain YYYY-MM-DD, not an ISO instant: the server pins that shape to
      // midday so a date typed in IST stays on the day the shopkeeper meant,
      // instead of sliding back one when read as UTC midnight.
      const payload = { amount, note, spentAt: toApiDate(form.spentAt) };
      if (editing?._id) await expenseApi.update(editing._id, payload);
      else await expenseApi.create(payload);

      toast.success(t('expenses.saved'));
      setEditing(null);
      await load({ silent: true });
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row) => {
    const ok = await confirm({
      title: t('expenses.deleteConfirm'),
      message: t('expenses.deleteWarning'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await expenseApi.remove(row._id);
      toast.success(t('expenses.removed'));
      setEditing(null);
      await load({ silent: true });
    } catch (err) {
      toast.error(err.message);
    }
  };

  /* ------------------------------- rendering ----------------------------- */

  const renderRow = useCallback(({ item }) => (
    <View className="mx-4 mb-2 flex-row items-center rounded-2xl border border-slate-200 bg-white p-3">
      <Pressable
        onPress={() => openEdit(item)}
        accessibilityRole="button"
        accessibilityLabel={`${item.note}, ${formatINR(item.amount)}`}
        className="flex-1 flex-row items-center active:opacity-70"
      >
        <View className="mr-3 h-10 w-10 items-center justify-center rounded-xl bg-amber-50">
          <Ionicons name="cash-outline" size={19} color="#B45309" />
        </View>
        <View className="flex-1 pr-2">
          <Text className="text-sm font-semibold text-slate-900" numberOfLines={2}>{item.note}</Text>
          <Text className="mt-0.5 text-xs text-slate-400">{formatDate(item.spentAt)}</Text>
        </View>
        <Text className="text-base font-bold text-slate-900">− {formatINR(item.amount)}</Text>
      </Pressable>

      <Pressable
        onPress={() => remove(item)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`${t('common.delete')} ${item.note}`}
        className="ml-2 p-1"
      >
        <Ionicons name="trash-outline" size={18} color="#94A3B8" />
      </Pressable>
    </View>
  ), [t]);

  return (
    <View className="flex-1">
      {/* Fixed, not inside the list: the whole point of this screen is adding an
          expense, and a button that scrolls away is one the operator has to hunt
          for after reading three months of entries. */}
      <View className="px-4 pb-2">
        <Button title={t('expenses.add')} icon="add" onPress={openAdd} fullWidth />
      </View>

      <ErrorBanner message={error} onRetry={load} retryLabel={t('common.retry')} />

      {loading ? (
        <Loading label={t('common.loading')} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => String(item._id)}
          renderItem={renderRow}
          refreshing={refreshing}
          onRefresh={() => load({ silent: true })}
          contentContainerStyle={{ paddingBottom: 40 }}
          ListHeaderComponent={
            rows.length ? (
              <View className="mb-3 px-4">
                <View className="flex-row gap-2">
                  <StatTile
                    className="flex-1"
                    label={t('expenses.total')}
                    value={formatINR(summary.total)}
                    tone="negative"
                  />
                  <StatTile className="flex-1" label={t('expenses.count')} value={String(summary.count)} />
                </View>
                {summary.truncated ? (
                  <Text className="mt-2 text-xs text-slate-400">
                    {t('expenses.truncated', { shown: rows.length, total: summary.count })}
                  </Text>
                ) : null}
                <Text className="mt-2 text-xs text-slate-400">{t('expenses.whyHint')}</Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState icon="cash-outline" title={t('expenses.none')} hint={t('expenses.noneHint')} />
          }
        />
      )}

      <FormModal
        visible={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?._id ? t('expenses.edit') : t('expenses.add')}
        submitLabel={t('common.save')}
        cancelLabel={t('common.cancel')}
        onSubmit={submit}
        submitting={saving}
      >
        <TextField
          label={t('expenses.amount')}
          value={form.amount}
          onChangeText={(amount) => { setForm((f) => ({ ...f, amount })); setFormError(null); }}
          mode="money"
          prefix="₹"
          placeholder="0"
          autoFocus
        />
        <TextField
          label={t('expenses.note')}
          value={form.note}
          onChangeText={(note) => { setForm((f) => ({ ...f, note })); setFormError(null); }}
          placeholder={t('expenses.notePlaceholder')}
          maxLength={140}
        />
        <DateField
          label={t('expenses.date')}
          value={form.spentAt}
          onChange={(spentAt) => setForm((f) => ({ ...f, spentAt }))}
          hint={t('expenses.dateHint')}
        />

        {formError ? <Text className="mb-2 text-sm text-red-600">{formError}</Text> : null}

        {editing?._id ? (
          <Pressable
            onPress={() => remove(editing)}
            accessibilityRole="button"
            className="mb-1 flex-row items-center justify-center py-2"
          >
            <Ionicons name="trash-outline" size={16} color="#DC2626" />
            <Text className="ml-1.5 text-sm font-semibold text-red-600">{t('common.delete')}</Text>
          </Pressable>
        ) : null}
      </FormModal>
    </View>
  );
}
