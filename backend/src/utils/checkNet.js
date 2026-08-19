/**
 * Diagnoses "Could not connect to any servers in your MongoDB Atlas cluster".
 *
 * That message always blames the IP allow-list, but a corporate/college
 * firewall blocking outbound TCP 27017 produces the exact same error. This
 * script tells the two apart:
 *
 *   - control port open + shards closed  ->  Atlas side (allow-list or paused)
 *   - control port also closed           ->  your network blocks outbound TCP
 *
 *   npm run net:check
 */
import 'dotenv/config';
import net from 'node:net';
import dns from 'node:dns';
import { Resolver } from 'node:dns/promises';

if (process.env.DNS_SERVERS) {
  const servers = process.env.DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean);
  dns.setServers(servers);
  console.log(`(using DNS_SERVERS override: ${servers.join(', ')})`);
}

const uri = process.env.MONGODB_URI || '';
if (!uri) {
  console.error('MONGODB_URI is not set in backend/.env');
  process.exit(1);
}

/** Resolve the shard list, whether the URI is SRV or already explicit. */
async function shardHosts() {
  const hostPart = uri.split('@')[1]?.split(/[/?]/)[0];
  if (!hostPart) throw new Error('Could not read the host out of MONGODB_URI');

  if (!uri.startsWith('mongodb+srv://')) {
    return hostPart.split(',').map((h) => {
      const [host, port] = h.split(':');
      return { host, port: Number(port) || 27017 };
    });
  }
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  if (process.env.DNS_SERVERS) {
    resolver.setServers(process.env.DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean));
  }
  const records = await resolver.resolveSrv(`_mongodb._tcp.${hostPart}`);
  return records.map((r) => ({ host: r.name, port: r.port }));
}

function probe(host, port, timeout = 8000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const started = Date.now();
    socket.setTimeout(timeout);
    socket.once('connect', () => { socket.destroy(); resolve({ ok: true, ms: Date.now() - started }); });
    socket.once('timeout', () => { socket.destroy(); resolve({ ok: false, reason: 'TIMEOUT' }); });
    socket.once('error', (err) => { socket.destroy(); resolve({ ok: false, reason: err.code || err.message }); });
    socket.connect(port, host);
  });
}

console.log('\nControl test -- can this machine open outbound TCP at all?');
const control = await probe('google.com', 443);
console.log(`  google.com:443  ->  ${control.ok ? `OPEN (${control.ms}ms)` : `BLOCKED (${control.reason})`}`);

let hosts;
try {
  hosts = await shardHosts();
} catch (err) {
  console.error(`\nCould not resolve the shard list: ${err.code || err.message}`);
  console.error('Run "npm run dns:check" first -- this is a DNS problem, not a firewall one.');
  process.exit(1);
}

console.log(`\nAtlas shards (${hosts.length}):`);
const results = [];
for (const { host, port } of hosts) {
  const r = await probe(host, port);
  results.push(r);
  console.log(`  ${host.split('.')[0]}:${port}  ->  ${r.ok ? `OPEN (${r.ms}ms)` : `${r.reason}`}`);
}

const reachable = results.filter((r) => r.ok).length;
console.log('\n' + '='.repeat(62));

if (reachable > 0) {
  console.log(`${reachable}/${results.length} shards reachable. The network path is fine.`);
  console.log('If Mongoose still fails, the cause is the database username/password');
  console.log('(check special characters are URL-encoded) rather than connectivity.');
  process.exit(0);
}

if (!control.ok) {
  console.log('No outbound TCP at all -- check your internet connection or proxy settings.');
  process.exit(1);
}

console.log('Outbound TCP works, but every Atlas shard times out. Port 27017 is');
console.log('being refused before it reaches MongoDB. In order of likelihood:\n');
console.log('  1. Atlas -> Security -> Network Access has no entry covering your IP.');
console.log('     Add 0.0.0.0/0 and wait for the status to turn from Pending to Active.\n');
console.log('  2. Atlas -> Database: the cluster is Paused. Free M0 clusters pause');
console.log('     after 60 days idle. Click Resume and wait a few minutes.\n');
console.log('  3. Your network blocks outbound 27017 (common on office/college Wi-Fi');
console.log('     and some ISPs). Test on a phone hotspot -- if it works there, this');
console.log('     is the cause, and there is no fix except a different network.');
process.exit(1);
