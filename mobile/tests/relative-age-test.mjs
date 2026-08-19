import fs from 'fs';
const src = fs.readFileSync('/root/posapp/src/utils/money.js','utf8')
  .replace("import { APP_CONFIG } from '../config';", "const APP_CONFIG = { currencySymbol: '₹' };");
const m = await import('data:text/javascript,' + encodeURIComponent(src));
let pass=0, fail=0;
const eq=(g,w,l)=>{const ok=JSON.stringify(g)===JSON.stringify(w); ok?(pass++,console.log('  PASS  '+l)):(fail++,console.log(`  FAIL  ${l}: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`));};
const NOW = 1_800_000_000_000;
eq(m.relativeAge(null, NOW), null, 'no timestamp -> no age');
eq(m.relativeAge(NOW, NOW), {key:'offline.justNow', n:0}, 'this second reads "just now"');
eq(m.relativeAge(NOW - 59_000, NOW), {key:'offline.justNow', n:0}, '59 seconds is still "just now"');
eq(m.relativeAge(NOW - 60_000, NOW), {key:'offline.minutesAgo', n:1}, 'one minute');
eq(m.relativeAge(NOW - 3_000_000, NOW), {key:'offline.minutesAgo', n:50}, '50 minutes');
eq(m.relativeAge(NOW - 3_600_000, NOW), {key:'offline.hoursAgo', n:1}, 'one hour');
eq(m.relativeAge(NOW - 23*3_600_000, NOW), {key:'offline.hoursAgo', n:23}, '23 hours stays in hours');
eq(m.relativeAge(NOW - 24*3_600_000, NOW), {key:'offline.daysAgo', n:1}, '24 hours becomes a day');
eq(m.relativeAge(NOW - 9*24*3_600_000, NOW), {key:'offline.daysAgo', n:9}, 'nine days');
// A clock that jumped backwards must not print a negative age.
eq(m.relativeAge(NOW + 500_000, NOW), {key:'offline.justNow', n:0}, 'a future timestamp clamps to "just now", never negative');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
