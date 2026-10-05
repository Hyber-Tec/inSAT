// Groups panel (managed academies) - student groups, so a test or practice
// can be given to a whole group at once. List, create and edit groups, and
// open one to add students (searchable, any number at once) or remove them.

import React, { useState, useEffect, useCallback } from 'react';
import { LuArrowLeft, LuPencil, LuPlus, LuTrash2, LuUserMinus, LuUserPlus, LuUsers } from 'react-icons/lu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '../api.js';
import { EmptyState, ErrorNote, Loading } from '../ui.jsx';
import { Field, FormDialog, SectionHead, initialsOf, useConfirm } from './shared.jsx';
import { PeoplePicker } from './assign.jsx';

/** Create a group, or edit one's name and description. */
function GroupDialog({ group = null, onClose, onSaved }) {
  const [form, setForm] = useState({ name: group?.name || '', description: group?.description || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = { name: form.name.trim(), description: form.description.trim() };
      if (group) await api.patch(`/api/admin/groups/${group.id}`, body);
      else await api.post('/api/admin/groups', body);
      onSaved();
    } catch (err) {
      setError(err.message || 'Could not save the group');
      setBusy(false);
    }
  };

  return (
    <FormDialog
      busy={busy}
      onClose={onClose}
      onSubmit={submit}
      title={group ? 'Edit group' : 'New group'}
      description={group
        ? 'Change the name or description. Members and what is assigned to the group stay.'
        : 'Group students together to give them tests and practice at once.'}
      footer={(
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy || !form.name.trim()}>
            {busy && <Spinner />}
            {busy ? 'Saving…' : group ? 'Save changes' : 'Create group'}
          </Button>
        </>
      )}
    >
      <Field id="group-name" label="Name" value={form.name} onChange={set('name')} placeholder="Fall SAT class" autoFocus required />
      <div className="grid gap-2">
        <Label htmlFor="group-description">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
        <Textarea id="group-description" value={form.description} onChange={set('description')} rows={3} placeholder="Who is in this group and why" />
      </div>
      <ErrorNote>{error}</ErrorNote>
    </FormDialog>
  );
}

function Members({ group, onBack, onChanged }) {
  const [members, setMembers] = useState(null);
  const [students, setStudents] = useState([]);
  const [picked, setPicked] = useState([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);
  const [confirmNode, askConfirm] = useConfirm();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [{ members: m }, { users }] = await Promise.all([
        api.get(`/api/admin/groups/${group.id}/members`),
        api.get('/api/admin/users'),
      ]);
      setMembers(m || []);
      setStudents(users || []);
    } catch (err) {
      setError(err.message || 'Could not load the members');
      setMembers((m) => m || []);
    }
  }, [group.id]);

  useEffect(() => { load(); }, [load]);

  const inGroup = new Set((members || []).map((m) => m.id));
  const candidates = students.filter((s) => !inGroup.has(s.id));

  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      await api.post(`/api/admin/groups/${group.id}/members`, { userIds: picked });
      setPicked([]);
      await load();
      onChanged();
    } catch (err) {
      setError(err.message || 'Could not add them');
    } finally {
      setAdding(false);
    }
  };

  const remove = (m) => askConfirm({
    title: 'Remove from group?',
    message: `${m.displayName} leaves ${group.name}. Their account stays, and so do the attempts they already made.`,
    confirmLabel: 'Remove',
    tone: 'danger',
    onConfirm: async () => {
      await api.del(`/api/admin/groups/${group.id}/members/${m.id}`);
      setMembers((prev) => prev.filter((x) => x.id !== m.id));
      onChanged();
    },
  });

  return (
    <div>
      <Button variant="ghost" size="sm" className="mb-4 -ml-2.5 text-muted-foreground" onClick={onBack}>
        <LuArrowLeft /> All groups
      </Button>
      <SectionHead eyebrow="Group" title={group.name} sub={group.description || 'Add students to this group, or remove them.'} />
      <ErrorNote className="mb-5">{error}</ErrorNote>

      {members === null ? <Loading /> : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <section className="space-y-3">
            <div className="text-sm text-muted-foreground">{members.length} {members.length === 1 ? 'member' : 'members'}</div>
            {members.length === 0 ? (
              <EmptyState icon={LuUsers} title="No members yet" hint="Add students from the list to build this group." />
            ) : (
              <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
                {members.map((m) => (
                  <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                    <Avatar className="size-9"><AvatarFallback className="text-xs font-medium">{initialsOf(m.displayName, m.email)}</AvatarFallback></Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{m.displayName}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground">{m.email}</div>
                    </div>
                    <Button variant="ghost" size="sm" className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={() => remove(m)}>
                      <LuUserMinus /> Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <Card>
            <CardHeader>
              <CardTitle>Add students</CardTitle>
              <CardDescription>{candidates.length ? 'Search, tick any number, and add them at once.' : 'Every student is already in this group.'}</CardDescription>
            </CardHeader>
            {candidates.length > 0 && (
              <CardContent className="grid gap-3">
                <PeoplePicker students={candidates} users={picked} onUsers={setPicked} hint="Tick the students to add" />
                <Button onClick={add} disabled={!picked.length || adding}>
                  {adding ? <Spinner /> : <LuUserPlus data-icon="inline-start" />}
                  {adding ? 'Adding…' : picked.length ? `Add ${picked.length} ${picked.length === 1 ? 'student' : 'students'}` : 'Add students'}
                </Button>
              </CardContent>
            )}
          </Card>
        </div>
      )}
      {confirmNode}
    </div>
  );
}

export default function Groups() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // a group, or {} for a new one
  const [open, setOpen] = useState(null);
  const [confirmNode, askConfirm] = useConfirm();

  const load = useCallback(async () => {
    setError(null);
    try {
      const { groups: list } = await api.get('/api/admin/groups');
      setGroups(list || []);
    } catch (err) {
      setError(err.message || 'Could not load the groups');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const remove = (g) => askConfirm({
    title: 'Delete group?',
    message: `${g.name} is removed, with what was assigned to it. Its students keep their accounts and their attempts.`,
    confirmLabel: 'Delete group',
    tone: 'danger',
    onConfirm: async () => {
      await api.del(`/api/admin/groups/${g.id}`);
      setGroups((prev) => prev.filter((x) => x.id !== g.id));
    },
  });

  if (open) {
    return <Members group={open} onBack={() => { setOpen(null); load(); }} onChanged={load} />;
  }

  return (
    <div>
      <SectionHead
        eyebrow="Classes"
        title="Groups"
        sub="Group students so you can give a test or practice to all of them at once."
        right={<Button onClick={() => setEditing({})}><LuPlus data-icon="inline-start" /> New group</Button>}
      />
      <ErrorNote className="mb-5">{error}</ErrorNote>

      {loading ? <Loading /> : groups.length === 0 ? (
        <EmptyState icon={LuUsers} title="No groups yet" hint="Create a group to give tests and practice to several students at once." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <Card key={g.id} className="gap-4">
              <CardHeader>
                <CardTitle className="truncate">{g.name}</CardTitle>
                <CardDescription className="line-clamp-2 min-h-10">{g.description || 'No description'}</CardDescription>
                <CardAction className="flex items-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Edit ${g.name}`} onClick={() => setEditing(g)}><LuPencil /></Button>
                    </TooltipTrigger>
                    <TooltipContent>Edit group</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={`Delete ${g.name}`} onClick={() => remove(g)}><LuTrash2 /></Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete group</TooltipContent>
                  </Tooltip>
                </CardAction>
              </CardHeader>
              <CardFooter className="justify-between">
                <Badge variant="secondary">{g.memberCount} {g.memberCount === 1 ? 'member' : 'members'}</Badge>
                <Button variant="outline" size="sm" onClick={() => setOpen(g)}><LuUsers /> Members</Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <GroupDialog group={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
      {confirmNode}
    </div>
  );
}
