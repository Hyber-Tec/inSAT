// Giving out work in a managed academy: a picker of students and groups, and
// the dialog that assigns a test, or practice topics, to any number of them at
// once. Every student's attempt is their own: a test is assembled when they
// start it, and practice is built from their record in each skill.

import React, { useEffect, useState } from 'react';
import { LuSearch, LuSend, LuUsers } from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { api } from '../api.js';
import { ErrorNote, Loading } from '../ui.jsx';
import { FormDialog, initialsOf } from './shared.jsx';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What an assignment did: how many it gave out, and how many already had it. */
export const assignedNote = (what, { created, skipped }) => (created
  ? `Assigned ${what}: ${created} new${skipped ? `, ${skipped} already had it` : ''}.`
  : `Everyone you picked already had ${what}.`);

/** Questions per skill in a practice set, as the server sizes it (lib/practice.js). */
/** What a test is: its SAT test, or a custom test of the academy's own questions. */
const testKind = (x) => x.blueprintName || (x.kind === 'fixed' ? 'Custom' : 'Test');

export const perSkillFor = (k) => Math.max(3, Math.min(10, Math.round(12 / Math.max(1, k))));

function PickRow({ checked, onToggle, media, title, sub, mono }) {
  return (
    <label className={cn('flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50', checked && 'bg-muted/60')}>
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      {media}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className={cn('block truncate text-xs text-muted-foreground', mono && 'font-mono')}>{sub}</span>
      </span>
    </label>
  );
}

const ListLabel = ({ children }) => (
  <div className="bg-muted/40 px-3 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</div>
);

/**
 * Search students (and groups) and tick any number of them, one by one or
 * every match at once. `users` and `groupIds` are the ticked ids.
 */
export function PeoplePicker({ students, groups = [], users, groupIds = [], onUsers, onGroups, hint = 'Tick who to give it to', className }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const gm = groups.filter((g) => !needle || g.name.toLowerCase().includes(needle));
  const sm = students.filter((s) => !needle || `${s.displayName} ${s.email}`.toLowerCase().includes(needle));
  const matches = gm.length + sm.length;
  const allTicked = matches > 0 && gm.every((g) => groupIds.includes(g.id)) && sm.every((s) => users.includes(s.id));
  const flip = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const tickAll = () => {
    const gIds = new Set(gm.map((g) => g.id));
    const sIds = new Set(sm.map((s) => s.id));
    if (allTicked) {
      onGroups?.(groupIds.filter((id) => !gIds.has(id)));
      onUsers(users.filter((id) => !sIds.has(id)));
    } else {
      onGroups?.([...new Set([...groupIds, ...gIds])]);
      onUsers([...new Set([...users, ...sIds])]);
    }
  };
  const ticked = [users.length && plural(users.length, 'student'), groupIds.length && plural(groupIds.length, 'group')].filter(Boolean);

  return (
    <div className={cn('grid gap-2', className)}>
      <div className="relative">
        <LuSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search"
          placeholder={groups.length ? 'Search students and groups' : 'Search students by name or email'} className="pl-9" />
      </div>
      <div className="scrollbar-thin max-h-64 overflow-y-auto rounded-lg border">
        {matches === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {needle ? `Nothing matches "${q.trim()}".` : 'No students yet.'}
          </p>
        ) : (
          <div className="divide-y">
            {gm.length > 0 && <ListLabel>Groups</ListLabel>}
            {gm.map((g) => (
              <PickRow key={g.id} checked={groupIds.includes(g.id)} onToggle={() => onGroups(flip(groupIds, g.id))}
                media={<span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted/50"><LuUsers className="size-4" /></span>}
                title={g.name} sub={plural(g.memberCount, 'member')} />
            ))}
            {gm.length > 0 && sm.length > 0 && <ListLabel>Students</ListLabel>}
            {sm.map((s) => (
              <PickRow key={s.id} checked={users.includes(s.id)} onToggle={() => onUsers(flip(users, s.id))}
                media={<Avatar className="size-8"><AvatarFallback className="text-[11px] font-medium">{initialsOf(s.displayName, s.email)}</AvatarFallback></Avatar>}
                title={s.displayName} sub={s.email} mono />
            ))}
          </div>
        )}
      </div>
      <div className="flex min-h-7 items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className={cn(ticked.length && 'font-medium text-foreground')}>{ticked.length ? `${ticked.join(' and ')} selected` : hint}</span>
        {matches > 0 && (
          <Button type="button" variant="link" size="xs" className="h-auto px-0" onClick={tickAll}>
            {allTicked ? 'Clear' : `Select all${needle ? ' matches' : ''} (${matches})`}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Assign a test (`kind="exam"`: one of the academy's tests, or `examId`
 * fixed) or practice topics (`kind="practice"`, `practice` = { skills,
 * difficulty }) to students and groups, with an optional due date.
 */
export function AssignDialog({ kind = 'exam', examId: fixedExam = null, practice = null, initialUserIds = [], onClose, onDone }) {
  const [data, setData] = useState(null); // { exams, students, groups }
  const [loadError, setLoadError] = useState(null);
  const [examId, setExamId] = useState(fixedExam || '');
  const [users, setUsers] = useState(initialUserIds);
  const [groupIds, setGroupIds] = useState([]);
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // A custom test with no questions yet cannot be taken, so it is not offered.
        const [exams, students, groups] = await Promise.all([
          kind === 'exam' ? api.get('/api/admin/exams').then((r) => r.exams.filter((x) => x.kind !== 'fixed' || x.questionCount > 0)) : [],
          api.get('/api/admin/users').then((r) => r.users.filter((u) => u.active)),
          api.get('/api/admin/groups').then((r) => r.groups),
        ]);
        if (cancelled) return;
        setData({ exams, students, groups });
        if (!fixedExam && exams.length) setExamId((id) => id || exams[0].id);
      } catch (err) {
        if (!cancelled) setLoadError(err.message || 'Could not load your tests and students');
      }
    })();
    return () => { cancelled = true; };
  }, [kind, fixedExam]);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Due by the end of the chosen day, wherever the admin is.
      const dueAt = due ? new Date(`${due}T23:59:00`).toISOString() : undefined;
      const result = await api.post('/api/admin/assignments', {
        kind, ...(kind === 'exam' ? { examId } : { practice }), userIds: users, groupIds, dueAt,
      });
      onDone(result);
    } catch (err) {
      setError(err.message || 'Could not assign it');
      setBusy(false);
    }
  };

  const exam = data?.exams.find((x) => x.id === examId);
  const perSkill = practice ? perSkillFor(practice.skills.length) : 0;
  const ready = kind === 'practice' ? practice?.skills?.length : examId;
  return (
    <FormDialog
      busy={busy}
      onClose={onClose}
      onSubmit={submit}
      className="sm:max-w-lg"
      title={kind === 'exam' ? 'Assign a test' : 'Assign practice'}
      description={kind === 'exam'
        ? 'Each student gets their own set of questions, put together when they start.'
        : 'Built for each student when they start, from their record in each skill.'}
      footer={(
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy || !data || !ready || (!users.length && !groupIds.length)}>
            {busy ? <Spinner /> : <LuSend data-icon="inline-start" />}
            {busy ? 'Assigning…' : 'Assign'}
          </Button>
        </>
      )}
    >
      {loadError ? <ErrorNote>{loadError}</ErrorNote> : !data ? <Loading className="py-6" /> : (
        <>
          {kind === 'exam' ? (
            <div className="grid gap-2">
              <Label htmlFor="assign-test">Test</Label>
              {data.exams.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tests yet. Create one in Tests first.</p>
              ) : fixedExam && exam ? (
                <div className="rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
                  <span className="font-medium">{exam.title}</span>
                  <span className="text-muted-foreground"> · {testKind(exam)}{exam.questionCount ? `, ${exam.questionCount} questions` : ''}</span>
                </div>
              ) : (
                <NativeSelect id="assign-test" className="w-full" value={examId} onChange={(e) => setExamId(e.target.value)}>
                  {data.exams.map((x) => (
                    <NativeSelectOption key={x.id} value={x.id}>{x.title} ({testKind(x)})</NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </div>
          ) : (
            <div className="grid gap-2 rounded-lg border bg-muted/40 px-3.5 py-3">
              <div className="flex flex-wrap gap-1.5">
                {practice.skills.map((s) => <Badge key={s} variant="outline" className="bg-background">{s}</Badge>)}
              </div>
              <p className="text-xs text-muted-foreground">
                {perSkill * practice.skills.length} questions, {perSkill} per skill,{' '}
                {practice.difficulty ? `${practice.difficulty} only` : 'each at a difficulty that fits how the student is doing'}.
              </p>
            </div>
          )}
          <div className="grid gap-2">
            <Label>Who</Label>
            <PeoplePicker students={data.students} groups={data.groups} users={users} groupIds={groupIds}
              onUsers={setUsers} onGroups={setGroupIds} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="assign-due">Due date <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="assign-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} className="w-48" />
          </div>
          <ErrorNote>{error}</ErrorNote>
        </>
      )}
    </FormDialog>
  );
}
