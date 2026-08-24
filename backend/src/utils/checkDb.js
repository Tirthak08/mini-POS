/**
 * Standalone connection smoke test:  npm run db:check
 * Confirms the URI, the Atlas IP allow-list and the DB user all work,
 * without starting the HTTP server.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../config/db.js';
import './../models/index.js';

try {
  console.log('Connecting to Atlas...');
  const conn = await connectDB();
  console.log(`Connected. Database: "${conn.name}"`);

  const collections = await conn.db.listCollections().toArray();
  console.log(
    collections.length
      ? `Existing collections: ${collections.map((c) => c.name).join(', ')}`
      : 'No collections yet (expected on a fresh cluster).'
  );

  console.log('Syncing indexes for all models...');
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  console.log('Indexes in place for:', Object.keys(mongoose.models).join(', '));

  console.log('\nAll good. Atlas is reachable and the schemas are valid.');
} catch (err) {
  console.error('\nFAILED:', err.message);
  if (/querySrv|EREFUSED|ENODATA/i.test(err.message)) {
    console.error('Hint: this is a DNS SRV problem, not MongoDB. Run "npm run dns:check".');
  } else if (/IP|whitelist|ENOTFOUND|timed out/i.test(err.message)) {
    console.error('Hint: check Atlas -> Network Access, and that your cluster is not paused.');
  }
  if (/auth|password/i.test(err.message)) {
    console.error('Hint: check the DB username/password, and URL-encode special characters.');
  }
  process.exitCode = 1;
} finally {
  await disconnectDB();
}
