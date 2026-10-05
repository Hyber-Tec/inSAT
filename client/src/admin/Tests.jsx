// Tests panel (managed academies). A SAT test is the digital SAT, or one of
// its sections, timed like the real thing or untimed; every student who is
// given it gets their own set of questions, put together from the question
// pool when they start. A custom test is the academy's own questions, read
// out of an upload or written by AI (authoring.jsx), the same for everyone,
// and has its own page to review and edit them (TestEditor.jsx). Tests can be
// filed in folders (a whole folder can be assigned at once), locked until a
// release time, or hidden from students.

import React, { useState, useEffect, useCallback } from 'react';
import {
  LuClock, LuEllipsis, LuEye, LuEyeOff, LuFilePen, LuFileText, LuFolder, LuFolderPlus, LuLock, LuLockOpen, LuPencil,
  LuPlus, LuSend, LuTimer, LuTimerOff, LuTrash2,
} from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { api } from '../api.js';
import { ChoiceCards, EmptyState, ErrorNote, Loading, StatusBadge } from '../ui.jsx';
import { SECTION_NAME } from '../skills.jsx';
import { Field, FormDialog, ResultBanner, SectionHead, fmtDate, useConfirm } from './shared.jsx';
import { AssignDialog, PeoplePicker, assignedNote } from './assign.jsx';
import {
  AiFields, AiKeyNeeded, FileDrop, Segmented, Working, aiBody, aiCountOk, newAiRequest,
} from './authoring.jsx';
import TestEditor from './TestEditor.jsx';

const SOURCES = [
  { value: 'pool', title: 'SAT from the question pool', description: 'The digital SAT or one section. Each student gets their own questions.' },
  { value: 'upload', title: 'From an upload', description: 'AI reads the questions and answer key out of PDFs or images.' },
  { value: 'ai', title: 'Written by AI', description: 'New questions on a domain or skill you pick, each double-checked.' },
];

const SAT_TESTS = [['full', 'Full SAT'], ['rw', 'Reading and Writing'], ['math', 'Math']];
const SAT_HINT = {
  full: 'Both sections, 98 questions, with adaptive second modules.',
  rw: 'One section, 54 questions, with an adaptive second module.',
  math: 'One section, 44 questions, with the calculator and an adaptive second module.',
};

// Which sections an upload holds, for the model reading it ('' finds both).
const UPLOAD_SECTIONS = [['', 'Both'], ['English', 'Reading and Writing'], ['Math', 'Math']];

// A lock whose release time has passed has opened by itself.
const lockedNow = (t) => Boolean(t.locked) && (!t.unlocksAt || new Date(t.unlocksAt).getTime() > Date.now());
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a custom test was made with, said once it is ready to review. */
function madeNote(title, r, source) {
  const parts = [`Made "${title}" with ${plural(r.questions, 'question')}${source === 'ai' && r.requested > r.questions ? ` of the ${r.requested} asked for` : ''}.`];
  if (r.flagged) parts.push(`${plural(r.flagged, 'draft')} failed the answer check and ${r.flagged === 1 ? 'was' : 'were'} left out.`);
  if (r.notes?.length) parts.push(`From your files: ${r.notes.join('; ')}.`);
  parts.push('Check them, then assign the test.');
  return parts.join(' ');
}

function CreateTest({ folders, taxonomy, ai, initialFolderId, onClose, onCreated, onOpenSettings }) {
  const [title, setTitle] = useState('');
  const [source, setSource] = useState('pool');
  const [scope, setScope] = useState('full');
  const [files, setFiles] = useState([]);
  const [sections, setSections] = useState('');
  const [request, setRequest] = useState(() => newAiRequest(taxonomy));
  const [timed, setTimed] = useState(true);
  const [folderIds, setFolderIds] = useState(initialFolderId ? [initialFolderId] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const custom = source !== 'pool';
  const blocked = custom && !ai?.ready;
  const ready = title.trim() && !blocked && (source !== 'upload' || files.length) && (source !== 'ai' || aiCountOk(request));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const common = { title: title.trim(), timingMode: timed ? 'full' : 'untimed', folderIds };
    try {
      if (source === 'pool') {
        const { exam } = await api.post('/api/admin/exams', { ...common, kind: 'sat', scope });
        onCreated(exam);
      } else if (source === 'upload') {
        const fd = new FormData();
        files.forEach((f) => fd.append('files', f));
        fd.append('title', common.title);
        fd.append('timingMode', common.timingMode);
        fd.append('section', sections);
        fd.append('folderIds', JSON.stringify(folderIds));
        const r = await api.upload('/api/admin/exams/from-upload', fd);
        onCreated(r.exam, madeNote(common.title, r, source));
      } else {
        const r = await api.post('/api/admin/exams/from-ai', { ...common, ...aiBody(request) });
        onCreated(r.exam, madeNote(common.title, r, source));
      }
    } catch (err) {
      setError(err.message || 'Could not create the test');
      setBusy(false);
    }
  };

  return (
    <FormDialog
      busy={busy}
      onClose={onClose}
      onSubmit={submit}
      tall
      className="sm:max-w-lg"
      title="New test"
      description="A SAT test from the question pool, or a test of your own questions."
      footer={(
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy || !ready}>
            {busy ? <Spinner /> : <LuPlus data-icon="inline-start" />}
            {busy ? (source === 'upload' ? 'Reading…' : source === 'ai' ? 'Writing…' : 'Creating…') : 'Create test'}
          </Button>
        </>
      )}
    >
      <Field id="test-title" label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="October practice SAT" autoFocus required disabled={busy} />
      <div className="grid gap-2">
        <Label>Make it from</Label>
        <ChoiceCards label="Make it from" options={SOURCES} value={source} onChange={(v) => !busy && setSource(v)} />
      </div>
      {blocked && <AiKeyNeeded onOpenSettings={onOpenSettings} />}
      {source === 'pool' && (
        <div className="grid gap-2">
          <Label htmlFor="test-scope">Test</Label>
          <Segmented id="test-scope" label="Test" options={SAT_TESTS} value={scope} onChange={setScope} disabled={busy} />
          <p className="text-xs text-muted-foreground">{SAT_HINT[scope]}</p>
        </div>
      )}
      {source === 'upload' && (
        <>
          <FileDrop files={files} onFiles={setFiles} disabled={busy || blocked} />
          <div className="grid gap-2">
            <Label htmlFor="upload-sections">Sections in the files</Label>
            <Segmented id="upload-sections" label="Sections in the files" options={UPLOAD_SECTIONS} value={sections} onChange={setSections} disabled={busy || blocked} />
          </div>
        </>
      )}
      {source === 'ai' && <AiFields taxonomy={taxonomy} value={request} onChange={setRequest} disabled={busy || blocked} />}
      <div className="flex items-center gap-2.5">
        <Switch id="test-timed" checked={timed} onCheckedChange={setTimed} disabled={busy} />
        <Label htmlFor="test-timed" className="font-normal">{custom ? 'Timed at the SAT\'s pace' : 'Timed like the real SAT'}</Label>
      </div>
      {folders.length > 0 && (
        <div className="grid gap-2">
          <Label>Folders <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <FolderChecks folders={folders} value={folderIds} onChange={setFolderIds} />
        </div>
      )}
      {busy && source === 'upload' && <Working>Reading the questions out of your files. A whole practice test can take a few minutes; keep this open.</Working>}
      {busy && source === 'ai' && <Working>Writing {plural(Number(request.n), 'question')} and checking each one. This takes about a minute; keep this open.</Working>}
      <ErrorNote>{error}</ErrorNote>
    </FormDialog>
  );
}

function FolderChecks({ folders, value, onChange }) {
  return (
    <div className="scrollbar-thin max-h-48 divide-y overflow-y-auto rounded-lg border">
      {folders.map((f) => (
        <label key={f.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/50">
          <Checkbox checked={value.includes(f.id)}
            onCheckedChange={(on) => onChange(on ? [...value, f.id] : value.filter((x) => x !== f.id))} />
          <LuFolder className="size-4 text-muted-foreground" />
          <span className="text-sm">{f.name}</span>
        </label>
      ))}
    </div>
  );
}

/** File a test in folders (any number; none is "Not in a folder"). */
function FoldersDialog({ test, folders, onClose, onSaved }) {
  const [value, setValue] = useState(test.folderIds || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/admin/exams/${test.id}/folders`, { folderIds: value });
      onSaved();
    } catch (err) {
      setError(err.message || 'Could not file the test');
      setBusy(false);
    }
  };
  return (
    <FormDialog busy={busy} onClose={onClose} onSubmit={submit} title="Folders" description={`Where "${test.title}" is filed.`}
      footer={(
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy && <Spinner />}{busy ? 'Saving…' : 'Save'}</Button>
        </>
      )}>
      {folders.length ? <FolderChecks folders={folders} value={value} onChange={setValue} /> : (
        <p className="text-sm text-muted-foreground">No folders yet. Create one with New folder.</p>
      )}
      <ErrorNote>{error}</ErrorNote>
    </FormDialog>
  );
}

/** Lock a test until a release time, or until it is unlocked by hand. */
function LockDialog({ test, onClose, onSaved }) {
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    let unlocksAt = null;
    if (when) {
      const t = new Date(when);
      if (Number.isNaN(t.getTime())) { setError('That date and time could not be read.'); return; }
      if (t.getTime() <= Date.now()) { setError('The release time must be in the future.'); return; }
      unlocksAt = t.toISOString();
    }
    setBusy(true);
    setError(null);
    try {
      const { exam } = await api.patch(`/api/admin/exams/${test.id}`, { locked: true, unlocksAt });
      onSaved(exam);
    } catch (err) {
      setError(err.message || 'Could not lock the test');
      setBusy(false);
    }
  };
  return (
    <FormDialog busy={busy} onClose={onClose} onSubmit={submit} title="Lock test"
      description={`Students given "${test.title}" see it but cannot start it until it opens, so you can hand it out ahead of time.`}
      footer={(
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? <Spinner /> : <LuLock data-icon="inline-start" />}{busy ? 'Locking…' : 'Lock test'}</Button>
        </>
      )}>
      <Field id="lock-until" label="Opens by itself at (optional)" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)}
        hint="Leave it empty to keep the test locked until you unlock it." className="w-64" />
      <ErrorNote>{error}</ErrorNote>
    </FormDialog>
  );
}

/** A name for something: a test's new title, or a folder. */
function NameDialog({ title, description, label, initial = '', submitLabel, onSubmit, onClose }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
    } catch (err) {
      setError(err.message || 'Could not save it');
      setBusy(false);
    }
  };
  return (
    <FormDialog busy={busy} onClose={onClose} onSubmit={submit} title={title} description={description}
      footer={(
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim() || name.trim() === initial}>{busy && <Spinner />}{busy ? 'Saving…' : submitLabel}</Button>
        </>
      )}>
      <Field id="name" label={label} value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
      <ErrorNote>{error}</ErrorNote>
    </FormDialog>
  );
}

/** Give every test in a folder to students and groups at once. */
function AssignFolder({ folder, onClose, onDone }) {
  const [data, setData] = useState(null);
  const [users, setUsers] = useState([]);
  const [groupIds, setGroupIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const [{ users: u }, { groups }] = await Promise.all([api.get('/api/admin/users'), api.get('/api/admin/groups')]);
        setData({ students: u.filter((x) => x.active), groups });
      } catch (err) { setError(err.message || 'Could not load your students'); }
    })();
  }, []);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post(`/api/admin/exam-folders/${folder.id}/assign`, { userIds: users, groupIds }));
    } catch (err) {
      setError(err.message || 'Could not assign the folder');
      setBusy(false);
    }
  };
  return (
    <FormDialog busy={busy} onClose={onClose} onSubmit={submit} className="sm:max-w-lg" title={`Assign "${folder.name}"`}
      description={`Gives every test in this folder (${plural(folder.examCount, 'test')}) to who you pick. Tests they already have are skipped.`}
      footer={(
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy || !data || (!users.length && !groupIds.length)}>
            {busy ? <Spinner /> : <LuSend data-icon="inline-start" />}{busy ? 'Assigning…' : 'Assign'}
          </Button>
        </>
      )}>
      {data ? (
        <PeoplePicker students={data.students} groups={data.groups} users={users} groupIds={groupIds} onUsers={setUsers} onGroups={setGroupIds} />
      ) : !error && <Loading className="py-6" />}
      <ErrorNote>{error}</ErrorNote>
    </FormDialog>
  );
}

// What a test is: its SAT test, or (a custom test) the sections it has.
function kindLine(t) {
  if (t.kind !== 'fixed') return t.blueprintName || 'Test';
  const sections = (t.sections || []).map((k) => SECTION_NAME[k]).join(' and ');
  return sections ? `Custom · ${sections}` : 'Custom';
}

function TestRow({ t, onAssign, onAction }) {
  const locked = lockedNow(t);
  const custom = t.kind === 'fixed';
  const empty = custom && !t.questionCount;
  const Icon = custom ? LuFilePen : LuFileText;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5', !t.active && 'bg-muted/30')}>
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/50">
        <Icon className="size-4" />
      </div>
      <div className="min-w-48 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {custom ? (
            <button type="button" onClick={() => onAction('edit', t)}
              className={cn('text-left font-medium underline-offset-4 outline-none hover:underline focus-visible:underline', !t.active && 'text-muted-foreground')}>
              {t.title}
            </button>
          ) : (
            <span className={cn('font-medium', !t.active && 'text-muted-foreground')}>{t.title}</span>
          )}
          {!t.active && <StatusBadge tone="neutral">Hidden from students</StatusBadge>}
          {locked && <StatusBadge tone="warning">{t.unlocksAt ? `Locked until ${fmtDate(t.unlocksAt, { time: true })}` : 'Locked'}</StatusBadge>}
          {empty && <StatusBadge tone="warning">No questions yet</StatusBadge>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{kindLine(t)}{t.questionCount ? ` · ${plural(t.questionCount, 'question')}` : ''}</span>
          <span className="inline-flex items-center gap-1"><LuClock className="size-3.5" />{t.timingMode === 'untimed' ? 'Untimed' : 'Timed'}</span>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {custom && <Button variant="ghost" size="sm" onClick={() => onAction('edit', t)}><LuFilePen /> Questions</Button>}
        <Button variant="outline" size="sm" disabled={empty} onClick={() => onAssign(t)}><LuSend /> Assign</Button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`More for ${t.title}`}><LuEllipsis /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={() => onAction('lock', t)}>{locked ? <LuLockOpen /> : <LuLock />}{locked ? 'Unlock' : 'Lock…'}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction('timing', t)}>
              {t.timingMode === 'untimed' ? <LuTimer /> : <LuTimerOff />}{t.timingMode === 'untimed' ? 'Make timed' : 'Make untimed'}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction('active', t)}>{t.active ? <LuEyeOff /> : <LuEye />}{t.active ? 'Hide from students' : 'Show to students'}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction('folders', t)}><LuFolder /> Folders…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction('rename', t)}><LuPencil /> Rename…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onAction('delete', t)}><LuTrash2 /> Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function FolderHeader({ folder, count, onAction }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-1 pb-2">
      <LuFolder className={cn('size-4', folder ? 'text-foreground' : 'text-muted-foreground')} />
      <span className={cn('text-sm font-medium', !folder && 'text-muted-foreground')}>{folder ? folder.name : 'Not in a folder'}</span>
      <span className="text-xs text-muted-foreground">{plural(count, 'test')}</span>
      {folder && (
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" disabled={!count} onClick={() => onAction('assign', folder)}><LuSend /> Assign folder</Button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`More for the ${folder.name} folder`}><LuEllipsis /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={() => onAction('rename', folder)}><LuPencil /> Rename…</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => onAction('delete', folder)}><LuTrash2 /> Delete folder</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

export default function Tests({ onGo }) {
  const [tests, setTests] = useState([]);
  const [folders, setFolders] = useState([]);
  const [ai, setAi] = useState(null); // whether uploads and AI can run now
  const [taxonomy, setTaxonomy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [banner, setBanner] = useState(null);
  const [dialog, setDialog] = useState(null); // { kind, item }
  const [editing, setEditing] = useState(null); // { id, notice } of the custom test open
  const [confirmNode, askConfirm] = useConfirm();
  const openSettings = onGo ? () => onGo('settings') : null;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [{ exams, ai: status, taxonomy: tree }, { folders: f }] = await Promise.all([api.get('/api/admin/exams'), api.get('/api/admin/exam-folders')]);
      setTests(exams || []);
      setAi(status || null);
      setTaxonomy(tree || null);
      setFolders((f || []).filter((x) => !x.parentId));
    } catch (err) {
      setError(err.message || 'Could not load the tests');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const close = () => setDialog(null);
  const patchTest = async (t, body) => {
    setError(null);
    try {
      const { exam } = await api.patch(`/api/admin/exams/${t.id}`, body);
      setTests((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...exam } : x)));
    } catch (err) { setError(err.message || 'Could not update the test'); }
  };

  const testAction = (kind, t) => {
    if (kind === 'edit') return setEditing({ id: t.id, notice: null });
    if (kind === 'lock') return lockedNow(t) ? patchTest(t, { locked: false }) : setDialog({ kind: 'lock', item: t });
    if (kind === 'active') return patchTest(t, { active: !t.active });
    if (kind === 'timing') return patchTest(t, { timingMode: t.timingMode === 'untimed' ? 'full' : 'untimed' });
    if (kind === 'delete') {
      return askConfirm({
        title: 'Delete test?',
        message: `"${t.title}" is deleted with everything assigned from it and every attempt at it, scores included. This cannot be undone.`,
        confirmLabel: 'Delete test',
        tone: 'danger',
        onConfirm: async () => {
          await api.del(`/api/admin/exams/${t.id}`);
          setTests((prev) => prev.filter((x) => x.id !== t.id));
        },
      });
    }
    return setDialog({ kind, item: t });
  };
  const folderAction = (kind, f) => {
    if (kind === 'delete') {
      return askConfirm({
        title: 'Delete folder?',
        message: `The "${f.name}" folder is removed. Its tests stay, and so does everything assigned from them.`,
        confirmLabel: 'Delete folder',
        tone: 'danger',
        onConfirm: async () => { await api.del(`/api/admin/exam-folders/${f.id}`); await load(); },
      });
    }
    return setDialog({ kind: kind === 'rename' ? 'renameFolder' : 'assignFolder', item: f });
  };

  const open = editing && tests.find((t) => t.id === editing.id);
  if (open && taxonomy) {
    return (
      <TestEditor key={open.id} test={open} taxonomy={taxonomy} ai={ai} notice={editing.notice} onOpenSettings={openSettings}
        onBack={() => { setEditing(null); load(); }} onChanged={load} />
    );
  }

  // Tests by folder (a test filed in two folders shows in both), then the rest.
  const sections = folders.map((f) => ({ folder: f, items: tests.filter((t) => t.folderIds?.includes(f.id)) }));
  const loose = tests.filter((t) => !t.folderIds?.some((id) => folders.some((f) => f.id === id)));
  if (loose.length || !folders.length) sections.push({ folder: null, items: loose });

  return (
    <div>
      <SectionHead
        eyebrow="Assessments"
        title="Tests"
        sub="SAT tests from the question pool, where each student gets their own questions, and custom tests of your own questions from an upload or written by AI."
        right={(
          <>
            <Button variant="outline" onClick={() => setDialog({ kind: 'newFolder' })}><LuFolderPlus data-icon="inline-start" /> New folder</Button>
            <Button onClick={() => setDialog({ kind: 'new' })}><LuPlus data-icon="inline-start" /> New test</Button>
          </>
        )}
      />
      <ErrorNote className="mb-5">{error}</ErrorNote>
      {banner && <div className="mb-5"><ResultBanner onDismiss={() => setBanner(null)}>{banner}</ResultBanner></div>}

      {loading ? <Loading /> : tests.length === 0 && !folders.length ? (
        <EmptyState icon={LuFileText} title="No tests yet" hint="Create a test, then assign it to students or a group." />
      ) : (
        <div className="space-y-7">
          {sections.map(({ folder, items }) => (
            <section key={folder?.id || 'loose'}>
              {(folders.length > 0) && <FolderHeader folder={folder} count={items.length} onAction={folderAction} />}
              {items.length ? (
                <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
                  {items.map((t) => <TestRow key={t.id} t={t} onAssign={(x) => setDialog({ kind: 'assign', item: x })} onAction={testAction} />)}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">
                  No tests in this folder. File one here with its Folders… option.
                </div>
              )}
            </section>
          ))}
        </div>
      )}

      {dialog?.kind === 'new' && taxonomy && (
        <CreateTest folders={folders} taxonomy={taxonomy} ai={ai} onClose={close} onOpenSettings={openSettings}
          onCreated={(exam, notice) => {
            close();
            setTests((prev) => [exam, ...prev]);
            // A custom test opens on its questions, to be checked before it is assigned.
            if (exam.kind === 'fixed') setEditing({ id: exam.id, notice });
          }} />
      )}
      {dialog?.kind === 'assign' && (
        <AssignDialog examId={dialog.item.id} onClose={close}
          onDone={(result) => { close(); setBanner(assignedNote(`"${dialog.item.title}"`, result)); }} />
      )}
      {dialog?.kind === 'lock' && (
        <LockDialog test={dialog.item} onClose={close}
          onSaved={(exam) => { close(); setTests((prev) => prev.map((x) => (x.id === exam.id ? { ...x, ...exam } : x))); }} />
      )}
      {dialog?.kind === 'folders' && (
        <FoldersDialog test={dialog.item} folders={folders} onClose={close} onSaved={() => { close(); load(); }} />
      )}
      {dialog?.kind === 'rename' && (
        <NameDialog title="Rename test" label="Title" initial={dialog.item.title} submitLabel="Rename" onClose={close}
          onSubmit={async (title) => { await api.patch(`/api/admin/exams/${dialog.item.id}`, { title }); close(); load(); }} />
      )}
      {dialog?.kind === 'newFolder' && (
        <NameDialog title="New folder" description="Folders keep tests in order; a whole folder can be assigned at once." label="Name"
          submitLabel="Create folder" onClose={close}
          onSubmit={async (name) => { await api.post('/api/admin/exam-folders', { name }); close(); load(); }} />
      )}
      {dialog?.kind === 'renameFolder' && (
        <NameDialog title="Rename folder" label="Name" initial={dialog.item.name} submitLabel="Rename" onClose={close}
          onSubmit={async (name) => { await api.patch(`/api/admin/exam-folders/${dialog.item.id}`, { name }); close(); load(); }} />
      )}
      {dialog?.kind === 'assignFolder' && (
        <AssignFolder folder={dialog.item} onClose={close}
          onDone={(result) => { close(); setBanner(assignedNote(`the "${dialog.item.name}" folder`, result)); }} />
      )}
      {confirmNode}
    </div>
  );
}
