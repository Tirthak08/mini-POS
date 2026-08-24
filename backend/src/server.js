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
