// The predicted SAT score (functions/lib/prediction.js): what a student's
// answers so far say they would most likely score on a full practice test,
// and the range it likely falls in. A student's dashboard and a student's page
// show it whole (the score per section and in all); the rosters, its total.
// A section has no prediction until there is enough to go on: about a
// section's worth of answers, across the section.

import React from 'react';
import { LuGauge } from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const range = (part) => `${part.low}–${part.high}`;
const count = (n) => `${n.toLocaleString()} ${n === 1 ? 'answer' : 'answers'}`;

// Whose prediction it is: the student's own, or a student's to their academy.
const WORDS = {
  you: {
    basis: (n) => `From your ${count(n)} in tests and practice. Harder questions count for more, and recent ones count most.`,
    pending: 'Your predicted score appears once you have answered enough questions across a section, in tests or practice. A practice test is the quickest way there.',
  },
  student: {
    basis: (n) => `From the student’s ${count(n)} in tests and practice. Harder questions count for more, and recent ones count most.`,
    pending: 'Their predicted score appears once they have answered enough questions across a section, in tests or practice.',
  },
};

/**
 * One predicted score: its label, the score (or a dash until it is ready) and
 * its range. Side by side, the scores sit in boxes of the total's height, so
 * the labels, the scores and the ranges each keep to one line.
 */
function Figure({ label, part, waiting, lead = false, className }) {
  const ready = part?.score != null;
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-2 flex items-end sm:h-12">
        <span className={cn(
          'leading-none font-semibold tracking-tight tabular-nums',
          lead ? 'text-5xl' : 'text-3xl',
          !ready && 'text-muted-foreground/50',
        )}>
          {ready ? part.score : '-'}
        </span>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">{ready ? `Likely ${range(part)}` : waiting}</div>
    </div>
  );
}

/** The whole prediction, in a card; nothing for a student who has answered nothing yet. */
export function PredictedScore({ prediction, subject = 'you', className }) {
  const p = prediction;
  if (!p?.answered) return null;
  const words = WORDS[subject] || WORDS.you;
  const any = p.rw?.ready || p.math?.ready;
  return (
    <Card className={cn('gap-5 px-6 py-6 sm:px-8', className)}>
      <div className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <LuGauge className="size-4 text-foreground" />Predicted SAT score
      </div>
      {any ? (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <Figure lead label="Total" part={p.total} waiting="Needs both sections" className="col-span-2 sm:col-span-1" />
            <Figure label="Reading and Writing" part={p.rw} waiting="Needs more answers" />
            <Figure label="Math" part={p.math} waiting="Needs more answers" />
          </div>
          <p className="border-t pt-4 text-xs leading-relaxed text-muted-foreground">{words.basis(p.answered)}</p>
        </>
      ) : (
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{words.pending}</p>
      )}
    </Card>
  );
}

/** What a roster shows of a prediction: its total, else the one section there is, the rest on hover. */
export function PredictedFigure({ predicted, className }) {
  const p = predicted;
  const sections = [['Reading and Writing', p?.rw], ['Math', p?.math]];
  const only = !p?.total && sections.filter(([, part]) => part?.ready);
  const shown = p?.total
    ? { value: p.total.score, label: 'Predicted' }
    : only?.length === 1
      ? { value: only[0][1].score, label: `Predicted ${only[0][0].toLowerCase()}` }
      : { value: '-', label: 'Predicted' };
  const detail = p?.total || only?.length
    ? [
      p.total && `Total ${p.total.score}, likely ${range(p.total)}`,
      ...sections.map(([name, part]) => (part?.ready ? `${name} ${part.score}, likely ${range(part)}` : `${name}: not enough answers yet`)),
    ].filter(Boolean)
    : ['Not enough answers yet'];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div tabIndex={0} aria-label={`${shown.label}: ${shown.value === '-' ? 'not yet' : shown.value}. ${detail.join('. ')}`}
          className={cn('rounded-sm text-right outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', className)}>
          <div className={cn('font-mono text-xl leading-none font-semibold tabular-nums', shown.value === '-' && 'text-muted-foreground/50')}>
            {shown.value}
          </div>
          <div className="mt-1.5 text-[11px] font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase">{shown.label}</div>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="grid gap-0.5">{detail.map((line) => <div key={line} className="whitespace-nowrap">{line}</div>)}</div>
      </TooltipContent>
    </Tooltip>
  );
}
