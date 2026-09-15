import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import Screen from '../components/Screen';
import Button from '../components/Button';
import TextField from '../components/TextField';
import EmptyState from '../components/EmptyState';
import FormModal from '../components/FormModal';
import Loading, { ErrorBanner } from '../components/Loading';
import { customerApi } from '../api/endpoints';
import { useCustomerStore } from '../store/customerStore';
import { confirm } from '../store/confirmStore';
import { toast } from '../store/uiStore';
import { formatINR, formatDate } from '../utils/money';
import { PAYMENT_METHODS } from '../utils/payments';

/**
 * One customer's khata.
 *
 * Sales and repayments in a single list, newest first, the way the paper book
 * they replace reads. Two separate lists would make the only question anybody
 * has here -- "how did this number get to 400?" -- something the reader has to
 * do arithmetic to answer.
 *
 * The balance at the top is the server's, recomputed on every load. It is never
 * adjusted locally after recording a payment: the point of deriving it is that
 * there is exactly one place the number comes from, and a screen that did its
 * own subtraction would be a second place that could disagree.
 */
export default function CustomerLedgerScreen({ route, navigation }) {
  const { t } = useTranslation();
  const { id, name } = route.params ?? {};

  const reloadList = useCustomerStore((s) => s.load);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const [payOpen, setPayOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async ({ silent = false } = {}) => {
    silent ? setRefreshing(true) : setLoading(true);
    try {
      const res = await customerApi.get(id);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const customer = data?.customer;
  const balance = customer?.balance ?? 0;
  const owes = balance > 0;

  const openPayment = () => {
    // Pre-filled with what is owed, because settling in full is the common case
    // and typing the figure again is a chance to get it wrong. Editable, since
    // part payments are the whole reason this exists.
    setAmount(owes ? String(balance) : '');
    setMethod('cash');
    setNote('');
    setFormError({});
    setPayOpen(true);
  };

  const submitPayment = async () => {
    const value = Number(amount);
    if (!amount || !Number.isFinite(value) || value <= 0) {
      return setFormError({ amount: t('customers.amountRequired') });
    }
    setSaving(true);
    try {
      await customerApi.recordPayment(id, { amount: value, method, note: note.trim() });
      setPayOpen(false);
      await load({ silent: true });
      // The list behind this screen holds a balance that has just changed.
      reloadList({ silent: true });
      toast.success(t('customers.paymentRecorded', { amount: formatINR(value) }));
    } catch (err) {
      toast.error(err.message ?? t('errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  const undoPayment = async (entry) => {
    const ok = await confirm({
      title: t('customers.undoPaymentTitle'),
      message: t('customers.undoPaymentMessage', { amount: formatINR(entry.amount) }),
      confirmLabel: t('customers.undoPayment'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await customerApi.removePayment(entry.paymentId);
      await load({ silent: true });
      reloadList({ silent: true });
      toast.success(t('customers.paymentUndone'));
    } catch (err) {
      toast.error(err.message ?? t('errors.generic'));
    }
  };

  const renderEntry = useCallback(({ item }) => {
    if (item.type === 'payment') {
      return (
        <View className="mx-4 mb-2 flex-row items-center rounded-2xl border border-emerald-200 bg-emerald-50 p-3">
          <Ionicons name="arrow-down-circle" size={20} color="#059669" />
          <View className="ml-2.5 flex-1">
            <Text className="text-sm font-bold text-emerald-800">
              {t('customers.paidBack', { amount: formatINR(item.amount) })}
            </Text>
            <Text className="mt-0.5 text-xs text-slate-500">
              {formatDate(item.at, { withTime: true })} · {t(`pos.pay_${item.method}`)}
              {item.note ? ` · ${item.note}` : ''}
            </Text>
          </View>
          <Pressable
            onPress={() => undoPayment(item)}
            hitSlop={8}
            className="p-1.5"
            accessibilityRole="button"
            accessibilityLabel={`${t('customers.undoPayment')} ${formatINR(item.amount)}`}
          >
            <Ionicons name="close-circle-outline" size={18} color="#64748B" />
          </Pressable>
        </View>
      );
    }

    const onCredit = item.credited > 0;
    return (
      <View className={`mx-4 mb-2 rounded-2xl border p-3 ${onCredit ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
        <View className="flex-row items-center">
          <Ionicons name="receipt-outline" size={18} color={onCredit ? '#D97706' : '#64748B'} />
          <Text className="ml-2 flex-1 text-sm font-bold text-slate-900">{item.receiptNo}</Text>
          <Text className="text-sm font-bold text-slate-900">{formatINR(item.total)}</Text>
        </View>
        <Text className="mt-1 text-xs text-slate-500">
          {formatDate(item.at, { withTime: true })} · {t('customers.itemCount', { count: item.items })}
        </Text>
        {onCredit ? (
          <Text className="mt-1 text-xs font-semibold text-amber-700">
            {t('customers.paidOf', { paid: formatINR(item.paid), total: formatINR(item.total) })}
            {' · '}
            {t('customers.addedToDebt', { amount: formatINR(item.credited) })}
          </Text>
        ) : null}
      </View>
    );
  }, [t]);

  return (
    <Screen
      title={customer?.name ?? name ?? t('customers.title')}
      onBack={() => navigation.goBack()}
      showSettings={false}
      showLogout={false}
      includeBottomInset
    >
      <ErrorBanner message={error} onRetry={load} retryLabel={t('common.retry')} />

      {loading && !data ? <Loading /> : (
        <FlatList
          data={data?.timeline ?? []}
          keyExtractor={(e, i) => `${e.type}-${e.orderId ?? e.paymentId ?? i}`}
          renderItem={renderEntry}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load({ silent: true })} />}
          contentContainerStyle={{ paddingBottom: 24 }}
          ListHeaderComponent={
            <View className="px-4 pb-2 pt-3">
              <View className={`rounded-2xl border p-4 ${owes ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}>
                <Text className="text-xs font-medium text-slate-500">
                  {owes ? t('customers.stillOwes') : balance < 0 ? t('customers.inCredit') : t('customers.settled')}
                </Text>
                <Text className={`mt-1 text-3xl font-bold ${owes ? 'text-amber-700' : balance < 0 ? 'text-emerald-700' : 'text-slate-900'}`}>
                  {formatINR(Math.abs(balance))}
                </Text>
                {customer?.phone ? (
                  <Text className="mt-1 text-xs text-slate-500">{customer.phone}</Text>
                ) : null}
                {customer?.note ? (
                  <Text className="mt-1 text-xs text-slate-500">{customer.note}</Text>
                ) : null}

                <View className="mt-3 flex-row gap-3">
                  <Metric label={t('customers.totalBilled')} value={formatINR(customer?.billed ?? 0)} />
                  <Metric label={t('customers.totalRepaid')} value={formatINR(customer?.repaid ?? 0)} />
                  <Metric label={t('customers.sales')} value={String(customer?.orders ?? 0)} />
                </View>
              </View>

              <Button
                className="mt-3"
                title={t('customers.recordPayment')}
                onPress={openPayment}
                icon="cash-outline"
                variant={owes ? 'success' : 'secondary'}
                fullWidth
              />
            </View>
          }
          ListEmptyComponent={
            <EmptyState icon="receipt-outline" title={t('customers.noLedger')} hint={t('customers.noLedgerHint')} />
          }
        />
      )}

      <FormModal
        visible={payOpen}
        title={t('customers.recordPayment')}
        onClose={() => setPayOpen(false)}
        onSubmit={submitPayment}
        submitLabel={t('customers.recordPayment')}
        submitting={saving}
      >
        <TextField
          label={t('customers.amountReceived')}
          value={amount}
          onChangeText={setAmount}
          mode="money"
          prefix="₹"
          placeholder="0"
          error={formError.amount}
          hint={owes ? t('customers.owesNow', { amount: formatINR(balance) }) : undefined}
        />

        <Text className="mb-1.5 text-sm font-medium text-slate-700">{t('pos.paidBy')}</Text>
        <View className="mb-3 flex-row gap-2" accessibilityRole="radiogroup">
          {PAYMENT_METHODS.map((m) => {
            const active = method === m;
            return (
              <Pressable
                key={m}
                onPress={() => setMethod(m)}
                accessibilityRole="radio"
                accessibilityLabel={t(`pos.pay_${m}`)}
                aria-checked={active}
                accessibilityState={{ checked: active }}
                className={`flex-1 items-center rounded-xl border py-2.5 ${active ? 'border-blue-600 bg-blue-50' : 'border-slate-300 bg-white'}`}
              >
                <Text className={`text-xs font-bold ${active ? 'text-blue-700' : 'text-slate-600'}`}>
                  {t(`pos.pay_${m}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <TextField
          label={t('customers.note')}
          value={note}
          onChangeText={setNote}
          placeholder={t('customers.paymentNotePlaceholder')}
          hint={t('common.optional')}
        />
      </FormModal>
    </Screen>
  );
}

function Metric({ label, value }) {
  return (
    <View className="flex-1">
      <Text className="text-[11px] text-slate-500" numberOfLines={1}>{label}</Text>
      <Text className="mt-0.5 text-sm font-bold text-slate-900" numberOfLines={1}>{value}</Text>
    </View>
  );
}
