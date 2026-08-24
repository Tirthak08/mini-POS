import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import Screen from '../components/Screen';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import Loading, { ErrorBanner } from '../components/Loading';
import { StatTile, Badge } from '../components/Card';
import { adminApi } from '../api/endpoints';
import { useAuthStore } from '../store/authStore';
import { toast } from '../store/uiStore';
import { confirm } from '../store/confirmStore';
import { formatINR, formatDate } from '../utils/money';
import { colors } from '../theme';

export default function AdminScreen() {
  const { t } = useTranslation();
  const adminUsername = useAuthStore((s) => s.adminUsername);

  const [stats, setStats] = useState(null);
  const [businesses, setBusinesses] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async ({ silent = false, includeDeleted = showArchived } = {}) => {
    silent ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const [statsRes, listRes] = await Promise.all([
        adminApi.stats(),
        adminApi.businesses({ includeDeleted }),
      ]);
      setStats(statsRes.stats);
      setBusinesses(listRes.businesses ?? []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [showArchived]);

  useEffect(() => { load(); }, [load]);

  /**
   * Archive is a cascading SOFT delete, so one confirmation is enough -- it is
   * reversible. Purge is not, so it demands a second, explicit confirmation.
   */
  const archive = async (business) => {
    const ok = await confirm({
      title: `${t('admin.archive')} — ${business.name}`,
      message: t('admin.archiveWarning'),
      confirmLabel: t('admin.archive'),
      destructive: true,
    });
    if (!ok) return;

    setBusyId(business.businessId);
    try {
      const res = await adminApi.deleteBusiness(business.businessId);
      const d = res.deleted ?? {};
      toast.success(`${business.name}: ${d.orders ?? 0} ${t('admin.orders')}, ${d.products ?? 0} ${t('admin.products')}`);
      await load({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const restore = async (business) => {
    const ok = await confirm({
      title: `${t('admin.restore')} — ${business.name}`,
      message: t('admin.restoreWarning'),
      confirmLabel: t('admin.restore'),
    });
    if (!ok) return;

    setBusyId(business.businessId);
    try {
      const res = await adminApi.restoreBusiness(business.businessId);
      // The backend renames the shop if its name was taken while archived.
      toast.success(
        res.renamedFrom
          ? `${t('admin.restoredAs')} "${res.business.name}"`
          : `${t('admin.restore')}: ${res.business.name}`
      );
      await load({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const purge = async (business) => {
    const first = await confirm({
      title: `${t('admin.purge')} — ${business.name}`,
      message: t('admin.purgeWarning'),
      confirmLabel: t('admin.purge'),
      destructive: true,
    });
    if (!first) return;

    const a = business.archived ?? {};
    const second = await confirm({
      title: business.name,
      message: `${a.categories ?? 0} ${t('admin.categories')} · ${a.products ?? 0} ${t('admin.products')} · ${a.orders ?? 0} ${t('admin.orders')}`,
      confirmLabel: t('common.confirm'),
      destructive: true,
    });
    if (!second) return;

    setBusyId(business.businessId);
    try {
      const res = await adminApi.purgeBusiness(business.businessId);
      const p = res.purged ?? {};
      toast.success(`${business.name}: ${p.orders ?? 0} ${t('admin.orders')}, ${p.products ?? 0} ${t('admin.products')}`);
      setBusinesses((prev) => prev.filter((b) => b.businessId !== business.businessId));
      await load({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const toggleArchived = () => {
    const next = !showArchived;
    setShowArchived(next);
    load({ silent: true, includeDeleted: next });
  };

  const renderBusiness = useCallback(({ item }) => {
    const busy = busyId === item.businessId;
    const archivedCounts = item.archived ?? {};
    const cells = item.isDeleted
      ? [
          { label: t('admin.categories'), value: String(archivedCounts.categories ?? 0) },
          { label: t('admin.products'), value: String(archivedCounts.products ?? 0) },
          { label: t('admin.orders'), value: String(archivedCounts.orders ?? 0) },
          { label: t('admin.revenue'), value: formatINR(archivedCounts.revenue ?? 0) },
        ]
      : [
          { label: t('admin.categories'), value: String(item.categories ?? 0) },
          { label: t('admin.products'), value: String(item.products ?? 0) },
          { label: t('admin.orders'), value: String(item.orders ?? 0) },
          { label: t('admin.revenue'), value: formatINR(item.revenue ?? 0) },
        ];

    return (
      <View
        className={`mx-4 mb-2 rounded-2xl border bg-white p-4 ${busy ? 'opacity-50' : ''} ${item.isDeleted ? 'border-slate-300 bg-slate-50' : 'border-slate-200'}`}
      >
        <View className="flex-row items-start">
          <View className={`mr-3 h-10 w-10 items-center justify-center rounded-xl ${item.isDeleted ? 'bg-slate-200' : 'bg-blue-50'}`}>
            <Ionicons
              name={item.isDeleted ? 'archive-outline' : 'storefront-outline'}
              size={20}
              color={item.isDeleted ? colors.textMuted : colors.brand}
            />
          </View>

          <View className="flex-1">
            <Text className="text-base font-semibold text-slate-900" numberOfLines={1}>{item.name}</Text>
            <Text className="mt-0.5 text-xs text-slate-400">
              {t('admin.created')} {formatDate(item.createdAt)}
            </Text>
            {item.isDeleted ? (
              <View className="mt-1.5">
                <Badge label={`${t('admin.archivedBadge')} · ${formatDate(item.deletedAt)}`} tone="neutral" />
              </View>
            ) : null}
          </View>
        </View>

        <View className="mt-3 flex-row border-t border-slate-100 pt-3">
          {cells.map((cell) => (
            <View key={cell.label} className="flex-1">
              {/* No "(archived)" suffix here: it truncated all four column
                  headers, and the row's Archived badge already says so. */}
              <Text className="text-xs text-slate-400" numberOfLines={1}>{cell.label}</Text>
              <Text className="mt-0.5 text-sm font-semibold text-slate-800" numberOfLines={1}>{cell.value}</Text>
            </View>
          ))}
        </View>

        {!item.isDeleted ? (
          <Text className="mt-2 text-xs text-slate-400">
            {t('admin.lastActivity')}: {item.lastActivity ? formatDate(item.lastActivity, { withTime: true }) : t('admin.never')}
          </Text>
        ) : null}

        <View className="mt-3 flex-row gap-2">
          {item.isDeleted ? (
            <>
              <View className="flex-1">
                <Button
                  title={t('admin.restore')}
                  accessibilityLabel={`${t('admin.restore')} ${item.name}`}
                  icon="refresh" variant="secondary" size="sm"
                  onPress={() => restore(item)} disabled={busy} fullWidth
                />
              </View>
              <View className="flex-1">
                <Button
                  title={t('admin.purge')}
                  accessibilityLabel={`${t('admin.purge')} ${item.name}`}
                  icon="trash" variant="danger" size="sm"
                  onPress={() => purge(item)} disabled={busy} fullWidth
                />
              </View>
            </>
          ) : (
            <View className="flex-1">
              <Button
                title={t('admin.archive')}
                accessibilityLabel={`${t('admin.archive')} ${item.name}`}
                icon="archive-outline" variant="secondary" size="sm"
                onPress={() => archive(item)} disabled={busy} fullWidth
              />
            </View>
          )}
        </View>
      </View>
    );
  }, [busyId, t]);

  return (
    <Screen
      title={t('admin.title')}
      subtitle={adminUsername ? `${t('auth.signedInAs')} ${adminUsername}` : undefined}
      // Admin replaces the tab navigator rather than sitting inside it, so
      // nothing else is claiming the bottom inset on its behalf.
      includeBottomInset
    >
      <ErrorBanner message={error} onRetry={load} retryLabel={t('common.retry')} />

      {loading ? (
        <Loading label={t('common.loading')} />
      ) : (
        <FlatList
          data={businesses}
          keyExtractor={(item) => item.businessId}
          renderItem={renderBusiness}
          refreshing={refreshing}
          onRefresh={() => load({ silent: true })}
          contentContainerStyle={{ paddingBottom: 40, paddingTop: 12 }}
          ListHeaderComponent={
            <View className="mb-3 px-4">
              {stats ? (
                <>
                  <View className="flex-row gap-2">
                    <StatTile
                      className="flex-1"
                      label={t('admin.totalBusinesses')}
                      value={String(stats.businesses)}
                      sub={stats.archivedBusinesses ? `${stats.archivedBusinesses} ${t('admin.archivedCounts')}` : undefined}
                      tone="brand"
                    />
                    <StatTile className="flex-1" label={t('admin.totalProducts')} value={String(stats.products)} />
                  </View>
                  <View className="mt-2 flex-row gap-2">
                    <StatTile className="flex-1" label={t('admin.totalOrders')} value={String(stats.orders)} />
                    <StatTile className="flex-1" label={t('admin.grossRevenue')} value={formatINR(stats.grossRevenue)} />
                  </View>
                </>
              ) : null}

              <Pressable
                onPress={toggleArchived}
                accessibilityRole="button"
                className={`mt-3 flex-row items-center justify-center rounded-xl border py-2.5 ${showArchived ? 'border-blue-600 bg-blue-50' : 'border-slate-300 bg-white'}`}
              >
                <Ionicons name="archive-outline" size={16} color={showArchived ? colors.brand : colors.textMuted} />
                <Text className={`ml-2 text-sm font-semibold ${showArchived ? 'text-blue-700' : 'text-slate-600'}`}>
                  {showArchived ? t('admin.hideArchived') : t('admin.showArchived')}
                </Text>
              </Pressable>
            </View>
          }
          ListEmptyComponent={<EmptyState icon="storefront-outline" title={t('admin.noBusinesses')} />}
        />
      )}
    </Screen>
  );
}
