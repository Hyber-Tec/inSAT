// Path routing for the signed-out marketing surface. The signed-in app is a
// role-based state machine (see App.jsx), so this only needs to tell the
// landing page, the sign-in and sign-up pages and an invite link (/?invite=)
// apart and keep the URL honest - real URLs mean /sign-in is linkable,
// refreshable, and works with the back button. Change the URL only through
// navigate(), so the app hears of it.
// Firebase Hosting serves index.html for every path (firebase.json).

import { useEffect, useState } from 'react';

export const ROUTES = { home: '/', signIn: '/sign-in', signUp: '/sign-up' };

/** Back to the top of the page, gliding unless the reader asked for less motion. */
export function scrollToTop() {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' });
}

// Going where you already are goes back to the top; an invite's ?invite=
// counts as somewhere else.
export function navigate(path, { replace = false } = {}) {
  if (window.location.pathname + window.location.search === path) {
    scrollToTop();
    return;
  }
  window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
  // pushState/replaceState don't fire popstate, so nudge listeners ourselves.
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

/** The current path and query, kept in step with navigate() and the back button. */
export function useLocation() {
  const read = () => ({ pathname: window.location.pathname, search: window.location.search });
  const [location, setLocation] = useState(read);
  useEffect(() => {
    const onPop = () => setLocation(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return location;
}

// Anchor props for an in-app link: a real href (middle-click / open-in-new-tab
// keep working) that routes client-side on a plain left click.
export function linkProps(path) {
  return {
    href: path,
    onClick: (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(path);
    },
  };
}
