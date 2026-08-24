import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { sanitiseDecimal, sanitiseInteger } from '../utils/money';

/**
 * `mode` picks the keyboard AND filters the text, because on Android a numeric
 * keyboard still lets a hardware/gboard user paste letters.
 *   money    -> decimal keypad, digits + one dot   (price, cost, discount)
 *   integer  -> number pad, digits only            (stock, quantity)
 *   pin      -> number pad, digits only, secure    (PRD 7, edge case 3)
 *   password -> full keyboard, secure, unfiltered  (admin password)
 */
export default function TextField({
  label, value, onChangeText, placeholder, mode = 'text', error, hint,
  maxLength, autoCapitalize = 'sentences', multiline = false, editable = true,
  prefix, className = '', autoFocus = false, accessibilityLabel,
}) {
  const [focused, setFocused] = useState(false);

  const keyboardType =
    mode === 'money' ? 'decimal-pad' : mode === 'integer' || mode === 'pin' ? 'number-pad' : 'default';
  const secure = mode === 'pin' || mode === 'password';

  const handleChange = (text) => {
    if (mode === 'money') return onChangeText(sanitiseDecimal(text));
    if (mode === 'integer' || mode === 'pin') return onChangeText(sanitiseInteger(text));
    onChangeText(text);
  };

  const borderClass = error
    ? 'border-red-400 bg-red-50'
    : focused
      ? 'border-blue-500 bg-white'
      : 'border-slate-300 bg-white';

  return (
    <View className={`mb-3 ${className}`}>
      {label ? <Text className="mb-1.5 text-sm font-medium text-slate-700">{label}</Text> : null}

      <View className={`flex-row items-center rounded-xl border px-3 ${borderClass} ${!editable ? 'opacity-60' : ''}`}>
        {prefix ? <Text className="mr-1 text-base text-slate-500">{prefix}</Text> : null}
        <TextInput
          value={value == null ? '' : String(value)}
          onChangeText={handleChange}
          placeholder={placeholder}
          placeholderTextColor="#94A3B8"
          keyboardType={keyboardType}
          secureTextEntry={secure}
          maxLength={maxLength ?? (mode === 'pin' ? 6 : undefined)}
          autoCapitalize={mode === 'text' ? autoCapitalize : 'none'}
          autoComplete={mode === 'password' ? 'password' : 'off'}
          autoCorrect={mode === 'text'}
          multiline={multiline}
          editable={editable}
          autoFocus={autoFocus}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          // Falls back to the visible label. A caller passes this when several
          // identical fields sit in one list and the label alone is ambiguous.
          accessibilityLabel={accessibilityLabel ?? label}
          className="flex-1 py-3 text-base text-slate-900"
          style={multiline ? { minHeight: 80, textAlignVertical: 'top' } : undefined}
        />
      </View>

      {error ? (
        <Text className="mt-1 text-xs text-red-600">{error}</Text>
      ) : hint ? (
        <Text className="mt-1 text-xs text-slate-500">{hint}</Text>
      ) : null}
    </View>
  );
}
