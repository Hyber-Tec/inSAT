// insat sign-in, at /sign-in, and the frame it shares with sign-up
// (SignUp.jsx): one card on a quiet background, so the form is the only thing
// asking for attention. Email and password, or Google; reached from the
// landing page (see Landing.jsx).

import React, { useState } from 'react';
import { LuArrowLeft, LuCircleCheck } from 'react-icons/lu';
import { FcGoogle } from 'react-icons/fc';
import { authMessage, useAuth } from './auth.jsx';
import { isExamApp } from './desktop.js';
import { HomeLink, Wordmark, ErrorNote } from './ui.jsx';
import { ROUTES, linkProps } from './nav.js';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

/** The signed-out screens' frame: back to home, the wordmark, a card. */
export function AuthShell({ title, description, children, footer }) {
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
              <CardTitle className="text-xl font-semibold">{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">{children}</CardContent>
          </Card>

          {footer}
        </div>
      </div>

      <p className="text-center text-xs text-muted-foreground">Not affiliated with the College Board.</p>
    </div>
  );
}

/**
 * Continue with Google, and the rule under it. The desktop exam app's webview
 * cannot open Google's sign-in window, so there it is email and password only.
 */
export function GoogleButton({ onError, label = 'Continue with Google' }) {
  const { loginWithGoogle } = useAuth();
  const [busy, setBusy] = useState(false);
  if (isExamApp) return null;
  const go = async () => {
    onError(null);
    setBusy(true);
    try { await loginWithGoogle(); } catch (err) { onError(authMessage(err)); setBusy(false); }
  };
  return (
    <>
      <Button type="button" variant="outline" size="lg" className="w-full" onClick={go} disabled={busy}>
        {busy ? <Spinner /> : <FcGoogle />} {label}
      </Button>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
      </div>
    </>
  );
}

export default function Login() {
  const { login, resetPassword, notice } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(authMessage(err));
      setBusy(false);
    }
  };

  const forgot = async () => {
    setError(null);
    setResetSent(false);
    if (!email.trim()) { setError('Enter your email address, then choose "Forgot password?" again.'); return; }
    try {
      await resetPassword(email);
      setResetSent(true);
    } catch (err) {
      setError(authMessage(err));
    }
  };

  return (
    <AuthShell
      title="Sign in"
      description="Welcome back."
      footer={(
        <p className="mx-auto mt-5 max-w-xs text-center text-xs leading-relaxed text-balance text-muted-foreground">
          New to insat? <a {...linkProps(ROUTES.signUp)} className="font-medium text-foreground underline-offset-4 hover:underline">Create an account</a>.
          {' '}Academy students: sign in with the account your academy created for you.
        </p>
      )}
    >
      <GoogleButton onError={setError} />
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" value={email} autoFocus autoComplete="username" required
            onChange={(e) => setEmail(e.target.value)} placeholder="you@school.edu" />
        </div>
        <div className="grid gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="password">Password</Label>
            <button type="button" onClick={forgot} className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Forgot password?
            </button>
          </div>
          <Input id="password" type="password" value={password} autoComplete="current-password" required
            onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </div>
        <ErrorNote>{error || notice}</ErrorNote>
        {resetSent && (
          <p className="flex items-start gap-1.5 text-sm text-emerald-700">
            <LuCircleCheck className="mt-0.5 size-4 shrink-0" /> If {email.trim()} has an account, a link to reset its password is on its way.
          </p>
        )}
        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {busy && <Spinner />}
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthShell>
  );
}
