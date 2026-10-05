// Assignments panel (managed academies) - everything given out: tests, and
// practice topics assigned from a student's page, one section per group and
// one for work given to students directly, with how many have finished. Hiding
// an assignment keeps it off those students' dashboards (the test and its
// other assignments are untouched).

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { LuCalendarClock, LuEye, LuEyeOff, LuFileText, LuSend, LuTarget, LuTrash2, LuUser, LuUsers } from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '../api.js';
import { EmptyState, ErrorNote, Loading, StatusBadge } from '../ui.jsx';
import { ResultBanner, SectionHead, fmtDate, useConfirm } from './shared.jsx';
import { AssignDialog, assignedNote } from './assign.jsx';

function Row({ a, direct, onHidden, onRemove }) {
  const practice = a.kind === 'practice';
  const Icon = practice ? LuTarget : LuFileText;
  const done = a.completedCount >= a.targetSize;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5', a.hidden && 'bg-muted/30')}>
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/50">
        <Icon className="size-4" />
      </div>
      <div className="min-w-48 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('font-medium', a.hidden && 'text-muted-foreground')}>{a.title}</span>
          <Badge variant="secondary">{practice ? 'Practice' : 'Test'}</Badge>
          {a.hidden && <StatusBadge tone="neutral">Hidden from students</StatusBadge>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {direct && <span className="inline-flex items-center gap-1"><LuUser className="size-3.5" />{a.targetName}</span>}
          <span className={cn(done && 'text-emerald-700')}>
            {direct ? (done ? 'Done' : 'Not done yet') : `${a.completedCount} of ${a.targetSize} done`}
          </span>
          {a.dueAt && <span className="inline-flex items-center gap-1"><LuCalendarClock className="size-3.5" />Due {fmtDate(a.dueAt)}</span>}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={() => onHidden(a)}>
          {a.hidden ? <LuEye /> : <LuEyeOff />} {a.hidden ? 'Show' : 'Hide'}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              aria-label={`Remove ${a.title} from ${a.targetName}`} onClick={() => onRemove(a)}>
              <LuTrash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove assignment</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function Section({ icon: Icon, title, items, direct = false, onHidden, onRemove }) {
  const hidden = items.filter((a) => a.hidden).length;
  return (
    <section>
      <div className="flex flex-wrap items-center gap-2 px-1 pb-2">
        <Icon className="size-4" />
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{items.length} {items.length === 1 ? 'assignment' : 'assignments'}{hidden ? `, ${hidden} hidden` : ''}</span>
      </div>
      <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
        {items.map((a) => <Row key={a.id} a={a} direct={direct} onHidden={onHidden} onRemove={onRemove} />)}
      </div>
    </section>
  );
}

export default function Assignments() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [banner, setBanner] = useState(null);
  const [assigning, setAssigning] = useState(false);
  const [confirmNode, askConfirm] = useConfirm();

  const load = useCallback(async () => {
    setError(null);
    try {
      const { assignments } = await api.get('/api/admin/assignments');
      setItems(assignments || []);
    } catch (err) {
      setError(err.message || 'Could not load the assignments');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleHidden = async (a) => {
    setError(null);
    try {
      const { assignment } = await api.patch(`/api/admin/assignments/${a.id}`, { hidden: !a.hidden });
      setItems((prev) => prev.map((x) => (x.id === a.id ? { ...x, hidden: assignment.hidden } : x)));
    } catch (err) { setError(err.message || 'Could not update the assignment'); }
  };

  const remove = (a) => askConfirm({
    title: 'Remove assignment?',
    message: `"${a.title}" comes off ${a.targetType === 'group' ? `the ${a.targetName} group's` : `${a.targetName}'s`} dashboard. Attempts already made, and their scores, stay.`,
    confirmLabel: 'Remove',
    tone: 'danger',
    onConfirm: async () => {
      await api.del(`/api/admin/assignments/${a.id}`);
      setItems((prev) => prev.filter((x) => x.id !== a.id));
    },
  });

  const { groups, direct } = useMemo(() => {
    const byGroup = new Map();
    const loose = [];
    for (const a of items) {
      if (a.targetType !== 'group') { loose.push(a); continue; }
      if (!byGroup.has(a.targetId)) byGroup.set(a.targetId, { id: a.targetId, name: a.targetName || 'Group', items: [] });
      byGroup.get(a.targetId).items.push(a);
    }
    return { groups: [...byGroup.values()].sort((x, y) => x.name.localeCompare(y.name)), direct: loose };
  }, [items]);

  return (
    <div>
      <SectionHead
        eyebrow="Coursework"
        title="Assignments"
        sub="Every test and practice set you have given out, by group and by student. Hide one to keep it off their dashboards until you are ready."
        right={<Button onClick={() => setAssigning(true)}><LuSend data-icon="inline-start" /> Assign a test</Button>}
      />
      <ErrorNote className="mb-5">{error}</ErrorNote>
      {banner && <div className="mb-5"><ResultBanner onDismiss={() => setBanner(null)}>{banner}</ResultBanner></div>}

      {loading ? <Loading /> : items.length === 0 ? (
        <EmptyState icon={LuSend} title="Nothing assigned yet" hint="Assign a test to students or a group. Practice topics are assigned from a student's page." />
      ) : (
        <div className="space-y-7">
          {groups.map((g) => <Section key={g.id} icon={LuUsers} title={g.name} items={g.items} onHidden={toggleHidden} onRemove={remove} />)}
          {direct.length > 0 && <Section icon={LuUser} title="Given to students directly" items={direct} direct onHidden={toggleHidden} onRemove={remove} />}
        </div>
      )}

      {assigning && (
        <AssignDialog onClose={() => setAssigning(false)}
          onDone={(result) => { setAssigning(false); setBanner(assignedNote('the test', result)); load(); }} />
      )}
      {confirmNode}
    </div>
  );
}
