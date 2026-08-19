import { useMemo, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import Button from './Button';
import Select from './Select';
import { formatDate } from '../utils/money';
import {
  PRESET_KEYS, resolveRange, startOfDay, endOfDay, sameDay, describeRange, WEEK_STARTS_ON,
} from '../utils/dateRange';

/**
 * The period filter shared by Reports and Sales (PRD 6).
 *
 * The calendar is hand-built out of plain Views rather than pulling in
 * @react-native-community/datetimepicker, for two reasons: that package has no
 * real web renderer (so the browser test harness could not drive it), and its
 * native dialog is one-date-at-a-time, which makes picking a *range* a
 * four-tap affair. A month grid lets the operator tap start and end.
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
/**
 * Rotated by WEEK_STARTS_ON so the grid's first column is the same day the
 * "This week" preset starts on. Hard-coding the order here once let the two
 * disagree about which day a week begins.
 */
const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  ['S', 'M', 'T', 'W', 'T', 'F', 'S'][(i + WEEK_STARTS_ON) % 7]);

/** Calendar cells for a month, padded with nulls so week rows line up. */
function monthCells(year, month) {
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const lead = (first.getDay() - WEEK_STARTS_ON + 7) % 7;
  const cells = Array(lead).fill(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function MonthGrid({ year, month, from, to, maxDate, onPick }) {
  const cells = useMemo(() => monthCells(year, month), [year, month]);
  const rows = useMemo(() => {
    const out = [];
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
    return out;
  }, [cells]);

  return (
    <View>
      <View className="mb-1 flex-row">
        {WEEKDAYS.map((w, i) => (
          <View key={i} className="flex-1 items-center py-1">
            <Text className="text-xs font-semibold text-slate-400">{w}</Text>
          </View>
        ))}
      </View>

      {rows.map((row, ri) => (
        <View key={ri} className="flex-row">
          {row.map((day, ci) => {
            if (!day) return <View key={ci} className="flex-1 py-1" />;

            const disabled = maxDate && startOfDay(day) > startOfDay(maxDate);
            const isStart = sameDay(day, from);
            const isEnd = sameDay(day, to);
            const inside = from && to && day > from && day < to;
            const edge = isStart || isEnd;

            return (
              <Pressable
                key={ci}
                onPress={() => !disabled && onPick(day)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={formatDate(day)}
                accessibilityState={{ disabled: !!disabled, selected: edge || !!inside }}
                className="flex-1 items-center py-1"
              >
                <View
                  className={`h-9 w-9 items-center justify-center rounded-full ${
                    edge ? 'bg-blue-600' : inside ? 'bg-blue-100' : ''
                  }`}
                >
                  <Text
                    className={`text-sm ${
                      disabled
                        ? 'text-slate-300'
                        : edge
                          ? 'font-bold text-white'
                          : inside
                            ? 'font-semibold text-blue-700'
                            : 'text-slate-700'
                    }`}
                  >
                    {day.getDate()}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function CustomRangeSheet({ visible, initial, onCancel, onApply }) {
  const { t } = useTranslation();
  const today = startOfDay(new Date());

  const [cursor, setCursor] = useState(() => {
    const base = initial?.from ?? today;
    return { year: base.getFullYear(), month: base.getMonth() };
  });
  const [from, setFrom] = useState(() => (initial?.from ? startOfDay(initial.from) : null));
  const [to, setTo] = useState(() => (initial?.to ? startOfDay(initial.to) : null));

  /** First tap starts a fresh range; second tap closes it. */
  const pick = (day) => {
    if (!from || (from && to)) {
      setFrom(day);
      setTo(null);
      return;
    }
    if (day < from) {
      setTo(from);
      setFrom(day);
    } else {
      setTo(day);
    }
  };

  const step = (delta) => {
    setCursor((c) => {
      const d = new Date(c.year, c.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };

  // A single tapped day is a legitimate one-day range, so `to` falling back to
  // `from` is intentional rather than an incomplete selection.
  const canApply = !!from;
  const preview = from ? `${formatDate(from)} – ${formatDate(to ?? from)}` : t('range.pickStart');
  const atCurrentMonth =
    cursor.year === today.getFullYear() && cursor.month === today.getMonth();

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-black/40">
        <Pressable className="flex-1" onPress={onCancel} accessibilityLabel="Close" />
        <View className="rounded-t-3xl bg-white pb-6">
          <View className="flex-row items-center justify-between border-b border-slate-200 px-5 py-4">
            <Text className="text-lg font-bold text-slate-900" accessibilityRole="header">
              {t('range.customTitle')}
            </Text>
            <Pressable onPress={onCancel} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
              <Ionicons name="close" size={22} color="#64748B" />
            </Pressable>
          </View>

          <View className="px-5 pt-3">
            <Text className="mb-3 text-center text-sm font-semibold text-blue-700">{preview}</Text>

            <View className="mb-2 flex-row items-center justify-between">
              <Pressable
                onPress={() => step(-1)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t('range.prevMonth')}
                className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
              >
                <Ionicons name="chevron-back" size={20} color="#334155" />
              </Pressable>
              <Text className="text-base font-semibold text-slate-800">
                {MONTH_NAMES[cursor.month]} {cursor.year}
              </Text>
              <Pressable
                onPress={() => step(1)}
                disabled={atCurrentMonth}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t('range.nextMonth')}
                accessibilityState={{ disabled: atCurrentMonth }}
                className={`h-9 w-9 items-center justify-center rounded-full active:bg-slate-100 ${atCurrentMonth ? 'opacity-30' : ''}`}
              >
                <Ionicons name="chevron-forward" size={20} color="#334155" />
              </Pressable>
            </View>

            <MonthGrid
              year={cursor.year}
              month={cursor.month}
              from={from}
              to={to}
              maxDate={today}
              onPick={pick}
            />
          </View>

          <View className="mt-3 flex-row gap-3 border-t border-slate-100 px-5 pt-3">
            <View className="flex-1">
              <Button title={t('common.cancel')} variant="secondary" onPress={onCancel} fullWidth />
            </View>
            <View className="flex-1">
              <Button
                title={t('range.apply')}
                onPress={() => onApply({ from, to: to ?? from })}
                disabled={!canApply}
                fullWidth
              />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * @param value  the resolved range currently in effect
 * @param onChange called with a fresh resolved range
 */
export default function DateRangePicker({ value, onChange, className = '' }) {
  const { t } = useTranslation();
  const [sheetOpen, setSheetOpen] = useState(false);

  const choose = (key) => {
    if (key === 'custom') return setSheetOpen(true);
    onChange(resolveRange(key));
  };

  return (
    <View className={className}>
      {/* A dropdown, not a chip row: eight presets never fit across a phone,
          and the ones past the fourth were scrolled out of sight with nothing
          to hint they existed. */}
      <Select
        className="mb-0 px-4 pt-3"
        label={t('range.period')}
        value={value?.key}
        options={PRESET_KEYS.map((key) => ({
          value: key,
          label: t(`range.${key}`),
          icon: key === 'custom' ? 'calendar-outline' : undefined,
        }))}
        onChange={choose}
        sheetTitle={t('range.period')}
        // Ten fixed presets are read, not searched.
        searchable={false}
      />

      {/* The pill alone does not say which dates are in play once you leave the
          obvious presets, so the resolved range is always spelled out. */}
      <Text className="px-4 pb-2 text-xs text-slate-400">
        {t('range.showing')}: {describeRange(value, t, formatDate)}
      </Text>

      {sheetOpen ? (
        <CustomRangeSheet
          visible
          initial={value?.key === 'custom' ? value : null}
          onCancel={() => setSheetOpen(false)}
          onApply={({ from, to }) => {
            setSheetOpen(false);
            onChange(resolveRange('custom', { custom: { from, to } }));
          }}
        />
      ) : null}
    </View>
  );
}
