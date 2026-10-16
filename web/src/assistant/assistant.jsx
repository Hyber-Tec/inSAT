// The AI assistant in the app: whom it is offered to, the conversation, and
// the floating "Ask AI" button with its panel. Students and admins ask it
// about what is on their screen: each message goes with the screen it was
// sent from (screen.js) and the name the screen gives itself
// (useAssistantScreen), and the answer streams in from the API
// (functions/routes/assistant.js). It is not there in the test runner
// (useAssistantHidden); a screen that shows the conversation itself, a
// question's review, stands in for the floating panel while it is open
// (useAssistantHost). The conversation lives as long as the signed-in app.
// The panel is its own chunk (Chat.jsx), loaded when it is first wanted.

import React, {
  createContext, lazy, Suspense, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { LuSparkles } from 'react-icons/lu';
import { Spinner } from '@/components/ui/spinner';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { captureScreen } from './screen.js';

export const MAX_MESSAGE = 2000; // characters, as the API takes (functions/lib/assistant.js)

const ApiCtx = createContext(null);
const StateCtx = createContext(null);

export const loadChat = () => import('./Chat.jsx');
const FloatingPanel = lazy(() => loadChat().then((m) => ({ default: m.FloatingPanel })));

// Refusals the API explains (lib/assistant.js REASONS): the panel shows them
// in place of the box to ask in.
const REFUSALS = new Set(['not_configured', 'off', 'test', 'limit']);

let serial = 0;
const nextId = () => `m${(serial += 1)}`;

const failureText = (err) => (err instanceof TypeError
  ? 'Could not reach insat. Check your connection and try again.'
  : err.message || 'AI could not answer just now. Please try again in a moment.');

export function AssistantProvider({ children }) {
  const { user } = useAuth();
  const offered = Boolean(user?.assistant) && (user.role === 'student' || user.role === 'admin');
  const [open, setOpenState] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null); // GET /api/assistant/status
  const [screens, setScreens] = useState([]); // [{ key, label, suggestions }], the last is current
  const [hidden, setHidden] = useState(0);
  const [hosts, setHosts] = useState(0);
  const [actions, setActions] = useState({});

  const live = useRef({});
  live.current = { messages, screens };
  const controller = useRef(null);
  const asking = useRef(false); // set at once, where `busy` waits for a render
  const focusLauncher = useRef(false);

  const refresh = useCallback(async () => {
    try { setStatus(await api.get('/api/assistant/status')); } catch { setStatus(null); }
  }, []);

  const stop = useCallback(() => controller.current?.abort(), []);

  const setOpen = useCallback((value) => {
    setOpenState((was) => {
      const next = typeof value === 'function' ? value(was) : value;
      if (was && !next) focusLauncher.current = true;
      return next;
    });
  }, []);

  const update = (id, fn) => setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  /** Ask a question: it goes with the screen as it is now, and the answer streams in. */
  const ask = useCallback(async (text) => {
    const question = String(text || '').trim();
    if (!question || asking.current) return;
    asking.current = true;
    const here = live.current.screens.at(-1) || null;
    let shot = { text: '', figures: [] };
    try { shot = captureScreen(); } catch { /* the question goes without the screen */ }
    const history = live.current.messages
      .filter((m) => m.content && m.state !== 'error')
      .map(({ role, content }) => ({ role, content }));
    const mine = { id: nextId(), role: 'user', content: question, screen: here?.label || null };
    const reply = { id: nextId(), role: 'assistant', content: '', state: 'streaming' };
    setMessages((ms) => [...ms, mine, reply]);
    setDraft('');
    setBusy(true);
    const ctrl = new AbortController();
    controller.current = ctrl;

    // Text arrives in small pieces; the screen takes them once a frame.
    let pending = '';
    let frame = 0;
    const flush = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (!pending) return;
      const more = pending;
      pending = '';
      update(reply.id, (m) => ({ ...m, content: m.content + more }));
    };

    try {
      await api.stream('/api/assistant/chat', {
        messages: [...history, { role: 'user', content: question }],
        screen: { title: here?.label || undefined, text: shot.text, figures: shot.figures },
      }, {
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === 'text') {
            pending += e.text;
            if (!frame) frame = requestAnimationFrame(flush);
          } else if (e.type === 'done') {
            flush();
            update(reply.id, (m) => ({ ...m, state: 'done', truncated: Boolean(e.truncated) }));
            setStatus((s) => (s ? { ...s, remaining: e.remaining } : s));
          } else if (e.type === 'error') {
            flush();
            update(reply.id, (m) => ({ ...m, state: 'error', error: e.message }));
          }
        },
      });
      // The connection ended without saying how the answer did.
      update(reply.id, (m) => (m.state !== 'streaming' ? m
        : m.content ? { ...m, state: 'done' } : { ...m, state: 'error', error: 'The answer did not arrive. Please try again.' }));
    } catch (err) {
      flush();
      if (ctrl.signal.aborted) {
        update(reply.id, (m) => ({ ...m, state: 'stopped' }));
      } else if (REFUSALS.has(err.code)) {
        // Not sent: the question goes back in the box, and the panel says why.
        setMessages((ms) => ms.filter((m) => m.id !== mine.id && m.id !== reply.id));
        setDraft((d) => d || question);
        refresh();
      } else {
        update(reply.id, (m) => ({ ...m, state: 'error', error: failureText(err) }));
      }
    } finally {
      if (controller.current === ctrl) controller.current = null;
      asking.current = false;
      setBusy(false);
    }
  }, [refresh]);

  /** Ask the last question again (after it failed). */
  const retry = useCallback(() => {
    const ms = live.current.messages;
    const last = ms.at(-1);
    const question = ms.at(-2);
    if (asking.current || last?.role !== 'assistant' || question?.role !== 'user') return;
    setMessages(ms.slice(0, -2));
    live.current.messages = ms.slice(0, -2);
    ask(question.content);
  }, [ask]);

  /** A new conversation. */
  const reset = useCallback(() => {
    stop();
    setMessages([]);
    setDraft('');
  }, [stop]);

  // Registration, for the screens around it.
  const putScreen = useCallback((entry) => setScreens((s) => {
    const i = s.findIndex((x) => x.key === entry.key);
    if (i < 0) return [...s, entry];
    const copy = [...s];
    copy[i] = entry;
    return copy;
  }), []);
  const dropScreen = useCallback((key) => setScreens((s) => s.filter((x) => x.key !== key)), []);
  const hide = useCallback(() => {
    setHidden((n) => n + 1);
    return () => setHidden((n) => n - 1);
  }, []);
  const host = useCallback(() => {
    setHosts((n) => n + 1);
    return () => setHosts((n) => n - 1);
  }, []);
  const putAction = useCallback((name, fn) => {
    setActions((a) => ({ ...a, [name]: fn }));
    return () => setActions((a) => {
      const { [name]: _gone, ...rest } = a;
      return rest;
    });
  }, []);

  // Hidden (a test is being taken): closed, and nothing left asking.
  useEffect(() => {
    if (hidden) {
      setOpenState(false);
      stop();
    }
  }, [hidden, stop]);

  // Whether it can answer, each time it opens.
  useEffect(() => {
    if (open && offered) refresh();
  }, [open, offered, refresh]);

  const registry = useMemo(
    () => ({ putScreen, dropScreen, hide, host, putAction, refresh }),
    [putScreen, dropScreen, hide, host, putAction, refresh],
  );
  const state = useMemo(() => ({
    offered,
    role: user?.role,
    // A test is on screen (the runner hides the assistant): other chrome steps aside too.
    onTest: hidden > 0,
    open: open && offered && !hidden,
    setOpen,
    messages,
    draft,
    setDraft,
    busy,
    status,
    screen: screens.at(-1) || null,
    actions,
    ask,
    retry,
    reset,
    stop,
    refresh,
    focusLauncher,
  }), [offered, user?.role, open, hidden, setOpen, messages, draft, busy, status, screens, actions, ask, retry, reset, stop, refresh]);

  // It floats over a screen that has named itself (so not over the app while
  // it loads), unless that screen hides it or shows it itself.
  return (
    <ApiCtx.Provider value={registry}>
      <StateCtx.Provider value={state}>
        {children}
        {offered && screens.length > 0 && !hidden && !hosts && <Floating />}
      </StateCtx.Provider>
    </ApiCtx.Provider>
  );
}

/** The assistant's state and what can be done with it, or null outside the signed-in app. */
export const useAssistant = () => useContext(StateCtx);

/** The part of the screen a phone's keyboard leaves (its visual viewport), while `active`: a panel that fills the screen is sized to it. */
export function useVisibleBox(active) {
  const [box, setBox] = useState(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return undefined;
    const on = () => setBox({ top: vv.offsetTop, height: vv.height });
    on();
    vv.addEventListener('resize', on);
    vv.addEventListener('scroll', on);
    return () => {
      vv.removeEventListener('resize', on);
      vv.removeEventListener('scroll', on);
    };
  }, [active]);
  return active ? box : null;
}

/** Whether a media query matches, kept up to date. */
export function useMedia(query) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

/**
 * Name the screen this component shows, for the AI and for the person (the
 * panel says what the AI sees), with questions worth asking on it. The screen
 * mounted last is the current one.
 */
export function useAssistantScreen(label, suggestions = []) {
  const registry = useContext(ApiCtx);
  const key = useId();
  const asked = JSON.stringify(suggestions);
  useEffect(() => (registry ? () => registry.dropScreen(key) : undefined), [registry, key]);
  useEffect(() => {
    if (registry && label) registry.putScreen({ key, label, suggestions: JSON.parse(asked) });
  }, [registry, key, label, asked]);
}

/** While this component is shown (`active`), the assistant is not: the test runner. Before it paints, so it never shows. */
export function useAssistantHidden(active = true) {
  const registry = useContext(ApiCtx);
  useLayoutEffect(() => (registry && active ? registry.hide() : undefined), [registry, active]);
}

/** While `active`, this component shows the conversation itself, in place of the floating panel (from its first paint). */
export function useAssistantHost(active = true) {
  const registry = useContext(ApiCtx);
  useLayoutEffect(() => (registry && active ? registry.host() : undefined), [registry, active]);
}

/** A way to have the assistant check again whether it can answer (after a setting that bears on it changed). */
export function useAssistantRefresh() {
  const registry = useContext(ApiCtx);
  return registry?.refresh || (() => {});
}

/** Something the assistant can lead to (an admin's Settings), by name. */
export function useAssistantAction(name, fn) {
  const registry = useContext(ApiCtx);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => (registry && fn ? registry.putAction(name, (...args) => latest.current(...args)) : undefined), [registry, name, Boolean(fn)]); // eslint-disable-line react-hooks/exhaustive-deps
}

function Launcher() {
  const a = useAssistant();
  const ref = useRef(null);
  useEffect(() => {
    if (a.focusLauncher.current) {
      a.focusLauncher.current = false;
      ref.current?.focus();
    }
  }, [a.focusLauncher]);
  return (
    <button
      ref={ref}
      type="button"
      data-assistant
      aria-label="Ask AI"
      aria-haspopup="dialog"
      onClick={() => a.setOpen(true)}
      onPointerEnter={loadChat}
      onFocus={loadChat}
      className="fixed right-4 bottom-4 z-45 inline-flex size-12 items-center justify-center gap-2 rounded-full bg-primary text-primary-foreground shadow-lg ring-1 shadow-black/15 ring-black/5 transition-[filter,transform] outline-none select-none hover:brightness-110 focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.97] animate-in fade-in-0 zoom-in-90 animation-duration-200 sm:right-6 sm:bottom-6 sm:h-11 sm:w-auto sm:pr-4 sm:pl-3.5"
    >
      <LuSparkles className="size-5 sm:size-4" />
      <span className="text-sm font-medium max-sm:sr-only">Ask AI</span>
    </button>
  );
}

/** The panel's frame while its chunk loads (briefly, the first time). */
const PanelLoading = () => (
  <div data-assistant className="fixed z-45 flex items-center justify-center bg-background max-sm:inset-0 sm:right-6 sm:bottom-6 sm:h-[min(40rem,calc(100svh-3rem))] sm:w-100 sm:rounded-2xl sm:border sm:shadow-2xl">
    <Spinner className="size-5 text-muted-foreground" />
  </div>
);

function Floating() {
  const a = useAssistant();
  if (!a.open) return <Launcher />;
  return (
    <Suspense fallback={<PanelLoading />}>
      <FloatingPanel onClose={() => a.setOpen(false)} />
    </Suspense>
  );
}
