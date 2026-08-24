import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import Screen from '../components/Screen';
import Button from '../components/Button';
import TextField from '../components/TextField';
import { Card } from '../components/Card';
import { authApi } from '../api/endpoints';
import { toast } from '../store/uiStore';
import { colors } from '../theme';

/**
 * Changing the PIN.
 *
 * Three fields rather than two: the confirmation exists because the PIN is
 * masked and there is no "forgot my PIN" flow. A typo in a masked field that is
 * never repeated back locks the shop out of its own data, and only the super
 * admin could undo it. The extra field is cheap insurance against that.
 *
 * The current PIN is asked for even though the session is already
 * authenticated. A signed-in phone left on the counter is the realistic threat
 * here, not a stolen token -- and re-entering four digits is the difference
 * between "someone picked up the phone" and "someone changed the lock".
 *
 * Validation runs on the client only to catch what is obvious (mismatch, too
 * short). Whether the current PIN is right is the server's answer, never
 * guessed at locally, and the per-account rate limit on /auth/pin is what makes
 * that safe.
 */
export default function SecurityScreen({ navigation }) {
  const { t } = useTranslation();

  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const tooShort = newPin.length < 4;
  const mismatch = confirmPin.length > 0 && newPin !== confirmPin;
  const ready = currentPin.length >= 4 && !tooShort && newPin === confirmPin;

  const submit = async () => {
    if (!ready) return;
    if (newPin === currentPin) {
      setError(t('settings.pinUnchanged'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await authApi.changePin(currentPin, newPin);
      toast.success(t('auth.pinChanged'));
      navigation.goBack();
    } catch (err) {
      /**
       * A wrong current PIN comes back as 400, deliberately -- see the comment
       * on the server's changePin. It used to be 401, and the api client
       * (rightly) reads any 401 as an expired session and signs the shop out,
       * so one mistyped digit threw the operator back to the login screen with
       * "Session expired". 429 is the per-account rate limiter.
       *
       * `wrongPin` is matched on the server's own message rather than the
       * status alone, because a missing field is also a 400 and deserves its
       * own wording.
       */
      const wrongPin = err.status === 400 && /current pin/i.test(err.message ?? '');
      setError(
        wrongPin ? t('settings.currentPinWrong')
          : err.status === 429 ? t('settings.tooManyAttempts')
            : err.message
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      title={t('settings.security')}
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
          <View className="mb-4 flex-row items-start rounded-2xl border border-blue-100 bg-blue-50 p-3.5">
            <Ionicons name="shield-checkmark" size={20} color={colors.brand} />
            <Text className="ml-2.5 flex-1 text-xs leading-5 text-slate-600">
              {t('settings.securityIntro')}
            </Text>
          </View>

          <Card>
            <Text className="mb-3 text-base font-bold text-slate-900">{t('auth.changePin')}</Text>

            <TextField
              label={t('auth.currentPin')}
              value={currentPin}
              onChangeText={(v) => { setCurrentPin(v); setError(null); }}
              mode="pin"
              placeholder="••••"
            />
            <TextField
              label={t('auth.newPin')}
              value={newPin}
              onChangeText={(v) => { setNewPin(v); setError(null); }}
              mode="pin"
              placeholder="••••"
              hint={t('auth.pinHint')}
            />
            <TextField
              label={t('auth.confirmPin')}
              value={confirmPin}
              onChangeText={(v) => { setConfirmPin(v); setError(null); }}
              mode="pin"
              placeholder="••••"
              error={mismatch ? t('auth.pinMismatch') : undefined}
            />

            {error ? (
              <Text className="mb-3 text-sm text-red-600">{error}</Text>
            ) : null}

            <Button
              title={t('auth.changePin')}
              onPress={submit}
              loading={saving}
              disabled={!ready}
              icon="key-outline"
              fullWidth
            />
          </Card>

          <Text className="mt-3 px-1 text-xs text-slate-400">{t('settings.pinRecoveryHint')}</Text>
        </View>
      </ScrollView>
    </Screen>
  );
}
