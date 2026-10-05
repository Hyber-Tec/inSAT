// Cloud Functions for insat.
//
//   api       the API (app.js), behind Firebase Hosting at /api/**
//   syncPool  once a day, copies what was added to insat's question pool into
//             the generation pool AI writing learns from (lib/pool.js)
//
// The app is imported on the first request, not when the CLI reads this file
// to deploy it, so deploying needs none of the runtime's secrets.

import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';

setGlobalOptions({ region: 'us-central1' });

// Encrypts each academy's AI key at rest (lib/crypto.js).
const ENCRYPTION_KEY = defineSecret('ENCRYPTION_KEY');

let app = null;

export const api = onRequest(
  { memory: '1GiB', cpu: 1, concurrency: 40, timeoutSeconds: 540, secrets: [ENCRYPTION_KEY] },
  async (req, res) => {
    app ||= import('./app.js').then((m) => m.createApp());
    (await app)(req, res);
  },
);

export const syncPool = onSchedule(
  { schedule: 'every day 04:00', timeZone: 'America/New_York', memory: '1GiB', timeoutSeconds: 540 },
  async () => {
    const { syncGlobalPool } = await import('./lib/pool.js');
    console.log(`[pool] copied ${await syncGlobalPool()} questions into the generation pool`);
  },
);
