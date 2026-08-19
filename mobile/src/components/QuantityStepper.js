import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * The Swiggy/Zomato pattern: an ADD button that becomes a −/count/+ control once
 * the item is in the cart.
 *
 * Both states occupy the same footprint so the card does not resize when the
 * first unit is added — otherwise the grid reflows under the operator's thumb
 * mid-tap, which is how you ring up the wrong item.
 */
export default function QuantityStepper({
  qty = 0, onAdd, onIncrement, onDecrement,
  addLabel = 'ADD', disabled = false, compact = false, itemLabel,
}) {
  const height = compact ? 30 : 34;
  // A grid of cards whose controls are all called "ADD" / "plus" tells a screen
  // reader user nothing about which product they are about to sell.
  const named = (base) => (itemLabel ? `${base} ${itemLabel}` : base);

  if (qty <= 0) {
    return (
      <Pressable
        onPress={onAdd}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={named(addLabel)}
        className={`w-full flex-row items-center justify-center rounded-lg border px-3 ${disabled ? 'border-slate-200 bg-slate-100' : 'border-blue-600 bg-white active:bg-blue-50'}`}
        style={{ height }}
      >
        <Ionicons name="add" size={compact ? 14 : 16} color={disabled ? '#94A3B8' : '#2563EB'} />
        <Text
          className={`ml-0.5 font-bold ${compact ? 'text-xs' : 'text-sm'} ${disabled ? 'text-slate-400' : 'text-blue-600'}`}
          numberOfLines={1}
        >
          {addLabel}
        </Text>
      </Pressable>
    );
  }

  /**
   * The minus and plus each take an equal share of the width and the count sits
   * centred between them. Previously all three hugged the left edge of a
   * full-width blue bar, which looked broken and wasted most of the tap area --
   * the two controls an operator uses constantly were the smallest targets on
   * the card.
   */
  return (
    <View
      className="w-full flex-row items-center overflow-hidden rounded-lg bg-blue-600"
      style={{ height }}
      accessibilityLabel={`${named(addLabel)}: ${qty}`}
    >
      <Pressable
        onPress={onDecrement}
        accessibilityRole="button"
        accessibilityLabel={named('minus')}
        className="h-full flex-1 items-center justify-center active:bg-blue-700"
      >
        <Ionicons name="remove" size={compact ? 16 : 18} color="#fff" />
      </Pressable>

      <Text
        className={`px-1 text-center font-bold text-white ${compact ? 'text-sm' : 'text-base'}`}
        style={{ minWidth: 26 }}
      >
        {qty}
      </Text>

      <Pressable
        onPress={onIncrement}
        accessibilityRole="button"
        accessibilityLabel={named('plus')}
        className="h-full flex-1 items-center justify-center active:bg-blue-700"
      >
        <Ionicons name="add" size={compact ? 16 : 18} color="#fff" />
      </Pressable>
    </View>
  );
}
