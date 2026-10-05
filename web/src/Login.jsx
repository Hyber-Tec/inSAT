// insat sign-in, at /sign-in. One card on a quiet background, so the form is
// the only thing asking for attention. Reached from the landing page (see
// Landing.jsx).

import React, { useState } from 'react';
import { LuArrowLeft } from 'react-icons/lu';
import { useAuth } from './auth.jsx';
import { HomeLink, Wordmark, ErrorNote } from './ui.jsx';
import { ROUTES, linkProps } from './nav.js';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message || 'Sign in failed');
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-svh flex-col bg-muted/40 px-4 py-5 sm:px-6">
      <Button variant="ghost" size="sm" asChild className="self-start text-muted-foreground">
        <a {...linkProps(ROUTES.home)}><LuArrowLeft /> Back to home</a>
      </Button>

      {/* Optical centring: a little above true centre reads as centred on a tall screen. */}
      <div className="flex flex-1 items-center justify-center pt-6 pb-[6vh]">
        <div className="w-full max-w-sm animate-in fade-in-0 slide-in-from-bottom-2 animation-duration-500">
          <div className="mb-7 flex justify-center"><HomeLink><Wordmark size="lg" /></HomeLink></div>

          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-xl font-semibold">Sign in</CardTitle>
              <CardDescription>Welcome back.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={email} autoFocus autoComplete="username" required
                    onChange={(e) => setEmail(e.target.value)} placeholder="you@school.edu" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="password">Password</Label>
                  <Input id="password" type="password" value={password} autoComplete="current-password" required
                    onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
                </div>
                <ErrorNote>{error}</ErrorNote>
                <Button type="submit" size="lg" className="w-full" disabled={busy}>
                  {busy && <Spinner />}
                  {busy ? 'Signing in…' : 'Sign in'}
                </Button>
              </form>
            </CardContent>
          </Card>

          <p className="mx-auto mt-5 max-w-xs text-center text-xs leading-relaxed text-balance text-muted-foreground">
            Students: sign in with the account your academy created for you. Trouble signing in?
            Contact your insat administrator.
          </p>
        </div>
      </div>

      <p className="text-center text-xs text-muted-foreground">Not affiliated with the College Board.</p>
    </div>
  );
}
