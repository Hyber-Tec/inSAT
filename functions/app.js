// The insat API as an Express app: served by the `api` Cloud Function behind
// Firebase Hosting (/api/**), and by server.js on a workstation. Before its
// first request an instance makes sure a fresh project has insat's
// institution, the generation pool and the blueprint templates.

import express from 'express';
import cors from 'cors';
import { config } from './lib/config.js';
import { requireAuth, requireRole } from './lib/auth.js';
import { bootstrap } from './lib/pool.js';
import { readAsset } from './lib/assets.js';
import { asyncHandler, errorHandler, notFound } from './lib/http.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import studentRoutes from './routes/student.js';
import superRoutes from './routes/super.js';

// Origins that may call the API from a browser: the app's own (CLIENT_ORIGIN),
// any localhost in development, and the desktop exam app's webview.
const isLocalDevOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
const DESKTOP_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Requests with no Origin (curl, same-origin through Hosting) are allowed too.
  app.use(cors({
    origin(origin, cb) {
      const ok = !origin || config.corsOrigins.includes(origin) || isLocalDevOrigin(origin) || DESKTOP_ORIGINS.includes(origin);
      cb(null, ok);
    },
    maxAge: 600,
  }));
  app.use(express.json({ limit: '4mb' }));

  let ready = null;
  app.use((_req, _res, next) => {
    ready ||= bootstrap().catch((err) => { ready = null; throw err; });
    ready.then(() => next(), next);
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'insat-api' }));

  // Public: question figure assets (referenced by <img> tags that can't send a token).
  app.get('/api/assets/:id', asyncHandler(async (req, res) => {
    const asset = await readAsset(req.params.id);
    if (!asset) throw notFound('asset');
    res.set('Content-Type', asset.mime);
    res.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    res.send(asset.bytes);
  }));

  app.use('/api/auth', authRoutes);
  app.use('/api/super', requireAuth, requireRole('superadmin'), superRoutes);
  app.use('/api/admin', requireAuth, requireRole('admin'), adminRoutes);
  app.use('/api/student', requireAuth, requireRole('student'), studentRoutes);

  app.use('/api', (_req, _res, next) => next(notFound()));
  app.use(errorHandler);
  return app;
}
