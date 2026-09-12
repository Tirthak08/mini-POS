import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';

/**
 * The full version of a report section that the screen only had room to
 * summarise.
 *
 * The report cards show the top few categories and products because a phone
 * cannot usefully render forty bars. That is the right default and the wrong
 * ceiling: the question "which of my products actually lost money" is answered
 * by the rows that did NOT make the top eight. This is where they live.
 *
 * Full-screen rather than a centred dialog, because unlike the forms this is a
 * long list to be read and scrolled, not a short decision to be made.
 */
export default function DetailModal({
  visible, onClose, title, subtitle, columns, rows, totals, totalsLabel, emptyLabel, footnote,
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View className="flex-1 bg-slate-50" style={{ paddingTop: insets.top }}>
        <View className="flex-row items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
          <View className="flex-1 pr-2">
            <Text className="text-lg font-bold text-slate-900" numberOfLines={1} accessibilityRole="header">
              {title}
            </Text>
            {subtitle ? <Text className="mt-0.5 text-xs text-slate-500" numberOfLines={1}>{subtitle}</Text> : null}
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          >
            <Ionicons name="close" size={24} color="#64748B" />
          </Pressable>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ padding: 16, paddingBottom: 32 + insets.bottom }}
        >
          <View className="rounded-2xl border border-slate-200 bg-white p-3">
            <DataTable
              columns={columns}
              rows={rows}
              totals={totals}
              totalsLabel={totalsLabel}
              emptyLabel={emptyLabel}
            />
          </View>
          {footnote ? (
            <Text className="mt-3 px-1 text-xs text-slate-400">{footnote}</Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
