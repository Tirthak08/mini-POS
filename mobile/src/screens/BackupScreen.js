import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import * as DocumentPicker from 'expo-document-picker';

import Screen from '../components/Screen';
import Button from '../components/Button';
import { backupApi } from '../api/endpoints';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { useInventoryStore } from '../store/inventoryStore';
import { confirm } from '../store/confirmStore';
import { toast } from '../store/uiStore';
import { formatDate } from '../utils/money';
import {
  saveBackupFile, readPickedText, parseBackupText, describeBackup, approxSize,
} from '../utils/backupFile';

/**
 * The copy of the shop that lives somewhere else.
 *
 * Atlas's free tier takes no automated backups, so until this screen existed
 * every product, sale and expense the shop had ever recorded lived in exactly
 * one place. The report export was not a substitute: it is a flattened summary
 * meant for reading, and nothing can be rebuilt from it.
 *
 * WHY RESTORE IS DELIBERATELY AWKWARD
 * -----------------------------------
 * Taking a backup is one tap, because a backup nobody takes is worthless.
 * Restoring is three, because it is the only screen in the app that can destroy
 * a year of records in a second, and the person doing it is usually having a
 * bad day already. So the file is read and SUMMARISED first -- shop name, date,
 * what is in it -- and the shop is told exactly what it is about to lose before
 * anything is sent.
 */
export default function BackupScreen({ navigation }) {
  const { t } = useTranslation();
  const business = useAuthStore((s) => s.business);
  const lastBackupAt = useSettingsStore((s) => s.lastBackupAt);
  const markBackedUp = useSettingsStore((s) => s.markBackedUp);
  const loadAll = useInventoryStore((s) => s.loadAll);

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null); // 'export' | 'export-photos' | 'restore'
  const [picked, setPicked] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await backupApi.status();
      setStatus(res?.counts ? res : null);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  /* ------------------------------ taking one ------------------------------ */
  const takeBackup = useCallback(async (images) => {
    setBusy(images ? 'export-photos' : 'export');
    try {
      const res = await backupApi.export({ images });
      const where = await saveBackupFile(res.backup, business?.name, {
        mode: 'save', images,
      });
      // null means the folder picker was dismissed -- a decision, not a failure,
      // and marking the shop "backed up" after it would be a lie.
      if (where === null) return;
      markBackedUp();
      toast.success(t('backup.saved'));
    } catch (err) {
      toast.error(err.message || t('errors.generic'));
    } finally {
      setBusy(null);
    }
  }, [business?.name, markBackedUp, t]);

  /* ------------------------------ putting one back ------------------------------ */
  const pickFile = useCallback(async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        // Not 'application/json': plenty of Android file providers hand a .json
        // back as octet-stream or text/plain, and a filter that hides the file
        // the operator is looking at is worse than no filter.
        type: '*/*',
        copyToCacheDirectory: true,
      });
      if (res.canceled) return;

      const asset = res.assets?.[0];
      const text = await readPickedText(asset);
      const backup = parseBackupText(text, { t });
      setPicked({ backup, summary: describeBackup(backup), name: asset?.name ?? '' });
    } catch (err) {
      setPicked(null);
      toast.error(err.message || t('backup.errorNotBackup'));
    }
  }, [t]);

  const doRestore = useCallback(async () => {
    if (!picked) return;
    const occupied = (status?.counts?.products ?? 0) + (status?.counts?.orders ?? 0) > 0;

    const ok = await confirm({
      title: t('backup.restoreConfirmTitle'),
      message: occupied
        ? t('backup.restoreConfirmReplace', {
            products: status?.counts?.products ?? 0,
            orders: status?.counts?.orders ?? 0,
            shop: picked.summary.shopName ?? '—',
          })
        : t('backup.restoreConfirmEmpty', { shop: picked.summary.shopName ?? '—' }),
      confirmLabel: t('backup.restoreCta'),
      destructive: true,
    });
    if (!ok) return;

    setBusy('restore');
    try {
      const res = await backupApi.restore(picked.backup, { mode: occupied ? 'replace' : 'empty' });
      await loadAll({ silent: true });
      setPicked(null);
      await refresh();
      toast.success(t('backup.restored', {
        products: res.restored?.products ?? 0,
        orders: res.restored?.orders ?? 0,
      }));
    } catch (err) {
      toast.error(err.message || t('errors.generic'));
    } finally {
      setBusy(null);
    }
  }, [picked, status, loadAll, refresh, t]);

  const counts = status?.counts;
  const photosHeavy = (status?.approxImageBytes ?? 0) > 2 * 1024 * 1024;

  return (
    <Screen
      title={t('backup.title')}
      onBack={() => navigation.goBack()}
      showSettings={false}
      showLogout={false}
      includeBottomInset
    >
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* ---------------------------- what you have ---------------------------- */}
        <View className="mb-5 rounded-2xl border border-slate-200 bg-white p-4">
          <View className="mb-2 flex-row items-center">
            <Ionicons name="cloud-upload-outline" size={16} color="#475569" />
            <Text className="ml-1.5 text-sm font-semibold text-slate-700">{t('backup.whatsInIt')}</Text>
          </View>

          {loading ? (
            <ActivityIndicator style={{ marginVertical: 12 }} />
          ) : counts ? (
            <>
              <Row label={t('backup.products')} value={String(counts.products)} />
              <Row label={t('backup.orders')} value={String(counts.orders)} />
              <Row label={t('backup.expenses')} value={String(counts.expenses)} />
              <Row label={t('backup.photos')}
                value={`${counts.images} · ${approxSize(status.approxImageBytes)}`} last />
            </>
          ) : (
            <Text className="py-2 text-sm text-slate-500">{t('backup.statusUnavailable')}</Text>
          )}

          <Text className="mt-3 text-xs text-slate-400">
            {lastBackupAt
              ? t('backup.lastTaken', { when: formatDate(lastBackupAt, { withTime: true }) })
              : t('backup.neverTaken')}
          </Text>
        </View>

        <Button
          title={t('backup.takeCta')}
          onPress={() => takeBackup(false)}
          loading={busy === 'export'}
          disabled={Boolean(busy)}
          icon="download-outline"
          fullWidth
        />
        <Text className="mb-4 mt-2 px-1 text-xs text-slate-500">{t('backup.takeHint')}</Text>

        <Button
          title={t('backup.takeWithPhotosCta')}
          onPress={() => takeBackup(true)}
          loading={busy === 'export-photos'}
          disabled={Boolean(busy) || !counts?.images}
          variant="secondary"
          icon="images-outline"
          fullWidth
        />
        <Text className="mb-6 mt-2 px-1 text-xs text-slate-500">
          {photosHeavy
            ? t('backup.photosHeavy', { size: approxSize(status?.approxImageBytes) })
            : t('backup.takeWithPhotosHint')}
        </Text>

        {/* ------------------------------ restoring ------------------------------ */}
        <View className="mb-3 h-px bg-slate-200" />

        <View className="mb-2 flex-row items-center">
          <Ionicons name="cloud-download-outline" size={16} color="#475569" />
          <Text className="ml-1.5 text-sm font-semibold text-slate-700">{t('backup.restoreTitle')}</Text>
        </View>
        <Text className="mb-3 text-xs text-slate-500">{t('backup.restoreHint')}</Text>

        {picked ? (
          <View className="mb-3 rounded-2xl border border-amber-300 bg-amber-50 p-4">
            <Text className="text-sm font-bold text-slate-900" numberOfLines={1}>
              {picked.summary.shopName ?? picked.name}
            </Text>
            {picked.summary.exportedAt ? (
              <Text className="mt-0.5 text-xs text-slate-600">
                {t('backup.fileTaken', { when: formatDate(picked.summary.exportedAt, { withTime: true }) })}
              </Text>
            ) : null}
            <Text className="mt-2 text-xs text-slate-700">
              {t('backup.fileHolds', {
                products: picked.summary.products,
                orders: picked.summary.orders,
                expenses: picked.summary.expenses,
              })}
            </Text>
            {!picked.summary.includesImages ? (
              <Text className="mt-1 text-xs text-amber-700">{t('backup.fileNoPhotos')}</Text>
            ) : null}

            <View className="mt-3 flex-row gap-2">
              <Button
                title={t('backup.restoreCta')}
                onPress={doRestore}
                loading={busy === 'restore'}
                disabled={Boolean(busy)}
                variant="danger"
                size="sm"
              />
              <Button
                title={t('common.cancel')}
                onPress={() => setPicked(null)}
                disabled={Boolean(busy)}
                variant="secondary"
                size="sm"
              />
            </View>
          </View>
        ) : (
          <Button
            title={t('backup.pickCta')}
            onPress={pickFile}
            disabled={Boolean(busy)}
            variant="secondary"
            icon="folder-open-outline"
            fullWidth
          />
        )}

        <Text className="mt-4 px-1 text-xs text-slate-400">{t('backup.footer')}</Text>

        {Platform.OS === 'ios' ? (
          <Text className="mt-2 px-1 text-xs text-slate-400">{t('backup.iosNote')}</Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function Row({ label, value, last = false }) {
  return (
    <View className={`flex-row items-center justify-between py-2 ${last ? '' : 'border-b border-slate-100'}`}>
      <Text className="text-sm text-slate-600">{label}</Text>
      <Text className="text-sm font-bold text-slate-900">{value}</Text>
    </View>
  );
}
