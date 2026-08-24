/**
 * Two things a missing translation key does NOT do: throw, or look obviously
 * broken in review. i18next renders the key path itself, so `settings.pinSet`
 * appears on the shopkeeper's screen looking almost like a label. This suite is
 * the only thing standing between a typo and that.
 *
 * It checks three claims:
 *   1. every t('...') literal in src/ resolves in English;
 *   2. Hindi and Gujarati have exactly the same key set as English;
 *   3. interpolation placeholders survive translation.
 *
 * Only literal keys are checked. A handful of call sites build the key at
 * runtime -- t(`range.${key}`) in the period filter, and the relativeAge helper
 * which returns its key -- so those are asserted separately against the lists
 * they can produce, rather than skipped and quietly trusted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, load } from './_paths.mjs';

const en = (await load('i18n/en.js')).default;
const hi = (await load('i18n/hi.js')).default;
const gu = (await load('i18n/gu.js')).default;
const { PRESET_KEYS } = await load('utils/dateRange.js', [
  ["import { toApiDate } from './money';", 'const toApiDate = () => "";'],
]);

let pass = 0, fail = 0;
const check = (label, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${label}`))
     : (fail++, console.log(`  FAIL  ${label}${extra !== undefined ? '  ' + String(extra).slice(0, 300) : ''}`));
};

const flat = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = String(v);
  }
  return out;
};

const E = flat(en), H = flat(hi), G = flat(gu);

/* ------------------------- 1. keys used in the app ------------------------- */
const SRC = path.join(ROOT, 'src');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
});

const files = walk(SRC);
check('found source files to scan', files.length > 15, files.length);

const used = new Map(); // key -> first file that used it
// Literal single/double-quoted keys only; template literals are handled below.
const RE = /\bt\(\s*'([A-Za-z0-9_.]+)'|\bt\(\s*"([A-Za-z0-9_.]+)"/g;
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(RE)) {
    const key = m[1] ?? m[2];
    if (!used.has(key)) used.set(key, path.relative(SRC, file));
  }
}
check('scanned a realistic number of literal keys', used.size > 100, used.size);

const missing = [...used].filter(([key]) => !(key in E));
check('every literal t() key exists in English',
  missing.length === 0, missing.map(([k, f]) => `${k} (${f})`).join(', '));

/* --------------------- 2. the computed keys, explicitly -------------------- */
// DateRangePicker renders t(`range.${key}`) for every preset.
const missingPresets = PRESET_KEYS.filter((k) => !(`range.${k}` in E));
check('every date-range preset has a label', missingPresets.length === 0, missingPresets.join(', '));

// relativeAge() returns the key for the offline staleness banner.
const AGE_KEYS = ['offline.justNow', 'offline.minutesAgo', 'offline.hoursAgo', 'offline.daysAgo'];
const missingAge = AGE_KEYS.filter((k) => !(k in E));
check('every relative-age key exists', missingAge.length === 0, missingAge.join(', '));

/* ------------------------------ 3. parity ------------------------------ */
const onlyIn = (a, b) => Object.keys(a).filter((k) => !(k in b));
check('Hindi has every English key', onlyIn(E, H).length === 0, onlyIn(E, H).join(', '));
check('Gujarati has every English key', onlyIn(E, G).length === 0, onlyIn(E, G).join(', '));
check('Hindi has no stray keys', onlyIn(H, E).length === 0, onlyIn(H, E).join(', '));
check('Gujarati has no stray keys', onlyIn(G, E).length === 0, onlyIn(G, E).join(', '));

const vars = (s) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((v) => v.replace(/[{}\s]/g, '')).sort().join(',');
const placeholderDrift = [];
for (const key of Object.keys(E)) {
  for (const [name, dict] of [['hi', H], ['gu', G]]) {
    if (dict[key] !== undefined && vars(E[key]) !== vars(dict[key])) {
      placeholderDrift.push(`${name}.${key}`);
    }
  }
}
check('interpolation placeholders survive translation',
  placeholderDrift.length === 0, placeholderDrift.join(', '));

/**
 * A translated value identical to the English one is nearly always a forgotten
 * string. Three keys legitimately repeat: the version number, the brand
 * lockup, and the example shop name in the rename placeholder.
 */
const ALLOW = new Set(['settings.version', 'settings.footer', 'settings.businessPlaceholder']);
const untranslated = [];
for (const [name, dict] of [['hi', H], ['gu', G]]) {
  for (const key of Object.keys(E)) {
    if (ALLOW.has(key) || !/[A-Za-z]{4,}/.test(E[key])) continue;
    if (dict[key] === E[key]) untranslated.push(`${name}.${key}`);
  }
}
check('no English strings left sitting in hi/gu', untranslated.length === 0, untranslated.join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
