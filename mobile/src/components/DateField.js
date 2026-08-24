import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import Button from './Button';
import MonthGrid, { MonthHeader } from './MonthGrid';
import { formatDate } from '../utils/money';
import { startOfDay, sameDay } from '../utils/dateRange';

const dayBefore = (d, n = 1) => {
  const out = startOfDay(d);
  out.setDate(out.getDate() - n);
  return out;
};

/**
 * Picks ONE past date. Built for the expense form, where the date is usually
 * today and occasionally yesterday.
 *
 * That distribution is the whole design. Two taps for the common case would be
 * a calendar; here Today and Yesterday are one tap each and already selected by
 * default, and the calendar is only opened for the genuine catch-up case --
 * last week's electricity bill found in a drawer.
 *
 * Future dates are refused, matching the server, which rejects anything more
 * than a day ahead. A shop cannot have spent money it has not spent yet, and
 * letting one through would move money into a period whose report was already
 * read and trusted.
 */
export default function DateField({ label, value, onChange, hint }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const today = startOfDay(new Date());
  const yesterday = dayBefore(today);
  const selected = value ? startOfDay(value) : today;

  const isToday = sameDay(selected, today);
  const isYesterday = sameDay(selected, yesterday);
  const isOther = !isToday && !isYesterday;

  const [cursor, setCursor] = useState(() => ({
    year: selected.getFullYear(), month: selected.getMonth(),
  }));

  const step = (delta) => setCursor((c) => {
    const d = new Date(c.year, c.month + delta, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const Chip = ({ active, onPress, children, accessibilityLabel }) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={accessibilityLabel}
      className={`flex-1 flex-row items-center justify-center rounded-xl border py-2.5 ${
        active ? 'border-blue-600 bg-blue-600' : 'border-slate-300 bg-white'
      }`}
    >
      {children}
    </Pressable>
  );

  // Indic labels measure narrower than they draw on Android, so an explicit
  // lineHeight and one line keeps a Gujarati chip from clipping its descenders.
  const chipText = (active) =>
    `text-sm font-semibold ${active ? 'text-white' : 'text-slate-600'}`;

  return (
    <View className="mb-3">
      {label ? <Text className="mb-1.5 text-sm font-medium text-slate-700">{label}</Text> : null}

      <View className="flex-row gap-2">
        <Chip active={isToday} onPress={() => onChange(today)} accessibilityLabel={t('expenses.today')}>
          <Text className={chipText(isToday)} numberOfLines={1} style={{ lineHeight: 20 }}>
            {t('expenses.today')}
          </Text>
        </Chip>
        <Chip active={isYesterday} onPress={() => onChange(yesterday)} accessibilityLabel={t('range.yesterday')}>
          <Text className={chipText(isYesterday)} numberOfLines={1} style={{ lineHeight: 20 }}>
            {t('range.yesterday')}
          </Text>
        </Chip>
        <Chip
          active={isOther}
          onPress={() => { setCursor({ year: selected.getFullYear(), month: selected.getMonth() }); setOpen(true); }}
          accessibilityLabel={t('expenses.pickDate')}
        >
          <Ionicons name="calendar-outline" size={15} color={isOther ? '#FFFFFF' : '#475569'} />
          <Text className={`ml-1.5 ${chipText(isOther)}`} numberOfLines={1} style={{ lineHeight: 20 }}>
            {isOther ? formatDate(selected) : t('expenses.pickDate')}
          </Text>
        </Chip>
      </View>

      {hint ? <Text className="mt-1 text-xs text-slate-500">{hint}</Text> : null}

      <Modal visible={open} animationType="fade" transparent onRequestClose={() => setOpen(false)}>
        <View className="flex-1 items-center justify-center px-4">
          <Pressable
            className="absolute inset-0 bg-black/50"
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          />
          <View className="w-full max-w-md overflow-hidden rounded-3xl bg-white" style={{ elevation: 12 }}>
            <View className="flex-row items-center justify-between border-b border-slate-200 px-5 py-4">
              <Text className="text-lg font-bold text-slate-900" accessibilityRole="header">
                {t('expenses.pickDate')}
              </Text>
              <Pressable
                onPress={() => setOpen(false)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t('common.close')}
              >
                <Ionicons name="close" size={22} color="#64748B" />
              </Pressable>
            </View>

            <View className="px-5 pt-3">
              <MonthHeader
                cursor={cursor}
                onStep={step}
                maxDate={today}
                prevLabel={t('range.prevMonth')}
                nextLabel={t('range.nextMonth')}
              />
              {/* One date: `from` marks it and `to` is left out, which is what
                  makes the shared grid highlight a single day rather than a span. */}
              <MonthGrid
                year={cursor.year}
                month={cursor.month}
                from={selected}
                maxDate={today}
                onPick={(day) => { onChange(startOfDay(day)); setOpen(false); }}
              />
            </View>

            <View className="px-5 pb-5 pt-3">
              <Button title={t('common.cancel')} variant="secondary" onPress={() => setOpen(false)} fullWidth />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
