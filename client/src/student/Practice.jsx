// Self-guided practice on the student dashboard: what to work on next, a full
// test or one section on the SAT's clock, a map of every College Board skill
// to build a practice set from, and the practice already done.
//
// All of it reads from the server: GET /api/student/profile (accuracy and
// what is available per skill) and GET /api/student/practice (history).

import React, { useState } from 'react';
import { LuBookOpen, LuCalculator, LuClock, LuLayers, LuRotateCcw, LuTarget, LuTrash2 } from 'react-icons/lu';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Action, ConfirmDialog, SectionHeading, StatusBadge } from '../ui.jsx';
import { SECTION_NAME, SkillMap } from '../skills.jsx';

const TESTS = [
  { mode: 'full', title: 'Full practice test', questions: 98, minutes: 134, icon: LuLayers, sections: ['rw', 'math'],
    blurb: 'Both sections, with adaptive second modules and a break in between.' },
  { mode: 'rw', title: 'Reading and Writing', questions: 54, minutes: 64, icon: LuBookOpen, sections: ['rw'],
    blurb: 'Two 32-minute modules. The second one adapts to how the first went.' },
  { mode: 'math', title: 'Math', questions: 44, minutes: 70, icon: LuCalculator, sections: ['math'],
    blurb: 'Two 35-minute modules, with the calculator and reference sheet.' },
];

/** The sections of a test that have nothing to serve (none unseen, none makeable). */
const unavailable = (test, sections) => test.sections.filter((k) => sections && !sections[k]?.ready && !sections[k]?.more);

const duration = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
};

const shortDate = (iso) => (iso
  ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  : '');

// --- What to work on next ---------------------------------------------------

function NextUp({ profile, busy, onPractise, onTest }) {
  const bySkill = new Map(profile.skills.map((s) => [s.skill, s]));
  const recommended = profile.recommended.map((name) => bySkill.get(name)).filter(Boolean);
  const tested = profile.skills.filter((s) => s.answered).length;
  // The broadest test there are questions for: the full test, else a section.
  const test = TESTS.find((t) => !unavailable(t, profile.sections).length);
  const testLabel = !test ? null : test.mode === 'full' ? 'a full practice test' : `a ${test.title} practice test`;
  const testAction = (verb) => test && (
    <Action size="lg" className="px-4" busy={busy === test.mode} disabled={Boolean(busy)} onClick={() => onTest(test.mode)}>
      {busy === test.mode ? 'Preparing your test…' : `${verb} ${testLabel}`}
    </Action>
  );

  let eyebrow, title, body, action;
  if (!profile.answered) {
    eyebrow = 'Step 1 · Diagnostic';
    title = 'Start with a diagnostic test';
    body = 'A full practice test maps all 29 skills; one section maps its half. From then on this page picks what to practice next, at a difficulty that fits you, with an explanation for every answer.';
    action = testAction('Start');
  } else if (recommended.length) {
    eyebrow = 'Next up';
    title = recommended.length === 1 ? 'Practice your weakest skill' : 'Practice your weakest skills';
    body = 'Picked from everything you have answered so far. Questions are set at a difficulty that fits how you are doing in each skill.';
    action = (
      <Action size="lg" className="px-4" busy={busy === 'next'} disabled={Boolean(busy)}
        onClick={() => onPractise(recommended.map((s) => s.skill), 'next')}>
        {busy === 'next' ? 'Preparing your set…' : recommended.length === 1 ? 'Practice this skill' : `Practice these ${recommended.length} skills`}
      </Action>
    );
  } else {
    eyebrow = 'Next up';
    title = 'No weak spots in what you have tried';
    body = tested < profile.skills.length
      ? `You have answered questions in ${tested} of ${profile.skills.length} skills. A full practice test covers the rest.`
      : 'Every skill is reading as strong. A full practice test keeps it honest.';
    action = testAction('Take');
  }

  return (
    <Card className="bg-linear-to-b from-muted/70 to-card px-6 py-7 sm:px-8 sm:py-8">
      <div>
        <div className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <LuTarget className="size-4 text-foreground" />{eyebrow}
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{body}</p>
      </div>
      {recommended.length > 0 && profile.answered > 0 && (
        <div className="divide-y rounded-lg border bg-card">
          {recommended.map((s) => (
            <div key={s.skill} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{s.skill}</div>
                <div className="text-xs text-muted-foreground">{SECTION_NAME[s.section]} · {s.domainLabel}</div>
              </div>
              <div className="text-sm whitespace-nowrap text-muted-foreground">
                <span className="font-medium text-foreground tabular-nums">{s.correct}</span> of{' '}
                <span className="font-medium text-foreground tabular-nums">{s.answered}</span> correct
              </div>
            </div>
          ))}
        </div>
      )}
      {action && <div>{action}</div>}
    </Card>
  );
}

// --- Full test / one section ------------------------------------------------

function TimedSwitch({ on, onChange }) {
  return (
    <div className="flex items-center gap-2.5">
      <Switch id="timed" checked={on} onCheckedChange={onChange} />
      <Label htmlFor="timed" className="font-normal text-muted-foreground">Timed like the real SAT</Label>
    </div>
  );
}

function TestCards({ busy, timed, sections, onTest }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {TESTS.map((t) => {
        const missing = unavailable(t, sections);
        return (
          <Card key={t.mode} className="gap-4 px-5">
            <div className="flex size-9 items-center justify-center rounded-md border bg-muted/50">
              <t.icon className="size-4.5" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold tracking-tight">{t.title}</h3>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>{t.questions} questions</span>
                <span aria-hidden>·</span>
                <LuClock className="size-3.5" />
                <span>{timed ? duration(t.minutes) : 'Untimed'}</span>
              </div>
            </div>
            <p className="flex-1 leading-relaxed text-muted-foreground">{t.blurb}</p>
            {missing.length ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {missing.map((k) => SECTION_NAME[k]).join(' and ')} questions are not available yet.
              </p>
            ) : (
              <Action variant="outline" className="w-fit px-3" busy={busy === t.mode} disabled={Boolean(busy)} onClick={() => onTest(t.mode)}>
                {busy === t.mode ? 'Preparing…' : 'Start'}
              </Action>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// --- Practice done so far ---------------------------------------------------

function resultOf(p) {
  if (p.status !== 'completed') return null;
  if (p.mode === 'skills') return { value: `${p.correct}/${p.questionCount}`, label: 'Correct' };
  if (p.mode === 'rw') return { value: p.rwScaled, label: 'Reading and Writing' };
  if (p.mode === 'math') return { value: p.mathScaled, label: 'Math' };
  return { value: p.totalScaled, label: 'Total' };
}

function History({ items, busyId, onResume, onReview, onDiscard }) {
  const [all, setAll] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const shown = all ? items : items.slice(0, 6);
  return (
    <section className="space-y-4">
      <SectionHeading title="Your practice" />
      <div className="grid gap-3">
        {shown.map((p) => {
          const done = p.status === 'completed';
          const result = resultOf(p);
          const busy = busyId === p.sessionId;
          return (
            <Card key={p.sessionId} className="flex-row flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
              <div className="min-w-56 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{p.title}</span>
                  {!done && <StatusBadge tone="warning">In progress</StatusBadge>}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {done
                    ? `${shortDate(p.completedAt)} · ${p.questionCount} questions`
                    : `Started ${shortDate(p.startedAt)} · ${p.answered} of ${p.questionCount ?? '?'} answered`}
                  {p.mode === 'skills' && p.skills.length > 1 ? ` · ${p.skills.join(', ')}` : ''}
                </div>
              </div>
              <div className="ml-auto flex items-center gap-5">
                {result && (
                  <div className="text-right">
                    <div className="font-mono text-xl leading-none font-semibold tabular-nums">{result.value ?? '-'}</div>
                    <div className="mt-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{result.label}</div>
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  {done
                    ? <Button variant="outline" size="sm" disabled={busy} onClick={() => onReview(p)}>Review</Button>
                    : <Button size="sm" disabled={busy} onClick={() => onResume(p)}><LuRotateCcw /> Resume</Button>}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="Discard" disabled={busy} onClick={() => setConfirm(p)}
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                        <LuTrash2 />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Discard</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
      {items.length > shown.length && (
        <Button variant="ghost" size="sm" onClick={() => setAll(true)}>Show all {items.length}</Button>
      )}
      {confirm && (
        <ConfirmDialog
          title="Discard this practice?"
          body={confirm.status === 'completed'
            ? `"${confirm.title}" will be removed from your list. Its results still count toward your skill map, and your academy can still see them.`
            : `"${confirm.title}" and the answers in it will be removed. Its questions can come up again in later practice.`}
          confirmLabel="Discard"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={async () => { await onDiscard(confirm); setConfirm(null); }}
        />
      )}
    </section>
  );
}

// --- The whole practice area ------------------------------------------------

export default function PracticeHome({ profile, history, busy, busyId, onStart, onResume, onReview, onDiscard }) {
  const [timed, setTimed] = useState(true);
  const test = (mode) => onStart({ mode, timed }, mode);
  const practise = (skills, key, difficulty = null) => onStart({ mode: 'skills', skills, ...(difficulty ? { difficulty } : {}) }, key);
  return (
    <div className="space-y-12">
      <NextUp profile={profile} busy={busy} onPractise={practise} onTest={test} />
      <section className="space-y-4">
        <SectionHeading title="Take a practice test" actions={<TimedSwitch on={timed} onChange={setTimed} />} />
        <TestCards busy={busy} timed={timed} sections={profile.sections} onTest={test} />
      </section>
      <SkillMap profile={profile} busy={busy} onPractise={practise} />
      {history.length > 0 && (
        <History items={history} busyId={busyId} onResume={onResume} onReview={onReview} onDiscard={onDiscard} />
      )}
    </div>
  );
}
