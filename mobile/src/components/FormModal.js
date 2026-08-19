import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Button from './Button';

/** Bottom-sheet style modal used for every add/edit form. */
export default function FormModal({
  visible, onClose, title, children,
  submitLabel, onSubmit, submitting = false, submitVariant = 'primary', cancelLabel = 'Cancel',
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/40">
        {/* Tapping the dimmed area closes, matching platform expectations. */}
        <Pressable className="flex-1" onPress={onClose} accessibilityLabel="Close" />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View className="max-h-[90%] rounded-t-3xl bg-white pb-6">
            <View className="flex-row items-center justify-between border-b border-slate-200 px-5 py-4">
              <Text className="text-lg font-bold text-slate-900">{title}</Text>
              <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
                <Ionicons name="close" size={22} color="#64748B" />
              </Pressable>
            </View>

            {/* paddingBottom keeps the last field from being cut in half by the
                action row, which made the sheet look broken. */}
            <ScrollView
              className="px-5 pt-4"
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingBottom: 12 }}
              showsVerticalScrollIndicator
            >
              {children}
            </ScrollView>

            <View className="flex-row gap-3 border-t border-slate-100 px-5 pt-3">
              <View className="flex-1">
                <Button title={cancelLabel} variant="secondary" onPress={onClose} fullWidth />
              </View>
              <View className="flex-1">
                <Button
                  title={submitLabel}
                  variant={submitVariant}
                  onPress={onSubmit}
                  loading={submitting}
                  fullWidth
                />
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
