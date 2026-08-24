import mongoose from 'mongoose';
import dns from 'node:dns';

let connecting = null;

/**
 * Some ISPs, office networks and VPNs answer ordinary DNS but refuse the SRV
 * queries a mongodb+srv:// string needs, which surfaces as
 * "querySrv ECONNREFUSED". Setting DNS_SERVERS in .env routes Node's lookups
 * through a resolver that does answer them -- no Windows changes required.
 */
function applyDnsOverride() {
  const raw = process.env.DNS_SERVERS;
  if (!raw) return;
  const servers = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!servers.length) return;
  dns.setServers(servers);
  console.log(`Resolving DNS via ${servers.join(', ')} (DNS_SERVERS override)`);
}

/**
 * Opens (and memoises) the single Mongoose connection for the whole process.
 * The connection string lives ONLY here, server-side. The React Native app
 * never sees it -- see PRD section 7, edge case 1.
 */
export async function connectDB() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error('MONGODB_URI is missing. Copy backend/.env.example to backend/.env and fill it in.');
  }
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    throw new Error('MONGODB_URI does not look like a Mongo connection string.');
  }

  // readyState: 0 disconnected, 1 connected, 2 connecting, 3 disconnecting
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (connecting) return connecting;

  applyDnsOverride();
  mongoose.set('strictQuery', true);

  mongoose.connection.on('connected', () =>
    console.log(`MongoDB connected  ->  db "${mongoose.connection.name}"`)
  );
  mongoose.connection.on('error', (err) => console.error('MongoDB error:', err.message));
  mongoose.connection.on('disconnected', () => console.warn('MongoDB disconnected'));

  connecting = mongoose
    .connect(uri, {
      dbName: process.env.MONGODB_DB || 'mini_pos',
      serverSelectionTimeoutMS: 10_000,
      maxPoolSize: 10,
    })
    .then((m) => m.connection)
    .catch((err) => {
      // Turn the driver's cryptic DNS errors into an actionable message.
      if (/querySrv|EREFUSED|ENODATA/.test(err.message) && uri.startsWith('mongodb+srv://')) {
        throw new Error(
          `${err.message}\n\n` +
          'This is a DNS SRV lookup failure on your network, not a MongoDB fault.\n' +
          'Run "npm run dns:check" -- it will tell you which resolver works and\n' +
          'print the exact line to add to .env.'
        );
      }
      throw err;
    })
    .finally(() => {
      connecting = null;
    });

  return connecting;
}

export async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

/** True when Atlas is reachable -- used by GET /api/health. */
export function dbStatus() {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  return {
    state: states[mongoose.connection.readyState] ?? 'unknown',
    db: mongoose.connection.name || null,
  };
}
