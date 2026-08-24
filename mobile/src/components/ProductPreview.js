import { Image, Modal, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import QuantityStepper from './QuantityStepper';
import { productImageSource } from './ProductImage';
import { useAuthStore } from '../store/authStore';
import { formatINR } from '../utils/money';

/**
 * Full-screen look at one product.
 *
 * Tapping a card used to add it to the cart, which made the photo useless -- you
 * could not inspect a ring without also selling one. Now the card opens this,
 * and only the ADD control changes the cart.
 */
export default function ProductPreview({ product, qty = 0, onClose, onAdd, onIncrement, onDecrement }) {
  const { t } = useTranslation();
  const token = useAuthStore((s) => s.token);

  if (!product) return null;

  const source = productImageSource(product.imageUrl, token);
  const out = (product.stock ?? 0) <= 0;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 bg-black/95">
        <SafeAreaView className="flex-1" edges={['top', 'bottom', 'left', 'right']}>
          <View className="flex-row items-start justify-between px-4 pb-2 pt-2">
            <View className="flex-1 pr-3">
              <Text className="text-lg font-bold text-white" numberOfLines={2}>{product.name}</Text>
              {product.category ? (
                <Text className="mt-0.5 text-xs text-slate-400">{product.category}</Text>
              ) : null}
            </View>
            <Pressable
              onPress={onClose}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
              className="rounded-full bg-white/10 p-2"
            >
              <Ionicons name="close" size={22} color="#fff" />
            </Pressable>
          </View>

          {/* Tapping the backdrop closes, as in any photo viewer. */}
          <Pressable className="flex-1 items-center justify-center px-4" onPress={onClose}>
            {source ? (
              <Image
                source={source}
                // resizeMode is also set in `style`: as a bare prop it does not
                // reach object-fit on every platform, and the photo ends up
                // stretched to the box instead of fitted inside it.
                style={{ width: '100%', height: '100%', resizeMode: 'contain' }}
                resizeMode="contain"
                accessibilityLabel={product.name}
                accessibilityIgnoresInvertColors
              />
            ) : (
              <View className="items-center">
                <Ionicons name="image-outline" size={64} color="#475569" />
                <Text className="mt-3 text-sm text-slate-400">{t('inventory.photo')}</Text>
              </View>
            )}
          </Pressable>

          <View className="px-4 pb-2 pt-3">
            <View className="mb-3 flex-row items-end justify-between">
              <Text className="text-2xl font-bold text-white">{formatINR(product.price)}</Text>
              <Text className={`text-sm ${out ? 'text-red-400' : 'text-slate-300'}`}>
                {out ? t('pos.outOfStock') : `${product.stock} ${t('pos.left')}`}
              </Text>
            </View>

            {onAdd ? (
              <QuantityStepper
                qty={qty}
                addLabel={t('pos.addToCart')}
                itemLabel={product.name}
                disabled={out}
                onAdd={onAdd}
                onIncrement={onIncrement}
                onDecrement={onDecrement}
              />
            ) : null}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
