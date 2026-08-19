import { useState } from 'react';
import { ActivityIndicator, Image, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Button from './Button';
import { useAuthStore } from '../store/authStore';
import { API_BASE_URL } from '../api/client';

/**
 * Renders a product photo from the API, or a placeholder when there is none.
 *
 * The token goes in the query string rather than a header: React Native's
 * <Image> cannot attach headers on every platform, and a plain URL is what lets
 * the OS image cache do its job. The route accepts ?token= for GET only.
 */
export function productImageSource(imageUrl, token) {
  if (!imageUrl || !token) return null;
  const path = imageUrl.startsWith('/') ? imageUrl : `/${imageUrl}`;
  return { uri: `${API_BASE_URL}${path}?token=${encodeURIComponent(token)}` };
}

export default function ProductImage({
  imageUrl, localUri, size = 56, rounded = 'rounded-xl', iconSize, className = '', fill = false,
}) {
  const token = useAuthStore((s) => s.token);
  const [status, setStatus] = useState('idle'); // idle | loading | error

  // A freshly picked local file shows instantly; otherwise fetch from the API.
  const source = localUri ? { uri: localUri } : productImageSource(imageUrl, token);
  // `fill` lets the parent size the tile with classes (e.g. aspect-square w-full)
  // instead of a fixed pixel box.
  const box = fill ? undefined : { width: size, height: size };
  // resizeMode duplicated into style: the bare prop does not always reach
  // object-fit, which silently stretches the photo.
  const inner = fill
    ? { width: '100%', height: '100%', resizeMode: 'cover' }
    : { width: size, height: size, resizeMode: 'cover' };
  const glyph = iconSize ?? (fill ? 28 : Math.round(size * 0.42));

  if (!source || status === 'error') {
    return (
      <View className={`items-center justify-center bg-slate-100 ${rounded} ${className}`} style={box}>
        <Ionicons name="image-outline" size={glyph} color="#94A3B8" />
      </View>
    );
  }

  return (
    <View className={`overflow-hidden bg-slate-100 ${rounded} ${className}`} style={box}>
      <Image
        source={source}
        style={inner}
        resizeMode="cover"
        onLoadStart={() => setStatus('loading')}
        onLoad={() => setStatus('idle')}
        onError={() => setStatus('error')}
        accessibilityIgnoresInvertColors
      />
      {status === 'loading' ? (
        <View className="absolute inset-0 items-center justify-center">
          <ActivityIndicator size="small" color="#94A3B8" />
        </View>
      ) : null}
    </View>
  );
}

/** Square photo slot used in the product form, with take / choose / remove. */
export function ImagePickerTile({
  imageUrl, localUri, uploading, onCamera, onGallery, onRemove,
  label, uploadingLabel, cameraLabel, galleryLabel, removeLabel,
}) {
  const hasPhoto = Boolean(localUri || imageUrl);

  return (
    <View className="mb-4">
      {label ? <Text className="mb-1.5 text-sm font-medium text-slate-700">{label}</Text> : null}

      <View className="flex-row items-start">
        <ProductImage imageUrl={imageUrl} localUri={localUri} size={88} rounded="rounded-2xl" />

        <View className="ml-3 flex-1">
          {uploading ? (
            <View className="flex-row items-center py-2">
              <ActivityIndicator size="small" color="#2563EB" />
              <Text className="ml-2 text-sm text-slate-500">{uploadingLabel}</Text>
            </View>
          ) : (
            <>
              <View className="flex-row gap-2">
                <View className="flex-1">
                  <Button title={cameraLabel} icon="camera" variant="secondary" size="sm" onPress={onCamera} fullWidth />
                </View>
                <View className="flex-1">
                  <Button title={galleryLabel} icon="images" variant="secondary" size="sm" onPress={onGallery} fullWidth />
                </View>
              </View>
              {hasPhoto ? (
                <View className="mt-2">
                  <Button title={removeLabel} icon="trash-outline" variant="ghost" size="sm" onPress={onRemove} />
                </View>
              ) : null}
            </>
          )}
        </View>
      </View>
    </View>
  );
}
