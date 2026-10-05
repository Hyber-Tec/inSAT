// Superadmin console (platform owner): provision institutions/academies and
// their first admin. Each institution is fully isolated - its admin then
// invites their own students and manages their own bank, exams, and groups.

import React, { useState, useEffect, useCallback } from 'react';
import {
  LuBuilding2, LuEllipsis, LuGraduationCap, LuKeyRound, LuPlus, LuPower, LuRepeat, LuRotateCcw, LuSearch,
  LuTrash2, LuUserPlus, LuUsers,
} from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '../api.js';
import { ChoiceCards, ConfirmDialog, EmptyState, ErrorNote, HomeLink, Loading, SectionHeading, StatusBadge, Wordmark } from '../ui.jsx';
import { scrollToTop } from '../nav.js';
import { UserMenu } from '../account.jsx';
import { ResultBanner } from '../admin/shared.jsx';

export default function SuperAdminApp() {
  const [institutions, setInstitutions] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [addAdminFor, setAddAdminFor] = useState(null);
  const [manageFor, setManageFor] = useState(null);
  const [studentsFor, setStudentsFor] = useState(null);
  const [deleting, setDeleting] = useState(null); // institution pending delete confirmation
  const [switching, setSwitching] = useState(null); // institution pending a mode change
  const [banner, setBanner] = useState(null); // { email, password, institution }

  const load = useCallback(async () => {
    setError(null);
    try {
      const { institutions } = await api.get('/api/super/institutions');
      setInstitutions(institutions);
    } catch (err) { setError(err.message); setInstitutions([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onDelete = async (inst) => {
    await api.del(`/api/super/institutions/${inst.id}`);
    load();
  };

  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <HomeLink onHome={scrollToTop}><Wordmark /></HomeLink>
            <Separator orientation="vertical" className="h-5" />
            <span className="text-sm text-muted-foreground">Platform</span>
          </div>
          <UserMenu />
        </div>
      </header>

      <main className="mx-auto max-w-6xl animate-in space-y-6 px-4 py-8 animation-duration-300 fade-in-0 sm:px-6 sm:py-10">
        <SectionHeading
          as="h1"
          eyebrow="Tenants"
          title="Institutions"
          actions={<Button onClick={() => setCreating(true)}><LuPlus data-icon="inline-start" /> New institution</Button>}
        />

        <ErrorNote>{error}</ErrorNote>
        {banner && (
          <ResultBanner tone="success" onDismiss={() => setBanner(null)}>
            <div className="mb-1 flex items-center gap-1.5 font-medium"><LuKeyRound className="size-4" /> {banner.institution} is ready</div>
            <div className="text-foreground/80">
              Share these admin credentials: <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs">{banner.email}</code> / <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs">{banner.password}</code>
            </div>
          </ResultBanner>
        )}

        {institutions === null ? (
          <Loading />
        ) : institutions.length === 0 ? (
          <EmptyState icon={LuBuilding2} title="No institutions yet" hint="Create your first academy and invite its admin." />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {institutions.map((i) => (
              <Card key={i.id} className="gap-5 px-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <h3 className="truncate font-semibold tracking-tight">{i.name}</h3>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="outline">{(MODES[i.mode] || MODES.self_guided).title}</Badge>
                      {i.holdsPool && <Badge variant="outline">Question pool</Badge>}
                      <Badge variant="secondary" className="font-mono">{i.slug}</Badge>
                    </div>
                  </div>
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`More for ${i.name}`} className="-mt-1 -mr-1 text-muted-foreground"><LuEllipsis /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-60">
                      <DropdownMenuItem onSelect={() => setSwitching(i)}>
                        <LuRepeat /> Make {i.mode === 'managed' ? 'self-guided' : 'institution-managed'}
                      </DropdownMenuItem>
                      {/* insat's own institution holds the question pool every institution uses. */}
                      {!i.holdsPool && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(i)}><LuTrash2 /> Delete institution</DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="grid grid-cols-4 divide-x rounded-lg border">
                  <CountStat n={i.adminCount} label="Admins" />
                  <CountStat n={i.studentCount} label="Students" />
                  <CountStat n={i.itemCount} label="Questions" />
                  <CountStat n={i.examCount} label="Tests" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" size="sm" onClick={() => setAddAdminFor(i)}><LuUserPlus /> Add admin</Button>
                  <Button variant="outline" size="sm" onClick={() => setManageFor(i)} disabled={!i.adminCount}><LuUsers /> Admins</Button>
                  <Button variant="outline" size="sm" className="col-span-2" onClick={() => setStudentsFor(i)} disabled={!i.studentCount}><LuGraduationCap /> Students</Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </main>

      {creating && (
        <CreateInstitutionModal
          onClose={() => setCreating(false)}
          onCreated={(res) => {
            setCreating(false);
            if (res.admin) setBanner({ email: res.admin.email, password: res.password, institution: res.institution.name });
            load();
          }}
        />
      )}
      {addAdminFor && (
        <AddAdminModal
          institution={addAdminFor}
          onClose={() => setAddAdminFor(null)}
          onAdded={(res) => { setAddAdminFor(null); setBanner({ email: res.admin.email, password: res.password, institution: addAdminFor.name }); load(); }}
        />
      )}
      {manageFor && (
        <ManageAdminsModal
          institution={manageFor}
          onClose={() => setManageFor(null)}
          onChanged={load}
          onReset={(email, password) => setBanner({ email, password, institution: manageFor.name })}
        />
      )}
      {studentsFor && (
        <ManageStudentsModal
          institution={studentsFor}
          onClose={() => setStudentsFor(null)}
          onChanged={load}
        />
      )}
      {switching && (
        <ConfirmDialog
          title={switching.mode === 'managed' ? `Make ${switching.name} self-guided?` : `Make ${switching.name} institution-managed?`}
          body={switching.mode === 'managed'
            ? 'Its students practice on their own again. Its groups, tests and assignments are kept, out of use, until it is managed again.'
            : 'Its admins get groups, tests and assignments, and its students do assigned work only: they can no longer start practice themselves. Nothing is deleted, and you can switch back.'}
          confirmLabel={switching.mode === 'managed' ? 'Make self-guided' : 'Make managed'}
          onCancel={() => setSwitching(null)}
          onConfirm={async () => {
            await api.patch(`/api/super/institutions/${switching.id}`, { mode: switching.mode === 'managed' ? 'self_guided' : 'managed' });
            setSwitching(null);
            load();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          body="This permanently deletes the institution and ALL of its admins, students, bank items, exams, and results. This cannot be undone."
          confirmLabel="Delete institution"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={async () => { await onDelete(deleting); setDeleting(null); }}
        />
      )}
    </div>
  );
}

const CountStat = ({ n, label }) => (
  <div className="px-1 py-2.5 text-center">
    <div className="font-mono text-lg leading-none font-semibold tabular-nums">{n}</div>
    <div className="mt-1 text-[11px] text-muted-foreground">{label}</div>
  </div>
);

/** A person in a list, with icon actions on the right. */
function PersonRow({ person, actions }) {
  return (
    <div className={cn('flex items-center gap-3 px-4 py-3', !person.active && 'opacity-60')}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {person.displayName} {!person.active && <StatusBadge tone="warning">Deactivated</StatusBadge>}
        </div>
        <div className="truncate text-xs text-muted-foreground">{person.email}</div>
      </div>
      <div className="flex shrink-0 gap-1">{actions}</div>
    </div>
  );
}

const IconAction = ({ children, title, onClick, disabled, className }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button variant="ghost" size="icon-sm" aria-label={title} onClick={onClick} disabled={disabled} className={className}>{children}</Button>
    </TooltipTrigger>
    <TooltipContent>{title}</TooltipContent>
  </Tooltip>
);

const danger = 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive';

function ListDialog({ title, description, onClose, children }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// View, search, deactivate/reactivate, or delete an institution's students.
function ManageStudentsModal({ institution, onClose, onChanged }) {
  const [students, setStudents] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [removing, setRemoving] = useState(null); // student pending delete confirmation
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  // Debounce the search box so we don't hit the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = query ? `?search=${encodeURIComponent(query)}` : '';
      const { students } = await api.get(`/api/super/institutions/${institution.id}/students${qs}`);
      setStudents(students);
    } catch (err) { setError(err.message); setStudents([]); }
  }, [institution.id, query]);
  useEffect(() => { load(); }, [load]);

  const toggleActive = async (s) => {
    setBusyId(s.id); setError(null);
    try { await api.patch(`/api/super/institutions/${institution.id}/students/${s.id}`, { active: !s.active }); await load(); onChanged?.(); }
    catch (err) { setError(err.message); } finally { setBusyId(null); }
  };
  const remove = async (s) => {
    setBusyId(s.id);
    try { await api.del(`/api/super/institutions/${institution.id}/students/${s.id}`); await load(); onChanged?.(); }
    finally { setBusyId(null); }
  };

  return (
    <ListDialog title="Students" description={`for ${institution.name}`} onClose={onClose}>
      <div className="relative">
        <LuSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or email…" className="pl-9" aria-label="Search students" />
      </div>
      <ErrorNote>{error}</ErrorNote>
      {students === null ? (
        <Loading className="py-8" />
      ) : students.length === 0 ? (
        <EmptyState title={query ? 'No matches' : 'No students'} hint={query ? 'Try a different name or email.' : 'This institution has no students yet.'} className="p-8" />
      ) : (
        <div className="scrollbar-thin max-h-96 divide-y overflow-y-auto rounded-lg border">
          {students.map((s) => (
            <PersonRow key={s.id} person={s} actions={(
              <>
                <IconAction title={s.active ? 'Deactivate' : 'Reactivate'} onClick={() => toggleActive(s)} disabled={busyId === s.id}
                  className={s.active ? 'text-amber-700' : 'text-emerald-700'}><LuPower /></IconAction>
                <IconAction title="Delete student" onClick={() => setRemoving(s)} disabled={busyId === s.id} className={danger}><LuTrash2 /></IconAction>
              </>
            )} />
          ))}
        </div>
      )}
      {removing && (
        <ConfirmDialog
          title={`Delete ${removing.displayName || removing.email}?`}
          body={`This permanently removes their account and results from ${institution.name}. This cannot be undone.`}
          confirmLabel="Delete student"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={async () => { await remove(removing); setRemoving(null); }}
        />
      )}
    </ListDialog>
  );
}

// View, deactivate/reactivate, reset-password, or remove an institution's admins.
function ManageAdminsModal({ institution, onClose, onChanged, onReset }) {
  const [admins, setAdmins] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [resetFor, setResetFor] = useState(null);   // admin pending password reset
  const [removeFor, setRemoveFor] = useState(null); // admin pending removal confirmation

  const load = useCallback(async () => {
    setError(null);
    try { const { admins } = await api.get(`/api/super/institutions/${institution.id}/admins`); setAdmins(admins); }
    catch (err) { setError(err.message); setAdmins([]); }
  }, [institution.id]);
  useEffect(() => { load(); }, [load]);

  const patch = async (a, body, after) => {
    setBusyId(a.id); setError(null);
    try { const r = await api.patch(`/api/super/institutions/${institution.id}/admins/${a.id}`, body); after?.(r); await load(); onChanged?.(); }
    catch (err) { setError(err.message); throw err; } finally { setBusyId(null); }
  };
  const toggleActive = (a) => patch(a, { active: !a.active }).catch(() => {});
  const remove = async (a) => {
    setBusyId(a.id);
    try { await api.del(`/api/super/institutions/${institution.id}/admins/${a.id}`); await load(); onChanged?.(); }
    finally { setBusyId(null); }
  };

  return (
    <ListDialog title="Admins" description={`for ${institution.name}`} onClose={onClose}>
      <ErrorNote>{error}</ErrorNote>
      {admins === null ? (
        <Loading className="py-8" />
      ) : admins.length === 0 ? (
        <EmptyState title="No admins" hint="Add an admin to give this academy access." className="p-8" />
      ) : (
        <div className="divide-y rounded-lg border">
          {admins.map((a) => (
            <PersonRow key={a.id} person={a} actions={(
              <>
                <IconAction title="Reset password" onClick={() => setResetFor(a)} disabled={busyId === a.id}><LuRotateCcw /></IconAction>
                <IconAction title={a.active ? 'Deactivate' : 'Reactivate'} onClick={() => toggleActive(a)} disabled={busyId === a.id}
                  className={a.active ? 'text-amber-700' : 'text-emerald-700'}><LuPower /></IconAction>
                <IconAction title="Remove admin" onClick={() => setRemoveFor(a)} disabled={busyId === a.id} className={danger}><LuTrash2 /></IconAction>
              </>
            )} />
          ))}
        </div>
      )}
      {resetFor && (
        <ResetPasswordModal
          admin={resetFor}
          onClose={() => setResetFor(null)}
          onSubmit={async (pw) => {
            await patch(resetFor, { password: pw }, () => onReset?.(resetFor.email, pw));
            setResetFor(null);
          }}
        />
      )}
      {removeFor && (
        <ConfirmDialog
          title={`Remove ${removeFor.displayName || removeFor.email}?`}
          body={`They lose access to ${institution.name} immediately. Students and data are kept.`}
          confirmLabel="Remove admin"
          danger
          onCancel={() => setRemoveFor(null)}
          onConfirm={async () => { await remove(removeFor); setRemoveFor(null); }}
        />
      )}
    </ListDialog>
  );
}

function Field({ id, label, ...props }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
    </div>
  );
}

/** A form in a dialog that cannot be closed while it is saving. */
function FormDialog({ title, description, busy, onClose, onSubmit, children, submitLabel, busyLabel, canSubmit, className }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className={cn('sm:max-w-md', className)}>
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {children}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || !canSubmit}>
              {busy && <Spinner />}
              {busy ? busyLabel : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Styled replacement for the old window.prompt password reset: a small form
// with validation, matching the create/add-admin dialogs.
function ResetPasswordModal({ admin, onClose, onSubmit }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await onSubmit(pw); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <FormDialog title="Reset password" description={`for ${admin.email}`} busy={busy} onClose={onClose} onSubmit={submit}
      submitLabel="Reset password" busyLabel="Resetting…" canSubmit={pw.length >= 6}>
      <Field id="admin-reset-password" label="New temporary password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} placeholder="At least 6 characters" />
      <p className="-mt-2 text-xs leading-relaxed text-muted-foreground">
        Share it with them directly - it will also be shown on the dashboard after the reset.
      </p>
      <ErrorNote>{error}</ErrorNote>
    </FormDialog>
  );
}

// How an institution runs (server/lib/modes.js).
const MODES = {
  self_guided: {
    title: 'Self-guided',
    description: 'Students practice on their own: a diagnostic test, a map of their skills, and practice sets built from their weakest.',
  },
  managed: {
    title: 'Institution-managed',
    description: 'Admins assign tests and practice topics and follow each student\'s results. Students do what is assigned to them.',
  },
};
const MODE_OPTIONS = Object.entries(MODES).map(([value, m]) => ({ value, ...m }));

function CreateInstitutionModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState('self_guided');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api.post('/api/super/institutions', { name, mode, adminName, adminEmail, adminPassword });
      onCreated({ ...res, password: adminPassword });
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <FormDialog title="New institution" description="Creates the academy, the way it runs, and its first admin."
      busy={busy} onClose={onClose} onSubmit={submit} submitLabel="Create institution" busyLabel="Creating…"
      canSubmit={name && adminEmail && adminPassword.length >= 6}>
      <Field id="inst-name" label="Institution name" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="e.g. GA Prep Academy" />
      <div className="grid gap-2">
        <Label>How it runs</Label>
        <ChoiceCards label="How it runs" options={MODE_OPTIONS} value={mode} onChange={setMode} />
      </div>
      <Separator />
      <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">First admin</div>
      <Field id="inst-admin-name" label="Admin name" value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Full name" />
      <Field id="inst-admin-email" label="Admin email" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="admin@academy.edu" />
      <Field id="inst-admin-password" label="Temporary password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="At least 6 characters" />
      <ErrorNote>{error}</ErrorNote>
    </FormDialog>
  );
}

function AddAdminModal({ institution, onClose, onAdded }) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api.post(`/api/super/institutions/${institution.id}/admins`, { displayName, email, password });
      onAdded({ ...res, password });
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <FormDialog title="Add admin" description={`to ${institution.name}`} busy={busy} onClose={onClose} onSubmit={submit}
      submitLabel="Add admin" busyLabel="Adding…" canSubmit={email && password.length >= 6}>
      <Field id="add-admin-name" label="Admin name" value={displayName} autoFocus onChange={(e) => setDisplayName(e.target.value)} placeholder="Full name" />
      <Field id="add-admin-email" label="Admin email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@academy.edu" />
      <Field id="add-admin-password" label="Temporary password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" />
      <ErrorNote>{error}</ErrorNote>
    </FormDialog>
  );
}
