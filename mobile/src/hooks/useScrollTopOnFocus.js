import { useCallback, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';

/**
 * Returns a ref to attach to a scrollable, which jumps back to the top each
 * time the screen regains focus.
 *
 * React Navigation keeps every tab MOUNTED, which is what makes switching
 * instant -- but it also means a screen keeps whatever scroll offset it had.
 * Come back to Stock after browsing to the bottom of a long catalogue and you
 * land in the middle of it, with no indication that there is anything above.
 * On Reports it is worse: the figures that answer "how did today go" are at the
 * very top, and returning to the tab showed a chart instead.
 *
 * Handles both list types because the app uses both -- FlatList exposes
 * scrollToOffset, ScrollView exposes scrollTo, and neither responds to the
 * other's method.
 *
 * Not animated: an animation here would read as the screen moving on its own
 * after you arrived. Instant looks like the screen was simply already at the
 * top, which is what a fresh screen should look like.
 */
export function useScrollTopOnFocus() {
  const ref = useRef(null);

  useFocusEffect(
    useCallback(() => {
      const node = ref.current;
      if (!node) return;

      // Wrapped because both calls throw if the list has not laid out yet --
      // which happens on the very first focus, before any content exists.
      try {
        if (typeof node.scrollToOffset === 'function') {
          node.scrollToOffset({ offset: 0, animated: false });
        } else if (typeof node.scrollTo === 'function') {
          node.scrollTo({ y: 0, animated: false });
        }
      } catch {
        // A list that cannot be scrolled yet is already at the top.
      }
    }, [])
  );

  return ref;
}

export default useScrollTopOnFocus;
