// Admin shell for insat: a quiet sidebar and the active panel (on a phone,
// a top bar with the sections in a row). A self-guided academy's admin creates
// student accounts and watches their progress; the studying itself is the
// student's own (see student/Practice.jsx). A managed academy's admin also
// keeps groups and tests, assigns them, and follows each student on their own
// page. A single useState drives the active panel; each panel is imported
// directly.

import React, { useState, useEffect } from 'react';
import { LuChartColumn, LuFileText, LuLayers, LuSend, LuSettings, LuUsers } from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { HomeLink, Wordmark } from '../ui.jsx';
import { UserMenu } from '../account.jsx';
import { assetUrl } from '../api.js';
import { scrollToTop } from '../nav.js';
import { useAuth } from '../auth.jsx';

import Students from './Students.jsx';
import Groups from './Groups.jsx';
import Tests from './Tests.jsx';
import Assignments from './Assignments.jsx';
import Results from './Results.jsx';
import Settings from './Settings.jsx';

const SECTIONS = {
  students: { label: 'Students', icon: LuUsers, Panel: Students },
  groups: { label: 'Groups', icon: LuLayers, Panel: Groups },
  tests: { label: 'Tests', icon: LuFileText, Panel: Tests },
  assignments: { label: 'Assignments', icon: LuSend, Panel: Assignments },
  results: { label: 'Progress', icon: LuChartColumn, Panel: Results },
  settings: { label: 'Settings', icon: LuSettings, Panel: Settings },
};
const NAV_BY_MODE = {
  self_guided: ['students', 'results', 'settings'],
  managed: ['students', 'groups', 'tests', 'assignments', 'results', 'settings'],
};

function NavItem({ item, active, onClick }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium whitespace-nowrap transition-colors',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground',
      )}
    >
      <Icon className="size-4" />
      {item.label}
    </button>
  );
}

export default function AdminApp() {
  const { user } = useAuth();
  const brand = user?.branding?.logoAssetId
    ? { logoSrc: assetUrl(user.branding.logoAssetId), name: user.institutionName }
    : null;
  const mode = user?.institutionMode === 'managed' ? 'managed' : 'self_guided';
  const NAV = NAV_BY_MODE[mode].map((id) => ({ id, ...SECTIONS[id] }));
  // Remember which console section the admin was on across reloads (per account).
  const sectionKey = `pa-admin-section:${user?.id || user?.email || 'default'}`;
  const [activeId, setActiveId] = useState(() => {
    try {
      const saved = localStorage.getItem(sectionKey);
      if (saved && NAV.some((n) => n.id === saved)) return saved;
    } catch { /* localStorage unavailable - fall back to default */ }
    return 'students';
  });
  // The student whose page is open (managed academies), within Students.
  const [studentId, setStudentId] = useState(null);
  // Choosing a section in the menu opens it afresh, even the one already open
  // (from a custom test's page, Tests goes back to the list of tests).
  const [visit, setVisit] = useState(0);
  useEffect(() => {
    try { localStorage.setItem(sectionKey, activeId); } catch { /* ignore */ }
  }, [sectionKey, activeId]);
  const active = NAV.find((n) => n.id === activeId) || NAV[0];
  const go = (id) => { setActiveId(id); setStudentId(null); setVisit((n) => n + 1); window.scrollTo(0, 0); };
  const openStudent = (id) => { setActiveId('students'); setStudentId(id); window.scrollTo(0, 0); };
  // The logo leads to the first section, or back up it when already there.
  const goHome = () => {
    if (active.id === NAV[0].id && !studentId) scrollToTop();
    else go(NAV[0].id);
  };
  const Panel = active.Panel;

  return (
    <div className="flex min-h-svh max-md:flex-col">
      <aside className="flex shrink-0 flex-col border-b bg-sidebar text-sidebar-foreground select-none md:sticky md:top-0 md:h-svh md:w-60 md:border-r md:border-b-0">
        <div className="flex h-14 items-center justify-between gap-3 px-4 md:border-b">
          <HomeLink label={brand?.name} onHome={goHome}><Wordmark brand={brand} /></HomeLink>
          <div className="md:hidden"><UserMenu /></div>
        </div>

        <nav aria-label="Admin sections" className="flex gap-1 overflow-x-auto px-3 pb-2 md:flex-1 md:flex-col md:overflow-visible md:py-4">
          <div className="px-2.5 pb-1.5 text-xs font-medium text-muted-foreground max-md:hidden">Console</div>
          {NAV.map((item) => (
            <NavItem key={item.id} item={item} active={item.id === active.id} onClick={() => go(item.id)} />
          ))}
        </nav>

        <div className="border-t p-2 max-md:hidden">
          <UserMenu variant="sidebar" />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 hidden h-14 items-center border-b bg-background/80 px-6 backdrop-blur-md md:flex lg:px-8">
          <div className="truncate text-sm text-muted-foreground">
            {user?.institutionName || 'insat'}
            <span className="mx-2 text-muted-foreground/50">/</span>
            <span className="font-medium text-foreground">{active.label}</span>
          </div>
        </header>
        <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
          <div key={`${active.id}:${studentId || ''}:${visit}`} className="mx-auto max-w-5xl animate-in animation-duration-300 fade-in-0">
            <Panel mode={mode} studentId={studentId} onOpenStudent={mode === 'managed' ? openStudent : null}
              onCloseStudent={() => setStudentId(null)} onGo={go} />
          </div>
        </main>
      </div>
    </div>
  );
}
