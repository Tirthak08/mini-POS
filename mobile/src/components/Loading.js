import { ActivityIndicator, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function Loading({ label }) {
  return (
    <View className="flex-1 items-center justify-center py-12">
      <ActivityIndicator size="large" color="#2563EB" />
      {label ? <Text className="mt-3 text-sm text-slate-500">{label}</Text> : null}
    </View>
  );
}

export function ErrorBanner({ message, onRetry, retryLabel = 'Try again' }) {
  if (!message) return null;
  return (
    <View className="mx-4 mt-3 flex-row items-start rounded-xl border border-red-200 bg-red-50 p-3">
      <Text className="flex-1 text-sm text-red-700">{message}</Text>
      {onRetry ? (
        <Text onPress={onRetry} className="ml-3 text-sm font-semibold text-red-700 underline">
          {retryLabel}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Shown when the catalogue on screen came off the disk cache rather than the
 * server. Amber, not red: nothing is broken, but the stock counts are a
 * snapshot, and stock is the figure most likely to have moved while offline.
 * Saying "last synced" is the whole point -- a cache presented silently is
 * worse than no cache, because the operator would trust the numbers.
 */
export function StaleBanner({ message, onRetry, retryLabel = 'Refresh' }) {
  if (!message) return null;
  return (
    <View className="mx-4 mt-3 flex-row items-center rounded-xl border border-amber-300 bg-amber-50 p-3">
      <Ionicons name="cloud-offline-outline" size={16} color="#B45309" />
      <Text className="ml-2 flex-1 text-sm text-amber-800">{message}</Text>
      {onRetry ? (
        <Text onPress={onRetry} className="ml-3 text-sm font-semibold text-amber-800 underline">
          {retryLabel}
        </Text>
      ) : null}
    </View>
  );
}
