import { Text, View } from 'react-native';

/**
 * A small read-only table with an optional totals row.
 *
 * Shared by the export preview and the report detail views, because they show
 * the same numbers and a second implementation would eventually disagree with
 * the first. It is deliberately plain Views rather than a grid library: the
 * columns here are few and fixed, and the one thing that must be right --
 * numbers aligning under each other -- is a matter of tabular figures and a
 * right-aligned cell, not of a layout engine.
 *
 * @param columns [{ key, label, align, width, flex, tone }]
 * @param rows    plain objects keyed by column key
 * @param totals  one more object, rendered beneath a rule
 */
export default function DataTable({
  columns = [], rows = [], totals = null, totalsLabel = 'Total', emptyLabel,
}) {
  const cellStyle = (col) => (col.width ? { width: col.width } : { flex: col.flex ?? 1 });

  const align = (col) => (col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left');

  const toneClass = (tone, value) => {
    if (tone === 'positive') return 'text-green-600';
    if (tone === 'negative') return 'text-red-600';
    // `auto` colours by sign, which is what a profit column wants: a negative
    // figure that reads the same as a positive one is the easiest number in a
    // report to miss.
    if (tone === 'auto') return Number(value) < 0 ? 'text-red-600' : 'text-slate-800';
    return 'text-slate-800';
  };

  if (!rows.length) {
    return (
      <Text className="py-5 text-center text-sm text-slate-400">{emptyLabel ?? '—'}</Text>
    );
  }

  return (
    <View>
      <View className="flex-row border-b border-slate-200 pb-1.5">
        {columns.map((col) => (
          <Text
            key={col.key}
            style={cellStyle(col)}
            className={`text-[11px] font-bold uppercase tracking-wide text-slate-400 ${align(col)}`}
            numberOfLines={1}
          >
            {col.label}
          </Text>
        ))}
      </View>

      {rows.map((row, i) => (
        <View
          key={row.__key ?? i}
          className={`flex-row py-2 ${i > 0 ? 'border-t border-slate-100' : ''}`}
        >
          {columns.map((col) => (
            <Text
              key={col.key}
              style={cellStyle(col)}
              className={`text-[13px] ${align(col)} ${toneClass(col.tone, row[col.key])}`}
              // Two lines, not one: a product name is the column most likely to
              // be long, and truncating it makes the row useless.
              numberOfLines={col.key === 'name' ? 2 : 1}
            >
              {row[`${col.key}Display`] ?? row[col.key] ?? ''}
            </Text>
          ))}
        </View>
      ))}

      {totals ? (
        /* Double rule and a tinted ground, so the bottom line is never mistaken
           for one more row of data. */
        <View className="mt-1 flex-row border-t-2 border-slate-300 bg-slate-50 py-2.5">
          {columns.map((col, i) => (
            <Text
              key={col.key}
              style={cellStyle(col)}
              className={`text-[13px] font-bold ${align(col)} ${toneClass(col.tone, totals[col.key])}`}
              numberOfLines={1}
            >
              {i === 0 && totals[col.key] == null && totals[`${col.key}Display`] == null
                ? totalsLabel
                : (totals[`${col.key}Display`] ?? totals[col.key] ?? '')}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
