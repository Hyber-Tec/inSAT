// A managed academy's custom tests are its own questions: read out of an
// upload by AI, written by AI, or written by hand. The pieces here are shared
// by the New test dialog (Tests.jsx) and a custom test's editor
// (TestEditor.jsx). Uploads and AI run on the academy's own AI key (Settings).

import React, { useState } from 'react';
import { LuFile, LuFileUp, LuKeyRound, LuX } from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api } from '../api.js';
import { MathText } from '../MathText.jsx';
import { ErrorNote } from '../ui.jsx';
import { FormDialog } from './shared.jsx';

export const LETTERS = ['A', 'B', 'C', 'D'];
export const DIFFICULTIES = [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']];
const SECTIONS = [['rw', 'Reading and Writing'], ['math', 'Math']];

// What the server reads questions out of (lib/ingest.js), and how much of it.
const ACCEPT = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_FILES = 20;
const MAX_BYTES = 25 * 1024 * 1024;

const optional = <span className="font-normal text-muted-foreground">(optional)</span>;

/** A row of buttons for one choice among a few: [[value, label], ...]. */
export function Segmented({ id, label, options, value, onChange, disabled }) {
  return (
    <ToggleGroup id={id} type="single" variant="outline" spacing={0} value={value} aria-label={label} disabled={disabled}
      onValueChange={(v) => v && onChange(v)} className="w-full">
      {options.map(([v, text]) => (
        <ToggleGroupItem key={v} value={v} className="flex-1 bg-background px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
          {text}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

const sizeOf = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** PDFs or images to read questions out of: picked, or dropped on it. */
export function FileDrop({ files, onFiles, disabled }) {
  const [over, setOver] = useState(false);
  const [note, setNote] = useState(null);
  const add = (list) => {
    const all = [...list];
    const fits = all.filter((f) => ACCEPT.includes(f.type) && f.size <= MAX_BYTES);
    const next = [...files, ...fits.filter((f) => !files.some((x) => x.name === f.name && x.size === f.size))].slice(0, MAX_FILES);
    setNote(fits.length < all.length
      ? 'Only PDFs and PNG, JPG, GIF or WebP images up to 25 MB can be read; the rest were left out.'
      : files.length + fits.length > MAX_FILES ? `Up to ${MAX_FILES} files at a time.` : null);
    onFiles(next);
  };
  return (
    <div className="grid gap-2">
      <label
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) add(e.dataTransfer.files); }}
        className={cn(
          'flex flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
          disabled ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-muted/40',
          over && 'border-primary bg-muted/60',
        )}>
        <LuFileUp className="mb-1 size-5 text-muted-foreground" />
        <span className="text-sm font-medium">{files.length ? 'Add more files' : 'Choose PDFs or images'}</span>
        <span className="text-xs text-muted-foreground">Or drop them here. A whole practice test PDF works.</span>
        <input type="file" multiple accept={ACCEPT.join(',')} className="sr-only" disabled={disabled}
          onChange={(e) => { add(e.target.files || []); e.target.value = ''; }} />
      </label>
      {files.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {files.map((f, i) => (
            <li key={`${f.name}:${f.size}`} className="flex items-center gap-3 py-1.5 pr-1.5 pl-3 text-sm">
              <LuFile className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{sizeOf(f.size)}</span>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${f.name}`} disabled={disabled}
                onClick={() => onFiles(files.filter((_, j) => j !== i))}>
                <LuX />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {note && <p className="text-xs text-amber-700">{note}</p>}
    </div>
  );
}

/** The first choices for what AI writes. */
export const newAiRequest = (taxonomy) => ({
  section: 'rw', domain: taxonomy.rw[0].id, skill: '', focus: '', difficulty: 'medium', n: 10,
});

/** The request body for what AI writes; a chosen skill is the topic, else the focus. */
export const aiBody = (v) => ({
  section: v.section, domain: v.domain, difficulty: v.difficulty, n: Number(v.n), topic: v.skill || v.focus.trim(),
});

export const aiCountOk = (v) => Number.isInteger(Number(v.n)) && Number(v.n) >= 1 && Number(v.n) <= 20;

/** What AI should write: a section, domain and skill (or a looser focus), a difficulty and how many. */
export function AiFields({ taxonomy, value, onChange, disabled }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const domains = taxonomy[value.section];
  const domain = domains.find((d) => d.id === value.domain) || domains[0];
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="ai-section">Section</Label>
        <Segmented id="ai-section" label="Section" options={SECTIONS} value={value.section} disabled={disabled}
          onChange={(section) => set({ section, domain: taxonomy[section][0].id, skill: '' })} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="ai-domain">Domain</Label>
          <NativeSelect id="ai-domain" className="w-full" value={domain.id} disabled={disabled}
            onChange={(e) => set({ domain: e.target.value, skill: '' })}>
            {domains.map((d) => <NativeSelectOption key={d.id} value={d.id}>{d.label}</NativeSelectOption>)}
          </NativeSelect>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="ai-skill">Skill</Label>
          <NativeSelect id="ai-skill" className="w-full" value={value.skill} disabled={disabled} onChange={(e) => set({ skill: e.target.value })}>
            <NativeSelectOption value="">Any skill of the domain</NativeSelectOption>
            {domain.skills.map((s) => <NativeSelectOption key={s} value={s}>{s}</NativeSelectOption>)}
          </NativeSelect>
        </div>
      </div>
      {!value.skill && (
        <div className="grid gap-2">
          <Label htmlFor="ai-focus">Focus {optional}</Label>
          <Input id="ai-focus" value={value.focus} maxLength={200} disabled={disabled} onChange={(e) => set({ focus: e.target.value })}
            placeholder={value.section === 'rw' ? 'Passages about ecology' : 'Word problems about interest rates'} />
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
        <div className="grid gap-2">
          <Label htmlFor="ai-difficulty">Difficulty</Label>
          <Segmented id="ai-difficulty" label="Difficulty" options={DIFFICULTIES} value={value.difficulty} disabled={disabled}
            onChange={(difficulty) => set({ difficulty })} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="ai-count">Questions</Label>
          <Input id="ai-count" type="number" inputMode="numeric" min={1} max={20} value={value.n} disabled={disabled}
            onChange={(e) => set({ n: e.target.value })} aria-describedby="ai-count-hint" />
        </div>
      </div>
      <p id="ai-count-hint" className="-mt-2 text-xs text-muted-foreground">
        Up to 20 at a time. Each one is solved again by a second model and kept only if it agrees, so a few may drop out.
      </p>
    </div>
  );
}

/** Uploads and AI need the academy's own key; says so and leads to Settings. */
export function AiKeyNeeded({ onOpenSettings }) {
  return (
    <Alert className="border-amber-200 bg-amber-50 text-amber-900">
      <LuKeyRound />
      <AlertTitle>Add your AI key first</AlertTitle>
      <AlertDescription className="text-amber-800">
        Reading uploads and writing questions run on your academy&apos;s own AI provider key.
      </AlertDescription>
      {onOpenSettings && (
        <div className="col-start-2 mt-2.5">
          <Button type="button" variant="outline" size="sm" className="bg-background text-foreground" onClick={onOpenSettings}>Open Settings</Button>
        </div>
      )}
    </Alert>
  );
}

/** While a slow request runs: what is happening and that the dialog must stay open. */
export function Working({ children }) {
  return (
    <div role="status" className="flex items-start gap-3 rounded-lg border bg-muted/50 px-3.5 py-3 text-sm text-muted-foreground">
      <Spinner className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

// Where uploaded questions go in a test: as the file has them, or all into one module.
const TARGETS = [
  ['', 'Where the file puts each question'],
  ['rw:1', 'Reading and Writing, Module 1'],
  ['rw:2', 'Reading and Writing, Module 2'],
  ['math:1', 'Math, Module 1'],
  ['math:2', 'Math, Module 2'],
];

/** Add questions from an upload to a custom test. */
export function UploadIntoTest({ test, ready, onOpenSettings, onClose, onDone }) {
  const [files, setFiles] = useState([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));
      fd.append('target', target);
      onDone(await api.upload(`/api/admin/exams/${test.id}/questions/upload`, fd));
    } catch (err) {
      setError(err.message || 'Could not read those files');
      setBusy(false);
    }
  };
  return (
    <FormDialog busy={busy} onClose={onClose} onSubmit={submit} tall className="sm:max-w-lg"
      title="Add from an upload" description={`AI reads every question out of the files, with the answer key when they have one, and adds them to "${test.title}".`}
      footer={(
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy || !ready || !files.length}>{busy && <Spinner />}{busy ? 'Reading…' : 'Add questions'}</Button>
        </>
      )}>
      {!ready && <AiKeyNeeded onOpenSettings={onOpenSettings} />}
      <FileDrop files={files} onFiles={setFiles} disabled={busy || !ready} />
      <div className="grid gap-2">
        <Label htmlFor="upload-target">Put them in</Label>
        <NativeSelect id="upload-target" className="w-full" value={target} disabled={busy || !ready} onChange={(e) => setTarget(e.target.value)}>
          {TARGETS.map(([v, text]) => <NativeSelectOption key={v} value={v}>{text}</NativeSelectOption>)}
        </NativeSelect>
        <p className="text-xs text-muted-foreground">A practice test marks where Module 2 starts; the questions follow it.</p>
      </div>
      {busy && <Working>Reading the questions out of your files. A whole practice test can take a few minutes; keep this open.</Working>}
      <ErrorNote>{error}</ErrorNote>
    </FormDialog>
  );
}

/** Add questions AI writes to a custom test. */
export function WriteIntoTest({ test, taxonomy, ready, onOpenSettings, onClose, onDone }) {
  const [req, setReq] = useState(() => newAiRequest(taxonomy));
  const [module, setModule] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post(`/api/admin/exams/${test.id}/questions/generate`, { ...aiBody(req), module: Number(module) }));
    } catch (err) {
      setError(err.message || 'Could not write the questions');
      setBusy(false);
    }
  };
  return (
    <FormDialog busy={busy} onClose={onClose} onSubmit={submit} tall className="sm:max-w-lg"
      title="Write with AI" description={`New questions for "${test.title}", each checked before it is added.`}
      footer={(
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy || !ready || !aiCountOk(req)}>{busy && <Spinner />}{busy ? 'Writing…' : 'Write questions'}</Button>
        </>
      )}>
      {!ready && <AiKeyNeeded onOpenSettings={onOpenSettings} />}
      <AiFields taxonomy={taxonomy} value={req} onChange={setReq} disabled={busy || !ready} />
      <div className="grid gap-2">
        <Label htmlFor="write-module">Add to</Label>
        <Segmented id="write-module" label="Add to" options={[['1', 'Module 1'], ['2', 'Module 2']]} value={module} onChange={setModule} disabled={busy || !ready} />
      </div>
      {busy && <Working>Writing {Number(req.n) === 1 ? 'the question' : `${Number(req.n)} questions`} and checking each one. This takes about a minute; keep this open.</Working>}
      <ErrorNote>{error}</ErrorNote>
    </FormDialog>
  );
}

const blankQuestion = (section, taxonomy) => ({
  section,
  domain: taxonomy[section][0].id,
  skill: taxonomy[section][0].skills[0],
  difficulty: 'medium',
  passage: '',
  question: '',
  answerType: 'multiple-choice',
  choices: ['', '', '', ''],
  correctIdx: 0,
  answerText: '',
  explanation: '',
});

const fromQuestion = (q) => ({
  section: q.section,
  domain: q.domain || '',
  skill: q.skill || '',
  difficulty: q.difficulty || 'medium',
  passage: q.passage || '',
  question: q.question || '',
  answerType: q.answerType === 'grid-in' ? 'grid-in' : 'multiple-choice',
  choices: [0, 1, 2, 3].map((i) => q.choices?.[i] ?? ''),
  correctIdx: q.correctIdx ?? 0,
  answerText: q.answerText ?? q.correctAnswer ?? '',
  explanation: q.rationale?.correct || '',
});

/** Why a question cannot be saved yet, or null. */
function problemWith(f) {
  if (!f.domain || !f.skill) return 'Choose the domain and skill it tests.';
  if (!f.question.trim()) return 'Write the question.';
  if (f.answerType === 'grid-in') return f.answerText.trim() ? null : 'Enter the correct answer.';
  const choices = f.choices.map((c) => c.trim());
  if (choices.some((c) => !c)) return 'Fill in all four choices.';
  if (new Set(choices.map((c) => c.toLowerCase())).size < 4) return 'The four choices must differ.';
  return null;
}

/**
 * Write a question for a custom test, or edit one of it (`question`). A new
 * question picks its section and module (starting from `section` and
 * `module`); an edited one keeps its place.
 */
export function QuestionDialog({ test, taxonomy, question = null, section: initialSection = 'rw', module: initialModule = 1, onClose, onSaved }) {
  const [f, setF] = useState(() => (question ? fromQuestion(question) : blankQuestion(initialSection, taxonomy)));
  const [module, setModule] = useState(String(initialModule));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const editing = Boolean(question);
  const domains = taxonomy[f.section];
  const domain = domains.find((d) => d.id === f.domain);
  const rw = f.section === 'rw';
  const grid = f.answerType === 'grid-in';
  const problem = problemWith(f);

  const changeSection = (section) => setF((x) => ({
    ...blankQuestion(section, taxonomy), question: x.question, explanation: x.explanation, difficulty: x.difficulty,
  }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      domain: f.domain, skill: f.skill, difficulty: f.difficulty, question: f.question.trim(),
      passage: rw ? f.passage.trim() || null : null, answerType: f.answerType, explanation: f.explanation.trim(),
      ...(grid ? { answerText: f.answerText.trim() } : { choices: f.choices.map((c) => c.trim()), correctIdx: f.correctIdx }),
    };
    try {
      if (editing) await api.patch(`/api/admin/exams/${test.id}/question`, { qid: question.qid, ...body });
      else await api.post(`/api/admin/exams/${test.id}/questions/manual`, { section: f.section, module: Number(module), ...body });
      onSaved();
    } catch (err) {
      setError(err.message || 'Could not save the question');
      setBusy(false);
    }
  };

  return (
    <FormDialog busy={busy} onClose={onClose} onSubmit={submit} tall className="sm:max-w-2xl"
      title={editing ? 'Edit question' : 'Write a question'}
      description={editing
        ? 'Changes apply to this test from the next attempt on. Attempts already made keep the question as it was.'
        : `A question of your own for "${test.title}". Write math in LaTeX between \\( and \\), like \\(x^2\\).`}
      footer={(
        <>
          {problem && !busy && <p className="mr-auto self-center text-xs text-muted-foreground max-sm:order-last">{problem}</p>}
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy || Boolean(problem)}>{busy && <Spinner />}{busy ? 'Saving…' : editing ? 'Save changes' : 'Add question'}</Button>
        </>
      )}>
      {!editing && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="q-section">Section</Label>
            <Segmented id="q-section" label="Section" options={SECTIONS} value={f.section} onChange={changeSection} disabled={busy} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="q-module">Module</Label>
            <Segmented id="q-module" label="Module" options={[['1', 'Module 1'], ['2', 'Module 2']]} value={module} onChange={setModule} disabled={busy} />
          </div>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="q-domain">Domain</Label>
          <NativeSelect id="q-domain" className="w-full" value={f.domain} disabled={busy}
            onChange={(e) => set({ domain: e.target.value, skill: domains.find((d) => d.id === e.target.value)?.skills[0] || '' })}>
            {!domain && <NativeSelectOption value="">Choose a domain</NativeSelectOption>}
            {domains.map((d) => <NativeSelectOption key={d.id} value={d.id}>{d.label}</NativeSelectOption>)}
          </NativeSelect>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="q-skill">Skill</Label>
          <NativeSelect id="q-skill" className="w-full" value={domain?.skills.includes(f.skill) ? f.skill : ''} disabled={busy || !domain}
            onChange={(e) => set({ skill: e.target.value })}>
            {!domain?.skills.includes(f.skill) && <NativeSelectOption value="">Choose a skill</NativeSelectOption>}
            {(domain?.skills || []).map((s) => <NativeSelectOption key={s} value={s}>{s}</NativeSelectOption>)}
          </NativeSelect>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="q-difficulty">Difficulty</Label>
        <Segmented id="q-difficulty" label="Difficulty" options={DIFFICULTIES} value={f.difficulty} onChange={(difficulty) => set({ difficulty })} disabled={busy} />
      </div>
      {rw && (
        <div className="grid gap-2">
          <Label htmlFor="q-passage">Passage {optional}</Label>
          <Textarea id="q-passage" rows={4} value={f.passage} disabled={busy} onChange={(e) => set({ passage: e.target.value })}
            placeholder="The text the question is about" className="font-serif" />
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="q-question">Question</Label>
        <Textarea id="q-question" rows={3} value={f.question} disabled={busy} onChange={(e) => set({ question: e.target.value })}
          placeholder={rw ? 'Which choice best states the main idea of the text?' : 'If \\(3x + 5 = 20\\), what is the value of \\(x\\)?'} />
        {/\\\(|\\\[|\$\$/.test(f.question) && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 font-serif text-sm leading-relaxed">
            <MathText text={f.question} />
          </div>
        )}
      </div>
      {!rw && (
        <div className="grid gap-2">
          <Label htmlFor="q-type">Answer</Label>
          <Segmented id="q-type" label="Answer" options={[['multiple-choice', 'Four choices'], ['grid-in', 'Student enters it']]}
            value={f.answerType} onChange={(answerType) => set({ answerType })} disabled={busy} />
        </div>
      )}
      {grid ? (
        <div className="grid gap-2">
          <Label htmlFor="q-answer">Correct answer</Label>
          <Input id="q-answer" value={f.answerText} disabled={busy} onChange={(e) => set({ answerText: e.target.value })}
            placeholder="3/4" className="w-48 font-mono" />
          <p className="text-xs text-muted-foreground">Any equal value counts: 3/4, .75 and 0.75 are all right.</p>
        </div>
      ) : (
        <fieldset className="grid gap-2" disabled={busy}>
          <legend className="mb-2 text-sm font-medium">Choices <span className="font-normal text-muted-foreground">(mark the right one)</span></legend>
          <div role="radiogroup" aria-label="Correct choice" className="grid gap-2">
            {f.choices.map((c, i) => {
              const on = f.correctIdx === i;
              return (
                <div key={LETTERS[i]} className="flex items-center gap-2.5">
                  <button type="button" role="radio" aria-checked={on} aria-label={`${LETTERS[i]} is correct`} onClick={() => set({ correctIdx: i })}
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      on ? 'border-emerald-600 bg-emerald-600 text-white' : 'hover:bg-muted',
                    )}>
                    {LETTERS[i]}
                  </button>
                  <Input value={c} aria-label={`Choice ${LETTERS[i]}`} onChange={(e) => set({ choices: f.choices.map((x, j) => (j === i ? e.target.value : x)) })} />
                </div>
              );
            })}
          </div>
        </fieldset>
      )}
      <div className="grid gap-2">
        <Label htmlFor="q-explanation">Explanation {optional}</Label>
        <Textarea id="q-explanation" rows={3} value={f.explanation} disabled={busy} onChange={(e) => set({ explanation: e.target.value })}
          placeholder="Why the answer is right. Students see it when they review." />
      </div>
      <ErrorNote>{error}</ErrorNote>
    </FormDialog>
  );
}
