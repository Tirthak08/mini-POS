import { useEffect, useRef, useState } from 'react';
import {
  Keyboard, Modal, Platform, Pressable, ScrollView, Text, useWindowDimensions, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Button from './Button';
import { dialogBox, isCramped } from '../utils/dialogLayout';

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
 * THE KEYBOARD
 * ------------
 * This used to wrap the card in a KeyboardAvoidingView with
 * `behavior={Platform.OS === 'ios' ? 'padding' : undefined}` -- which is to say
 * it did nothing at all on Android. And Android is where it was needed: a React
 * Native <Modal> is its own window, so the activity's `adjustResize` never
 * reaches it and the dialog stays centred in the FULL screen while the keyboard
 * covers its lower half. The operator typed into a field they could not see.
 *
 * The fix measures the keyboard and shrinks the box the card is centred inside,
 * so it re-centres in the space above it. No transforms, nothing to fight, and
 * it behaves the same on both platforms. The arithmetic is in
 * utils/dialogLayout.js so it can be tested -- there is no soft keyboard in the
 * browser harness, so a component test here would pass with the fix removed.
 *
 * The height cap is in PIXELS, not a percentage. `maxHeight: '86%'` resolves
 * against the PARENT, whose height came from this card's own content -- so the
 * rule read "86% of myself", clipping every dialog to 86% of itself no matter
 * how much room was free.
 */
export default function FormModal({
  visible, onClose, title, children,
  submitLabel, onSubmit, submitting = false, submitVariant = 'primary', cancelLabel = 'Cancel',
}) {
  const { height } = useWindowDimensions();
  const [keyboard, setKeyboard] = useState(0);
  const scrollRef = useRef(null);

  useEffect(() => {
    // iOS fires `will` events ahead of the animation, so the dialog moves with
    // the keyboard instead of after it. Android only has the `did` pair.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const onShow = Keyboard.addListener(showEvent, (e) => {
      setKeyboard(e?.endCoordinates?.height ?? 0);
    });
    const onHide = Keyboard.addListener(hideEvent, () => setKeyboard(0));
    return () => { onShow.remove(); onHide.remove(); };
  }, []);

  // A dialog that closes while the keyboard is up would otherwise reopen with
  // a stale height and paint itself squashed for a frame.
  useEffect(() => { if (!visible) setKeyboard(0); }, [visible]);

  const { maxHeight, paddingBottom } = dialogBox(height, keyboard);
  const cramped = isCramped(height, keyboard);

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onClose}
      // Without this the modal window on Android sits below the status bar and
      // measures short, which throws the keyboard arithmetic off by its height.
      statusBarTranslucent
    >
      <View
        className={`flex-1 items-center px-4 ${cramped ? 'justify-start pt-3' : 'justify-center'}`}
        style={{ paddingBottom }}
      >
        {/* Backdrop is its own layer behind the card, not a parent of it: as a
            parent, a tap anywhere on the form would bubble out and close the
            dialog mid-edit. */}
        <Pressable
          className="absolute inset-0 bg-black/50"
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />

        <View
          className="w-full max-w-md overflow-hidden rounded-3xl bg-white"
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
            ref={scrollRef}
            className="px-5 pt-4"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: 12 }}
            showsVerticalScrollIndicator
            // Even with the card resized, a field near the bottom of a long
            // form can still sit under the keyboard. On iOS this scrolls the
            // focused input into view for free; Android ignores it, which is
            // why the resize above has to do the real work rather than lean
            // on it.
            automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
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
      </View>
    </Modal>
  );
}
