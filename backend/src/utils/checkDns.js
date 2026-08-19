/**
 * Diagnoses "querySrv ECONNREFUSED" / "querySrv ENOTFOUND".
 *
 * A mongodb+srv:// string needs a DNS **SRV** record lookup. Plenty of Indian
 * ISPs, office networks, college Wi-Fi and VPNs answer ordinary A-record
 * queries but refuse SRV ones, which is exactly this failure. This script
 * proves whether that is what is happening, and which resolver does work.
 *
 *   npm run dns:check
 */
import 'dotenv/config';
import { Resolver } from 'node:dns/promises';

const uri = process.env.MONGODB_URI || '';
if (!uri) {
  console.error('MONGODB_URI is not set in backend/.env');
  process.exit(1);
}
if (!uri.startsWith('mongodb+srv://')) {
  console.log('Your MONGODB_URI is already a non-SRV string, so SRV DNS is not involved.');
  process.exit(0);
}

const host = uri.split('@')[1]?.split(/[/?]/)[0];
if (!host) {
  console.error('Could not read the cluster host out of MONGODB_URI. Is it complete?');
  process.exit(1);
}
const srvName = `_mongodb._tcp.${host}`;
console.log(`Cluster host: ${host}`);
console.log(`SRV record:   ${srvName}\n`);

const CANDIDATES = [
  { label: 'your current DNS (Windows default)', servers: null },
  { label: 'Google DNS  8.8.8.8', servers: ['8.8.8.8', '8.8.4.4'] },
  { label: 'Cloudflare  1.1.1.1', servers: ['1.1.1.1', '1.0.0.1'] },
];

const working = [];
let plainDnsOk = false;

for (const { label, servers } of CANDIDATES) {
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  if (servers) resolver.setServers(servers);

  // A plain A-record lookup first: separates "DNS is broken" from "SRV is blocked".
  let aOk = false;
  try {
    // 'mongodb.net' itself has no A record, so probe a host that definitely does.
    await resolver.resolve4(host).catch(() => resolver.resolve4('www.google.com'));
    aOk = true;
    plainDnsOk = true;
  } catch { /* ignore */ }

  try {
    const records = await resolver.resolveSrv(srvName);
    working.push({ label, servers, records });
    console.log(`  OK    ${label}`);
    console.log(`        ${records.length} shard host(s):`);
    records.forEach((r) => console.log(`          ${r.name}:${r.port}`));
    try {
      const txt = await resolver.resolveTxt(host);
      console.log(`        options: ${txt.flat().join('')}`);
    } catch { /* optional */ }
  } catch (err) {
    console.log(`  FAIL  ${label}  ->  ${err.code || err.message}${aOk ? '  (plain DNS works here, so SRV specifically is blocked)' : ''}`);
  }
}

console.log('\n' + '='.repeat(62));

if (working.some((w) => w.servers === null)) {
  console.log('SRV lookups work on your default DNS. If Mongoose still cannot connect,');
  console.log('the problem is the Atlas IP allow-list or the username/password, not DNS.');
  process.exit(0);
}

if (!working.length) {
  console.log('No resolver could read the SRV record.');
  console.log(plainDnsOk
    ? 'Ordinary DNS works, so something is filtering SRV queries specifically --\nusually a VPN, office/college firewall, or antivirus web-shield.'
    : 'Even ordinary DNS failed, so check your internet connection first.');
  console.log('\nWorkaround that needs no DNS at all: switch to a non-SRV connection');
  console.log('string. In Atlas -> Connect -> Drivers, pick Node.js version "2.2.12 or');
  console.log('later" and copy the mongodb:// string it shows.');
  process.exit(1);
}

const best = working[0];
console.log('Your default DNS refuses SRV queries, but this one works:\n');
console.log(`    ${best.label}\n`);
console.log('Two ways to fix it -- the first needs no Windows changes:\n');
console.log(`  1. Add this line to backend/.env and re-run "npm run db:check":`);
console.log(`         DNS_SERVERS=${best.servers.join(',')}\n`);
console.log('  2. Or change it system-wide: Settings -> Network & Internet ->');
console.log(`     your adapter -> DNS server assignment -> Manual -> IPv4 on ->`);
console.log(`     Preferred ${best.servers[0]}, Alternate ${best.servers[1]}\n`);
console.log('Non-SRV fallback (bypasses SRV entirely), using the hosts found above:\n');
const hosts = best.records.map((r) => `${r.name}:${r.port}`).join(',');
let replicaSet = '';
try {
  const resolver = new Resolver();
  resolver.setServers(best.servers);
  const txt = (await resolver.resolveTxt(host)).flat().join('');
  replicaSet = new URLSearchParams(txt).get('replicaSet') || '';
} catch { /* optional */ }
console.log(`    mongodb://USERNAME:PASSWORD@${hosts}/?ssl=true${replicaSet ? `&replicaSet=${replicaSet}` : ''}&authSource=admin&retryWrites=true&w=majority`);
