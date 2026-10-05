// A custom test's page (managed academies): its questions, by section and
// module, each shown with its answer and explanation as students will meet
// it. Questions come in from an upload, from AI or by hand
// (authoring.jsx); each can be edited or removed, and selected ones moved to
// the section's other module. Every student given the test gets these same
// questions; a change applies to attempts started after it.

import React, { useState, useEffect, useCallback } from 'react';
import {
  LuArrowLeft, LuArrowRightLeft, LuChevronDown, LuFileUp, LuListChecks, LuPencil, LuPenLine, LuPlus, LuSend, LuSparkles, LuTrash2,
} from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api, assetUrl } from '../api.js';
import { MathText } from '../MathText.jsx';
import { EmptyState, ErrorNote, Loading, StatusBadge } from '../ui.jsx';
import { SECTION_NAME } from '../skills.jsx';
import { ResultBanner, SectionHead, useConfirm } from './shared.jsx';
import { AssignDialog, assignedNote } from './assign.jsx';
import { LETTERS, QuestionDialog, UploadIntoTest, WriteIntoTest } from './authoring.jsx';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The SAT's pace, as the server times a custom test (lib/examForm.js).
const SECONDS_PER_QUESTION = { rw: (32 * 60) / 27, math: (35 * 60) / 22 };
const minutesFor = (kind, count) => Math.ceil((count * SECONDS_PER_QUESTION[kind]) / 60);

const questionsOf = (m) => m.groups.flatMap((g) => g.questions);

function EditorQuestion({ q, n, domainLabel, selected, onSelect, onEdit, onDelete }) {
  const grid = q.answerType === 'grid-in';
  const explanation = q.rationale?.correct;
  return (
    <article className={cn('rounded-xl border bg-card p-4 shadow-xs transition-colors sm:p-5', selected && 'border-primary/60 bg-muted/30')}>
      {/* On a phone the domain and skill take a line of their own under the controls. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <Checkbox checked={selected} onCheckedChange={onSelect} aria-label={`Select question ${n}`} />
        <span className="flex size-6 items-center justify-center rounded-md bg-primary font-mono text-xs font-semibold text-primary-foreground">{n}</span>
        <Badge variant="secondary" className="capitalize">{q.difficulty || 'medium'}</Badge>
        {q.skill ? (
          <span className="min-w-0 text-xs text-muted-foreground max-sm:order-last max-sm:w-full">{domainLabel} · {q.skill}</span>
        ) : (
          <StatusBadge tone="warning">No skill set</StatusBadge>
        )}
        <div className="-mr-1.5 ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit}><LuPencil /> Edit</Button>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label={`Remove question ${n}`} onClick={onDelete}>
            <LuTrash2 />
          </Button>
        </div>
      </div>

      {q.passage && <div className="mb-3 font-serif text-sm leading-relaxed text-muted-foreground"><MathText text={q.passage} /></div>}
      {q.assetId && <img src={assetUrl(q.assetId)} alt="Figure" loading="lazy" className="mb-3 block max-h-80 max-w-full rounded-lg border bg-white p-1" />}
      <div className="mb-3 font-serif text-[15px] leading-relaxed font-medium"><MathText text={q.question} /></div>

      {grid ? (
        <div className="inline-flex items-center gap-3 rounded-md border border-emerald-300 bg-emerald-50/70 px-3 py-2">
          <span className="text-[11px] font-semibold tracking-wide text-emerald-700 uppercase">Answer</span>
          <span className="font-mono"><MathText text={String(q.answerText ?? '')} /></span>
        </div>
      ) : (
        <div className="grid gap-1.5">
          {(q.choices || []).map((c, i) => {
            const correct = i === q.correctIdx;
            return (
              <div key={LETTERS[i]} className={cn('flex items-start gap-2.5 rounded-md border px-3 py-2 text-sm', correct && 'border-emerald-300 bg-emerald-50/70')}>
                <span className={cn('w-4 shrink-0 font-mono text-xs leading-5 font-semibold', correct ? 'text-emerald-700' : 'text-muted-foreground')}>{LETTERS[i]}</span>
                <span className="flex-1 leading-relaxed"><MathText text={String(c)} /></span>
                {correct && <span className="text-[11px] leading-5 font-semibold tracking-wide text-emerald-700 uppercase">Answer</span>}
              </div>
            );
          })}
        </div>
      )}

      {explanation && (
        <div className="mt-3 rounded-md border bg-muted/50 px-3.5 py-3">
          <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {grid ? 'Explanation' : `Why ${LETTERS[q.correctIdx]} is correct`}
          </div>
          <div className="text-sm leading-relaxed text-foreground/80"><MathText text={explanation} /></div>
        </div>
      )}
    </article>
  );
}

export default function TestEditor({ test, taxonomy, ai, notice = null, onBack, onChanged, onOpenSettings }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [banner, setBanner] = useState(notice);
  const [timing, setTiming] = useState(test.timingMode);
  const [kind, setKind] = useState(null); // the section shown
  const [ordinal, setOrdinal] = useState(1); // its module shown
  const [selected, setSelected] = useState(() => new Set());
  const [dialog, setDialog] = useState(null); // { kind, question? }
  const [confirmNode, askConfirm] = useConfirm();

  const load = useCallback(async () => {
    try {
      const d = await api.get(`/api/admin/exams/${test.id}/preview`);
      setData(d);
      setError(null);
    } catch (err) {
      setError(err.message || 'Could not load the questions');
    }
  }, [test.id]);
  useEffect(() => { load(); }, [load]);

  const sections = data?.sections || [];
  // Keep the shown section and module real as questions come and go.
  const section = sections.find((s) => s.kind === kind) || sections[0] || null;
  const mod = section ? section.modules.find((m) => m.ordinal === ordinal) || section.modules[0] : null;
  const questions = mod ? questionsOf(mod) : [];
  const count = (s) => s.modules.reduce((n, m) => n + questionsOf(m).length, 0);
  const total = sections.reduce((n, s) => n + count(s), 0);
  const minutes = sections.reduce((n, s) => n + s.modules.reduce((k, m) => k + minutesFor(s.kind, questionsOf(m).length), 0), 0);
  const domainLabel = (q) => taxonomy[q.section]?.find((d) => d.id === q.domain)?.label || 'No domain';

  const show = (nextKind, nextOrdinal) => {
    setKind(nextKind);
    setOrdinal(nextOrdinal);
    setSelected(new Set());
  };
  const changed = async () => { await load(); onChanged(); };
  const added = (message) => { setDialog(null); setBanner(message); changed(); };

  const toggleTiming = async (on) => {
    const next = on ? 'full' : 'untimed';
    setTiming(next);
    setError(null);
    try {
      await api.patch(`/api/admin/exams/${test.id}`, { timingMode: next });
      onChanged();
    } catch (err) {
      setTiming(on ? 'untimed' : 'full');
      setError(err.message || 'Could not change the timing');
    }
  };

  const remove = (q, n) => askConfirm({
    title: `Remove question ${n}?`,
    message: 'It leaves this test. Attempts already made keep it, and so do their scores.',
    confirmLabel: 'Remove',
    tone: 'danger',
    onConfirm: async () => {
      await api.del(`/api/admin/exams/${test.id}/questions/${encodeURIComponent(q.qid)}`);
      setSelected((prev) => { const next = new Set(prev); next.delete(q.qid); return next; });
      await changed();
    },
  });

  const other = mod?.ordinal === 2 ? 1 : 2;
  const move = async () => {
    setError(null);
    try {
      const { moved } = await api.post(`/api/admin/exams/${test.id}/questions/move`, { qids: [...selected], module: other });
      setBanner(`Moved ${plural(moved, 'question')} to Module ${other}.`);
      setSelected(new Set());
      setOrdinal(other);
      await changed();
    } catch (err) {
      setError(err.message || 'Could not move the questions');
    }
  };

  const addMenu = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button><LuPlus data-icon="inline-start" /> Add questions <LuChevronDown data-icon="inline-end" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => setDialog({ kind: 'upload' })}><LuFileUp /> From an upload…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setDialog({ kind: 'ai' })}><LuSparkles /> Write with AI…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setDialog({ kind: 'write' })}><LuPenLine /> Write one yourself…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div>
      <Button variant="ghost" size="sm" className="mb-4 -ml-2.5 text-muted-foreground" onClick={onBack}>
        <LuArrowLeft /> All tests
      </Button>
      <SectionHead
        eyebrow="Custom test"
        title={test.title}
        sub="Every student you give it to gets these same questions. A change applies to attempts started after it."
        right={(
          <>
            {addMenu}
            <Button variant="outline" disabled={!total} onClick={() => setDialog({ kind: 'assign' })}><LuSend data-icon="inline-start" /> Assign</Button>
          </>
        )}
      />

      <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-muted/30 px-4 py-3">
        <div className="text-sm">
          <span className="font-medium">{plural(total, 'question')}</span>
          {sections.length > 0 && <span className="text-muted-foreground"> · {sections.map((s) => SECTION_NAME[s.kind]).join(' and ')}</span>}
        </div>
        <div className="flex items-center gap-2.5">
          <Switch id="test-timed" checked={timing !== 'untimed'} onCheckedChange={toggleTiming} />
          <Label htmlFor="test-timed" className="font-normal">Timed at the SAT&apos;s pace</Label>
          {total > 0 && (
            <span className="text-xs text-muted-foreground">
              {timing === 'untimed' ? 'Students take the time they need' : `${plural(minutes, 'minute')} in all`}
            </span>
          )}
        </div>
      </div>

      <ErrorNote className="mb-5">{error}</ErrorNote>
      {banner && <div className="mb-5"><ResultBanner onDismiss={() => setBanner(null)}>{banner}</ResultBanner></div>}

      {!data && !error ? <Loading /> : data && total === 0 ? (
        <EmptyState icon={LuListChecks} title="No questions yet" hint="Add questions from an upload, have AI write them, or write them yourself.">
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" onClick={() => setDialog({ kind: 'upload' })}><LuFileUp /> From an upload</Button>
            <Button variant="outline" onClick={() => setDialog({ kind: 'ai' })}><LuSparkles /> Write with AI</Button>
            <Button variant="outline" onClick={() => setDialog({ kind: 'write' })}><LuPenLine /> Write one</Button>
          </div>
        </EmptyState>
      ) : section && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {sections.length > 1 ? (
              <Tabs value={section.kind} onValueChange={(v) => show(v, 1)}>
                <TabsList>
                  {sections.map((s) => (
                    <TabsTrigger key={s.kind} value={s.kind} className="px-3">
                      {SECTION_NAME[s.kind]} <span className="text-muted-foreground tabular-nums">· {count(s)}</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            ) : (
              <h2 className="text-lg font-semibold tracking-tight">{SECTION_NAME[section.kind]}</h2>
            )}
            {section.modules.length > 1 && (
              <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={String(mod.ordinal)} aria-label="Module"
                onValueChange={(v) => v && show(section.kind, Number(v))}>
                {section.modules.map((m) => (
                  <ToggleGroupItem key={m.ordinal} value={String(m.ordinal)} className="bg-background px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
                    Module {m.ordinal} <span className="opacity-60 tabular-nums">· {questionsOf(m).length}</span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            )}
          </div>

          {selected.size > 0 && (
            <div className="sticky top-2 z-10 flex md:top-16 flex-wrap items-center gap-3 rounded-xl border bg-background/95 px-4 py-2.5 shadow-sm backdrop-blur-md">
              <span className="text-sm font-medium">{plural(selected.size, 'question')} selected</span>
              <Button size="sm" variant="outline" onClick={move}><LuArrowRightLeft /> Move to Module {other}</Button>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
          )}

          <div className="space-y-3">
            {questions.map((q, i) => (
              <EditorQuestion key={q.qid} q={q} n={i + 1} domainLabel={domainLabel(q)} selected={selected.has(q.qid)}
                onSelect={(on) => setSelected((prev) => {
                  const next = new Set(prev);
                  if (on) next.add(q.qid); else next.delete(q.qid);
                  return next;
                })}
                onEdit={() => setDialog({ kind: 'edit', question: q })}
                onDelete={() => remove(q, i + 1)} />
            ))}
          </div>
        </div>
      )}

      {dialog?.kind === 'upload' && (
        <UploadIntoTest test={test} ready={ai?.ready} onOpenSettings={onOpenSettings} onClose={() => setDialog(null)}
          onDone={(r) => added([
            `Added ${plural(r.appended, 'question')} from your upload.`,
            r.extracted > r.appended ? `${plural(r.extracted - r.appended, 'question')} ${r.extracted - r.appended === 1 ? 'was' : 'were'} already in the test.` : '',
            r.notes?.length ? `From your files: ${r.notes.join('; ')}.` : '',
          ].filter(Boolean).join(' '))} />
      )}
      {dialog?.kind === 'ai' && (
        <WriteIntoTest test={test} taxonomy={taxonomy} ready={ai?.ready} onOpenSettings={onOpenSettings} onClose={() => setDialog(null)}
          onDone={(r) => added(r.appended
            ? `Added ${plural(r.appended, 'question')}.${r.flagged ? ` ${plural(r.flagged, 'draft')} failed the answer check and ${r.flagged === 1 ? 'was' : 'were'} left out.` : ''}`
            : 'No question passed the answer check, so none were added. Try again.')} />
      )}
      {dialog?.kind === 'write' && (
        <QuestionDialog test={test} taxonomy={taxonomy} section={section?.kind || 'rw'} module={mod?.ordinal || 1}
          onClose={() => setDialog(null)} onSaved={() => added('Question added.')} />
      )}
      {dialog?.kind === 'edit' && (
        <QuestionDialog test={test} taxonomy={taxonomy} question={dialog.question}
          onClose={() => setDialog(null)} onSaved={() => added('Question saved.')} />
      )}
      {dialog?.kind === 'assign' && (
        <AssignDialog examId={test.id} onClose={() => setDialog(null)}
          onDone={(result) => { setDialog(null); setBanner(assignedNote(`"${test.title}"`, result)); }} />
      )}
      {confirmNode}
    </div>
  );
}
