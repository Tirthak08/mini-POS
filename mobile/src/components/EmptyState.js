import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Button from './Button';

export default function EmptyState({ icon = 'cube-outline', title, hint, actionLabel, onAction }) {
  return (
    <View className="items-center justify-center px-8 py-12">
      <View className="mb-3 h-16 w-16 items-center justify-center rounded-full bg-slate-100">
        <Ionicons name={icon} size={30} color="#94A3B8" />
      </View>
      <Text className="text-center text-base font-semibold text-slate-700">{title}</Text>
      {hint ? <Text className="mt-1 text-center text-sm text-slate-500">{hint}</Text> : null}
      {actionLabel && onAction ? (
        <View className="mt-4">
          <Button title={actionLabel} onPress={onAction} icon="add" size="sm" />
        </View>
      ) : null}
    </View>
  );
}
