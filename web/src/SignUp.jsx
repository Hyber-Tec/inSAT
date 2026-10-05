// insat sign-up, at /sign-up: a new account (Google, or a name, email and
// password) is a student of insat's own academy, ready for a diagnostic.
// Academies make their own students' accounts (admin Students tab).

import React, { useState } from 'react';
import { authMessage, useAuth } from './auth.jsx';
import { AuthShell, GoogleButton } from './Login.jsx';
import { ErrorNote } from './ui.jsx';
import { ROUTES, linkProps } from './nav.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

export default function SignUp() {
  const { signUp } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signUp({ name, email, password });
    } catch (err) {
      setError(authMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Create your account"
      description="Practice for the digital SAT, free."
      footer={(
        <p className="mx-auto mt-5 max-w-xs text-center text-xs leading-relaxed text-balance text-muted-foreground">
          Already have an account? <a {...linkProps(ROUTES.signIn)} className="font-medium text-foreground underline-offset-4 hover:underline">Sign in</a>.
        </p>
      )}
    >
      <GoogleButton onError={setError} label="Sign up with Google" />
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={name} autoFocus autoComplete="name" required
            onChange={(e) => setName(e.target.value)} placeholder="Your name" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" value={email} autoComplete="email" required
            onChange={(e) => setEmail(e.target.value)} placeholder="you@school.edu" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" value={password} autoComplete="new-password" required minLength={6}
            onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" />
        </div>
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" size="lg" className="w-full" disabled={busy || !name.trim() || password.length < 6}>
          {busy && <Spinner />}
          {busy ? 'Creating your account…' : 'Create account'}
        </Button>
      </form>
    </AuthShell>
  );
}
