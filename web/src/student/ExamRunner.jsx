// Server-driven exam runner. Consumes a sanitized session form (no answers),
// walks section -> Module 1 -> (adaptive route) -> Module 2 -> break -> finish.
// Routing is decided by the server after Module 1; the final score is computed
// server-side on finish. Progress autosaves so a refresh resumes.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  LuArrowRight, LuBookOpen, LuCalculator, LuCheck, LuChevronLeft, LuChevronRight, LuCoffee, LuFlag,
  LuLayoutGrid, LuTriangleAlert, LuX,
} from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { api, assetUrl } from '../api.js';
import { MathText } from '../MathText.jsx';
import { MathCalculator, Reference, formatTime, LETTERS } from './tools.jsx';

const moduleQuestions = (form, secIdx, modIdx, routing) => {
  const mod = form.sections[secIdx].modules[modIdx];
  if (mod.adaptive) {
    const kind = form.sections[secIdx].kind;
    return mod.variants[routing[kind] || 'easy'] || [];
  }
  return mod.questions || [];
};

export default function ExamRunner({ session, onFinished, onExit }) {
  const { sessionId, examTitle, timingMode, form } = session;
  const initialState = session.state || {};
  // Self-guided practice is the student's own: no lockdown and no tab-switch
  // record, which exist for exams an instructor assigned.
  const proctored = session.kind !== 'practice';
  const skillSet = session.practice?.mode === 'skills';

  const [secIdx, setSecIdx] = useState(initialState.position?.secIdx ?? 0);
  const [modIdx, setModIdx] = useState(initialState.position?.modIdx ?? 0);
  const [qIdx, setQIdx] = useState(0);
  const [phase, setPhase] = useState('intro'); // intro | test | break | submitting
  const [answers, setAnswers] = useState(initialState.answers || {});
  const [marked, setMarked] = useState(initialState.marked || {});
  const [crossed, setCrossed] = useState(initialState.crossed || {});
  const [routing, setRouting] = useState(session.routing || {});
  const [timeLeft, setTimeLeft] = useState(0);
  const [error, setError] = useState(null);
  const [focusLosses, setFocusLosses] = useState(initialState.proctor?.focusLosses || 0);
  const [proctorWarn, setProctorWarn] = useState(false);

  const section = form.sections[secIdx];
  const mod = section.modules[modIdx];
  const questions = moduleQuestions(form, secIdx, modIdx, routing);
  const isMath = section.kind === 'math';
  // A module may carry its own limit (a timed custom test gets the time its
  // length would have on the SAT); otherwise its section's applies. With no
  // limit at all it runs untimed rather than tripping "time's up" on a null.
  const limit = mod.timeLimitSec || section.timeLimitSec;
  const untimed = timingMode === 'untimed' || !limit;

  // Keep the latest state in a ref for autosave.
  const stateRef = useRef({});
  stateRef.current = { answers, marked, crossed, position: { secIdx, modIdx }, proctor: { focusLosses } };

  const persist = useCallback(async () => {
    try { await api.patch(`/api/student/sessions/${sessionId}/state`, { state: stateRef.current }); }
    catch { /* autosave is best-effort */ }
  }, [sessionId]);

  // Autosave every 15s during the test.
  useEffect(() => {
    if (phase !== 'test') return undefined;
    const t = setInterval(persist, 15000);
    return () => clearInterval(t);
  }, [phase, persist]);

  // Exam lockdown: request fullscreen, block copy/paste/right-click, and record
  // tab-switches (the count is saved on the session and shown to the admin).
  useEffect(() => {
    if (phase !== 'test' || !proctored) return undefined;
    const el = document.documentElement;
    if (el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(() => {});
    const prevent = (e) => e.preventDefault();
    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        setFocusLosses((n) => n + 1);
        setProctorWarn(true);
      }
    };
    document.addEventListener('copy', prevent);
    document.addEventListener('paste', prevent);
    document.addEventListener('cut', prevent);
    document.addEventListener('contextmenu', prevent);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      document.removeEventListener('copy', prevent);
      document.removeEventListener('paste', prevent);
      document.removeEventListener('cut', prevent);
      document.removeEventListener('contextmenu', prevent);
      document.removeEventListener('visibilitychange', onHidden);
      if (document.exitFullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, [phase, proctored]);

  // Timer.
  useEffect(() => {
    if (phase !== 'test' || untimed) return undefined;
    if (timeLeft <= 0) { submitModule(); return undefined; }
    const t = setInterval(() => setTimeLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [phase, timeLeft, untimed]); // eslint-disable-line react-hooks/exhaustive-deps

  const beginModule = () => {
    setQIdx(0);
    setTimeLeft(untimed ? 0 : limit);
    setPhase('test');
  };

  const setAnswer = (qid, idx) => {
    setAnswers((a) => ({ ...a, [qid]: idx }));
    setCrossed((c) => (c[qid]?.includes(idx) ? { ...c, [qid]: c[qid].filter((i) => i !== idx) } : c));
  };
  const toggleMark = (qid) => setMarked((m) => ({ ...m, [qid]: !m[qid] }));
  const toggleCross = (qid, idx) => setCrossed((c) => {
    const cur = c[qid] || [];
    return { ...c, [qid]: cur.includes(idx) ? cur.filter((i) => i !== idx) : [...cur, idx] };
  });

  async function submitModule() {
    setPhase('submitting');
    setError(null);
    const state = { answers, marked, crossed, position: { secIdx, modIdx }, proctor: { focusLosses } };
    try {
      const hasSecondModule = section.modules.length > 1;
      if (modIdx === 0 && hasSecondModule) {
        const { routing: r } = await api.post(`/api/student/sessions/${sessionId}/route`, { sectionKind: section.kind, state });
        setRouting((prev) => ({ ...prev, [section.kind]: r }));
        setModIdx(1);
        setPhase('intro');
      } else if (secIdx < form.sections.length - 1) {
        await api.patch(`/api/student/sessions/${sessionId}/state`, { state });
        // The break belongs to the full test; a skill set runs straight on.
        if (skillSet) nextSection();
        else setPhase('break');
      } else {
        const { results } = await api.post(`/api/student/sessions/${sessionId}/finish`, { state });
        onFinished(results);
      }
    } catch (err) {
      setError(err.message || 'Could not submit. Check your connection and try again.');
      setPhase('test');
    }
  }

  const nextSection = () => { setSecIdx((s) => s + 1); setModIdx(0); setPhase('intro'); };

    // ---- Screens -------------------------------------------------------------

  if (phase === 'submitting') {
    return (
      <Centered>
        <Spinner className="size-7 text-muted-foreground" />
        <p className="mt-4 text-sm text-muted-foreground">Saving your work…</p>
      </Centered>
    );
  }

  if (phase === 'break') {
    return <BreakScreen onContinue={nextSection} demo={timingMode === 'demo'} />;
  }

  if (phase === 'intro') {
    return (
      <ModuleIntro
        examTitle={examTitle}
        section={section}
        modIdx={modIdx}
        sectionIdx={secIdx}
        totalSections={form.sections.length}
        count={questions.length}
        hasGridIn={questions.some((q) => q.answerType === 'grid-in')}
        skillSet={skillSet}
        short={secIdx === 0 && modIdx === 0 ? session.practice?.short || [] : []}
        timingMode={timingMode}
        onExit={onExit}
        onStart={beginModule}
      />
    );
  }

  return (
    <>
      {proctorWarn && (
        <button type="button" onClick={() => setProctorWarn(false)}
          className="fixed top-3 left-1/2 z-60 inline-flex -translate-x-1/2 items-center gap-2 rounded-full bg-destructive px-4 py-2 text-sm font-medium text-white shadow-lg">
          <LuTriangleAlert className="size-4" />
          Stay on the exam tab - switching away is recorded ({focusLosses})
        </button>
      )}
      <TestView
        section={section}
        mod={mod}
        questions={questions}
        qIdx={qIdx}
        setQIdx={setQIdx}
        answers={answers}
        marked={marked}
        crossed={crossed}
        onAnswer={setAnswer}
        onMark={toggleMark}
        onCross={toggleCross}
        isMath={isMath}
        timeLeft={timeLeft}
        untimed={untimed}
        error={error}
        onSubmit={submitModule}
      />
    </>
  );
}

const Centered = ({ children }) => (
  <div className="flex min-h-svh flex-col items-center justify-center px-4">{children}</div>
);

/** Where a practice set came up short, in one sentence. */
function shortNote(short) {
  if (!short.length) return null;
  const parts = short.map((x) => (x.skill
    ? `${x.skill} (${x.have} of ${x.want})`
    : `${x.section} Module ${x.module} (${x.have} of ${x.want})`));
  return `Fewer questions than usual are available for ${parts.join(', ')}, so this set is shorter.`;
}

function ModuleIntro({ examTitle, section, modIdx, sectionIdx, totalSections, count, hasGridIn, skillSet, short, timingMode, onStart, onExit }) {
  const first = modIdx === 0;
  const adaptive = section.modules[modIdx]?.adaptive;
  // Only an adaptive second module is chosen by how the first one went.
  const nextAdaptive = Boolean(section.modules[modIdx + 1]?.adaptive);
  const limit = section.modules[modIdx]?.timeLimitSec || section.timeLimitSec;
  const time = (timingMode === 'untimed' || !limit) ? 'Untimed' : formatTime(limit);
  // A skill set is one run of questions per section, not a test in modules.
  const where = skillSet
    ? (totalSections > 1 ? ` · Part ${sectionIdx + 1} of ${totalSections}` : '')
    : ` · Section ${sectionIdx + 1} of ${totalSections} · Module ${modIdx + 1}`;
  const note = shortNote(short);
  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-8">
      <Card className="w-full max-w-lg animate-in gap-6 px-6 py-8 animation-duration-500 fade-in-0 slide-in-from-bottom-2 sm:px-8">
        <div className="space-y-2">
          <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{examTitle}{where}</div>
          <h1 className="text-3xl font-semibold tracking-tight">{section.name}</h1>
          <p className="leading-relaxed text-muted-foreground">
            {first
              ? (nextAdaptive
                  ? `You'll answer ${count} questions. Your performance on this module determines the difficulty of the next.`
                  : `You'll answer ${count} questions.`)
              : adaptive
                ? 'This is the adaptive module - its difficulty was set by how you did on Module 1.'
                : `This is the second module of this section - ${count} questions.`}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-3">
          <Stat label="Questions" value={count} />
          <Stat label="Time" value={time} />
          <Stat label="Tools" value={section.kind === 'math' ? 'Calculator · Reference' : 'Mark · Eliminate'} />
          <Stat label="Format" value={hasGridIn ? 'Choice & grid-in' : 'Multiple choice'} />
        </dl>
        {note && (
          <Alert className="border-amber-200 bg-amber-50 text-amber-800">
            <LuTriangleAlert />
            <AlertDescription className="text-amber-800">{note}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="lg" className="px-4" onClick={onStart}>
            {skillSet ? 'Start' : `Start Module ${modIdx + 1}`}
            <LuArrowRight data-icon="inline-end" />
          </Button>
          {sectionIdx === 0 && modIdx === 0 && (
            <Button size="lg" variant="ghost" className="px-4" onClick={onExit}>Back to dashboard</Button>
          )}
        </div>
      </Card>
    </div>
  );
}

const Stat = ({ label, value }) => (
  <div className="rounded-lg border bg-muted/40 px-4 py-3">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="mt-1 font-medium">{value}</dd>
  </div>
);

function BreakScreen({ onContinue, demo }) {
  const [secs, setSecs] = useState(demo ? 20 : 10 * 60);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Centered>
      <div className="max-w-md animate-in text-center animation-duration-500 fade-in-0 slide-in-from-bottom-2">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full border bg-muted/50">
          <LuCoffee className="size-5" />
        </div>
        <h1 className="mt-5 text-3xl font-semibold tracking-tight">Break time</h1>
        <p className="mt-2 leading-relaxed text-muted-foreground">
          Rest your eyes and stretch. Continue to the Math section when you&apos;re ready.
        </p>
        <div className="my-8 font-mono text-5xl font-medium tabular-nums">{formatTime(secs)}</div>
        <Button size="lg" className="px-4" onClick={onContinue}>Continue <LuArrowRight data-icon="inline-end" /></Button>
      </div>
    </Centered>
  );
}

function TestView({ section, mod, questions, qIdx, setQIdx, answers, marked, crossed, onAnswer, onMark, onCross, isMath, timeLeft, untimed, error, onSubmit }) {
  const [showCalc, setShowCalc] = useState(false);
  const [showRef, setShowRef] = useState(false);
  const [showNav, setShowNav] = useState(false);
  const [crossMode, setCrossMode] = useState(false);
  useEffect(() => setCrossMode(false), [qIdx]);

  const q = questions[qIdx];
  const isLast = qIdx === questions.length - 1;
  const isAnsweredQ = (qq) => { const a = answers[qq.qid]; return a !== undefined && a !== ''; };
  const answeredCount = questions.filter(isAnsweredQ).length;
  const userAnswer = answers[q.qid];
  const userCrossed = crossed[q.qid] || [];
  const lowTime = !untimed && timeLeft <= 60 && timeLeft > 0;

  const choose = (i) => (crossMode ? onCross(q.qid, i) : onAnswer(q.qid, i));

  // On a desktop the header and footer stay put and each pane scrolls on its
  // own, as on test day; on a phone the panes stack and the page scrolls.
  return (
    <div className="flex h-svh flex-col max-sm:h-auto max-sm:min-h-svh">
      <header className="flex min-h-14 shrink-0 items-center gap-4 border-b px-4 max-sm:flex-wrap max-sm:gap-y-2 max-sm:py-2 sm:px-6">
        <div className="text-sm font-medium">
          {section.name}<span className="mx-2 text-muted-foreground/50">·</span>Module {mod.ordinal}
        </div>
        <div className="flex-1" />
        {!untimed && (
          <div className={cn(
            'rounded-md border px-3 py-0.5 font-mono text-lg font-medium tabular-nums',
            lowTime && 'border-destructive/40 bg-destructive/5 text-destructive',
          )}>
            {formatTime(timeLeft)}
          </div>
        )}
        {isMath && (
          <div className="flex gap-1">
            <ToolButton icon={LuCalculator} label="Calculator" active={showCalc} onClick={() => { setShowCalc((v) => !v); setShowRef(false); }} />
            <ToolButton icon={LuBookOpen} label="Reference" active={showRef} onClick={() => { setShowRef((v) => !v); setShowCalc(false); }} />
          </div>
        )}
      </header>

      <div className="relative flex min-h-0 flex-1 overflow-hidden max-sm:flex-col max-sm:overflow-visible">
        {showCalc && <ToolWindow title="Calculator" onClose={() => setShowCalc(false)}><MathCalculator /></ToolWindow>}
        {showRef && <ToolWindow title="Reference sheet" onClose={() => setShowRef(false)}><Reference /></ToolWindow>}

        {!isMath && (
          <div className="pa-exam-passage scrollbar-thin min-w-0 flex-1 overflow-y-auto border-r px-6 py-8 lg:px-10 max-sm:flex-none max-sm:overflow-visible max-sm:border-r-0 max-sm:border-b max-sm:px-5 max-sm:py-6">
            <Passage q={q} />
          </div>
        )}
        <div className={cn(
          'pa-exam-question scrollbar-thin min-w-0 flex-1 overflow-y-auto px-6 py-8 lg:px-10 max-sm:flex-none max-sm:overflow-visible max-sm:px-5 max-sm:py-6',
          isMath && 'mx-auto w-full max-w-3xl',
        )}>
          <QuestionView
            q={q} number={qIdx + 1} isMath={isMath}
            isMarked={!!marked[q.qid]} onMark={() => onMark(q.qid)}
            crossMode={crossMode} setCrossMode={setCrossMode}
            userAnswer={userAnswer} userCrossed={userCrossed} onChoice={choose}
            onGrid={(v) => onAnswer(q.qid, v)}
          />
        </div>
      </div>

      <footer className="flex min-h-14 shrink-0 items-center gap-3 border-t bg-background px-4 max-sm:sticky max-sm:bottom-0 max-sm:z-10 max-sm:flex-wrap max-sm:py-2 sm:px-6">
        <div className="flex-1 text-sm text-muted-foreground max-sm:basis-full">
          {error
            ? <span className="text-destructive">{error}</span>
            : <><span className="font-medium text-foreground tabular-nums">{answeredCount}</span> of {questions.length} answered</>}
        </div>
        <Popover open={showNav} onOpenChange={setShowNav}>
          <PopoverTrigger asChild>
            <Button variant={showNav ? 'default' : 'outline'} size="sm" className="px-3">
              <LuLayoutGrid data-icon="inline-start" /> Question {qIdx + 1} of {questions.length}
            </Button>
          </PopoverTrigger>
          <PopoverContent side="top" sideOffset={10} collisionPadding={16} className="w-[min(27rem,calc(100vw-2rem))] gap-3 p-4">
            <Navigator questions={questions} answers={answers} marked={marked} currentIdx={qIdx}
              onJump={(i) => { setQIdx(i); setShowNav(false); }} />
          </PopoverContent>
        </Popover>
        <div className="flex flex-1 justify-end gap-2">
          <Button variant="outline" size="sm" disabled={qIdx === 0} onClick={() => setQIdx((i) => Math.max(0, i - 1))}>
            <LuChevronLeft data-icon="inline-start" /> Back
          </Button>
          {isLast
            ? <Button size="sm" onClick={onSubmit}><LuCheck data-icon="inline-start" /> Submit module</Button>
            : <Button size="sm" onClick={() => setQIdx((i) => Math.min(questions.length - 1, i + 1))}>Next <LuChevronRight data-icon="inline-end" /></Button>}
        </div>
      </footer>
    </div>
  );
}

const ToolButton = ({ icon: Icon, label, active, onClick }) => (
  <Button variant="ghost" onClick={onClick} aria-pressed={active}
    className={cn('h-auto flex-col gap-0.5 px-3 py-1.5 text-xs', active && 'bg-muted')}>
    <Icon className="size-4.5" />{label}
  </Button>
);

// How far a tool window can move each way and stay inside the test area (on a
// phone, the screen), as far from its edges as it opens (top-4 right-4).
const GUTTER = 16;
function roomFor(win) {
  const box = win.firstElementChild.getBoundingClientRect();
  const area = win.offsetParent?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  return {
    x: [area.left + GUTTER - box.left, area.right - GUTTER - box.right],
    y: [area.top + GUTTER - box.top, area.bottom - GUTTER - box.bottom],
  };
}
const clamp = (v, [lo, hi]) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * A tool floated over the test: a title bar with its close button, then the
 * tool. Dragged by its title bar, as on the real test, it moves off whatever
 * it covers; a resize that leaves it outside the area brings it back in.
 */
function ToolWindow({ title, children, onClose }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const [offset, setOffset] = useState([0, 0]);

  useEffect(() => {
    const fit = () => {
      if (!ref.current || drag.current) return;
      const room = roomFor(ref.current);
      const dx = clamp(0, room.x);
      const dy = clamp(0, room.y);
      if (dx || dy) setOffset(([x, y]) => [x + dx, y + dy]);
    };
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  const grab = (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    drag.current = { x: e.clientX, y: e.clientY, from: offset, room: roomFor(ref.current) };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    setOffset([d.from[0] + clamp(e.clientX - d.x, d.room.x), d.from[1] + clamp(e.clientY - d.y, d.room.y)]);
  };
  const drop = () => { drag.current = null; };

  return (
    <div ref={ref} style={{ translate: `${offset[0]}px ${offset[1]}px` }}
      className="absolute top-4 right-4 z-30 animate-in animation-duration-200 fade-in-0 slide-in-from-top-1 max-sm:fixed max-sm:inset-x-4 max-sm:top-24 max-sm:flex max-sm:justify-center">
      <div className="overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg">
        <div onPointerDown={grab} onPointerMove={move} onPointerUp={drop} onPointerCancel={drop}
          className="flex cursor-grab touch-none items-center justify-between gap-3 border-b py-1.5 pr-1.5 pl-3.5 select-none active:cursor-grabbing">
          <span className="text-sm font-medium">{title}</span>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}><LuX /></Button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Passage({ q }) {
  if (!q.passage && !q.assetId) {
    return <p className="text-sm text-muted-foreground italic">No passage for this question.</p>;
  }
  return (
    <div>
      <div className="mb-4 text-xs font-medium tracking-wide text-muted-foreground uppercase">Passage</div>
      {q.assetId && <img src={assetUrl(q.assetId)} alt="" className="mb-5 block max-h-90 max-w-full rounded-lg border" />}
      {q.passage && <div className="font-serif text-[17px] leading-[1.7]"><MathText text={q.passage} /></div>}
    </div>
  );
}

const pill = 'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors';

function QuestionView({ q, number, isMath, isMarked, onMark, crossMode, setCrossMode, userAnswer, userCrossed, onChoice, onGrid }) {
  const isGrid = q.answerType === 'grid-in';
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-2.5 border-b pb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground tabular-nums">{number}</div>
          <button type="button" onClick={onMark} aria-pressed={isMarked}
            className={cn(pill, isMarked ? 'border-amber-300 bg-amber-50 text-amber-700' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
            <LuFlag className={cn('size-3.5', isMarked && 'fill-current')} />{isMarked ? 'Marked' : 'Mark for review'}
          </button>
        </div>
        {!isGrid && (
          <button type="button" onClick={() => setCrossMode((v) => !v)} title="Cross out choices you've ruled out" aria-pressed={crossMode}
            className={cn(pill, crossMode ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
            <span className="font-semibold line-through">ABC</span>{crossMode ? 'On' : 'Off'}
          </button>
        )}
      </div>

      {isMath && q.assetId && <img src={assetUrl(q.assetId)} alt="" className="mb-5 block max-h-80 max-w-full rounded-lg border" />}

      <div className={cn('mb-6 leading-relaxed', isMath ? 'font-serif text-[17px]' : 'text-[15px] font-medium')}>
        <MathText text={q.question} />
      </div>

      {isGrid ? (
        <div className="space-y-2.5">
          <Input
            type="text"
            value={typeof userAnswer === 'string' ? userAnswer : ''}
            onChange={(e) => onGrid(e.target.value)}
            placeholder="Your answer"
            aria-label="Your answer"
            className="h-12 w-56 font-mono text-xl md:text-xl"
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Student-produced response - type a number. Fractions (e.g. <span className="font-mono">3/4</span>) and
            decimals (e.g. <span className="font-mono">.75</span>) are both accepted.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {q.choices.map((c, i) => {
            const selected = userAnswer === i;
            const isCrossed = userCrossed.includes(i);
            return (
              <button key={i} type="button" onClick={() => onChoice(i)} aria-pressed={selected}
                className={cn(
                  'flex items-start gap-3.5 rounded-lg border px-4 py-3.5 text-left text-[15px] transition-colors',
                  selected ? 'border-primary bg-muted/50 ring-1 ring-primary' : 'hover:border-foreground/30 hover:bg-muted/30',
                  isCrossed && 'text-muted-foreground',
                )}>
                <span className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full border text-sm font-semibold transition-colors',
                  selected ? 'border-primary bg-primary text-primary-foreground' : isCrossed ? 'border-muted-foreground/40 line-through' : 'border-foreground/60',
                )}>{LETTERS[i]}</span>
                <span className={cn('flex-1 pt-0.5 leading-relaxed', isCrossed && 'line-through opacity-60')}><MathText text={String(c)} /></span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Navigator({ questions, answers, marked, currentIdx, onJump }) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium">Question navigator</div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm border border-foreground/25 bg-muted" />Answered</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-amber-500" />Marked</span>
        </div>
      </div>
      <div className="grid grid-cols-10 gap-1.5">
        {questions.map((q, i) => {
          const current = i === currentIdx;
          const av = answers[q.qid];
          const answered = av !== undefined && av !== '';
          return (
            <button key={q.qid} type="button" onClick={() => onJump(i)} aria-current={current ? 'step' : undefined}
              className={cn(
                'relative aspect-square rounded-md border text-xs font-medium tabular-nums transition-colors',
                current ? 'border-primary bg-primary text-primary-foreground'
                  : answered ? 'border-foreground/25 bg-muted hover:bg-muted/60'
                    : 'border-dashed border-foreground/25 text-muted-foreground hover:bg-muted/50',
              )}>
              {i + 1}
              {marked[q.qid] && <span className="absolute -top-1 -right-1 size-2.5 rounded-full border-2 border-popover bg-amber-500" />}
            </button>
          );
        })}
      </div>
    </>
  );
}
