// A managed academy's student home: what their academy assigned them (tests
// and practice topics, filtered by group when they are in several), what to
// do next, and their skill map (read-only: practice is assigned, not chosen).
// Driven by GET /api/student/assignments and GET /api/student/profile.

import React, { useState } from 'react';
import {
  LuCalendarClock, LuCircleCheck, LuClock, LuFileText, LuLock, LuMonitorDown, LuRotateCcw, LuShieldCheck, LuTarget, LuUsers,
} from 'react-icons/lu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Action, EmptyState, SectionHeading, StatusBadge } from '../ui.jsx';
import { SkillMap } from '../skills.jsx';
import { EXAM_APP_DOWNLOADS, detectOS, needsExamApp } from '../desktop.js';

const when = (iso, time = false) => new Date(iso).toLocaleString(undefined, time
  ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  : { month: 'short', day: 'numeric' });

const isLocked = (a) => a.locked && a.status !== 'completed';

/** Tests need the desktop exam app when the academy requires it; practice never does. */
export const blockedByExamApp = (a) => needsExamApp && a.kind !== 'practice' && a.status !== 'completed';

function resultOf(a) {
  if (a.status !== 'completed') return null;
  if (a.kind === 'practice' || a.custom) return { value: `${a.correct}/${a.answered}`, label: 'Correct' };
  if (a.scope === 'rw') return { value: a.rwScaled, label: 'Reading and Writing' };
  if (a.scope === 'math') return { value: a.mathScaled, label: 'Math' };
  return { value: a.totalScaled, label: 'Total' };
}

function meta(a) {
  return [
    a.kind === 'practice' ? 'Practice' : 'Test',
    a.questionCount && `${a.questionCount} questions`,
    a.kind === 'practice' ? null : (a.timingMode === 'untimed' ? 'Untimed' : 'Timed'),
  ].filter(Boolean).join(' · ');
}

// The one to do next: one in progress, else the soonest due, else the newest.
function nextUp(items) {
  const open = items.filter((a) => a.status !== 'completed' && !isLocked(a));
  const started = open.find((a) => a.status === 'in_progress');
  if (started) return started;
  const due = open.filter((a) => a.dueAt).sort((x, y) => new Date(x.dueAt) - new Date(y.dueAt));
  return due[0] || open[0] || null;
}

function NextUp({ items, busyId, onStart }) {
  const next = nextUp(items);
  const done = items.filter((a) => a.status === 'completed').length;
  let eyebrow; let title; let body; let action = null;
  if (next) {
    const resume = next.status === 'in_progress';
    eyebrow = resume ? 'In progress' : 'Next up';
    title = next.examTitle;
    body = [meta(next), next.dueAt && `due ${when(next.dueAt)}`].filter(Boolean).join(' · ');
    action = (
      <Action size="lg" className="px-4" busy={busyId === next.id} disabled={Boolean(busyId) || blockedByExamApp(next)}
        onClick={() => onStart(next)}>
        {busyId === next.id ? 'Preparing…' : resume ? 'Resume' : next.kind === 'practice' ? 'Start practice' : 'Start test'}
      </Action>
    );
  } else if (items.length) {
    eyebrow = 'All caught up';
    title = 'Nothing waiting for you';
    body = `You have finished ${done} of ${items.length}. New work from your academy shows up here.`;
  } else {
    eyebrow = 'Assigned to you';
    title = 'Nothing assigned yet';
    body = 'When your academy gives you a test or practice, it shows up here.';
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
      {action && <div>{action}</div>}
    </Card>
  );
}

function Row({ a, busy, disabled, onStart, onReview }) {
  const done = a.status === 'completed';
  const locked = isLocked(a);
  const result = resultOf(a);
  const Icon = a.kind === 'practice' ? LuTarget : LuFileText;
  return (
    <Card className="flex-row flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/50">
        {done ? <LuCircleCheck className="size-4 text-emerald-700" /> : locked ? <LuLock className="size-4" /> : <Icon className="size-4" />}
      </div>
      <div className="min-w-56 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{a.examTitle}</span>
          {a.status === 'in_progress' && <StatusBadge tone="warning">In progress</StatusBadge>}
          {locked && <StatusBadge tone="neutral">Locked</StatusBadge>}
          {a.assignedVia === 'group' && <Badge variant="secondary"><LuUsers /> {a.groupName || 'Group'}</Badge>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{meta(a)}</span>
          {done && a.completedAt && <span>Finished {when(a.completedAt)}</span>}
          {!done && a.dueAt && <span className="inline-flex items-center gap-1"><LuCalendarClock className="size-3.5" />Due {when(a.dueAt)}</span>}
          {locked && a.unlocksAt && <span className="inline-flex items-center gap-1"><LuClock className="size-3.5" />Opens {when(a.unlocksAt, true)}</span>}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-5">
        {result && (
          <div className="text-right">
            <div className="font-mono text-xl leading-none font-semibold tabular-nums">{result.value ?? '-'}</div>
            <div className="mt-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{result.label}</div>
          </div>
        )}
        {done ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onReview(a)}>Review</Button>
        ) : locked ? (
          <Button variant="outline" size="sm" disabled><LuLock /> Locked</Button>
        ) : (
          <Action size="sm" busy={busy} disabled={disabled} icon={a.status === 'in_progress' ? LuRotateCcw : undefined} onClick={() => onStart(a)}>
            {busy ? 'Preparing…' : a.status === 'in_progress' ? 'Resume' : 'Start'}
          </Action>
        )}
      </div>
    </Card>
  );
}

// Tests run only in the locked-down desktop app when the academy requires it;
// point students to it (their own OS first). Finished work stays reviewable.
function ExamAppNotice() {
  const os = detectOS();
  const names = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };
  const order = [os, ...['windows', 'mac', 'linux'].filter((k) => k !== os)];
  return (
    <Card className="gap-4 px-6 py-6">
      <div className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <LuShieldCheck className="size-4 text-foreground" /> Secure testing
      </div>
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Take your tests in the insat Exam app</h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Tests run full screen in the desktop app. Install it and sign in with this same account; practice and past results stay here in the browser.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {order.map((key) => (EXAM_APP_DOWNLOADS[key] ? (
          <Button key={key} asChild variant={key === os ? 'default' : 'outline'}>
            <a href={EXAM_APP_DOWNLOADS[key]}><LuMonitorDown data-icon="inline-start" />{key === os ? `Download for ${names[key]}` : names[key]}</a>
          </Button>
        ) : (
          <Button key={key} variant="outline" disabled>{names[key]}: coming soon</Button>
        )))}
      </div>
    </Card>
  );
}

export default function AssignedHome({ assignments, groups, profile, busyId, onStart, onReview }) {
  const [filter, setFilter] = useState('all'); // 'all' | 'direct' | a group id
  const direct = assignments.filter((a) => a.assignedVia === 'user').length;
  // A filter that no longer applies (left the group, nothing direct) falls back to all.
  const valid = filter === 'all' || (filter === 'direct' && direct) || groups.some((g) => g.id === filter);
  const f = valid ? filter : 'all';
  const shown = assignments.filter((a) => (f === 'all' ? true : f === 'direct' ? a.assignedVia === 'user' : a.groupId === f));
  const todo = shown.filter((a) => a.status !== 'completed');
  const done = shown.filter((a) => a.status === 'completed');
  const row = (a) => (
    <Row key={a.id} a={a} busy={busyId === a.id} disabled={Boolean(busyId) || blockedByExamApp(a)} onStart={onStart} onReview={onReview} />
  );

  return (
    <div className="space-y-12">
      <NextUp items={assignments} busyId={busyId} onStart={onStart} />
      {needsExamApp && assignments.some((a) => a.kind !== 'practice' && a.status !== 'completed') && <ExamAppNotice />}

      {assignments.length > 0 && (
        <section className="space-y-4">
          <SectionHeading
            title="Assigned to you"
            actions={groups.length > 0 && (
              <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={f} onValueChange={(v) => v && setFilter(v)} aria-label="Show">
                <ToggleGroupItem value="all" className="px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">All</ToggleGroupItem>
                {direct > 0 && <ToggleGroupItem value="direct" className="px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">Just me</ToggleGroupItem>}
                {groups.map((g) => (
                  <ToggleGroupItem key={g.id} value={g.id} className="px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">{g.name}</ToggleGroupItem>
                ))}
              </ToggleGroup>
            )}
          />
          {shown.length === 0 ? (
            <EmptyState icon={LuFileText} title="Nothing here yet" hint="Work assigned to this group shows up here." />
          ) : (
            <div className="space-y-8">
              {todo.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-muted-foreground">To do</h3>
                  <div className="grid gap-3">{todo.map(row)}</div>
                </div>
              )}
              {done.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-muted-foreground">Done</h3>
                  <div className="grid gap-3">{done.map(row)}</div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {profile && <SkillMap profile={profile} readOnly />}
    </div>
  );
}
