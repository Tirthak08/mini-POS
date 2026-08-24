import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import Screen from '../components/Screen';
import Button from '../components/Button';
import TextField from '../components/TextField';
import { Card } from '../components/Card';
import { useAuthStore } from '../store/authStore';
import { toast } from '../store/uiStore';
import { formatDate } from '../utils/money';

/**
 * The shop's name, and the facts about the account that are not editable.
 *
 * The name deserves a warning rather than a plain field, because it is not
 * decoration: it is half of the sign-in credential. Change it and the old name
 * stops working at the login screen. Saying so before the save is the whole
 * point of this screen existing instead of an inline edit in the list.
 *
 * The mockup also showed GSTIN, PAN and a registration number. They are not
 * here because the backend has nowhere to put them, and a field that forgets
 * what you typed is worse than a field that is missing -- it looks like data
 * loss. When those are wanted they need a migration and validation (a GSTIN has
 * a checksum), not four more text inputs.
 */
export default function BusinessInfoScreen({ navigation }) {
  const { t } = useTranslation();
  const business = useAuthStore((s) => s.business);
  const counts = useAuthStore((s) => s.counts);
  const rename = useAuthStore((s) => s.renameBusiness);

  const [name, setName] = useState(business?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const trimmed = name.trim();
  const dirty = trimmed !== (business?.name ?? '').trim();
  const tooShort = trimmed.length < 2;

  const save = async () => {
    if (tooShort) {
      setError(t('auth.nameTooShort'));
      return;
    }
    setSaving(true);
    setError(null);
    const res = await rename(trimmed);
    setSaving(false);

    if (!res.ok) {
      // 409 is the interesting one: another shop already has the name. It is a
      // field-level problem, so it belongs under the field, not in a toast that
      // disappears before it can be acted on.
      setError(res.error?.status === 409 ? t('settings.nameTaken') : res.error?.message);
      return;
    }
    toast.success(t('settings.saved'));
    navigation.goBack();
  };

  const Fact = ({ label, value, mono }) => (
    <View className="flex-row items-start justify-between py-2">
      <Text className="pr-3 text-sm text-slate-500">{label}</Text>
      <Text
        className={`flex-1 text-right text-sm font-semibold text-slate-800 ${mono ? 'tracking-tight' : ''}`}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );

  return (
    <Screen
      title={t('settings.business')}
      onBack={() => navigation.goBack()}
      showSettings={false}
      showLogout={false}
      includeBottomInset
    >
      <ScrollView
        contentContainerStyle={{ paddingTop: 16, paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="px-4">
          <Card className="mb-4">
            <TextField
              label={t('auth.businessName')}
              value={name}
              onChangeText={(v) => { setName(v); setError(null); }}
              placeholder={t('settings.businessPlaceholder')}
              maxLength={60}
              error={error}
              hint={error ? undefined : t('settings.businessHint')}
            />
            <Button
              title={t('common.save')}
              onPress={save}
              loading={saving}
              disabled={!dirty || tooShort}
              icon="checkmark"
              fullWidth
            />
            {dirty && !error ? (
              <Text className="mt-2.5 text-xs text-amber-600">{t('settings.renameWarning')}</Text>
            ) : null}
          </Card>

          <Text className="mb-1.5 ml-1 text-xs font-bold uppercase tracking-wide text-slate-400">
            {t('settings.accountFacts')}
          </Text>
          <Card>
            <Fact label={t('settings.shopId')} value={business?.businessId ?? '—'} mono />
            <View className="h-px bg-slate-100" />
            <Fact
              label={t('settings.created')}
              value={business?.createdAt ? formatDate(business.createdAt) : '—'}
            />
            <View className="h-px bg-slate-100" />
            <Fact label={t('settings.products')} value={String(counts?.products ?? 0)} />
            <View className="h-px bg-slate-100" />
            <Fact label={t('settings.orders')} value={String(counts?.orders ?? 0)} />
          </Card>

          <Text className="mt-3 px-1 text-xs text-slate-400">{t('settings.shopIdHint')}</Text>
        </View>
      </ScrollView>
    </Screen>
  );
}
