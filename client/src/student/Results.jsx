// Results screen for a completed attempt. Renders the server-computed scores,
// what to practise next, and a per-question review (correct answer + the
// student's choice + an explanation for each choice). Driven entirely by the
// API results payload.
//
// A full test reports a total out of 1600, one section a score out of 800,
// and a skill practice set (which has no scaled score) correct of total.

import React, { useEffect, useState } from 'react';
import { LuArrowRight, LuChevronLeft, LuChevronRight, LuRotateCcw, LuTarget, LuX } from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { api, assetUrl } from '../api.js';
import { ErrorNote, Meter, StatusBadge } from '../ui.jsx';
import { MathText } from '../MathText.jsx';
import { LETTERS } from './tools.jsx';
import { LEVELS } from '../skills.jsx';

/** Skills missed in this attempt, weakest first: the ones to practise next. */
function missedSkills(sections) {
  return sections
    .flatMap((s) => s.skills || [])
    .filter((k) => k.correct < k.total)
    .sort((a, b) => a.correct / a.total - b.correct / b.total || b.total - a.total);
}

const isAnswered = (q) => (q.selectedIdx !== null && q.selectedIdx !== undefined)
  || (q.selectedText !== null && q.selectedText !== undefined && q.selectedText !== '');

const eyebrow = 'text-xs font-medium tracking-wide text-muted-foreground uppercase';

// `overall` (skill sets only): the student's standing in the skill across
// everything answered so far, this set included.
function Bar({ label, correct, total, overall }) {
  const pct = total ? Math.round((100 * correct) / total) : 0;
  const lv = overall && (LEVELS[overall.level] || LEVELS.untested);
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between gap-3 text-sm">
        <span className="leading-snug text-muted-foreground">{label}</span>
        <span className="font-mono font-medium whitespace-nowrap tabular-nums">{correct}/{total}</span>
      </div>
      <Meter value={pct} />
      {overall && (
        <div className="flex items-center justify-between gap-3 pt-0.5 text-xs text-muted-foreground">
          <span>Overall: {overall.correct} of {overall.answered} correct</span>
          <StatusBadge tone={lv.tone}>{lv.label}</StatusBadge>
        </div>
      )}
    </div>
  );
}

const Panel = ({ title, children }) => (
  <Card>
    <CardHeader><CardTitle className={eyebrow}>{title}</CardTitle></CardHeader>
    <CardContent className="gap-5">{children}</CardContent>
  </Card>
);

// `standing` (the student's profile by skill, once loaded) keeps out skills
// with nothing left to serve, so the button never offers an empty set.
function NextSteps({ sections, skillSet, standing, starting, error, onPractice }) {
  const servable = (skill) => {
    const k = standing?.get(skill);
    return !k || k.ready > 0 || k.more;
  };
  const missed = missedSkills(sections).filter((k) => servable(k.skill)).slice(0, 3);
  const practised = sections.flatMap((s) => s.skills || []).map((k) => k.skill).filter(servable);
  // A perfect skill set is worth repeating: the next one is set harder.
  const skills = missed.length ? missed.map((k) => k.skill) : skillSet ? practised : [];
  if (!skills.length) return null;
  const busy = starting === 'results';
  return (
    <Card className="flex-row flex-wrap items-center gap-x-5 gap-y-4 px-6 py-5">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
        <LuTarget className="size-5" />
      </div>
      <div className="min-w-60 flex-1">
        <div className="font-semibold tracking-tight">{missed.length ? 'Practice what you missed' : 'Every answer right'}</div>
        <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
          {missed.length
            ? `New questions in ${skills.join(', ')}, at a difficulty that fits how you did.`
            : 'Practice the same skills again, at a level that fits how you are doing.'}
        </p>
      </div>
      <Button className="px-3" disabled={Boolean(starting)} onClick={() => onPractice(skills)}>
        {busy && <Spinner />}
        {busy ? 'Preparing…' : missed.length === 1 ? 'Practice this skill' : missed.length ? 'Practice these skills' : 'Practice again'}
        {!busy && <LuArrowRight data-icon="inline-end" />}
      </Button>
      {error && <ErrorNote className="basis-full">{error}</ErrorNote>}
    </Card>
  );
}

export default function Results({ results, onBack, onPractice, starting = null, error = null }) {
  const [review, setReview] = useState(null); // {sIdx, qIdx}
  const sections = results.sections || [];
  const skillSet = results.practice?.mode === 'skills';
  // The student's profile, now including this attempt: where each skill of a
  // skill set stands overall, and what can still be practiced.
  const [standing, setStanding] = useState(null);
  useEffect(() => {
    if (!onPractice) return undefined;
    let live = true;
    api.get('/api/student/profile')
      .then((p) => live && setStanding(new Map(p.skills.map((k) => [k.skill, k]))))
      .catch(() => {});
    return () => { live = false; };
  }, [onPractice]);
  // A test of the academy's own questions is not built like the SAT, so it has
  // no scaled score either: the number correct is its result.
  const custom = !skillSet && results.totalScaled == null;
  const single = !skillSet && sections.length === 1 ? sections[0] : null;
  const skillRows = sections.flatMap((s) => s.skills || []);
  const pct = results.totalQuestions ? Math.round((100 * results.totalCorrect) / results.totalQuestions) : 0;

  const hero = skillSet
    ? { label: 'Correct', value: `${results.totalCorrect}/${results.totalQuestions}`, sub: `${pct}% of this set`,
        foot: `${skillRows.length} ${skillRows.length === 1 ? 'skill' : 'skills'} practiced` }
    : custom
      ? { label: 'Correct', value: `${results.totalCorrect}/${results.totalQuestions}`, sub: `${pct}% of this test`,
          foot: 'This test is your academy\'s own, so it has no SAT scaled score.' }
      : single
        ? { label: `${single.name} score`, value: single.scaled, sub: 'out of 800 · scaled' }
        : { label: 'Total score', value: results.totalScaled, sub: 'out of 1600 · scaled' };

  return (
    <main className="mx-auto max-w-5xl animate-in space-y-8 px-4 pt-8 pb-16 animation-duration-300 fade-in-0 sm:px-6 sm:pt-10">
      <div className={eyebrow}>{results.examTitle} · Results</div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* The score is the payoff, so it is the one dark surface on the page. */}
        <Card className="justify-between bg-primary px-7 py-7 text-primary-foreground ring-0">
          <div>
            <div className="text-xs font-medium tracking-wide uppercase opacity-70">{hero.label}</div>
            <div className="mt-2 text-7xl font-semibold tracking-tighter tabular-nums">{hero.value}</div>
            <div className="mt-2 text-sm opacity-70">{hero.sub}</div>
          </div>
          <div className="border-t border-primary-foreground/15 pt-4 text-sm">
            {hero.foot || <><span className="font-semibold tabular-nums">{results.totalCorrect}</span> of {results.totalQuestions} questions correct</>}
          </div>
        </Card>

        {skillSet ? (
          <Panel title="By skill">
            {skillRows.map((k) => (
              <Bar key={k.skill} label={k.skill} correct={k.correct} total={k.total} overall={standing?.get(k.skill)} />
            ))}
          </Panel>
        ) : single ? (
          <Panel title="By content domain">
            {single.domains.map((d) => <Bar key={d.domain} label={d.label} correct={d.correct} total={d.total} />)}
          </Panel>
        ) : (
          <div className="grid gap-4">
            {sections.map((s) => (
              <Card key={s.kind} className="gap-3 px-6 py-5">
                <div className={eyebrow}>{s.name}</div>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <div className="text-4xl font-semibold tracking-tight tabular-nums">{s.scaled ?? `${s.correct}/${s.total}`}</div>
                  <div className="text-sm text-muted-foreground">
                    {s.scaled != null
                      ? `${s.correct}/${s.total} correct${s.route ? ` · ${s.route} route` : ''}`
                      : `${s.total ? Math.round((100 * s.correct) / s.total) : 0}% correct`}
                  </div>
                </div>
                <Meter value={s.total ? (100 * s.correct) / s.total : 0} barClassName="bg-primary" />
              </Card>
            ))}
          </div>
        )}
      </div>

      {onPractice && (
        <NextSteps sections={sections} skillSet={skillSet} standing={standing} starting={starting} error={error} onPractice={onPractice} />
      )}

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <Legend className="border-emerald-300 bg-emerald-50" label="Correct" />
          <Legend className="border-red-300 bg-red-50" label="Incorrect" />
          <Legend className="border-dashed border-foreground/30" label="Not answered" />
          <span className="w-full sm:ml-auto sm:w-auto">Click any question to see what went wrong.</span>
        </div>

        {sections.map((s, sIdx) => (
          <Card key={s.kind} className="gap-4 px-6">
            <h2 className="font-semibold tracking-tight">{s.name}: question review</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1.5">
              {s.questions.map((q, qIdx) => {
                const answered = isAnswered(q);
                return (
                  <button key={q.qid} type="button" onClick={() => setReview({ sIdx, qIdx })}
                    className={cn(
                      'aspect-square rounded-md border text-sm font-medium tabular-nums transition-colors',
                      !answered ? 'border-dashed border-foreground/25 text-muted-foreground hover:bg-muted/50'
                        : q.isCorrect ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                          : 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100',
                    )}>
                    {qIdx + 1}
                  </button>
                );
              })}
            </div>
          </Card>
        ))}
      </div>

      <Button variant="outline" size="lg" className="px-4" onClick={onBack}>
        <LuRotateCcw data-icon="inline-start" /> Back to dashboard
      </Button>

      {review && (
        <ReviewModal
          sections={sections}
          review={review}
          onClose={() => setReview(null)}
          onNav={(d) => {
            const sec = sections[review.sIdx];
            let q = review.qIdx + d, sI = review.sIdx;
            if (q < 0) { if (sI === 0) return; sI -= 1; q = sections[sI].questions.length - 1; }
            else if (q >= sec.questions.length) { if (sI === sections.length - 1) return; sI += 1; q = 0; }
            setReview({ sIdx: sI, qIdx: q });
          }}
        />
      )}
    </main>
  );
}

const Legend = ({ label, className }) => (
  <span className="inline-flex items-center gap-1.5">
    <span className={cn('size-3.5 rounded-[4px] border', className)} />
    {label}
  </span>
);

function ReviewModal({ sections, review, onClose, onNav }) {
  const s = sections[review.sIdx];
  const q = s.questions[review.qIdx];
  const rationale = q.rationale || {};
  const answered = isAnswered(q);
  const wrongLetter = !q.isCorrect && q.selectedIdx != null ? LETTERS[q.selectedIdx] : null;
  const wrongWhy = wrongLetter && rationale[wrongLetter];
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      {/* Escape closes; the arrow keys step through the questions. */}
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') onNav(-1);
          else if (e.key === 'ArrowRight') onNav(1);
        }}
      >
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <div className={eyebrow}>{s.name} · {q.moduleLabel}</div>
            {/* On a phone the badge moves under the title rather than splitting it. */}
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <DialogTitle className="text-lg font-semibold whitespace-nowrap">Question {review.qIdx + 1}</DialogTitle>
              <StatusBadge tone={q.isCorrect ? 'success' : answered ? 'danger' : 'warning'}>
                {q.isCorrect ? 'Correct' : answered ? 'Incorrect' : 'Not answered'}
              </StatusBadge>
            </div>
            <DialogDescription className={cn('mt-1', !q.skill && 'sr-only')}>{q.skill || 'Answer review'}</DialogDescription>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button variant="outline" size="icon-sm" aria-label="Previous question" onClick={() => onNav(-1)}><LuChevronLeft /></Button>
            <Button variant="outline" size="icon-sm" aria-label="Next question" onClick={() => onNav(1)}><LuChevronRight /></Button>
            <Button variant="outline" size="icon-sm" aria-label="Close" onClick={onClose}><LuX /></Button>
          </div>
        </div>

        <div className="scrollbar-thin overflow-y-auto px-5 py-5 sm:px-6">
          {q.passage && (
            <div className="mb-5 border-b pb-5">
              <div className={cn(eyebrow, 'mb-2')}>Passage</div>
              <div className="font-serif text-[15px] leading-[1.7]"><MathText text={q.passage} /></div>
            </div>
          )}
          {q.assetId && <img src={assetUrl(q.assetId)} alt="" className="mb-5 block max-h-80 max-w-full rounded-lg border" />}
          <div className="mb-4 text-[15px] leading-relaxed font-medium"><MathText text={q.question} /></div>
          {!answered && q.answerType !== 'grid-in' && (
            <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-800">
              You didn&apos;t answer this question.
            </div>
          )}
          {q.answerType === 'grid-in' ? (
            <div className="flex flex-wrap gap-3">
              <div className={cn('min-w-40 flex-1 rounded-lg border px-4 py-3',
                q.isCorrect ? 'border-emerald-300 bg-emerald-50/70' : answered ? 'border-red-300 bg-red-50/70' : 'border-amber-200 bg-amber-50')}>
                <div className={cn('mb-1 text-xs font-semibold tracking-wide uppercase',
                  q.isCorrect ? 'text-emerald-700' : answered ? 'text-red-700' : 'text-amber-800')}>Your answer</div>
                <div className="text-lg">{answered ? <MathText text={q.selectedText} /> : 'No answer'}</div>
              </div>
              <div className="min-w-40 flex-1 rounded-lg border border-emerald-300 bg-emerald-50/70 px-4 py-3">
                <div className="mb-1 text-xs font-semibold tracking-wide text-emerald-700 uppercase">Correct answer</div>
                <div className="text-lg"><MathText text={String(q.correctAnswer ?? '')} /></div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {q.choices.map((c, i) => {
                const correct = i === q.correctIdx;
                const user = i === q.selectedIdx;
                return (
                  <div key={i} className={cn('flex items-start gap-3 rounded-lg border px-4 py-3 text-sm',
                    correct ? 'border-emerald-300 bg-emerald-50/70' : user ? 'border-red-300 bg-red-50/70' : '')}>
                    <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                      correct ? 'border-emerald-600 bg-emerald-600 text-white' : user ? 'border-red-600 bg-red-600 text-white' : 'border-foreground/60')}>
                      {LETTERS[i]}
                    </span>
                    <span className="flex-1 pt-px leading-relaxed"><MathText text={String(c)} /></span>
                    {correct && <span className="pt-0.5 text-[11px] font-semibold tracking-wide text-emerald-700 uppercase">Correct</span>}
                    {user && !correct && <span className="pt-0.5 text-[11px] font-semibold tracking-wide text-red-700 uppercase">Your answer</span>}
                  </div>
                );
              })}
            </div>
          )}
          {wrongWhy && (
            <div className="mt-5 rounded-lg border border-red-200 bg-red-50/60 p-4">
              <div className="mb-1.5 text-xs font-semibold tracking-wide text-red-700 uppercase">Why {wrongLetter} is wrong</div>
              <div className="text-sm leading-relaxed text-foreground/80"><MathText text={wrongWhy} /></div>
            </div>
          )}
          {rationale.correct && (
            <div className={cn('rounded-lg border bg-muted/50 p-4', wrongWhy ? 'mt-3' : 'mt-5')}>
              <div className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {q.correctIdx != null ? `Why ${LETTERS[q.correctIdx]} is correct` : 'Explanation'}
              </div>
              <div className="text-sm leading-relaxed text-foreground/80"><MathText text={rationale.correct} /></div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
