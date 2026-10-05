// One student's page (managed academies): who they are and their groups, how
// they are doing in every College Board skill, what is assigned to them, and
// every test and practice set they have done. Practice topics are assigned
// from the skill map, starting from the student's weakest skills.

import React, { useState, useEffect, useCallback } from 'react';
import { LuArrowLeft, LuChevronRight, LuFileText, LuSend, LuTarget, LuUsers } from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '../api.js';
import { EmptyState, ErrorNote, Loading, SectionHeading, StatusBadge } from '../ui.jsx';
import { SkillMap } from '../skills.jsx';
import { ResultBanner, Stat, fmtDate, initialsOf } from './shared.jsx';
import { AssignDialog, assignedNote } from './assign.jsx';
import { DetailModal } from './Results.jsx';

const STATUS = {
  not_started: { tone: 'neutral', label: 'Not started' },
  in_progress: { tone: 'warning', label: 'In progress' },
  completed: { tone: 'success', label: 'Done' },
};

/** A row that opens a finished attempt's review. */
function Openable({ onOpen, children, className }) {
  if (!onOpen) return <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3', className)}>{children}</div>;
  return (
    <div role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className={cn('flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40', className)}>
      {children}
      <LuChevronRight className="size-4 text-muted-foreground" />
    </div>
  );
}

function scoreOf(s) {
  if (s.status !== 'completed') return null;
  if (s.practiceMode === 'skills' || s.custom) return { value: `${s.correct}/${s.questionCount}`, label: 'Correct' };
  if (s.practiceMode === 'rw' || (!s.mathScaled && s.rwScaled)) return { value: s.rwScaled, label: 'Reading and Writing' };
  if (s.practiceMode === 'math' || (!s.rwScaled && s.mathScaled)) return { value: s.mathScaled, label: 'Math' };
  return { value: s.totalScaled, label: 'Total' };
}

export default function StudentPage({ studentId, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [banner, setBanner] = useState(null);
  const [assigning, setAssigning] = useState(null); // { kind, practice? }
  const [open, setOpen] = useState(null); // a session id

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get(`/api/admin/users/${studentId}/overview`));
    } catch (err) {
      setError(err.message || 'Could not load this student');
    }
  }, [studentId]);

  useEffect(() => { load(); }, [load]);

  const back = (
    <Button variant="ghost" size="sm" className="mb-4 -ml-2.5 text-muted-foreground" onClick={onBack}>
      <LuArrowLeft /> All students
    </Button>
  );
  if (!data) return <div>{back}{error ? <ErrorNote>{error}</ErrorNote> : <Loading />}</div>;

  const { student, groups, profile, sessions, assignments } = data;
  const done = sessions.filter((s) => s.status === 'completed');
  const lastTest = done.find((s) => s.kind !== 'practice' || s.practiceMode !== 'skills');
  const latest = lastTest && scoreOf(lastTest);

  return (
    <div className="space-y-10">
      <div>
        {back}
        <div className="flex flex-wrap items-center gap-4">
          <Avatar className="size-12"><AvatarFallback className="text-sm font-medium">{initialsOf(student.displayName, student.email)}</AvatarFallback></Avatar>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Student</div>
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
              {student.displayName}
              {!student.active && <StatusBadge tone="danger">Inactive</StatusBadge>}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="font-mono text-xs">{student.email}</span>
              {groups.map((g) => <Badge key={g.id} variant="secondary"><LuUsers /> {g.name}</Badge>)}
            </div>
          </div>
          <Button onClick={() => setAssigning({ kind: 'exam' })}><LuSend data-icon="inline-start" /> Assign a test</Button>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card size="sm" className="px-4"><Stat label={latest ? `Latest score (${latest.label})` : 'Latest score'} value={latest?.value} /></Card>
          <Card size="sm" className="px-4"><Stat label="Tests done" value={done.filter((s) => s.practiceMode !== 'skills').length} /></Card>
          <Card size="sm" className="px-4"><Stat label="Practice sets done" value={done.filter((s) => s.practiceMode === 'skills').length} /></Card>
          <Card size="sm" className="px-4"><Stat label="Questions answered" value={profile.answered} /></Card>
        </div>
      </div>

      {banner && <ResultBanner onDismiss={() => setBanner(null)}>{banner}</ResultBanner>}
      <ErrorNote>{error}</ErrorNote>

      <SkillMap
        key={studentId}
        profile={profile}
        title="Skills"
        subject="student"
        initialPicked={profile.recommended}
        actionLabel="Assign practice"
        onPractise={(skills, _key, difficulty) => setAssigning({ kind: 'practice', practice: { skills, difficulty } })}
      />

      <section className="space-y-4">
        <SectionHeading title="Assigned work" />
        {assignments.length === 0 ? (
          <EmptyState icon={LuSend} title="Nothing assigned yet" hint="Assign a test, or practice on the skills above." />
        ) : (
          <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {assignments.map((a) => {
              const st = STATUS[a.status] || STATUS.not_started;
              const Icon = a.kind === 'practice' ? LuTarget : LuFileText;
              return (
                <Openable key={a.id} onOpen={a.status === 'completed' && a.sessionId ? () => setOpen(a.sessionId) : null}>
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-48 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{a.title}</span>
                      <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
                      {a.hidden && <StatusBadge tone="neutral">Hidden</StatusBadge>}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {[a.kind === 'practice' ? 'Practice' : 'Test', a.questionCount && `${a.questionCount} questions`,
                        a.via && `via ${a.via}`, a.dueAt && `due ${fmtDate(a.dueAt)}`].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </Openable>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <SectionHeading title="Tests and practice" />
        {sessions.length === 0 ? (
          <EmptyState icon={LuFileText} title="Nothing taken yet" hint="Their skills fill in from what they answer in tests and practice." />
        ) : (
          <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {sessions.map((s) => {
              const score = scoreOf(s);
              return (
                <Openable key={s.sessionId} onOpen={s.status === 'completed' ? () => setOpen(s.sessionId) : null}>
                  <div className="min-w-48 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{s.title}</span>
                      {s.status !== 'completed' && <StatusBadge tone="warning">In progress</StatusBadge>}
                      {s.kind === 'practice' && !s.assigned && <Badge variant="secondary">Self-practice</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {s.status === 'completed' ? `Finished ${fmtDate(s.completedAt)}` : `Started ${fmtDate(s.startedAt)}`}
                    </div>
                  </div>
                  {score && (
                    <div className="text-right">
                      <div className="font-mono text-lg leading-none font-semibold tabular-nums">{score.value ?? '-'}</div>
                      <div className="mt-1 text-[11px] text-muted-foreground">{score.label}</div>
                    </div>
                  )}
                </Openable>
              );
            })}
          </div>
        )}
      </section>

      {assigning && (
        <AssignDialog kind={assigning.kind} practice={assigning.practice} initialUserIds={[student.id]}
          onClose={() => setAssigning(null)}
          onDone={(result) => {
            setAssigning(null);
            setBanner(assignedNote(assigning.kind === 'practice' ? 'the practice' : 'the test', result));
            load();
          }} />
      )}
      {open && <DetailModal sessionId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
