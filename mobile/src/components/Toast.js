import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUiStore } from '../store/uiStore';

const STYLES = {
  success: { box: 'bg-green-600', icon: 'checkmark-circle' },
  error: { box: 'bg-red-600', icon: 'alert-circle' },
  info: { box: 'bg-slate-800', icon: 'information-circle' },
};

export default function Toast() {
  const toast = useUiStore((s) => s.toast);
  const hide = useUiStore((s) => s.hideToast);
  if (!toast) return null;

  const style = STYLES[toast.type] ?? STYLES.info;

  return (
    <View className="absolute inset-x-0 bottom-6 z-50 items-center px-4" pointerEvents="box-none">
      <Pressable onPress={hide} className={`w-full flex-row items-center rounded-xl px-4 py-3 ${style.box}`}>
        <Ionicons name={style.icon} size={18} color="#fff" />
        <Text className="ml-2 flex-1 text-sm font-medium text-white">{toast.message}</Text>
      </Pressable>
    </View>
  );
}
