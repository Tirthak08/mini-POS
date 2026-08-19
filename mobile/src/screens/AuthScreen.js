import { useState } from 'react';
import {
  KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import Button from '../components/Button';
import TextField from '../components/TextField';
import LanguagePicker from '../components/LanguagePicker';
import { useAuthStore } from '../store/authStore';
import { healthApi } from '../api/endpoints';
import { API_BASE_URL } from '../api/client';
import { toast } from '../store/uiStore';

/**
 * One form, two account types.
 *
 * There used to be three tabs (Sign In / Register / Super Admin), which made the
 * user classify themselves before they had typed anything -- and two of those
 * tabs were the same action. Now a single form posts to /auth/signin and the
 * server works out whether the credentials belong to a shop or the super admin.
 * Registration sits behind a text link, the way a web app does it.
 */
export default function AuthScreen() {
  const { t } = useTranslation();
  const [mode, setMode] = useState('signin'); // 'signin' | 'register'

  const [identifier, setIdentifier] = useState('');
  const [secret, setSecret] = useState('');
  // The overwhelmingly common case is a shop owner typing a 4-digit PIN, so the
  // number pad is the default. An admin password needs letters, hence the toggle.
  const [numericSecret, setNumericSecret] = useState(true);

  const [shopName, setShopName] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');

  const [fieldErrors, setFieldErrors] = useState({});
  // Server messages are English. The two failures a shop owner actually hits are
  // shown in their own language instead of passing the raw API text through.
  const [formError, setFormError] = useState(null);
  const [health, setHealth] = useState(null); // null | 'checking' | 'ok' | 'down'

  const loading = useAuthStore((s) => s.loading);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);
  const signIn = useAuthStore((s) => s.signIn);
  const register = useAuthStore((s) => s.register);

  const switchMode = (next) => {
    setMode(next);
    setFieldErrors({});
    setFormError(null);
    clearError();
  };

  /** Turns an ApiError into something the operator can read in their language. */
  const describe = (err) => {
    if (!err) return t('errors.generic');
    if (err.isNetwork) return t('auth.serverUnreachable');
    if (err.status === 401) return t('auth.signInFailed');
    return err.message;
  };

  const submitSignIn = async () => {
    clearError();
    setFormError(null);
    const errors = {};
    if (!identifier.trim()) errors.identifier = t('errors.required');
    if (!secret) errors.secret = t('errors.required');
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;

    const result = await signIn(identifier.trim(), secret);
    if (!result.ok) setFormError(describe(result.error));
  };

  const submitRegister = async () => {
    clearError();
    setFormError(null);
    const errors = {};
    if (shopName.trim().length < 2) errors.shopName = t('auth.nameTooShort');
    if (!/^\d{4,6}$/.test(pin)) errors.pin = t('auth.pinHint');
    if (pin !== confirmPin) errors.confirmPin = t('auth.pinMismatch');
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;

    const result = await register(shopName, pin);
    if (!result.ok) {
      const detail = result.error?.details;
      if (detail?.pin) setFieldErrors((prev) => ({ ...prev, pin: detail.pin }));
      // A duplicate shop name (409) is worth showing verbatim -- it is specific
      // and actionable, unlike a generic auth failure.
      setFormError(describe(result.error));
    }
  };

  /** Lets you confirm the phone can see the backend before blaming the PIN. */
  const checkConnection = async () => {
    setHealth('checking');
    try {
      const res = await healthApi.check();
      setHealth(res?.ok ? 'ok' : 'down');
      toast[res?.ok ? 'success' : 'error'](
        res?.ok ? `Connected — MongoDB ${res.mongo?.state}` : 'Server reachable but database is down'
      );
    } catch (err) {
      setHealth('down');
      toast.error(err.message);
    }
  };

  const isRegister = mode === 'register';

  return (
    <SafeAreaView
      className="flex-1 bg-slate-50"
      // All four edges: Auth is a bare stack screen, with no tab bar to cover
      // the home-indicator / gesture area on its behalf.
      edges={['top', 'left', 'right', 'bottom']}
    >
      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 20 }} keyboardShouldPersistTaps="handled">
          {/* Brand + language */}
          <View className="mb-8 flex-row items-start justify-between">
            <View className="flex-1">
              <View className="mb-3 h-14 w-14 items-center justify-center rounded-2xl bg-blue-600">
                <Ionicons name="storefront" size={28} color="#fff" />
              </View>
              <Text className="text-2xl font-bold text-slate-900">Mini POS</Text>
              <Text className="mt-1 text-sm text-slate-500">{t('auth.tagline')}</Text>
            </View>
            <LanguagePicker />
          </View>

          <View className="rounded-2xl border border-slate-200 bg-white p-5">
            {/* Marked as a header so assistive tech (and automation) can tell the
                card title apart from the identically-labelled submit button. */}
            <Text
              accessibilityRole="header"
              className={`text-xl font-bold text-slate-900 ${isRegister ? 'mb-1' : 'mb-5'}`}
            >
              {isRegister ? t('auth.registerTitle') : t('auth.signInTitle')}
            </Text>
            {/* The identifier hint belongs on the field itself, not up here. */}
            {isRegister ? (
              <Text className="mb-5 text-sm text-slate-500">{t('auth.registerSubtitle')}</Text>
            ) : null}

            {isRegister ? (
              <>
                <TextField
                  label={t('auth.businessName')}
                  value={shopName}
                  onChangeText={setShopName}
                  placeholder="Sharma Kirana"
                  error={fieldErrors.shopName}
                />
                <TextField
                  label={t('auth.pin')}
                  value={pin}
                  onChangeText={setPin}
                  mode="pin"
                  placeholder="••••"
                  hint={t('auth.pinHint')}
                  error={fieldErrors.pin}
                />
                <TextField
                  label={t('auth.confirmPin')}
                  value={confirmPin}
                  onChangeText={setConfirmPin}
                  mode="pin"
                  placeholder="••••"
                  error={fieldErrors.confirmPin}
                />
              </>
            ) : (
              <>
                <TextField
                  label={t('auth.identifier')}
                  value={identifier}
                  onChangeText={setIdentifier}
                  placeholder="Sharma Kirana"
                  hint={t('auth.identifierHint')}
                  error={fieldErrors.identifier}
                />
                <TextField
                  label={t('auth.secret')}
                  value={secret}
                  onChangeText={setSecret}
                  mode={numericSecret ? 'pin' : 'password'}
                  placeholder={numericSecret ? '••••' : '••••••••'}
                  error={fieldErrors.secret}
                />
                {/* A shop PIN is digits; an admin password is not. One tap
                    switches the keyboard without adding a second form. */}
                <Pressable
                  onPress={() => { setNumericSecret((v) => !v); setSecret(''); }}
                  hitSlop={6}
                  accessibilityRole="button"
                  className="mb-1 self-start py-1"
                >
                  <Text className="text-xs font-semibold text-blue-600">
                    {numericSecret ? t('auth.usePassword') : t('auth.usePin')}
                  </Text>
                </Pressable>
              </>
            )}

            {formError || error ? (
              <View className="mb-3 mt-2 rounded-xl border border-red-200 bg-red-50 p-3">
                <Text className="text-sm text-red-700">{formError ?? error}</Text>
              </View>
            ) : null}

            <View className="mt-3">
              <Button
                title={isRegister ? t('auth.registerCta') : t('auth.signInCta')}
                onPress={isRegister ? submitRegister : submitSignIn}
                loading={loading}
                fullWidth
                size="lg"
                icon={isRegister ? 'person-add' : 'log-in'}
              />
            </View>
          </View>

          {/* Web-style switch between signing in and registering */}
          <View className="mt-5 flex-row items-center justify-center">
            <Text className="text-sm text-slate-500">
              {isRegister ? t('auth.haveAccount') : t('auth.noAccount')}
            </Text>
            <Pressable
              onPress={() => switchMode(isRegister ? 'signin' : 'register')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={isRegister ? t('auth.signInInstead') : t('auth.createAccount')}
              className="ml-1.5 py-1"
            >
              <Text className="text-sm font-bold text-blue-600">
                {isRegister ? t('auth.signInInstead') : t('auth.createAccount')}
              </Text>
            </Pressable>
          </View>

          {/* Connection diagnostics -- the first thing that goes wrong on a phone */}
          <View className="mt-auto pt-8">
            <View className="flex-row items-center justify-center">
              {health === 'ok' ? <Ionicons name="checkmark-circle" size={13} color="#16A34A" /> : null}
              {health === 'down' ? <Ionicons name="close-circle" size={13} color="#DC2626" /> : null}
              <Text className="mx-1.5 text-xs text-slate-400" numberOfLines={1}>
                {t('auth.connection')}: {API_BASE_URL.replace(/^https?:\/\//, '')}
              </Text>
              <Pressable onPress={checkConnection} hitSlop={8} accessibilityRole="button" className="py-1">
                <Text className="text-xs font-semibold text-blue-600">
                  {health === 'checking' ? t('common.loading') : t('auth.testConnection')}
                </Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
