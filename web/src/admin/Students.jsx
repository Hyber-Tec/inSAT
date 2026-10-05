// Students panel - roster of student accounts. Create accounts (admin sets an
// initial password and is shown it once), reset passwords, toggle active, delete.
// In a managed academy each student opens their own page (StudentPage.jsx).

import React, { useState, useEffect, useCallback } from 'react';
import { LuCheck, LuChevronRight, LuCopy, LuKeyRound, LuPower, LuTrash2, LuUserPlus, LuUsers } from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia } from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '../api.js';
import { EmptyState, ErrorNote, Loading, StatusBadge } from '../ui.jsx';
import { Field, FormDialog, SectionHead, ResultBanner, initialsOf, useConfirm } from './shared.jsx';
import StudentPage from './StudentPage.jsx';

function AddStudentModal({ onClose, onCreated }) {
  const [mode, setMode] = useState('invite'); // 'invite' | 'password'
  const [form, setForm] = useState({ displayName: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = { email: form.email.trim(), displayName: form.displayName.trim() };
      if (mode === 'password') body.password = form.password;
      const created = await api.post('/api/admin/users', body);
      onCreated({ ...created, mode, password: form.password });
    } catch (err) {
      setError(err.message || 'Could not create the student');
      setBusy(false);
    }
  };

  return (
    <FormDialog
      busy={busy}
      onClose={onClose}
      onSubmit={submit}
      title="Add a student"
      description="Invite by email (they set their own password) or set a starting password yourself."
      footer={(
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner /> : <LuUserPlus data-icon="inline-start" />}
            {busy ? 'Creating…' : (mode === 'invite' ? 'Create & invite' : 'Create student')}
          </Button>
        </>
      )}
    >
      <Tabs value={mode} onValueChange={setMode}>
        <TabsList className="w-full">
          <TabsTrigger value="invite">Send invite</TabsTrigger>
          <TabsTrigger value="password">Set password</TabsTrigger>
        </TabsList>
      </Tabs>
      <Field id="student-name" label="Full name" value={form.displayName} onChange={set('displayName')} placeholder="Sam Rivera" autoFocus required />
      <Field id="student-email" label="Email" type="email" value={form.email} onChange={set('email')} placeholder="sam@school.edu" required />
      {mode === 'password' && (
        <Field id="student-password" label="Initial password" value={form.password} onChange={set('password')} placeholder="At least 6 characters" required minLength={6} />
      )}
      <ErrorNote>{error}</ErrorNote>
    </FormDialog>
  );
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard unavailable */ }
  };
  return [copied, copy];
}

function InviteModal({ student, link, emailed, onClose }) {
  const [copied, copy] = useCopy();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite created</DialogTitle>
          <DialogDescription>
            {emailed ? `An invite email was sent to ${student.email}.` : 'Share this invite link - the student sets their own password.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <div className="text-xs text-muted-foreground">{student.displayName} · {student.email}</div>
          <div className="rounded-lg border bg-muted/50 px-3 py-2.5 font-mono text-xs break-all">{link}</div>
          {emailed && <div className="inline-flex items-center gap-1.5 text-xs text-emerald-700"><LuCheck className="size-3.5" /> Emailed to the student</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => copy(link)}>{copied ? <LuCheck /> : <LuCopy />}{copied ? 'Copied' : 'Copy link'}</Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CredentialModal({ student, password, onClose }) {
  const [copied, copy] = useCopy();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Account created</DialogTitle>
          <DialogDescription>Share these credentials with the student. The password is shown only now.</DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border bg-muted/50 p-4">
          <div className="mb-2 text-xs text-muted-foreground">{student.displayName}</div>
          <div className="font-mono text-sm break-all">{student.email}</div>
          <div className="mt-1 font-mono text-lg font-medium tracking-wide break-all">{password}</div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => copy(`${student.email} / ${password}`)}>{copied ? <LuCheck /> : <LuCopy />}{copied ? 'Copied' : 'Copy'}</Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordModal({ student, onClose, onDone }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.patch(`/api/admin/users/${student.id}`, { password });
      onDone(password);
    } catch (err) {
      setError(err.message || 'Could not reset the password');
      setBusy(false);
    }
  };

  return (
    <FormDialog
      busy={busy}
      onClose={onClose}
      onSubmit={submit}
      title="Reset password"
      description={`Set a new password for ${student.displayName}.`}
      footer={(
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner /> : <LuKeyRound data-icon="inline-start" />}
            {busy ? 'Saving…' : 'Reset password'}
          </Button>
        </>
      )}
    >
      <Field id="reset-password" label="New password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" autoFocus required minLength={6} />
      <ErrorNote>{error}</ErrorNote>
    </FormDialog>
  );
}

export default function Students({ mode = 'self_guided', studentId = null, onOpenStudent = null, onCloseStudent }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [credential, setCredential] = useState(null); // {student,password}
  const [invite, setInvite] = useState(null);          // {student,link,emailed}
  const [resetting, setResetting] = useState(null);    // student
  const [banner, setBanner] = useState(null);          // {tone,text}
  const [confirmNode, askConfirm] = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { users: list } = await api.get('/api/admin/users');
      setUsers(list || []);
    } catch (err) {
      setError(err.message || 'Could not load students');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleActive = async (student) => {
    try {
      await api.patch(`/api/admin/users/${student.id}`, { active: !student.active });
      setUsers((prev) => prev.map((u) => (u.id === student.id ? { ...u, active: !u.active } : u)));
    } catch (err) {
      setError(err.message || 'Could not update the student');
    }
  };

  const removeStudent = (student) => askConfirm({
    title: 'Delete student?',
    message: `This permanently removes ${student.displayName} and their account access. This cannot be undone.`,
    confirmLabel: 'Delete student',
    tone: 'danger',
    onConfirm: async () => {
      await api.del(`/api/admin/users/${student.id}`);
      setUsers((prev) => prev.filter((u) => u.id !== student.id));
    },
  });

  if (studentId) return <StudentPage studentId={studentId} onBack={() => { onCloseStudent(); load(); }} />;

  return (
    <div>
      <SectionHead
        eyebrow="Roster"
        title="Students"
        sub="Every student account on the platform. Create accounts, share initial credentials, and manage access."
        right={<Button onClick={() => setAdding(true)}><LuUserPlus data-icon="inline-start" /> Add student</Button>}
      />

      {error && <ErrorNote className="mb-5">{error}</ErrorNote>}
      {banner && <div className="mb-5"><ResultBanner tone={banner.tone} onDismiss={() => setBanner(null)}>{banner.text}</ResultBanner></div>}

      {loading ? (
        <Loading />
      ) : users.length === 0 ? (
        <EmptyState icon={LuUsers} title="No students yet"
          hint={mode === 'managed'
            ? 'Add a student and share the credentials, then give them tests and practice.'
            : 'Add a student and share the credentials; everything after that is self-guided.'} />
      ) : (
        <>
          <div className="mb-3 text-sm text-muted-foreground">
            {users.length} {users.length === 1 ? 'student' : 'students'}
          </div>
          <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {users.map((s) => (
              <Item key={s.id} className="rounded-none border-0 px-4 py-3">
                <ItemMedia>
                  <Avatar className="size-9">
                    <AvatarFallback className={cn('text-xs font-medium', !s.active && 'text-muted-foreground')}>{initialsOf(s.displayName, s.email)}</AvatarFallback>
                  </Avatar>
                </ItemMedia>
                <ItemContent className="min-w-48">
                  <div className="flex flex-wrap items-center gap-2 text-sm leading-snug font-medium">
                    {onOpenStudent ? (
                      <button type="button" onClick={() => onOpenStudent(s.id)}
                        className="rounded-sm text-left underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
                        {s.displayName}
                      </button>
                    ) : s.displayName}
                    {!s.active && <StatusBadge tone="danger">Inactive</StatusBadge>}
                    {s.mustChangePassword && <StatusBadge tone="warning">Must reset</StatusBadge>}
                  </div>
                  <ItemDescription className="truncate font-mono text-xs">{s.email}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  {onOpenStudent && <Button variant="outline" size="sm" onClick={() => onOpenStudent(s.id)}>View <LuChevronRight data-icon="inline-end" /></Button>}
                  <Button variant="outline" size="sm" onClick={() => setResetting(s)}><LuKeyRound /> Reset</Button>
                  <Button variant={s.active ? 'ghost' : 'outline'} size="sm" onClick={() => toggleActive(s)}>
                    <LuPower /> {s.active ? 'Deactivate' : 'Activate'}
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label="Delete" onClick={() => removeStudent(s)}>
                        <LuTrash2 />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete student</TooltipContent>
                  </Tooltip>
                </ItemActions>
              </Item>
            ))}
          </div>
        </>
      )}

      {adding && (
        <AddStudentModal
          onClose={() => setAdding(false)}
          onCreated={(created) => {
            setAdding(false);
            if (created.mode === 'password') setCredential({ student: created.user, password: created.password });
            else setInvite({ student: created.user, link: created.inviteLink, emailed: created.emailed });
            load();
          }}
        />
      )}
      {credential && (
        <CredentialModal student={credential.student} password={credential.password} onClose={() => setCredential(null)} />
      )}
      {invite && (
        <InviteModal student={invite.student} link={invite.link} emailed={invite.emailed} onClose={() => setInvite(null)} />
      )}
      {resetting && (
        <ResetPasswordModal
          student={resetting}
          onClose={() => setResetting(null)}
          onDone={(password) => {
            const student = resetting;
            setResetting(null);
            setCredential({ student, password });
            load();
          }}
        />
      )}
      {confirmNode}
    </div>
  );
}
