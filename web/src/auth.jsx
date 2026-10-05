// Auth context. Firebase Auth signs people in (email and password, or Google)
// and keeps them signed in; the API's /api/auth/me says who they are in insat
// (role, academy, branding), and makes the profile of a brand-new account: a
// student of insat's own academy. Exposes sign in, sign up, Google, a password
// reset email and sign out.

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import {
  createUserWithEmailAndPassword, onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword,
  signInWithPopup, signOut, updateProfile,
} from 'firebase/auth';
import { auth, googleProvider } from './firebase.js';
import { api } from './api.js';
import { ROUTES, navigate } from './nav.js';

const AuthCtx = createContext(null);

// What a person can act on, for each way signing in can fail.
const MESSAGES = {
  'auth/invalid-credential': 'Invalid email or password',
  'auth/wrong-password': 'Invalid email or password',
  'auth/user-not-found': 'Invalid email or password',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/user-disabled': 'This account is deactivated. Contact your administrator.',
  'auth/too-many-requests': 'Too many attempts. Try again in a few minutes, or reset your password.',
  'auth/email-already-in-use': 'An account with this email already exists. Sign in instead.',
  'auth/weak-password': 'Choose a password of at least 6 characters.',
  'auth/popup-blocked': 'Allow pop-ups for this site to continue with Google.',
  'auth/account-exists-with-different-credential': 'This email signs in with a password. Use the form below.',
  'auth/network-request-failed': 'Could not reach the sign-in service. Check your connection and try again.',
  'auth/missing-email': 'Enter your email address first.',
};
const CANCELLED = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled']);

/** A sign-in error in words, or null when the person just closed the window. */
export function authMessage(err) {
  if (CANCELLED.has(err?.code)) return null;
  return MESSAGES[err?.code] || err?.message || 'Sign in failed';
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // Why the last sign-in could not go on (a deactivated account), for the sign-in page.
  const [notice, setNotice] = useState(null);
  // A sign-up names the account before insat makes its profile.
  const signingUp = useRef(false);

  /** insat's view of the signed-in account; signs out when there is none to have. */
  const loadMe = useCallback(async () => {
    try {
      const { user: u } = await api.get('/api/auth/me');
      setUser(u);
      setNotice(null);
      return u;
    } catch (err) {
      setUser(null);
      setNotice(err.message);
      await signOut(auth);
      throw err;
    }
  }, []);

  useEffect(() => onAuthStateChanged(auth, async (account) => {
    if (signingUp.current) return;
    if (!account) {
      setUser(null);
      setLoading(false);
      return;
    }
    try { await loadMe(); } catch { /* the notice says why */ } finally { setLoading(false); }
  }), [loadMe]);

  const login = useCallback(async (email, password) => {
    setNotice(null);
    await signInWithEmailAndPassword(auth, email.trim(), password);
  }, []);

  const loginWithGoogle = useCallback(async () => {
    setNotice(null);
    await signInWithPopup(auth, googleProvider);
  }, []);

  const signUp = useCallback(async ({ name, email, password }) => {
    setNotice(null);
    signingUp.current = true;
    try {
      const { user: account } = await createUserWithEmailAndPassword(auth, email.trim(), password);
      await updateProfile(account, { displayName: name.trim() });
      await account.getIdToken(true);
      return await loadMe();
    } finally {
      signingUp.current = false;
      setLoading(false);
    }
  }, [loadMe]);

  const resetPassword = useCallback((email) => sendPasswordResetEmail(auth, email.trim(), {
    url: `${window.location.origin}${ROUTES.signIn}`,
  }), []);

  const logout = useCallback(async () => {
    await signOut(auth);
    setUser(null);
    // Land on the sign-in page, not the marketing landing page - whoever just
    // signed out is an existing user, and signing back in is the likely next
    // step. Replace, so Back does not return to a dead signed-in URL.
    navigate(ROUTES.signIn, { replace: true });
  }, []);

  return (
    <AuthCtx.Provider value={{ user, loading, notice, login, loginWithGoogle, signUp, resetPassword, logout, setUser }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
