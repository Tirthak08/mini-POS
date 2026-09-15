import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import { connectDB, disconnectDB, dbStatus } from './config/db.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import apiRoutes from './routes/index.js';

const app = express();
const PORT = Number(process.env.PORT) || 5000;

app.set('trust proxy', 1); // correct client IPs for the rate limiter behind Render/Railway
app.use(cors({ origin: '*' })); // dev: Expo Go calls this from the phone over LAN
/**
 * A restore is the one request that is legitimately enormous -- a year of a
 * shop's history, and its photos if they were included. It gets its own parser,
 * mounted BEFORE the general one so body-parser has already consumed the stream
 * by the time the 1mb limit would have rejected it.
 *
 * 25mb rather than "unlimited": this runs on a 512MB instance, and parsing JSON
 * costs several times the size of the text. Everything else stays at 1mb, which
 * is the real protection -- there is no other route where a large body is
 * anything but an attack.
 */
app.use('/api/backup/restore', express.json({ limit: '25mb' }));
app.use(express.json({ limit: '1mb' }));

app.use(
  '/api',
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { ok: false, error: 'Too many requests, slow down.' },
  })
);

app.get('/api/health', (_req, res) => {
  const db = dbStatus();
  res.status(db.state === 'connected' ? 200 : 503).json({
    ok: db.state === 'connected',
    service: 'mini-pos-api',
    mongo: db,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.use('/api', apiRoutes);

app.use(notFound);
app.use(errorHandler);

let server;
try {
  await connectDB();
  // 0.0.0.0, not localhost -- otherwise your phone cannot reach this over Wi-Fi.
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`API listening on http://0.0.0.0:${PORT}`);
    console.log(`Health check:     http://localhost:${PORT}/api/health`);
  });
} catch (err) {
  console.error('\nStartup failed:', err.message);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n${signal} received, shutting down...`);
    server?.close();
    await disconnectDB();
    process.exit(0);
  });
}

export default app;
