// Small shared building blocks for the admin panels. Kept deliberately tiny so
// each panel can compose them without prop-drilling or a heavy abstraction.

import React, { useState } from 'react';
import { LuX } from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog, SectionHeading, TONE } from '../ui.jsx';

export const initialsOf = (name, email) => (name || email || '?')
  .split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

/** A date as "Oct 2, 2026"; with `time`, "Oct 2, 3:30 PM". */
export function fmtDate(iso, { time = false } = {}) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, time
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** A labelled input, with an optional hint under it. */
export function Field({ id, label, hint, ...props }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * A form in a dialog that cannot be closed while it is saving. A `tall` one
 * keeps its title and buttons in view and scrolls what is between them.
 */
export function FormDialog({ busy, onClose, title, description, children, footer, onSubmit, className, tall = false }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className={cn('sm:max-w-md', tall && 'flex max-h-[min(90svh,56rem)] flex-col gap-0 p-0', className)}>
        <form onSubmit={onSubmit} className={tall ? 'flex min-h-0 flex-col' : 'grid gap-5'}>
          <DialogHeader className={cn(tall && 'border-b px-6 pt-6 pb-4 pr-12')}>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {tall ? <div className="scrollbar-thin grid min-h-0 gap-5 overflow-y-auto px-6 py-5">{children}</div> : children}
          <DialogFooter className={cn(tall && 'border-t px-6 py-4')}>{footer}</DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A panel's title, with an optional eyebrow, a line under it and actions on the right. */
export function SectionHead({ eyebrow, title, sub, right }) {
  return <SectionHeading as="h1" eyebrow={eyebrow} title={title} description={sub} actions={right} className="mb-6" />;
}

/**
 * Hook that returns [confirmNode, ask]. Call ask({ title, message, confirmLabel,
 * tone, onConfirm }) to open a styled confirmation that runs onConfirm; if it
 * fails, the dialog stays open and says why.
 */
export function useConfirm() {
  const [state, setState] = useState(null);
  const node = state ? (
    <ConfirmDialog
      title={state.title || 'Are you sure?'}
      body={state.message}
      confirmLabel={state.confirmLabel || 'Confirm'}
      danger={state.tone === 'danger'}
      onCancel={() => setState(null)}
      onConfirm={async () => { await state.onConfirm?.(); setState(null); }}
    />
  ) : null;
  return [node, setState];
}

/** Inline summary of what an action did (success, warning, danger or neutral). */
export function ResultBanner({ tone = 'success', children, onDismiss }) {
  const t = TONE[tone] || TONE.success;
  return (
    <Alert className={cn(t.soft, onDismiss && 'pr-11')}>
      <AlertDescription className={t.text}>{children}</AlertDescription>
      {onDismiss && (
        <Button variant="ghost" size="icon-xs" className={cn('absolute top-2.5 right-2.5', t.text)} aria-label="Dismiss" onClick={onDismiss}>
          <LuX />
        </Button>
      )}
    </Alert>
  );
}

/** A big number over a small label, for stats and scores. */
export function Stat({ label, value, size = 'md', className }) {
  return (
    <div className={className}>
      <div className={cn('font-mono leading-none font-semibold tabular-nums', size === 'lg' ? 'text-4xl' : 'text-2xl')}>{value ?? '-'}</div>
      <div className="mt-1.5 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
