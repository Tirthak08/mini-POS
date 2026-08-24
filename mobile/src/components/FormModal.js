import {
  KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, useWindowDimensions, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Button from './Button';

/**
 * Centred dialog used for every add/edit form.
 *
 * It used to slide up from the bottom edge as a sheet. A sheet is the right
 * shape for a short, glanceable action -- but these are real forms with five or
 * six fields, and anchoring them to the bottom edge pushed the first field
 * (product name) to the top of the sheet, far from the thumb, while the action
 * row sat under the keyboard. Centred, the form reads as a dialog: title at the
 * top, actions at the bottom, the whole thing balanced in the viewport.
 *
 * `animationType` changes with the shape. 'slide' means "a surface is arriving
 * from an edge" and would now contradict what the eye sees, so a centred dialog
 * fades in instead.
 *
 * The height is capped rather than fixed, and the body scrolls: the product form
 * with a photo tile is much taller than the category form with one field, and
 * both must fit above a raised keyboard on a short phone.
 *
 * That cap is in PIXELS, computed from the window, and it matters that it is
 * not a percentage. `maxHeight: '86%'` resolves against the PARENT, and the
 * parent here is a wrapper whose own height comes from this card's content --
 * so the rule read "86% of my own height", clipping every dialog to 86% of
 * itself no matter how much room was free, and leaving the card sitting 55px
 * above true centre inside a wrapper 14% taller than itself. Measured in the
 * browser, not spotted by reading it.
 */
export default function FormModal({
  visible, onClose, title, children,
  submitLabel, onSubmit, submitting = false, submitVariant = 'primary', cancelLabel = 'Cancel',
}) {
  const { height } = useWindowDimensions();
  // Leave a margin top and bottom even for the tallest form, so the dialog
  // always reads as floating above the screen rather than filling it.
  const maxHeight = Math.round(height * 0.86);

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center px-4">
        {/* Backdrop is its own layer behind the card, not a parent of it: as a
            parent, a tap anywhere on the form would bubble out and close the
            dialog mid-edit. */}
        <Pressable
          className="absolute inset-0 bg-black/50"
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          className="w-full max-w-md"
        >
          <View
            className="w-full overflow-hidden rounded-3xl bg-white"
            style={{
              maxHeight,
              shadowColor: '#00111F', shadowOpacity: 0.3,
              shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 12,
            }}
          >
            <View className="flex-row items-center justify-between border-b border-slate-200 px-5 py-4">
              <Text className="flex-1 pr-2 text-lg font-bold text-slate-900" numberOfLines={1}>
                {title}
              </Text>
              <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
                <Ionicons name="close" size={22} color="#64748B" />
              </Pressable>
            </View>

            {/* paddingBottom keeps the last field from being cut in half by the
                action row, which made the dialog look broken. */}
            <ScrollView
              className="px-5 pt-4"
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingBottom: 12 }}
              showsVerticalScrollIndicator
            >
              {children}
            </ScrollView>

            <View className="flex-row gap-3 border-t border-slate-100 px-5 pb-5 pt-3">
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
