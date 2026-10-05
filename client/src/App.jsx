// Top-level app: wraps everything in the auth provider and routes by role.

import React, { Suspense, lazy, useEffect } from 'react';
import { AuthProvider, useAuth } from './auth.jsx';
import { FullScreenSpinner } from './ui.jsx';
import { TooltipProvider } from '@/components/ui/tooltip';
import Landing from './Landing.jsx';
import { isExamApp } from './desktop.js';
import Login from './Login.jsx';
import { ROUTES, useLocation, navigate } from './nav.js';
import AcceptInvite from './AcceptInvite.jsx';

// Each role's app is its own chunk, so a student never downloads the admin
// console (and the landing page loads without any of them).
const StudentApp = lazy(() => import('./student/StudentApp.jsx'));
const AdminApp = lazy(() => import('./admin/AdminApp.jsx'));
const SuperAdminApp = lazy(() => import('./super/SuperAdminApp.jsx'));

/**
 * An institution's brand color becomes the theme's primary color (buttons,
 * selection, focus), with whichever text color, white or near-black, reads on
 * it. Without one the theme's own primary (Mist) stays.
 */
function applyAccent(accent) {
  const root = document.documentElement.style;
  const props = ['--primary', '--primary-foreground', '--ring'];
  if (!/^#[0-9a-f]{6}$/i.test(accent || '')) {
    props.forEach((p) => root.removeProperty(p));
    return;
  }
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  root.setProperty('--primary', accent);
  // Above this luminance near-black text has the better contrast.
  root.setProperty('--primary-foreground', luminance > 0.179 ? 'oklch(0.145 0 0)' : 'oklch(0.985 0 0)');
  root.setProperty('--ring', accent);
}

function Root() {
  const { user, loading } = useAuth();
  const { pathname: path, search } = useLocation();
  useEffect(() => applyAccent(user?.branding?.accent), [user]);
  // Once signed in, drop /sign-in from the URL so a refresh lands on the app
  // rather than a sign-in page the user no longer needs.
  useEffect(() => {
    if (user && window.location.pathname === ROUTES.signIn) navigate(ROUTES.home, { replace: true });
  }, [user]);
  const inviteToken = new URLSearchParams(search).get('invite');
  if (inviteToken) return <AcceptInvite token={inviteToken} />;
  if (loading) return <FullScreenSpinner />;
  // Signed out: the landing page is the front door, sign-in its own route. The
  // desktop exam app skips the marketing page - students open it to sign in.
  if (!user) return path === ROUTES.signIn || isExamApp ? <Login /> : <Landing />;
  const RoleApp = user.role === 'superadmin' ? SuperAdminApp : user.role === 'admin' ? AdminApp : StudentApp;
  return (
    <Suspense fallback={<FullScreenSpinner />}>
      <RoleApp />
    </Suspense>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <TooltipProvider delayDuration={300}>
        <Root />
      </TooltipProvider>
    </AuthProvider>
  );
}
