// Auth context: holds the current user, restores the session from a stored
// token on load, and exposes login/logout.

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setToken, getToken } from './api.js';
import { ROUTES, navigate } from './nav.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (getToken()) {
        try {
          const { user: u } = await api.get('/api/auth/me');
          if (!cancelled) setUser(u);
        } catch {
          setToken(null);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (email, password) => {
    const { token, user: u } = await api.post('/api/auth/login', { email, password });
    setToken(token);
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    // Land on the sign-in page, not the marketing landing page - whoever just
    // signed out is an existing user, and signing back in is the likely next
    // step. Replace, so Back does not return to a dead signed-in URL.
    navigate(ROUTES.signIn, { replace: true });
  }, []);

  return (
    <AuthCtx.Provider value={{ user, loading, login, logout, setUser }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
