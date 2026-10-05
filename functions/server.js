// The API on a port, outside the Functions emulator: the same app as the `api`
// Cloud Function. The browser checks start one with the AI provider mocked
// (web/scripts/check-authoring.mjs). Point it at the emulators with
// FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST and
// FIREBASE_STORAGE_EMULATOR_HOST, as `npm run api` does.

import { createApp } from './app.js';

const port = Number(process.env.PORT || 3002);
createApp().listen(port, () => {
  console.log(`[api] insat API listening on :${port}`);
});
