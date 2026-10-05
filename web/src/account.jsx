// The signed-in person's corner, the same in every role's app: their avatar
// opens a menu with who they are, account settings and sign out. Account
// settings shows the account and changes its password, which also clears the
// "must reset" an admin can set.

import React, { useState } from 'react';
import { LuChevronsUpDown, LuCircleCheck, LuLogOut, LuSettings } from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { api } from './api.js';
import { useAuth } from './auth.jsx';
import { ErrorNote } from './ui.jsx';

const initialsOf = (user) => (user?.displayName || user?.email || '?')
  .split(/\s+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join('').toUpperCase();

const UserAvatar = ({ user }) => (
  <Avatar className="size-8"><AvatarFallback className="text-xs font-medium">{initialsOf(user)}</AvatarFallback></Avatar>
);

/** Name over email. */
const Who = ({ user, className }) => (
  <span className={cn('grid min-w-0 text-left leading-tight', className)}>
    <span className="truncate text-sm font-medium">{user?.displayName || 'Your account'}</span>
    <span className="truncate text-xs text-muted-foreground">{user?.email}</span>
  </span>
);

/**
 * The account menu: a round avatar for a header, or (`variant="sidebar"`) the
 * avatar with name and email across a sidebar's foot, opening beside it.
 */
export function UserMenu({ variant = 'avatar' }) {
  const { user, logout } = useAuth();
  const [settings, setSettings] = useState(false);
  const sidebar = variant === 'sidebar';
  return (
    <>
      {/* Not modal: a modal menu handing focus to the settings dialog it opens
          can leave the page unclickable. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          {sidebar ? (
            <button type="button" className="flex w-full items-center gap-2.5 rounded-md p-1.5 outline-none hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-sidebar-accent">
              <UserAvatar user={user} />
              <Who user={user} className="flex-1" />
              <LuChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </button>
          ) : (
            <button type="button" aria-label="Account menu" className="rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <UserAvatar user={user} />
            </button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent side={sidebar ? 'right' : 'bottom'} align="end" className="w-60">
          <DropdownMenuLabel className="flex items-center gap-2.5 font-normal text-foreground">
            <UserAvatar user={user} />
            <Who user={user} />
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSettings(true)}><LuSettings /> Account settings</DropdownMenuItem>
          <DropdownMenuItem onSelect={logout}><LuLogOut /> Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {settings && <AccountSettings user={user} onClose={() => setSettings(false)} />}
    </>
  );
}

/** The account, and a new password for it. */
function AccountSettings({ user, onClose }) {
  const [current, setCurrent] = useState('');
  const [fresh, setFresh] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [changed, setChanged] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    if (fresh !== repeat) { setError('The new passwords do not match.'); return; }
    setBusy(true); setError(null); setChanged(false);
    try {
      await api.post('/api/auth/change-password', { currentPassword: current, newPassword: fresh });
      setCurrent(''); setFresh(''); setRepeat('');
      setChanged(true);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Account settings</DialogTitle>
          <DialogDescription>Signed in as {user?.email}</DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 rounded-lg border bg-muted/40 px-4 py-3 text-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd className="truncate font-medium">{user?.displayName || '-'}</dd>
          <dt className="text-muted-foreground">Email</dt>
          <dd className="truncate">{user?.email}</dd>
          {user?.institutionName && (
            <>
              <dt className="text-muted-foreground">Academy</dt>
              <dd className="truncate">{user.institutionName}</dd>
            </>
          )}
        </dl>

        <form onSubmit={save} className="grid gap-4">
          <div className="text-sm font-medium">Change password</div>
          <div className="grid gap-2">
            <Label htmlFor="current-password">Current password</Label>
            <Input id="current-password" type="password" value={current} autoComplete="current-password" required
              onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-password">New password</Label>
            <Input id="new-password" type="password" value={fresh} autoComplete="new-password" required minLength={6}
              onChange={(e) => setFresh(e.target.value)} placeholder="At least 6 characters" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="repeat-password">Confirm new password</Label>
            <Input id="repeat-password" type="password" value={repeat} autoComplete="new-password" required
              onChange={(e) => setRepeat(e.target.value)} />
          </div>
          <ErrorNote>{error}</ErrorNote>
          {changed && (
            <p className="flex items-center gap-1.5 text-sm text-emerald-700"><LuCircleCheck className="size-4" /> Your password was changed.</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Close</Button>
            <Button type="submit" disabled={busy || !current || fresh.length < 6 || !repeat}>
              {busy && <Spinner />} Change password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
