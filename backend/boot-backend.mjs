/**
 * Boots the API against a throwaway in-memory MongoDB replica set, for the
 * browser test suites. A replica SET rather than a standalone, because the
 * checkout path uses transactions.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
  instanceOpts: [{ launchTimeout: 120_000 }],
});
const uri = replSet.getUri();
fs.writeFileSync('/tmp/backend-uri.txt', uri);

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: '/root/postest',
  env: {
    ...process.env,
    PORT: '5000',
    /**
     * 'test', not 'development', so the per-account and per-IP login limiters
     * are skipped. Each browser suite registers a fresh shop, and 60 sign-ups
     * from one address in 15 minutes is well within a normal run of the whole
     * set -- the limiter then rejected the SEED step, and the suite failed
     * looking like an app bug when nothing was wrong with the app.
     */
    NODE_ENV: 'test',
    MONGODB_URI: uri,
    MONGODB_DB: 'e2e',
    JWT_SECRET: 'e2e-secret-long-enough-for-the-guard-0123456789',
    JWT_EXPIRES_IN: '2h',
    ADMIN_USERNAME: 'superadmin',
    ADMIN_PASSWORD: 'e2e-admin-pass',
    REPORT_TIMEZONE: 'Asia/Kolkata',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

process.on('SIGTERM', async () => { server.kill(); await replSet.stop(); process.exit(0); });
console.log('backend booting on :5000 against', uri);
