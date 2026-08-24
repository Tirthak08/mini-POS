/**
 * Drops every collection this app owns, then rebuilds the indexes.
 *
 *   npm run db:reset            (asks for confirmation)
 *   npm run db:reset -- --yes   (no prompt, for scripts)
 *
 * Intended for development. It refuses to run when NODE_ENV=production.
 */
import 'dotenv/config';
import readline from 'node:readline/promises';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../config/db.js';
import '../models/index.js';

const COLLECTIONS = ['businesses', 'categories', 'products', 'orders', 'counters', 'productimages'];

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to reset the database with NODE_ENV=production.');
  process.exit(1);
}

try {
  const conn = await connectDB();
  console.log(`Connected to "${conn.name}" at ${conn.host}`);

  const existing = (await conn.db.listCollections().toArray()).map((c) => c.name);
  const targets = COLLECTIONS.filter((c) => existing.includes(c));

  const counts = {};
  for (const name of targets) counts[name] = await conn.db.collection(name).countDocuments();

  if (!targets.length) {
    console.log('Nothing to drop -- the database is already empty.');
  } else {
    console.log('\nAbout to permanently DROP:');
    for (const name of targets) console.log(`  ${name.padEnd(12)} ${counts[name]} document(s)`);

    if (!process.argv.includes('--yes')) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('\nType RESET to confirm: ');
      rl.close();
      if (answer.trim() !== 'RESET') {
        console.log('Cancelled. Nothing was changed.');
        process.exit(0);
      }
    }

    for (const name of targets) {
      await conn.db.collection(name).drop();
      console.log(`  dropped ${name}`);
    }
  }

  console.log('\nRebuilding indexes from the current schemas...');
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  for (const [name, model] of Object.entries(mongoose.models)) {
    const idx = await model.collection.indexes();
    console.log(`  ${name}: ${idx.map((i) => i.name).join(', ')}`);
  }

  console.log('\nDone. Register a business in the app to start fresh.');
} catch (err) {
  console.error('\nFAILED:', err.message);
  process.exitCode = 1;
} finally {
  await disconnectDB();
}
