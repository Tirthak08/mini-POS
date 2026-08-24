import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import Button from './Button';
import Select from './Select';
import MonthGrid, { MonthHeader } from './MonthGrid';
import { formatDate } from '../utils/money';
import {
  PRESET_KEYS, resolveRange, startOfDay, describeRange,
} from '../utils/dateRange';

/**
 * The period filter shared by Reports and Sales (PRD 6).
 *
 * The month grid itself lives in MonthGrid.js -- the expense date field needs
 * the same calendar for a single day, and two copies would drift.
 */

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

            <MonthHeader
              cursor={cursor}
              onStep={step}
              maxDate={today}
              prevLabel={t('range.prevMonth')}
              nextLabel={t('range.nextMonth')}
            />

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
