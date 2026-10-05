// Firebase in the browser: the app and its Auth (email and password, Google).
// The config comes from web/.env.local (git-ignored; see web/.env.example).
// The browser never reads Firestore or Storage: everything goes through the
// API (functions/), which checks the signed-in user's ID token.

import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, GoogleAuthProvider } from 'firebase/auth';

const env = import.meta.env;
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID,
};
if (!config.apiKey) console.error('Firebase is not configured: copy web/.env.example to web/.env.local and fill it in.');

export const firebaseApp = initializeApp(config);
export const auth = getAuth(firebaseApp);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Development and the browser checks sign in against the Auth emulator.
const emulator = env.VITE_AUTH_EMULATOR_HOST;
if (emulator) connectAuthEmulator(auth, `http://${emulator}`, { disableWarnings: true });

// Analytics where the browser supports it (not in the emulator, the checks or
// the desktop app's webview), loaded on its own so the app does not wait on it.
if (config.measurementId && !emulator) {
  import('firebase/analytics')
    .then(({ getAnalytics, isSupported }) => isSupported().then((ok) => ok && getAnalytics(firebaseApp)))
    .catch(() => { /* analytics is optional */ });
}
