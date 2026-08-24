/**
 * Where the app's source lives, and where Playwright lives.
 *
 * Both used to be absolute paths into the machine the suites were written on
 * (`/root/posapp/...`, `/home/claude/.npm-global/...`). They ran there and
 * nowhere else -- shipped to the actual project folder, every one of them died
 * with EACCES on a path that did not exist. A test that only runs on one
 * machine is not a test the project owns.
 *
 * `src()` resolves against this file, so the suites work from any checkout.
 * `playwright()` tries the project's own dependency first and falls back to a
 * global install, and when neither is there it says so in one line instead of a
 * module-resolution stack.
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ROOT = path.resolve(import.meta.dirname, '..');

/** Absolute path to a file under mobile/src, e.g. src('utils/money.js'). */
export const src = (rel) => path.join(ROOT, 'src', rel);

/**
 * Read a source file and evaluate it with its imports rewritten.
 *
 * Metro resolves extensionless imports and app code is written for Metro, so
 * plain Node cannot import it directly. Substituting the import line is what
 * lets a suite test the REAL file rather than a copy that can drift from it.
 */
export const load = async (rel, subs = []) => {
  let code = fs.readFileSync(src(rel), 'utf8');
  for (const [from, to] of subs) code = code.replace(from, to);
  return import('data:text/javascript,' + encodeURIComponent(code));
};

const PLAYWRIGHT_CANDIDATES = [
  path.join(ROOT, 'node_modules/playwright/index.mjs'),
  path.join(ROOT, '..', 'node_modules/playwright/index.mjs'),
  '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs',
  '/usr/lib/node_modules/playwright/index.mjs',
  '/usr/local/lib/node_modules/playwright/index.mjs',
];

export const playwright = async () => {
  for (const candidate of PLAYWRIGHT_CANDIDATES) {
    if (fs.existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  try {
    return await import('playwright');
  } catch {
    console.error(
      'Playwright is not installed. The browser suites need it plus a Chromium:\n'
      + '  npm i -D playwright && npx playwright install chromium\n'
      + 'They also need the API on :5000 and `npx expo export --platform web` served on :8099.'
    );
    process.exit(2);
  }
};
