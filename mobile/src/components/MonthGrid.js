import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatDate } from '../utils/money';
import { startOfDay, sameDay, WEEK_STARTS_ON } from '../utils/dateRange';

/**
 * The month grid shared by the report period picker (a RANGE) and the expense
 * date field (a SINGLE day).
 *
 * It lives on its own because both need the same three fiddly things to be
 * right -- the lead padding, the week's first column, and "no future dates" --
 * and a second hand-rolled copy is how those quietly drift apart. `to` being
 * optional is what makes it serve both: pass one date and it highlights one
 * day, pass two and it paints the span between them.
 *
 * The calendar is hand-built out of plain Views rather than pulling in
 * @react-native-community/datetimepicker, for two reasons: that package has no
 * real web renderer (so the browser test harness could not drive it), and its
 * native dialog is one-date-at-a-time, which makes picking a *range* a
 * four-tap affair.
 */

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Rotated by WEEK_STARTS_ON so the grid's first column is the same day the
 * "This week" preset starts on. Hard-coding the order here once let the two
 * disagree about which day a week begins.
 */
export const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  ['S', 'M', 'T', 'W', 'T', 'F', 'S'][(i + WEEK_STARTS_ON) % 7]);

/** Calendar cells for a month, padded with nulls so week rows line up. */
export function monthCells(year, month) {
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const lead = (first.getDay() - WEEK_STARTS_ON + 7) % 7;
  const cells = Array(lead).fill(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export default function MonthGrid({ year, month, from, to, maxDate, onPick }) {
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

/**
 * The month header with its two arrows. Shared so both callers agree that you
 * cannot step past the current month -- a future expense is refused by the
 * server, and a future sales report is empty by definition.
 */
export function MonthHeader({ cursor, onStep, maxDate, prevLabel, nextLabel }) {
  const cap = maxDate ?? new Date();
  const atCap = cursor.year === cap.getFullYear() && cursor.month === cap.getMonth();

  return (
    <View className="mb-2 flex-row items-center justify-between">
      <Pressable
        onPress={() => onStep(-1)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={prevLabel}
        className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
      >
        <Ionicons name="chevron-back" size={20} color="#334155" />
      </Pressable>

      <Text className="text-base font-semibold text-slate-800">
        {MONTH_NAMES[cursor.month]} {cursor.year}
      </Text>

      <Pressable
        onPress={() => onStep(1)}
        disabled={atCap}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={nextLabel}
        accessibilityState={{ disabled: atCap }}
        className={`h-9 w-9 items-center justify-center rounded-full active:bg-slate-100 ${atCap ? 'opacity-30' : ''}`}
      >
        <Ionicons name="chevron-forward" size={20} color="#334155" />
      </Pressable>
    </View>
  );
}
