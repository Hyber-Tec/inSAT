// Progress panel - every practice session a student has taken, with scaled
// scores. Clicking a completed session opens a detail dialog with per-section
// scores and a question review.

import React, { useState, useEffect, useCallback } from 'react';
import {
  LuChartColumn, LuChevronRight, LuCircle, LuCircleCheck, LuCircleX, LuDownload, LuTrash2, LuTriangleAlert,
} from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api, assetUrl, authHeaders } from '../api.js';
import { EmptyState, ErrorNote, Loading, Meter, StatusBadge } from '../ui.jsx';
import { SectionHead, Stat, useConfirm } from './shared.jsx';
import { categoryLabel } from '../../taxonomy.js';
import { MathText } from '../MathText.jsx';

const LETTERS = ['A', 'B', 'C', 'D'];
const SECTION_LABELS = { rw: 'Reading & Writing', math: 'Math' };
const eyebrow = 'text-xs font-medium tracking-wide text-muted-foreground uppercase';

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS = {
  completed: { tone: 'success', label: 'Completed' },
  in_progress: { tone: 'warning', label: 'In progress' },
};

// Accuracy bar for one content domain: label + % + colored fill + n/N.
// Shared by the institution-wide analytics and the per-session analysis.
function DomainBar({ label, correct, total, sub }) {
  const pct = total ? Math.round((100 * correct) / total) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="leading-snug text-muted-foreground">{label}</span>
        <span className="font-mono font-medium tabular-nums">{pct}%</span>
      </div>
      <Meter value={pct} tone={pct >= 70 ? 'success' : pct >= 45 ? 'warning' : 'danger'} />
      <div className="text-xs text-muted-foreground tabular-nums">{correct}/{total}{sub ? ` · ${sub}` : ''}</div>
    </div>
  );
}

function Outcome({ q }) {
  const answered = (q.selectedIdx !== null && q.selectedIdx !== undefined)
    || (q.selectedText !== null && q.selectedText !== undefined && q.selectedText !== '');
  const [Icon, text, label] = q.isCorrect ? [LuCircleCheck, 'text-emerald-700', 'Correct']
    : answered ? [LuCircleX, 'text-red-700', 'Incorrect'] : [LuCircle, 'text-amber-700', 'Not answered'];
  return <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', text)}><Icon className="size-3.5" />{label}</span>;
}

function QuestionReview({ q }) {
  const choices = q.choices || [];
  const wrongLetter = !q.isCorrect && q.selectedIdx != null ? LETTERS[q.selectedIdx] : null;
  const wrongWhy = wrongLetter && q.rationale?.[wrongLetter];
  return (
    <div className="rounded-lg border p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {q.moduleLabel && <Badge variant="secondary">{q.moduleLabel}</Badge>}
        {q.domain && <Badge variant="secondary">{categoryLabel(q.section, q.domain)}</Badge>}
        <Outcome q={q} />
      </div>
      {q.skill && <div className="mb-3 text-xs text-muted-foreground">{q.skill}</div>}

      {q.passage && <div className="mb-3 font-serif text-sm leading-relaxed text-muted-foreground"><MathText text={q.passage} /></div>}
      {q.assetId && (
        <img src={assetUrl(q.assetId)} alt="Figure" loading="lazy" className="mb-3 block max-w-full rounded-lg border" />
      )}
      <div className="mb-3 font-serif text-[15px] leading-relaxed font-medium"><MathText text={q.question} /></div>

      {q.answerType === 'grid-in' ? (
        <div className="flex flex-wrap gap-2">
          <div className={cn('min-w-32 flex-1 rounded-md border px-3 py-2', q.isCorrect ? 'border-emerald-300 bg-emerald-50/70' : 'border-red-300 bg-red-50/70')}>
            <div className={cn('mb-0.5 text-[11px] font-semibold tracking-wide uppercase', q.isCorrect ? 'text-emerald-700' : 'text-red-700')}>Response</div>
            <div className="font-mono">{q.selectedText ? <MathText text={q.selectedText} /> : 'No answer'}</div>
          </div>
          <div className="min-w-32 flex-1 rounded-md border border-emerald-300 bg-emerald-50/70 px-3 py-2">
            <div className="mb-0.5 text-[11px] font-semibold tracking-wide text-emerald-700 uppercase">Key</div>
            <div className="font-mono"><MathText text={String(q.correctAnswer ?? '')} /></div>
          </div>
        </div>
      ) : (
        <div className="grid gap-1.5">
          {choices.map((choice, i) => {
            const isCorrect = i === q.correctIdx;
            const isSelected = i === q.selectedIdx;
            return (
              <div key={i} className={cn('flex items-start gap-2.5 rounded-md border px-3 py-2 text-sm',
                isCorrect ? 'border-emerald-300 bg-emerald-50/70' : isSelected ? 'border-red-300 bg-red-50/70' : '')}>
                <span className={cn('w-4 shrink-0 font-mono text-xs font-semibold leading-5',
                  isCorrect ? 'text-emerald-700' : isSelected ? 'text-red-700' : 'text-muted-foreground')}>{LETTERS[i]}</span>
                <span className="flex-1 leading-relaxed"><MathText text={String(choice)} /></span>
                {isCorrect && <span className="text-[11px] leading-5 font-semibold tracking-wide text-emerald-700 uppercase">Key</span>}
                {isSelected && !isCorrect && <span className="text-[11px] leading-5 font-semibold tracking-wide text-red-700 uppercase">Chose</span>}
              </div>
            );
          })}
        </div>
      )}

      {wrongWhy && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50/60 px-3.5 py-3">
          <div className="mb-1 text-[11px] font-semibold tracking-wide text-red-700 uppercase">Why {wrongLetter} is wrong</div>
          <div className="text-sm leading-relaxed text-foreground/80"><MathText text={wrongWhy} /></div>
        </div>
      )}
      {q.rationale?.correct && (
        <div className={cn('rounded-md border bg-muted/50 px-3.5 py-3', wrongWhy ? 'mt-2' : 'mt-3')}>
          <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {q.correctIdx != null ? `Why ${LETTERS[q.correctIdx]} is correct` : 'Explanation'}
          </div>
          <div className="text-sm leading-relaxed text-foreground/80"><MathText text={q.rationale.correct} /></div>
        </div>
      )}
    </div>
  );
}

// Per-session analysis for instructors: what the score means (adaptive route
// taken, blanks) and which content domains the student is weakest in.
function AnalysisPanel({ detail }) {
  const sections = (detail.sections || []).filter((s) => (s.domains || []).length > 0);
  if (!sections.length) return null;
  const pct = (d) => (d.total ? Math.round((100 * d.correct) / d.total) : 0);
  const weak = sections
    .flatMap((s) => s.domains)
    .filter((d) => d.total >= 2 && pct(d) < 70)
    .sort((a, b) => pct(a) - pct(b))
    .slice(0, 4);
  const thresholdPct = Math.round((detail.threshold ?? 0.6) * 100);

  const meaning = (s) => {
    const bits = [];
    if (s.adaptive) {
      bits.push(s.route === 'hard'
        ? `Module 1 cleared the ${thresholdPct}% routing bar, so Module 2 served the harder set and the full 800 ceiling was in reach.`
        : `Module 1 fell below the ${thresholdPct}% routing bar, so Module 2 served the easier set, which caps this section's scaled score at 600.`);
    }
    if (s.unanswered > 0) bits.push(`${s.unanswered} of ${s.total} questions were left unanswered.`);
    return bits.join(' ');
  };

  return (
    <Card className="mb-6">
      <CardHeader><CardTitle className={eyebrow}>Analysis</CardTitle></CardHeader>
      <CardContent className="gap-4">
        {weak.length > 0 ? (
          <div className="rounded-lg border border-red-200 bg-red-50/60 p-3">
            <div className="mb-2 text-[11px] font-semibold tracking-wide text-red-700 uppercase">Focus areas</div>
            <div className="flex flex-wrap gap-2">
              {weak.map((d) => (
                <span key={d.domain} className="inline-flex items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-xs font-medium">
                  {d.label} <span className="font-mono text-red-700 tabular-nums">{pct(d)}%</span>
                  <span className="font-normal text-muted-foreground tabular-nums">· {d.correct}/{d.total}</span>
                </span>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Accuracy is even across content domains - no clear weak area stands out.</p>
        )}

        {sections.map((s) => (
          <div key={s.kind} className="space-y-2">
            <div className="text-sm font-medium">{SECTION_LABELS[s.kind] || s.name}</div>
            {meaning(s) && <p className="text-xs leading-relaxed text-muted-foreground">{meaning(s)}</p>}
            <div className="grid gap-4 pt-1 sm:grid-cols-2 lg:grid-cols-3">
              {s.domains.map((d) => <DomainBar key={d.domain} label={d.label} correct={d.correct} total={d.total} />)}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function DetailModal({ sessionId, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { results } = await api.get(`/api/admin/results/${sessionId}`);
        if (!cancelled) setDetail(results);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load the result');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  // A skill set or a custom test has no scaled score: correct of total is the result.
  const byCount = detail?.totalScaled == null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {loading ? (
          <>
            <DialogTitle className="sr-only">Loading result</DialogTitle>
            <Loading />
          </>
        ) : error ? (
          <div className="p-6">
            <DialogTitle className="mb-4">Result</DialogTitle>
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : detail ? (
          <>
            {/* Score header */}
            <div className="border-b px-6 pt-6 pb-5">
              <div className={eyebrow}>{detail.studentName}</div>
              <DialogTitle className="mt-1 text-xl font-semibold tracking-tight">{detail.examTitle}</DialogTitle>
              <DialogDescription className="sr-only">Scores and a question-by-question review</DialogDescription>
              <div className="mt-5 flex flex-wrap items-end gap-x-9 gap-y-4">
                {/* One section has its own score, not a total. */}
                {byCount ? (
                  <Stat label="Correct" value={`${detail.totalCorrect}/${detail.totalQuestions}`} size="lg" />
                ) : detail.sections?.length === 1 ? (
                  <Stat label={`${SECTION_LABELS[detail.sections[0].kind] || detail.sections[0].name} scaled`} value={detail.sections[0].scaled} size="lg" />
                ) : (
                  <>
                    <Stat label="Total scaled" value={detail.totalScaled} size="lg" />
                    {(detail.sections || []).map((s, i) => <Stat key={i} label={SECTION_LABELS[s.kind] || s.name} value={s.scaled} />)}
                  </>
                )}
                {detail.totalCorrect != null && !byCount && (
                  <Stat label="Correct" value={`${detail.totalCorrect}/${detail.totalQuestions}`} />
                )}
              </div>
              {detail.proctor?.focusLosses > 0 && (
                <div className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-medium text-red-700">
                  <LuTriangleAlert className="size-3.5" /> Left the exam tab {detail.proctor.focusLosses}×
                </div>
              )}
            </div>

            {/* Analysis + sections + question review */}
            <div className="scrollbar-thin overflow-y-auto px-6 py-5">
              <AnalysisPanel detail={detail} />
              {(detail.sections || []).map((s, si) => (
                <div key={si} className={cn(si < detail.sections.length - 1 && 'mb-7')}>
                  <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
                    <h3 className="font-semibold tracking-tight">{SECTION_LABELS[s.kind] || s.name}</h3>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                      {s.route && <span>Route: <span className="font-medium text-foreground">{s.route}</span></span>}
                      {s.scaled != null && <span>Score: <span className="font-mono font-medium text-foreground tabular-nums">{s.scaled}</span></span>}
                      <span><span className="font-mono font-medium text-foreground tabular-nums">{s.correct ?? 0}/{s.total ?? 0}</span> correct</span>
                    </div>
                  </div>
                  <div className="grid gap-2.5">
                    {(s.questions || []).map((q, qi) => <QuestionReview key={qi} q={q} />)}
                  </div>
                </div>
              ))}
            </div>

            <DialogFooter className="border-t px-6 py-4">
              <Button variant="outline" onClick={onClose}>Close</Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ResultsAnalytics() {
  const [a, setA] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try { const data = await api.get('/api/admin/analytics'); if (!cancelled) setA(data); }
      catch { /* analytics are best-effort */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const exportCsv = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${api.base}/api/admin/results.csv`, { headers: await authHeaders() });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'insat-results.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } finally { setBusy(false); }
  };

  const o = a?.overall || {};
  const stats = [['Completed', o.completed], ['Avg total', o.avg_total], ['Avg R&W', o.avg_rw], ['Avg Math', o.avg_math]];
  return (
    <div className="mb-8 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map(([label, value]) => (
            <Card key={label} size="sm" className="px-4"><Stat label={label} value={value} /></Card>
          ))}
        </div>
        <Button variant="outline" onClick={exportCsv} disabled={busy}>
          {busy ? <Spinner /> : <LuDownload data-icon="inline-start" />}
          {busy ? 'Exporting…' : 'Export CSV'}
        </Button>
      </div>
      {a?.byDomain?.length > 0 && (
        <Card>
          <CardHeader><CardTitle className={eyebrow}>Accuracy by domain</CardTitle></CardHeader>
          <CardContent className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            {a.byDomain.map((d) => (
              <DomainBar key={`${d.section}-${d.domain}`} label={categoryLabel(d.section, d.domain)}
                correct={d.correct} total={d.total} sub={d.section === 'rw' ? 'R&W' : 'Math'} />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function Results({ onOpenStudent = null }) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openSession, setOpenSession] = useState(null);
  const [confirmNode, askConfirm] = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { results: list } = await api.get('/api/admin/results');
      setResults(list || []);
    } catch (err) {
      setError(err.message || 'Could not load results');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const deleteResult = (r) => askConfirm({
    title: 'Delete result?',
    message: `Delete ${r.studentName}'s ${r.status === 'completed' ? 'completed' : 'in-progress'} attempt at "${r.examTitle}"? This permanently removes the session and its answers and cannot be undone.`,
    confirmLabel: 'Delete result',
    tone: 'danger',
    onConfirm: async () => {
      await api.del(`/api/admin/results/${r.sessionId}`);
      setResults((prev) => prev.filter((x) => x.sessionId !== r.sessionId));
    },
  });

  return (
    <div>
      <SectionHead
        eyebrow="Performance"
        title="Results & scores"
        sub="Every practice session, scored on the 400–1600 scale. Open a completed session to review it question by question."
      />

      <ResultsAnalytics />

      {error && <ErrorNote className="mb-5">{error}</ErrorNote>}

      {loading ? (
        <Loading />
      ) : results.length === 0 ? (
        <EmptyState icon={LuChartColumn} title="No results yet" hint="Once students finish a practice test or a skill set, their scores appear here." />
      ) : (
        <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
          {results.map((r) => {
            const completed = r.status === 'completed';
            const status = STATUS[r.status] || { tone: 'neutral', label: r.status };
            // One section has its own score; only a full test has a total.
            const section = r.scope === 'rw' || r.scope === 'math' ? r.scope
              : completed && (r.rwScaled == null) !== (r.mathScaled == null) ? (r.rwScaled == null ? 'math' : 'rw') : null;
            const scores = r.practiceMode === 'skills' || r.custom
              ? [['Correct', completed ? `${r.correct}/${r.questionCount}` : null, true]]
              : section
                ? [[section === 'rw' ? 'R&W' : 'Math', section === 'rw' ? r.rwScaled : r.mathScaled, true]]
                : [['R&W', r.rwScaled], ['Math', r.mathScaled], ['Total', r.totalScaled, true]];
            return (
              <div
                key={r.sessionId}
                role={completed ? 'button' : undefined}
                tabIndex={completed ? 0 : undefined}
                onClick={completed ? () => setOpenSession(r.sessionId) : undefined}
                onKeyDown={completed ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenSession(r.sessionId); } } : undefined}
                className={cn(
                  'flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3.5 outline-none sm:px-5',
                  completed && 'cursor-pointer transition-colors hover:bg-muted/40 focus-visible:bg-muted/40',
                )}
              >
                <div className="min-w-56 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {onOpenStudent ? (
                      <button type="button" className="rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        onClick={(e) => { e.stopPropagation(); onOpenStudent(r.userId); }}>
                        {r.studentName}
                      </button>
                    ) : <span className="font-medium">{r.studentName}</span>}
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                    {r.kind === 'practice' && <Badge variant="secondary">{r.assigned ? 'Assigned practice' : 'Self-practice'}</Badge>}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {r.examTitle} · {completed ? `Completed ${fmtDate(r.completedAt)}` : `Started ${fmtDate(r.startedAt)}`}
                  </div>
                </div>

                <div className="ml-auto flex items-center gap-6">
                  {scores.map(([label, value, strong]) => (
                    <div key={label} className="text-right">
                      <div className={cn('font-mono text-lg leading-none tabular-nums', strong ? 'font-semibold' : 'text-muted-foreground')}>{value ?? '-'}</div>
                      <div className="mt-1 text-[11px] text-muted-foreground">{label}</div>
                    </div>
                  ))}
                  <div className="flex items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label="Delete result"
                          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          onClick={(e) => { e.stopPropagation(); deleteResult(r); }}>
                          <LuTrash2 />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Delete result</TooltipContent>
                    </Tooltip>
                    <LuChevronRight className={cn('size-4', completed ? 'text-muted-foreground' : 'invisible')} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {openSession && <DetailModal sessionId={openSession} onClose={() => setOpenSession(null)} />}
      {confirmNode}
    </div>
  );
}
