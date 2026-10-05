// Copy what was added to insat's question pool into the generation pool, the
// examples AI writing learns from (lib/pool.js syncGlobalPool). The syncPool
// Cloud Function does this once a day; run it after an import, a variation
// batch or a template top-up to have it at once. Idempotent.
//
//   node --env-file-if-exists=.env.local scripts/sync-global-pool.js
// (from functions/; the emulators when FIRESTORE_EMULATOR_HOST is set, production otherwise)

import { target } from '../lib/firebase.js';
import { syncGlobalPool } from '../lib/pool.js';

try {
  console.log(`writing to ${target()}`);
  const copied = await syncGlobalPool();
  console.log(`copied ${copied} questions from insat's pool into the generation pool`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
