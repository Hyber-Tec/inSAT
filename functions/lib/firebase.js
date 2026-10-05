// The Firebase Admin SDK: Firestore (the database), Auth (accounts) and the
// Storage bucket (question figures and academy logos). Inside Cloud Functions
// and the emulators the project comes from the environment. A script run on a
// workstation uses Application Default Credentials against the project below,
// or the emulators when FIRESTORE_EMULATOR_HOST (and FIREBASE_AUTH_EMULATOR_HOST,
// FIREBASE_STORAGE_EMULATOR_HOST) are set.

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';

export const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'insat-hyber';
export const STORAGE_BUCKET = process.env.STORAGE_BUCKET
  || (process.env.FIREBASE_CONFIG && JSON.parse(process.env.FIREBASE_CONFIG).storageBucket)
  || `${PROJECT_ID}.firebasestorage.app`;

const app = getApps()[0] || initializeApp({ projectId: PROJECT_ID, storageBucket: STORAGE_BUCKET });

export const db = getFirestore(app);
// A field left undefined is simply not written, as a missing column was NULL.
db.settings({ ignoreUndefinedProperties: true });

export const auth = getAuth(app);
export const bucket = () => getStorage(app).bucket(STORAGE_BUCKET);

/** Where writes go, for scripts to say before they change anything. */
export const target = () => (process.env.FIRESTORE_EMULATOR_HOST
  ? `the Firestore emulator (${process.env.FIRESTORE_EMULATOR_HOST}, project ${PROJECT_ID})`
  : `Firestore project ${PROJECT_ID} (production)`);
