import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import { writeCacheFile, deliver, stamp, slug } from './exports';

/**
 * Getting a backup off the phone, and a backup file back on to it.
 *
 * The file is the whole point. A backup that only ever exists on the server it
 * is a backup OF protects against nothing, so this module is about the two
 * moments where it stops being that: writing it somewhere the shopkeeper
 * chooses, and reading one they hand back.
 */

export const BACKUP_MIME = 'application/json';

export function backupFilename(shopName, { images = false } = {}) {
  return `vyapaar-${slug(shopName)}-${stamp()}${images ? '-with-photos' : ''}.json`;
}

/**
 * Writes the backup to a file and hands it to the share sheet, or saves it into
 * a folder the operator picks (Android's Storage Access Framework).
 *
 * Returns the destination, or null if they backed out of the folder picker.
 */
export async function saveBackupFile(backup, shopName, { mode = 'save', images = false } = {}) {
  const filename = backupFilename(shopName, { images });
  const uri = writeCacheFile(filename, JSON.stringify(backup));
  return deliver(uri, { mimeType: BACKUP_MIME, filename, dialogTitle: filename, mode });
}

/**
 * Reads the text of a file the operator picked.
 *
 * Three different worlds. On web the picker hands back a real File object (and
 * a blob: uri that fetch can read). On native, fetch cannot open a file:// uri
 * at all -- it has to go through expo-file-system, whose File/Paths API is the
 * supported one in SDK 54 (the old readAsStringAsync shims on the main import
 * throw).
 */
export async function readPickedText(asset) {
  if (!asset?.uri && !asset?.file) throw new Error('No file was selected');

  if (Platform.OS === 'web') {
    if (asset.file?.text) return asset.file.text();
    const res = await fetch(asset.uri);
    return res.text();
  }
  return new File(asset.uri).text();
}

/**
 * Turns the text of a file into a backup object, or says what is wrong with it
 * in words a shopkeeper can act on.
 *
 * The checks here are deliberately about the FILE, not the data: whether the
 * server will accept the contents is the server's business, and it has the
 * counts checksum to do it with. What cannot be left to the server is telling
 * someone who picked the wrong file that they picked the wrong file.
 */
export function parseBackupText(text, { t } = {}) {
  const say = (key, fallback) => (t ? t(key) : fallback);

  if (!text || !text.trim()) {
    throw new Error(say('backup.errorEmpty', 'That file is empty'));
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(say('backup.errorNotJson', 'That is not a Vyapaar backup file'));
  }

  // The export wraps the backup in { ok, backup } when it comes straight off
  // the API; a saved file holds the backup itself. Accept either, because the
  // difference is invisible to whoever is holding the file.
  const backup = parsed?.backup ?? parsed;

  if (!backup || typeof backup !== 'object' || !backup.data || backup.version == null) {
    throw new Error(say('backup.errorNotBackup', 'That file is not a Vyapaar backup'));
  }
  return backup;
}

/** A one-line summary of what a picked file holds, shown before anything is applied. */
export function describeBackup(backup) {
  const c = backup?.counts ?? {};
  return {
    shopName: backup?.business?.name ?? null,
    exportedAt: backup?.exportedAt ?? null,
    includesImages: Boolean(backup?.includesImages),
    products: c.products ?? backup?.data?.products?.length ?? 0,
    orders: c.orders ?? backup?.data?.orders?.length ?? 0,
    categories: c.categories ?? backup?.data?.categories?.length ?? 0,
    expenses: c.expenses ?? backup?.data?.expenses?.length ?? 0,
  };
}

/** Rough human size of a backup, for the warning about including photos. */
export function approxSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
