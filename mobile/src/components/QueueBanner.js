import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { useQueueStore, selectPending, selectFailed, selectQueuedValue } from '../store/queueStore';
import { useInventoryStore } from '../store/inventoryStore';
import { confirm } from '../store/confirmStore';
import { toast } from '../store/uiStore';
import { formatINR, formatDate } from '../utils/money';

/**
 * What the shop is owed by its own phone.
 *
 * A sale saved offline is real money that the records do not yet know about, so
 * it cannot be silent. It also cannot be alarming: "saved, will sync" is the
 * normal, expected outcome of selling in a shop with patchy data, and an angry
 * red banner for it would teach the operator to ignore red banners.
 *
 * So there are two states, and they look different on purpose. Waiting is
 * amber and passive. REFUSED is red and asks for a decision -- those sales will
 * never go through on their own, and the only thing worse than telling the
 * shopkeeper is not telling them.
 */
export default function QueueBanner({ className = '' }) {
  const { t } = useTranslation();
  const entries = useQueueStore((s) => s.entries);
  const syncing = useQueueStore((s) => s.syncing);
  const sync = useQueueStore((s) => s.sync);
  const retry = useQueueStore((s) => s.retry);
  const remove = useQueueStore((s) => s.remove);
  const loadAll = useInventoryStore((s) => s.loadAll);

  const pending = useQueueStore(selectPending);
  const failed = useQueueStore(selectFailed);
  const value = useQueueStore(selectQueuedValue);
  const [open, setOpen] = useState(false);

  if (!entries.length) return null;

  const runSync = async () => {
    const res = await sync();
    if (res?.synced) {
      // The server has just moved stock the phone already guessed at; the only
      // honest thing on screen now is what the server says.
      await loadAll({ silent: true });
      toast.success(t('queue.synced', { count: res.synced }));
    } else if (res?.remaining) {
      toast.error(t('queue.stillOffline'));
    }
  };

  const discard = async (entry) => {
    const ok = await confirm({
      title: t('queue.discardTitle'),
      message: t('queue.discardMessage', { amount: formatINR(entry.total) }),
      confirmLabel: t('queue.discard'),
      destructive: true,
    });
    if (ok) {
      remove(entry.id);
      await loadAll({ silent: true });
    }
  };

  const tone = failed > 0
    ? 'border-red-300 bg-red-50'
    : 'border-amber-300 bg-amber-50';

  return (
    <View className={`mx-4 mb-2 rounded-2xl border p-3 ${tone} ${className}`}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={failed > 0 ? t('queue.failedTitle', { count: failed }) : t('queue.pendingTitle', { count: pending })}
        className="flex-row items-center"
      >
        <Ionicons
          name={failed > 0 ? 'alert-circle' : 'cloud-offline-outline'}
          size={18}
          color={failed > 0 ? '#DC2626' : '#D97706'}
        />
        <View className="ml-2 flex-1">
          <Text className={`text-sm font-bold ${failed > 0 ? 'text-red-700' : 'text-amber-800'}`}>
            {failed > 0
              ? t('queue.failedTitle', { count: failed })
              : t('queue.pendingTitle', { count: pending })}
          </Text>
          <Text className="mt-0.5 text-xs text-slate-600">
            {failed > 0 ? t('queue.failedHint') : t('queue.pendingHint', { amount: formatINR(value) })}
          </Text>
        </View>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color="#64748B" />
      </Pressable>

      {pending > 0 ? (
        <Pressable
          onPress={runSync}
          disabled={syncing}
          accessibilityRole="button"
          accessibilityLabel={t('queue.syncNow')}
          className="mt-2 flex-row items-center justify-center rounded-xl bg-white/80 py-2"
        >
          {syncing ? <ActivityIndicator size="small" /> : (
            <>
              <Ionicons name="cloud-upload-outline" size={15} color="#1D4ED8" />
              <Text className="ml-1.5 text-xs font-bold text-blue-700">{t('queue.syncNow')}</Text>
            </>
          )}
        </Pressable>
      ) : null}

      {open ? (
        <View className="mt-2">
          {entries.map((e) => (
            <View key={e.id} className="mt-2 rounded-xl border border-slate-200 bg-white p-2.5">
              <View className="flex-row items-center justify-between">
                <Text className="text-sm font-bold text-slate-900">{formatINR(e.total)}</Text>
                <Text className="text-[11px] text-slate-400">{formatDate(e.createdAt, { withTime: true })}</Text>
              </View>
              <Text className="mt-0.5 text-xs text-slate-500">
                {t('queue.itemCount', { count: e.payload?.items?.length ?? 0 })}
                {e.attempts ? ` · ${t('queue.attempts', { count: e.attempts })}` : ''}
              </Text>
              {e.status === 'failed' ? (
                <>
                  <Text className="mt-1 text-xs font-semibold text-red-600">{e.error}</Text>
                  <View className="mt-2 flex-row gap-2">
                    <Pressable
                      onPress={() => retry(e.id)}
                      accessibilityRole="button"
                      accessibilityLabel={`${t('queue.tryAgain')} ${formatINR(e.total)}`}
                      className="rounded-lg border border-blue-600 px-3 py-1.5"
                    >
                      <Text className="text-xs font-bold text-blue-700">{t('queue.tryAgain')}</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => discard(e)}
                      accessibilityRole="button"
                      accessibilityLabel={`${t('queue.discard')} ${formatINR(e.total)}`}
                      className="rounded-lg border border-red-500 px-3 py-1.5"
                    >
                      <Text className="text-xs font-bold text-red-600">{t('queue.discard')}</Text>
                    </Pressable>
                  </View>
                </>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
