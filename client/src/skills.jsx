// The map of every College Board skill: accuracy and a mastery level for each,
// grouped by domain, one tab per section. A self-guided student picks skills
// from it to practise; a managed academy's admin picks a student's skills from
// it to assign as practice; a managed student sees their own map read-only.
// The profile comes from the server (lib/practice.js skillProfile), with what
// there is to practise in each skill.

import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Action, Meter, SectionHeading, StatusBadge } from './ui.jsx';

export const LEVELS = {
  focus: { label: 'Focus', tone: 'danger' },
  building: { label: 'Building', tone: 'warning' },
  strong: { label: 'Strong', tone: 'success' },
  untested: { label: 'Not tested', tone: 'neutral' },
};

export const SECTION_NAME = { rw: 'Reading and Writing', math: 'Math' };
const SECTIONS = [{ kind: 'rw', label: 'Reading and Writing' }, { kind: 'math', label: 'Math' }];

// The server allows up to this many skills in one practice set.
export const MAX_SKILLS = 8;

export const canPractise = (s) => s.ready > 0 || s.more;
/** Whether a set at one chosen difficulty could draw on this skill ('auto' is any). */
const availableAt = (s, level) => (level === 'auto' || !s.byDifficulty
  ? canPractise(s)
  : s.byDifficulty[level].ready > 0 || s.byDifficulty[level].more);

// Whose skills the map shows: the student's own, or a student's to an admin.
const WORDS = {
  you: {
    adaptive: 'Each skill at a difficulty that fits how you are doing in it',
    level: 'Set from how you are doing in each skill',
    pick: 'Pick skills from either section to build a practice set.',
  },
  student: {
    adaptive: 'Each skill at a difficulty that fits how the student is doing in it',
    level: 'Set from how the student is doing in each skill',
    pick: 'Pick skills from either section to assign as practice.',
  },
};

// Difficulty for a practice set. Adaptive sets each skill from the student's
// record in it (easier while it is weak, harder once it is strong).
const difficultyChoices = (words) => [
  ['auto', 'Adaptive', words.adaptive],
  ['easy', 'Easy'],
  ['medium', 'Medium'],
  ['hard', 'Hard'],
];

// `note` says why a skill cannot be picked, unless the whole section already
// said it once above the list. A read-only map has no checkboxes.
function SkillRow({ s, selected, full, note, level = 'auto', readOnly, onToggle }) {
  const available = availableAt(s, level);
  const disabled = readOnly || !available || (full && !selected);
  const lv = LEVELS[s.level] || LEVELS.untested;
  const pct = s.answered ? Math.round(s.mastery * 100) : 0;
  const Row = readOnly ? 'div' : 'label';
  return (
    <Row className={cn(
      'flex items-center gap-3 px-4 py-3 transition-colors',
      disabled ? 'cursor-default' : 'cursor-pointer hover:bg-muted/50',
      selected && 'bg-muted/60',
    )}>
      {!readOnly && <Checkbox checked={selected} disabled={disabled} onCheckedChange={() => onToggle(s.skill)} />}
      {/* On a narrow screen the numbers wrap under the name instead of squeezing it. */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-[1_1_15rem]">
          <div className={cn('text-sm font-medium', !readOnly && !available && 'text-muted-foreground')}>{s.skill}</div>
          {!readOnly && !available && note && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {level === 'auto' ? 'No questions available yet' : `No ${level} questions available yet`}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div title={s.answered ? `Estimated mastery ${pct}%` : 'Not tested yet'} className="w-20">
            <Meter value={pct} tone={lv.tone} />
          </div>
          <span className="w-11 text-right font-mono text-xs text-muted-foreground tabular-nums">
            {s.answered ? `${s.correct}/${s.answered}` : '-'}
          </span>
          <span className="flex w-22 justify-end"><StatusBadge tone={lv.tone}>{lv.label}</StatusBadge></span>
        </div>
      </div>
    </Row>
  );
}

function SkillList({ profile, section, level, picked, full, busy, words, readOnly, actionLabel, busyLabel, onToggle, onClear, onPractise, onLevel }) {
  const skills = profile.skills.filter((s) => s.section === section);
  const domains = [...new Set(skills.map((s) => s.domain))];
  const noneAvailable = !readOnly && !skills.some((s) => availableAt(s, level));
  return (
    <Card className="gap-0 py-0">
      {!readOnly && (
        <div role="group" aria-label="Difficulty" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/40 px-4 py-3">
          <span className="text-xs font-medium text-muted-foreground">Difficulty</span>
          <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={level} onValueChange={(v) => v && onLevel(v)}>
            {difficultyChoices(words).map(([value, label, hint]) => (
              <ToggleGroupItem key={value} value={value} title={hint} className="bg-background px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <span className="text-xs text-muted-foreground">
            {level === 'auto' ? words.level : `Only ${level} questions`}
          </span>
        </div>
      )}
      {noneAvailable && (
        <div className="border-b bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {level === 'auto' ? SECTION_NAME[section] : `No ${level} ${SECTION_NAME[section]}`} questions are available to practice yet.
        </div>
      )}
      {domains.map((domain, i) => {
        const rows = skills.filter((s) => s.domain === domain);
        const answered = rows.reduce((n, s) => n + s.answered, 0);
        const correct = rows.reduce((n, s) => n + s.correct, 0);
        return (
          <div key={domain} className={cn((i || noneAvailable) && 'border-t')}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 pt-4 pb-2">
              <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{rows[0].domainLabel}</div>
              <div className="text-xs whitespace-nowrap text-muted-foreground">
                {answered ? `${Math.round((100 * correct) / answered)}% correct · ${answered} answered` : 'Not tested yet'}
              </div>
            </div>
            <div className="divide-y border-t">
              {rows.map((s) => (
                <SkillRow key={s.skill} s={s} selected={picked.includes(s.skill)} full={full} note={!noneAvailable}
                  level={level} readOnly={readOnly} onToggle={onToggle} />
              ))}
            </div>
          </div>
        );
      })}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-3 border-t bg-muted/40 px-4 py-3">
          <p className="min-w-48 flex-1 text-sm text-muted-foreground">
            {picked.length
              ? `${picked.length} ${picked.length === 1 ? 'skill' : 'skills'} selected${full ? ` (up to ${MAX_SKILLS} per set)` : ''}${level === 'auto' ? '' : `, ${level} questions only`}`
              : words.pick}
          </p>
          {picked.length > 0 && <Button variant="ghost" size="sm" onClick={onClear}>Clear</Button>}
          <Action className="px-3" busy={busy === 'picked'} disabled={!picked.length || Boolean(busy)}
            onClick={() => onPractise(picked, 'picked', level === 'auto' ? null : level)}>
            {busy === 'picked' ? busyLabel : actionLabel}
          </Action>
        </div>
      )}
    </Card>
  );
}

/**
 * The skill map. `onPractise(skills, 'picked', difficulty)` runs the action on
 * the picked skills; `subject="student"` words it for an admin looking at a
 * student; `initialPicked` starts with skills ticked; `readOnly` shows the map
 * alone.
 */
export function SkillMap({
  profile, busy = null, onPractise, title = 'Your skills', subject = 'you', initialPicked = [],
  actionLabel = 'Practice selected', busyLabel = 'Preparing…', readOnly = false,
}) {
  // Open on the picked skills' section, else on the one answered most.
  const [tab, setTab] = useState(() => {
    const first = profile.skills.find((s) => initialPicked.includes(s.skill));
    if (first) return first.section;
    const answered = (kind) => profile.skills.filter((s) => s.section === kind).reduce((n, s) => n + s.answered, 0);
    return answered('math') > answered('rw') ? 'math' : 'rw';
  });
  const [picked, setPicked] = useState(() => initialPicked.slice(0, MAX_SKILLS));
  const [level, setLevel] = useState('auto');
  const words = WORDS[subject] || WORDS.you;
  const full = picked.length >= MAX_SKILLS;
  const toggle = (skill) => setPicked((p) => (p.includes(skill) ? p.filter((x) => x !== skill) : [...p, skill]));
  const chooseLevel = (next) => {
    setLevel(next);
    // A skill with nothing to serve at the new difficulty drops out of the selection.
    setPicked((p) => p.filter((name) => {
      const s = profile.skills.find((x) => x.skill === name);
      return s && availableAt(s, next);
    }));
  };

  return (
    <Tabs value={tab} onValueChange={setTab} className="gap-4">
      <SectionHeading
        title={title}
        actions={(
          <TabsList>
            {SECTIONS.map((sec) => <TabsTrigger key={sec.kind} value={sec.kind} className="px-3">{sec.label}</TabsTrigger>)}
          </TabsList>
        )}
      />
      {SECTIONS.map((sec) => (
        <TabsContent key={sec.kind} value={sec.kind}>
          <SkillList profile={profile} section={sec.kind} level={level} picked={picked} full={full} busy={busy}
            words={words} readOnly={readOnly} actionLabel={actionLabel} busyLabel={busyLabel}
            onToggle={toggle} onClear={() => setPicked([])} onPractise={onPractise} onLevel={chooseLevel} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
