// Public landing page - the front door at "/". Marketing surface only: it
// explains what insat is and sends people to /sign-up or /sign-in. Everything it
// claims is backed by the real product (blueprints.js structure, scoring.js
// ranges, the locked-down exam app), so keep copy and code in step.

import React, { useEffect, useState } from 'react';
import {
  LuArrowRight, LuBookOpen, LuCalculator, LuFlag, LuGauge, LuLayers, LuShieldCheck, LuSigma,
} from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { HomeLink, Wordmark } from './ui.jsx';
import { ROUTES, linkProps } from './nav.js';

const WRAP = 'mx-auto w-full max-w-6xl px-4 sm:px-6';

// --- Header -----------------------------------------------------------------

function Header() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={cn(
      'fixed inset-x-0 top-0 z-50 border-b transition-colors duration-200',
      scrolled ? 'border-border bg-background/80 backdrop-blur-md' : 'border-transparent',
    )}>
      <div className={cn(WRAP, 'flex h-16 items-center gap-8')}>
        <HomeLink><Wordmark /></HomeLink>
        <nav className="hidden items-center gap-6 text-sm text-muted-foreground sm:flex">
          <a href="#inside" className="transition-colors hover:text-foreground">What&apos;s inside</a>
          <a href="#how" className="transition-colors hover:text-foreground">How it works</a>
        </nav>
        <Button asChild className="ml-auto px-3.5">
          <a {...linkProps(ROUTES.signIn)}>Sign in</a>
        </Button>
      </div>
    </header>
  );
}

// --- Hero product preview ---------------------------------------------------

const CHOICES = [
  { letter: 'A', text: 'obscure' },
  { letter: 'B', text: 'illuminate' },
  { letter: 'C', text: 'predate' },
  { letter: 'D', text: 'complicate' },
];
const SELECTED = 'B';

/** The runner's chrome in miniature, mirroring student/ExamRunner.jsx. */
function ExamPreview() {
  return (
    <div className="relative animate-in fade-in-0 slide-in-from-bottom-4 animation-duration-700">
      <Card className="gap-0 py-0 shadow-xl shadow-foreground/5">
        <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-3 text-xs">
          <span className="font-medium text-muted-foreground">Reading and Writing · Module 2</span>
          <span className="font-mono font-medium tabular-nums">16:12</span>
        </div>
        <div className="p-5">
          <div className="mb-3 flex items-center text-xs">
            <span className="font-medium text-muted-foreground">Question 14 of 27</span>
            <span className="ml-auto inline-flex items-center gap-1.5 font-medium text-amber-700">
              <LuFlag className="size-3 fill-current" /> Marked
            </span>
          </div>
          <p className="mb-4 font-serif text-[15px] leading-relaxed">
            The curators contend that the poet&apos;s letters, long dismissed as mere ephemera, in fact ______ the
            preoccupations that animate her published work.
          </p>
          <div className="grid gap-2">
            {CHOICES.map((c) => {
              const on = c.letter === SELECTED;
              return (
                <div key={c.letter} className={cn(
                  'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm',
                  on && 'border-primary bg-muted/40 ring-1 ring-primary',
                )}>
                  <span className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                    on ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground',
                  )}>{c.letter}</span>
                  {c.text}
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      {/* The payoff of finishing, floated off the card's corner. */}
      <Card className="absolute -right-6 -bottom-16 hidden gap-1 px-4 py-3 shadow-lg lg:flex">
        <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Total score</div>
        <div className="font-mono text-2xl font-semibold tabular-nums">1480</div>
        <div className="text-xs text-muted-foreground">RW 740 · Math 740</div>
      </Card>
    </div>
  );
}

// --- Content data -----------------------------------------------------------

const FEATURES = [
  {
    icon: LuLayers,
    title: 'Built to the real structure',
    body: 'Two Reading and Writing modules of 27 questions in 32 minutes, then two Math modules of 22 in 35. Ninety-eight questions, sectioned and timed the way test day is.',
  },
  {
    icon: LuSigma,
    title: 'A second module that adapts',
    body: 'How you do on Module 1 decides whether Module 2 routes to the easier or harder form - the same branching the digital SAT uses, with scoring that accounts for the route you took.',
  },
  {
    icon: LuGauge,
    title: 'Scored the moment you finish',
    body: 'Section scores from 200 to 800 and a 400-1600 total, plus a question-by-question review showing your answer, the correct one, and why it is correct.',
  },
];

const STEPS = [
  {
    n: '01',
    title: 'Start with a diagnostic',
    body: 'Create a free account, or sign in with the one your academy made for you, and take a full practice test, or one section, on the real clock.',
  },
  {
    n: '02',
    title: 'See exactly where you stand',
    body: 'Scaled scores, then a map of all 29 College Board skills: which are strong, which are building, and which need focus.',
  },
  {
    n: '03',
    title: 'Practice what you missed',
    body: 'Sets built from your weakest skills, at a difficulty that fits how you are doing, with an explanation for every answer. Retest whenever you want to see the needle move.',
  },
];

const TOOLS = [
  { icon: LuCalculator, label: 'Graphing calculator' },
  { icon: LuBookOpen, label: 'Reference sheet' },
  { icon: LuFlag, label: 'Mark for review' },
  { icon: LuShieldCheck, label: 'Original questions' },
];

const STATS = [['98', 'questions'], ['400-1600', 'scaled score'], ['4', 'timed modules']];

function SectionIntro({ eyebrow, title, body }) {
  return (
    <div className="max-w-2xl">
      <div className="text-sm font-medium text-muted-foreground">{eyebrow}</div>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h2>
      {body && <p className="mt-4 text-base leading-relaxed text-muted-foreground text-pretty">{body}</p>}
    </div>
  );
}

// --- Page -------------------------------------------------------------------

export default function Landing() {
  return (
    <div className="min-h-svh">
      <Header />

      {/* ---------- Hero ---------- */}
      <section className="relative overflow-hidden">
        {/* A faint grid that fades out below the fold: depth without color. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_75%_65%_at_50%_0%,black,transparent)]" />
        <div className={cn(WRAP, 'relative grid items-center gap-16 pt-32 pb-24 lg:grid-cols-[1.05fr_0.95fr] lg:pt-40 lg:pb-32')}>
          <div className="animate-in fade-in-0 slide-in-from-bottom-2 animation-duration-500">
            <Badge variant="outline" className="h-6 rounded-full bg-background px-3 text-muted-foreground">SAT · AP · GPA</Badge>
            <h1 className="mt-6 text-4xl font-semibold tracking-tighter text-balance sm:text-5xl lg:text-6xl">
              Practice that feels like the real test.
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-muted-foreground text-pretty">
              Adaptive, College-Board-structured digital SAT practice that scores the moment
              you finish, shows you your weak skills, and builds your next set from them.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" asChild className="px-5">
                <a {...linkProps(ROUTES.signUp)}>Get started <LuArrowRight /></a>
              </Button>
              <Button size="lg" variant="outline" asChild className="px-5">
                <a {...linkProps(ROUTES.signIn)}>Sign in</a>
              </Button>
            </div>
            <div className="mt-10 flex flex-wrap gap-x-10 gap-y-4">
              {STATS.map(([value, label]) => (
                <div key={label}>
                  <div className="font-mono text-lg font-medium tabular-nums">{value}</div>
                  <div className="text-xs text-muted-foreground">{label}</div>
                </div>
              ))}
            </div>
          </div>
          <ExamPreview />
        </div>
      </section>

      {/* ---------- What's inside ---------- */}
      <section id="inside" className="scroll-mt-16 border-t py-20 sm:py-28">
        <div className={WRAP}>
          <SectionIntro
            eyebrow="What's inside"
            title="Every detail matched to the digital SAT."
            body="Not a question dump. A full exam engine that reproduces the structure, the timing, the adaptive routing, and the scoring."
          />
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <Card key={title} className="gap-5 px-6 transition-shadow hover:shadow-md">
                <div className="flex size-10 items-center justify-center rounded-lg border bg-muted/50">
                  <Icon className="size-5" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-base font-semibold tracking-tight">{title}</h3>
                  <p className="leading-relaxed text-muted-foreground">{body}</p>
                </div>
              </Card>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border bg-muted/40 px-6 py-4 text-sm">
            <span className="text-xs font-semibold tracking-wide uppercase">Test-day tools</span>
            {TOOLS.map(({ icon: Icon, label }) => (
              <span key={label} className="inline-flex items-center gap-2 text-muted-foreground">
                <Icon className="size-4 text-foreground" />{label}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- How it works ---------- */}
      <section id="how" className="scroll-mt-16 pb-20 sm:pb-28">
        <div className={WRAP}>
          <SectionIntro eyebrow="How it works" title="Diagnose, practice, retest." />
          <ol className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
            {STEPS.map(({ n, title, body }) => (
              <li key={n} className="border-t pt-6">
                <div className="font-mono text-sm text-muted-foreground">{n}</div>
                <h3 className="mt-3 text-base font-semibold tracking-tight">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---------- Closing call ---------- */}
      <section className="px-4 pb-20 sm:px-6 sm:pb-28">
        <div className="mx-auto max-w-6xl rounded-2xl bg-primary px-6 py-16 text-center text-primary-foreground sm:py-20">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Ready when you are.</h2>
          <p className="mt-4 text-primary-foreground/70">Create a free account, or sign in with the one your academy made for you.</p>
          <Button size="lg" variant="secondary" asChild className="mt-8 px-5">
            <a {...linkProps(ROUTES.signUp)}>Get started <LuArrowRight /></a>
          </Button>
        </div>
      </section>

      {/* ---------- Footer ---------- */}
      <footer className="border-t">
        <div className={cn(WRAP, 'flex flex-wrap items-center gap-x-6 gap-y-3 py-8')}>
          <HomeLink><Wordmark size="sm" /></HomeLink>
          <span className="ml-auto text-xs text-muted-foreground">Not affiliated with the College Board.</span>
          <a {...linkProps(ROUTES.signUp)} className="text-xs text-muted-foreground transition-colors hover:text-foreground">Sign up</a>
          <a {...linkProps(ROUTES.signIn)} className="text-xs text-muted-foreground transition-colors hover:text-foreground">Sign in</a>
        </div>
      </footer>
    </div>
  );
}
