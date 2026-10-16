// The AI assistant's conversation, as assistant.jsx keeps it: what to ask on
// this screen, the messages as their answers stream in, why it cannot answer
// when it cannot, and the box to ask in. Framed as the floating panel (the
// whole screen on a phone, kept clear of its keyboard), or as a pane in a
// question's review.

import React, { useEffect, useLayoutEffect, useRef } from 'react';
import {
  LuArrowUp, LuCircleAlert, LuClock, LuEye, LuLock, LuRotateCcw, LuSparkles, LuSquare, LuSquarePen, LuX,
} from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { MAX_MESSAGE, useAssistant, useMedia, useVisibleBox } from './assistant.jsx';
import { Reply } from './Markdown.jsx';

/**
 * Keep focus in the assistant as a control that starts an answer (a
 * suggestion, "Try again") leaves the page: on the box to ask in where there
 * is a keyboard to type with, else on the conversation (no keyboard pops up
 * over the answer). Escape still closes it, and a screen reader stays put.
 */
function keepFocus(from) {
  const root = from.closest('[data-assistant]');
  const box = window.matchMedia('(pointer: fine)').matches && root?.querySelector('textarea');
  (box || root?.querySelector('[role="log"]'))?.focus();
}

const Mark = ({ className }) => (
  <span className={cn('flex shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground', className)}>
    <LuSparkles className="size-[55%]" />
  </span>
);

function Header({ onClose, closeLabel }) {
  const a = useAssistant();
  return (
    <div className="flex h-14 shrink-0 items-center gap-2.5 border-b pr-2 pl-4">
      <Mark className="size-7" />
      <div className="min-w-0 flex-1 leading-tight">
        <h2 className="text-sm font-semibold">AI assistant</h2>
        {a.screen?.label && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground" title="What the AI sees when you send a message">
            <LuEye className="size-3 shrink-0" />
            <span className="truncate">Sees: {a.screen.label}</span>
          </p>
        )}
      </div>
      {a.messages.length > 0 && (
        <Button variant="ghost" size="icon-sm" aria-label="New chat" title="New chat" onClick={a.reset}><LuSquarePen /></Button>
      )}
      <Button variant="ghost" size="icon-sm" aria-label={closeLabel} title={closeLabel} onClick={onClose}><LuX /></Button>
    </div>
  );
}

function Welcome() {
  const a = useAssistant();
  const suggestions = a.screen?.suggestions || [];
  const blocked = a.status && !a.status.ready;
  return (
    <div className="mt-auto space-y-5">
      <div className="space-y-2">
        <Mark className="size-9 rounded-xl" />
        <h3 className="pt-1 text-base font-semibold tracking-tight">Ask about what is on your screen</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {a.role === 'admin'
            ? 'I see the screen you are on when you send a message, so you can ask about your students’ results, what you are looking at, or how to do something in insat.'
            : 'I see the screen you are on when you send a message, so you can ask about a question you are reviewing, your results, what to practice, or how insat works.'}
        </p>
      </div>
      {suggestions.length > 0 && !blocked && (
        <div className="flex flex-col items-start gap-2">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={(e) => {
                keepFocus(e.currentTarget);
                a.ask(s);
              }}
              disabled={a.busy}
              className="rounded-full border bg-background px-3.5 py-1.5 text-left text-sm shadow-xs transition-colors outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const Typing = () => (
  <span role="status" aria-label="AI is writing" className="inline-flex h-5 items-center gap-1">
    {[0, 150, 300].map((delay) => (
      <span key={delay} className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60" style={{ animationDelay: `${delay}ms` }} />
    ))}
  </span>
);

function Message({ m, last }) {
  const a = useAssistant();
  if (m.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1 pl-8">
        <div className="max-w-full rounded-2xl rounded-br-md bg-muted px-3.5 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap">{m.content}</div>
        {m.screen && (
          <div className="flex max-w-full items-center gap-1 pr-1 text-[11px] text-muted-foreground">
            <LuEye className="size-3 shrink-0" /><span className="truncate">{m.screen}</span>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="text-sm">
      {m.content ? <Reply text={m.content} partial={m.state !== 'done'} /> : m.state === 'streaming' && <Typing />}
      {m.truncated && <p className="mt-1.5 text-xs text-muted-foreground">The answer was cut short. Ask to go on.</p>}
      {m.state === 'stopped' && <p className="mt-1.5 text-xs text-muted-foreground">Stopped.</p>}
      {m.state === 'error' && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex items-start gap-1.5 text-destructive"><LuCircleAlert className="mt-0.5 size-4 shrink-0" />{m.error}</span>
          {last && (
            <Button variant="outline" size="xs" onClick={(e) => { keepFocus(e.currentTarget); a.retry(); }}>
              <LuRotateCcw /> Try again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Messages() {
  const a = useAssistant();
  const ref = useRef(null);
  // Follow the answer as it grows, unless the reader has scrolled up; a new
  // message brings the conversation to its end again.
  const stick = useRef(true);
  const seen = useRef(0);
  const count = a.messages.length;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (count !== seen.current) {
      seen.current = count;
      stick.current = true;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [a.messages, count]);
  return (
    <div
      ref={ref}
      role="log"
      tabIndex={-1}
      aria-live="polite"
      aria-busy={a.busy}
      aria-label="Conversation with the AI assistant"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-4 py-5 outline-none"
    >
      {count === 0 ? <Welcome /> : a.messages.map((m, i) => <Message key={m.id} m={m} last={i === count - 1} />)}
    </div>
  );
}

const NOTICE_ICONS = { test: LuLock, limit: LuClock };

/** Why it cannot answer now, in place of the box to ask in. */
function Notice() {
  const a = useAssistant();
  const { reason, message } = a.status;
  const Icon = NOTICE_ICONS[reason] || LuCircleAlert;
  const openSettings = reason === 'not_configured' && a.actions.openSettings;
  return (
    <div className="shrink-0 border-t p-3">
      <div className={cn(
        'flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm leading-relaxed',
        reason === 'test' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'bg-muted/50',
      )}>
        <Icon className={cn('mt-0.5 size-4 shrink-0', reason === 'test' ? 'text-amber-700' : 'text-muted-foreground')} />
        <div className="min-w-0 space-y-2.5">
          <p>{message}</p>
          {openSettings && (
            <Button size="sm" onClick={() => { a.setOpen(false); openSettings(); }}>Open Settings</Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Composer({ autoFocus }) {
  const a = useAssistant();
  const ref = useRef(null);
  const text = a.draft;
  const over = text.length > MAX_MESSAGE;
  const left = a.status?.ready ? a.status.remaining : null;

  // Grow with what is typed, up to about six lines.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 152)}px`;
  }, [text]);
  // Ready to type, where there is a keyboard to type on.
  useEffect(() => {
    if (autoFocus && window.matchMedia('(pointer: fine)').matches) ref.current?.focus();
  }, [autoFocus]);

  const send = (e) => {
    e?.preventDefault();
    if (!a.busy && text.trim() && !over) a.ask(text);
  };
  return (
    <form onSubmit={send} className="shrink-0 border-t bg-background p-3">
      <div className="flex items-end gap-2 rounded-xl border border-input bg-background py-1.5 pr-1.5 pl-3 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => a.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e);
          }}
          enterKeyHint="send"
          placeholder={a.messages.length ? 'Ask a follow-up…' : 'Ask about this screen…'}
          aria-label="Message the AI assistant"
          aria-invalid={over || undefined}
          className="scrollbar-thin max-h-38 min-h-7 flex-1 resize-none bg-transparent py-1 text-base leading-snug outline-none placeholder:text-muted-foreground sm:text-sm"
        />
        {a.busy ? (
          <Button type="button" size="icon-sm" variant="secondary" aria-label="Stop the answer" title="Stop"
            onClick={(e) => { keepFocus(e.currentTarget); a.stop(); }}>
            <LuSquare className="size-3 fill-current" />
          </Button>
        ) : (
          <Button type="submit" size="icon-sm" aria-label="Send" title="Send" disabled={!text.trim() || over}><LuArrowUp /></Button>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 px-1 text-[11px] leading-none text-muted-foreground">
        <span>AI can make mistakes. Check what matters.</span>
        {text.length > MAX_MESSAGE - 200 ? (
          <span className={cn('tabular-nums', over && 'font-medium text-destructive')}>{text.length}/{MAX_MESSAGE}</span>
        ) : left != null && left <= 10 && (
          <span className="tabular-nums">{left} left today</span>
        )}
      </div>
    </form>
  );
}

function Conversation({ autoFocus }) {
  const a = useAssistant();
  return (
    <>
      <Messages />
      {a.status && !a.status.ready ? <Notice /> : <Composer autoFocus={autoFocus} />}
    </>
  );
}

/** The panel in the corner of the screen (the whole screen on a phone). */
export function FloatingPanel({ onClose }) {
  const phone = useMedia('(max-width: 639px)');
  const box = useVisibleBox(phone);
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  // On a phone the panel is the screen: the page behind it stays put.
  useEffect(() => {
    if (!phone) return undefined;
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => { html.style.overflow = before; };
  }, [phone]);
  // Escape closes it from inside it, or when nothing else has focus (not
  // from the page, or from a dialog over it).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const at = document.activeElement;
      if (!at || at === document.body || ref.current?.contains(at)) close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <section
      ref={ref}
      role="dialog"
      aria-label="AI assistant"
      data-assistant
      style={box ? { top: box.top, height: box.height } : undefined}
      className="fixed z-45 flex flex-col overflow-hidden bg-background animate-in fade-in-0 animation-duration-200 max-sm:inset-x-0 max-sm:top-0 max-sm:h-svh sm:right-6 sm:bottom-6 sm:h-[min(40rem,calc(100svh-3rem))] sm:w-100 sm:rounded-2xl sm:border sm:shadow-2xl sm:slide-in-from-bottom-2"
    >
      <Header onClose={onClose} closeLabel="Close" />
      <Conversation autoFocus />
    </section>
  );
}

/** The conversation as a pane of a question's review. */
export function ReviewPane({ onClose }) {
  return (
    <section aria-label="AI assistant" data-assistant className="flex min-h-0 flex-1 flex-col bg-background lg:w-100 lg:flex-none lg:border-l">
      <Header onClose={onClose} closeLabel="Close the AI assistant" />
      <Conversation autoFocus />
    </section>
  );
}
