import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import Button from './Button';
import TextField from './TextField';
import { useConfirmStore } from '../store/confirmStore';

/**
 * Single dialog host, mounted once at the app root. Renders whatever the
 * confirm store is currently asking for. Works identically on Android, iOS and
 * web, unlike React Native's Alert.
 */
export default function ConfirmDialog() {
  const { t } = useTranslation();
  const request = useConfirmStore((s) => s.request);
  const respond = useConfirmStore((s) => s.respond);
  const [value, setValue] = useState('');

  // Reset the input every time a new prompt opens.
  useEffect(() => {
    if (request?.kind === 'number') setValue(request.initial ? String(request.initial) : '');
  }, [request]);

  if (!request) return null;

  const isNumber = request.kind === 'number';
  const cancel = () => respond(isNumber ? null : false);
  const accept = () => {
    if (!isNumber) return respond(true);
    const n = Number(value);
    respond(Number.isFinite(n) && n > 0 ? n : null);
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={cancel}>
      <View className="flex-1 items-center justify-center bg-black/50 px-6">
        {/* Tapping the backdrop cancels, matching platform expectations. */}
        <Pressable className="absolute inset-0" onPress={cancel} accessibilityLabel={t('common.cancel')} />

        <View className="w-full max-w-sm rounded-2xl bg-white p-5">
          <Text className="text-lg font-bold text-slate-900">{request.title}</Text>

          {request.message ? (
            <Text className="mt-2 text-sm leading-5 text-slate-600">{request.message}</Text>
          ) : null}

          {isNumber ? (
            <View className="mt-4">
              <TextField
                label={request.label}
                value={value}
                onChangeText={setValue}
                mode="integer"
                placeholder="0"
                autoFocus
              />
            </View>
          ) : null}

          <View className="mt-5 flex-row gap-3">
            <View className="flex-1">
              <Button
                title={request.cancelLabel || t('common.cancel')}
                variant="secondary"
                onPress={cancel}
                fullWidth
              />
            </View>
            <View className="flex-1">
              <Button
                title={request.confirmLabel || t('common.confirm')}
                variant={request.destructive ? 'danger' : 'primary'}
                onPress={accept}
                fullWidth
              />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}
