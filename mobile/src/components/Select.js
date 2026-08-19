import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

/**
 * A dropdown: a field showing the current choice, which opens a sheet listing
 * every option. Replaces the horizontal chip rows.
 *
 * Chips looked tidy with three short English words and fell apart everywhere
 * else. Options past the fourth scrolled off the right edge with nothing to
 * say they existed, and a Gujarati label like "ગયા મહિને" was wider than the
 * chip it had to fit, so Android wrapped it at the space and clipped the second
 * line -- the label silently became "ગયા". A dropdown fixes the cause rather
 * than the symptom: the option list is full-width, so a long label has room to
 * render whole, and nothing is hidden off-screen.
 *
 * Text that must never be truncated carries an explicit lineHeight. Devanagari
 * and Gujarati matras sit outside the box the font metrics report, so a line
 * height derived from those metrics clips them.
 */

/** 15/16px text: ~1.4x clears matras and descenders. */
const ROW_LINE_HEIGHT = 22;
/** Past this many options, scanning beats scrolling -- offer a filter box. */
const SEARCH_THRESHOLD = 8;

export default function Select({
  label,
  value,
  options = [],
  onChange,
  placeholder,
  error,
  hint,
  disabled = false,
  className = '',
  accessibilityLabel,
  sheetTitle,
  searchable,
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = useMemo(
    () => options.find((o) => String(o.value) === String(value)) ?? null,
    [options, value]
  );

  // Auto past the threshold, but a caller can force it off: a search box over
  // ten fixed period presets is noise, and it costs the list a row of height
  // that "Custom" needs to be visible without scrolling.
  const showSearch = searchable ?? options.length > SEARCH_THRESHOLD;
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return options;
    return options.filter((o) => String(o.label).toLowerCase().includes(term));
  }, [options, query]);

  const close = () => { setOpen(false); setQuery(''); };

  const borderClass = error
    ? 'border-red-400 bg-red-50'
    : open
      ? 'border-blue-500 bg-white'
      : 'border-slate-300 bg-white';

  return (
    <View className={`mb-3 ${className}`}>
      {label ? <Text className="mb-1.5 text-sm font-medium text-slate-700">{label}</Text> : null}

      <Pressable
        onPress={() => !disabled && setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
        // Includes the current choice, so a screen reader announces the state
        // and automation can tell two dropdowns apart by what they hold.
        accessibilityLabel={accessibilityLabel ?? `${label ?? ''}${label ? ': ' : ''}${selected?.label ?? placeholder ?? ''}`}
        accessibilityState={{ disabled, expanded: open }}
        style={{ minHeight: 48 }}
        className={`flex-row items-center rounded-xl border px-3 ${borderClass} ${disabled ? 'opacity-60' : ''}`}
      >
        {selected?.color ? (
          <View className="mr-2 h-2.5 w-2.5 rounded-full" style={{ backgroundColor: selected.color }} />
        ) : selected?.icon ? (
          <Ionicons name={selected.icon} size={15} color="#475569" style={{ marginRight: 6 }} />
        ) : null}

        <Text
          numberOfLines={1}
          style={{ lineHeight: ROW_LINE_HEIGHT }}
          className={`flex-1 text-base ${selected ? 'text-slate-900' : 'text-slate-400'}`}
        >
          {selected?.label ?? placeholder ?? ''}
        </Text>

        <Ionicons name="chevron-down" size={18} color="#64748B" />
      </Pressable>

      {error ? (
        <Text className="mt-1 text-xs text-red-600">{error}</Text>
      ) : hint ? (
        <Text className="mt-1 text-xs text-slate-500">{hint}</Text>
      ) : null}

      <Modal visible={open} animationType="slide" transparent onRequestClose={close}>
        <View className="flex-1 justify-end bg-black/40">
          <Pressable className="flex-1" onPress={close} accessibilityLabel={t('common.close')} />
          <View className="max-h-[75%] rounded-t-3xl bg-white pb-6">
            <View className="flex-row items-center justify-between border-b border-slate-200 px-5 py-4">
              <Text className="text-lg font-bold text-slate-900" accessibilityRole="header">
                {sheetTitle ?? label ?? ''}
              </Text>
              <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.close')}>
                <Ionicons name="close" size={22} color="#64748B" />
              </Pressable>
            </View>

            {showSearch ? (
              <View className="px-5 pt-3">
                <View className="flex-row items-center rounded-xl border border-slate-300 bg-white px-3">
                  <Ionicons name="search" size={16} color="#94A3B8" />
                  <TextInput
                    value={query}
                    onChangeText={setQuery}
                    placeholder={t('common.search')}
                    placeholderTextColor="#94A3B8"
                    className="ml-2 flex-1 py-2.5 text-base text-slate-900"
                    autoCorrect={false}
                  />
                </View>
              </View>
            ) : null}

            <FlatList
              data={visible}
              keyExtractor={(item) => String(item.value)}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingVertical: 4 }}
              ListEmptyComponent={
                <Text className="px-5 py-6 text-center text-sm text-slate-400">{t('common.none')}</Text>
              }
              renderItem={({ item }) => {
                const active = String(item.value) === String(value);
                return (
                  <Pressable
                    onPress={() => { onChange(item.value); close(); }}
                    accessibilityRole="button"
                    accessibilityLabel={item.label}
                    accessibilityState={{ selected: active }}
                    style={{ minHeight: 52 }}
                    className={`flex-row items-center px-5 ${active ? 'bg-blue-50' : 'active:bg-slate-100'}`}
                  >
                    {item.color ? (
                      <View className="mr-3 h-3 w-3 rounded-full" style={{ backgroundColor: item.color }} />
                    ) : item.icon ? (
                      <Ionicons name={item.icon} size={17} color="#475569" style={{ marginRight: 10 }} />
                    ) : null}

                    <View className="flex-1 pr-2">
                      {/* No numberOfLines: the sheet is full-width, so a long
                          label wraps onto a second line instead of being cut. */}
                      <Text
                        style={{ lineHeight: ROW_LINE_HEIGHT }}
                        className={`text-base ${active ? 'font-semibold text-blue-700' : 'text-slate-800'}`}
                      >
                        {item.label}
                      </Text>
                      {item.sub ? (
                        <Text className="mt-0.5 text-xs text-slate-400">{item.sub}</Text>
                      ) : null}
                    </View>

                    {active ? <Ionicons name="checkmark" size={20} color="#2563EB" /> : null}
                  </Pressable>
                );
              }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}
