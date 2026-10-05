// insat's own building blocks, on top of shadcn/ui (components/ui): the brand
// mark, section headings, status badges, errors, empty and loading states,
// and the confirmation dialog. Every surface imports from here or from
// components/ui, so the look stays one look.

import React, { useState } from 'react';
import { LuArrowRight, LuCircleAlert } from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { ROUTES, navigate } from './nav.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// --- Brand ------------------------------------------------------------------

/** The insat app icon, or an institution's own logo (cropped to a circle). */
export const Logo = ({ size = 32, src, className }) => (
  <img
    src={src || '/insat-app-icon.svg'}
    alt=""
    width={size}
    height={size}
    className={cn('block shrink-0', src ? 'rounded-full object-cover' : 'object-contain', className)}
  />
);

// Heights: insat's logo (the kit's mark and lettering, framed to what it
// paints), or an institution's logo beside its name.
const WORDMARK = { sm: [20, 24, 'text-sm'], md: [26, 28, 'text-base'], lg: [36, 36, 'text-lg'] };

/** insat's logo, or the institution's logo and name when `brand` = { logoSrc, name }. */
export function Wordmark({ size = 'md', brand = null, className }) {
  const [height, logo, text] = WORDMARK[size];
  if (!brand) {
    return <img src="/insat-logo.svg" alt="insat" style={{ height }} className={cn('block w-auto shrink-0', className)} />;
  }
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2.5', className)}>
      <Logo size={logo} src={brand.logoSrc} />
      <span className={cn('truncate font-semibold tracking-tight', text)}>{brand.name}</span>
    </span>
  );
}

/**
 * The logo and name as the way home: `onHome` is the app's own home (the
 * dashboard, the first section), the landing page without one. The href keeps
 * open-in-new-tab working.
 */
export function HomeLink({ onHome = () => navigate(ROUTES.home), label = 'insat', className, children }) {
  return (
    <a
      href={ROUTES.home}
      aria-label={`${label} home`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onHome();
      }}
      className={cn('inline-flex min-w-0 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', className)}
    >
      {children}
    </a>
  );
}

// --- Actions ----------------------------------------------------------------

/** A button that shows it is working: a spinner in place of its icon. */
export function Action({ busy, children, icon: Icon = LuArrowRight, ...props }) {
  return (
    <Button {...props}>
      {busy && <Spinner />}
      {children}
      {!busy && Icon && <Icon data-icon="inline-end" />}
    </Button>
  );
}

/**
 * A choice among a few options, each a card with a title and a line under it
 * (a radio group): `options` = [{ value, title, description }].
 */
export function ChoiceCards({ label, options, value, onChange, className }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('grid gap-2', className)}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
            className={cn(
              'flex items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              on ? 'border-primary bg-muted/60' : 'hover:bg-muted/40',
            )}>
            <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border', on && 'border-primary')}>
              {on && <span className="size-2 rounded-full bg-primary" />}
            </span>
            <span>
              <span className="block text-sm font-medium">{o.title}</span>
              {o.description && <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{o.description}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// --- Headings ---------------------------------------------------------------

/** A section's title, with an optional eyebrow, a line under it and actions on the right. */
export function SectionHeading({ eyebrow, title, description, actions, as: Heading = 'h2', className }) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}>
      <div className="min-w-0 space-y-1">
        {eyebrow && <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{eyebrow}</div>}
        <Heading className={cn('font-semibold tracking-tight', Heading === 'h1' ? 'text-2xl' : 'text-xl')}>{title}</Heading>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// --- Status -----------------------------------------------------------------

// Meaning, not decoration: green is right or strong, amber is pending or
// building, red is wrong or needs focus. Everything else stays neutral.
export const TONE = {
  success: { badge: 'border-emerald-200 bg-emerald-50 text-emerald-700', bar: 'bg-emerald-500', text: 'text-emerald-700', soft: 'border-emerald-200 bg-emerald-50' },
  warning: { badge: 'border-amber-200 bg-amber-50 text-amber-700', bar: 'bg-amber-500', text: 'text-amber-700', soft: 'border-amber-200 bg-amber-50' },
  danger: { badge: 'border-red-200 bg-red-50 text-red-700', bar: 'bg-red-500', text: 'text-red-700', soft: 'border-red-200 bg-red-50' },
  neutral: { badge: 'border-border bg-muted text-muted-foreground', bar: 'bg-muted-foreground/40', text: 'text-muted-foreground', soft: 'border-border bg-muted/50' },
};

export const StatusBadge = ({ tone = 'neutral', className, children }) => (
  <Badge variant="outline" className={cn(TONE[tone].badge, className)}>{children}</Badge>
);

/** A thin accuracy bar, colored by how it reads, by `tone`, or by `barClassName`. */
export function Meter({ value, tone, barClassName, className }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const t = tone || (pct >= 75 ? 'success' : pct >= 50 ? 'warning' : 'danger');
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div className={cn('h-full rounded-full transition-[width]', barClassName || TONE[t].bar)} style={{ width: `${pct}%` }} />
    </div>
  );
}

// --- Feedback ---------------------------------------------------------------

export const ErrorNote = ({ children, className }) => (children ? (
  <Alert variant="destructive" className={cn('border-destructive/30 bg-destructive/5', className)}>
    <LuCircleAlert />
    <AlertDescription>{children}</AlertDescription>
  </Alert>
) : null);

export const Loading = ({ className }) => (
  <div className={cn('flex justify-center py-16', className)}>
    <Spinner className="size-6 text-muted-foreground" />
  </div>
);

export const FullScreenSpinner = () => <Loading className="min-h-svh items-center py-0" />;

export const EmptyState = ({ icon: Icon, title, hint, children, className }) => (
  <Empty className={cn('border', className)}>
    <EmptyHeader>
      {Icon && <EmptyMedia variant="icon"><Icon /></EmptyMedia>}
      <EmptyTitle>{title}</EmptyTitle>
      {hint && <EmptyDescription>{hint}</EmptyDescription>}
    </EmptyHeader>
    {children}
  </Empty>
);

/**
 * A confirmation before something that cannot be undone. onConfirm may be
 * async: the dialog stays open, busy, until it finishes; if it throws, the
 * dialog stays open and says why instead of closing as if it worked.
 * Native browser dialogs are not used in this app: they cannot be styled and
 * they flash the hosting domain in their chrome.
 */
export function ConfirmDialog({ title, body, confirmLabel = 'Confirm', danger = false, onConfirm, onCancel }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const confirm = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err.message || 'That could not be done.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {body && <AlertDialogDescription>{body}</AlertDialogDescription>}
        </AlertDialogHeader>
        <ErrorNote>{error}</ErrorNote>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={danger ? 'destructive' : 'default'} disabled={busy} onClick={confirm}>
            {busy && <Spinner />}
            {busy ? 'Working…' : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
