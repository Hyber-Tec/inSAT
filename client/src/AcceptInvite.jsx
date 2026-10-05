// Invite acceptance: a user lands here via ?invite=<token>, sets their own
// password, and is signed straight in.

import React, { useState, useEffect } from 'react';
import { api, setToken } from './api.js';
import { useAuth } from './auth.jsx';
import { HomeLink, Wordmark, ErrorNote, Loading } from './ui.jsx';
import { ROUTES, navigate } from './nav.js';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

export default function AcceptInvite({ token }) {
  const { setUser } = useAuth();
  const [info, setInfo] = useState(null); // null=loading, {valid,email,name,role}
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(`/api/auth/invite/${encodeURIComponent(token)}`);
        if (!cancelled) setInfo(r);
      } catch {
        if (!cancelled) setInfo({ valid: false });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true); setError(null);
    try {
      const { token: jwt, user } = await api.post('/api/auth/accept-invite', { token, password });
      setToken(jwt);
      navigate(ROUTES.home, { replace: true });
      setUser(user);
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-8">
      <div className="w-full max-w-sm animate-in fade-in-0 slide-in-from-bottom-2 animation-duration-500">
        <div className="mb-7 flex justify-center"><HomeLink><Wordmark size="lg" /></HomeLink></div>
        <Card>
          {info === null ? (
            <Loading className="py-10" />
          ) : !info.valid ? (
            <>
              <CardHeader className="text-center">
                <CardTitle className="text-xl font-semibold">Invite not valid</CardTitle>
                <CardDescription>This invite link is invalid or has expired. Ask your administrator for a new one.</CardDescription>
              </CardHeader>
              <CardContent className="items-center">
                <Button variant="outline" onClick={() => navigate(ROUTES.signIn, { replace: true })}>
                  Go to sign in
                </Button>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader className="text-center">
                <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Welcome to insat</div>
                <CardTitle className="text-xl font-semibold">Set your password</CardTitle>
                <CardDescription className="break-all">{info.name ? `${info.name} · ` : ''}{info.email}</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={submit} className="grid gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="new-password">New password</Label>
                    <Input id="new-password" type="password" value={password} autoFocus autoComplete="new-password"
                      onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="confirm-password">Confirm password</Label>
                    <Input id="confirm-password" type="password" value={confirm} autoComplete="new-password"
                      onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat password" />
                  </div>
                  <ErrorNote>{error}</ErrorNote>
                  <Button type="submit" size="lg" className="w-full" disabled={busy || password.length < 6}>
                    {busy && <Spinner />}
                    {busy ? 'Setting up…' : 'Set password & sign in'}
                  </Button>
                </form>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
