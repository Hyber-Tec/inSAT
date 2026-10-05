// Student shell: the dashboard, the test runner and the results view. In a
// self-guided academy the dashboard is practice the student starts (a skill
// profile, full tests, sections and skill sets); in a managed one it is what
// the academy assigned (tests and practice topics). The dashboard and the
// results share a header whose logo leads back to the dashboard. Starting practice
// materializes a fresh, unique form on the server, which may take a moment
// while questions are prepared.

import React, { useState, useEffect, useCallback } from 'react';
import { LuRotateCcw } from 'react-icons/lu';
import { api, assetUrl } from '../api.js';
import { scrollToTop } from '../nav.js';
import { useAuth } from '../auth.jsx';
import { HomeLink, Wordmark, ErrorNote, Loading } from '../ui.jsx';
import { UserMenu } from '../account.jsx';
import { Button } from '@/components/ui/button';
import ExamRunner from './ExamRunner.jsx';
import Results from './Results.jsx';
import PracticeHome from './Practice.jsx';
import AssignedHome, { blockedByExamApp } from './Assigned.jsx';

export default function StudentApp() {
  const { user } = useAuth();
  const managed = user?.institutionMode === 'managed';
  const brand = user?.branding?.logoAssetId
    ? { logoSrc: assetUrl(user.branding.logoAssetId), name: user.institutionName }
    : null;
  const [view, setView] = useState('dashboard'); // dashboard | exam | results
  const [session, setSession] = useState(null);
  const [results, setResults] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [history, setHistory] = useState([]);
  const [assigned, setAssigned] = useState({ assignments: [], groups: [] });
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  // Which practice start is being prepared: a test mode, 'next' or 'picked'.
  const [starting, setStarting] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    const [p, h] = await Promise.allSettled([
      api.get('/api/student/profile'),
      managed ? api.get('/api/student/assignments') : api.get('/api/student/practice'),
    ]);
    // Self-guided, there is no dashboard without the profile: the skill map
    // and the test cards would only guess at what is available.
    setProfile(p.status === 'fulfilled' ? p.value : null);
    if (managed) setAssigned(h.status === 'fulfilled' ? h.value : { assignments: [], groups: [] });
    else setHistory(h.status === 'fulfilled' ? h.value.practice : []);
    const failed = [p, h].find((r) => r.status === 'rejected');
    if (failed) setError(failed.reason?.message || 'Could not load your dashboard.');
    setLoaded(true);
  }, [managed]);

  useEffect(() => { load(); }, [load]);

  const openSession = async (s) => {
    setError(null);
    if (s.status === 'completed') {
      const { results } = await api.get(`/api/student/sessions/${s.sessionId}/results`);
      setResults(results);
      setView('results');
    } else {
      setSession(s);
      setView('exam');
    }
  };

  const startPractice = async (body, key) => {
    setStarting(key);
    setError(null);
    try {
      await openSession(await api.post('/api/student/practice', body));
    } catch (err) {
      setError(err.message || 'Could not start practice.');
      if (view === 'dashboard') window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setStarting(null);
    }
  };

  // Runs fn on one item of the dashboard, which shows it is busy meanwhile.
  const busyWith = (keyOf, fn) => async (x) => {
    setBusyId(keyOf(x));
    setError(null);
    try {
      await fn(x);
    } catch (err) {
      setError(err.message);
      if (view === 'dashboard') window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setBusyId(null);
    }
  };
  const withSession = (fn) => busyWith((p) => p.sessionId, fn);
  const resumePractice = withSession(async (p) => openSession(await api.get(`/api/student/sessions/${p.sessionId}`)));
  const reviewPractice = withSession(async (p) => openSession({ sessionId: p.sessionId, status: 'completed' }));
  const discardPractice = withSession(async (p) => {
    await api.del(`/api/student/practice/${p.sessionId}`);
    await load();
  });
  // An assignment starts (or resumes) on the server; a finished one opens its review.
  const startAssignment = busyWith((a) => a.id, async (a) => {
    if (blockedByExamApp(a)) throw new Error('Tests are taken in the insat Exam app. Download it below and sign in there.');
    await openSession(await api.post(`/api/student/assignments/${a.id}/start`));
  });
  const reviewAssignment = busyWith((a) => a.id, async (a) => openSession({ sessionId: a.sessionId, status: 'completed' }));

  const backToDashboard = () => {
    setView('dashboard');
    setSession(null);
    setResults(null);
    load();
  };

  const goHome = () => {
    if (view === 'dashboard') scrollToTop();
    else { backToDashboard(); window.scrollTo(0, 0); }
  };

  if (view === 'exam' && session) {
    return <ExamRunner session={session} onExit={backToDashboard} onFinished={(r) => { setError(null); setResults(r); setView('results'); }} />;
  }

  const header = (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
        <HomeLink label={brand?.name} onHome={goHome}><Wordmark brand={brand} /></HomeLink>
        <UserMenu />
      </div>
    </header>
  );

  if (view === 'results' && results) {
    return (
      <div className="min-h-svh">
        {header}
        <Results results={results} onBack={backToDashboard} starting={starting} error={error}
          onPractice={managed ? null : (skills) => startPractice({ mode: 'skills', skills }, 'results')} />
      </div>
    );
  }

  return (
    <div className="min-h-svh">
      {header}

      <main className="mx-auto max-w-5xl animate-in px-4 pt-8 pb-16 animation-duration-300 fade-in-0 sm:px-6 sm:pt-10">
        {error && <ErrorNote className="mb-6">{error}</ErrorNote>}

        {!loaded ? (
          <Loading />
        ) : managed ? (
          <AssignedHome assignments={assigned.assignments} groups={assigned.groups} profile={profile} busyId={busyId}
            onStart={startAssignment} onReview={reviewAssignment} />
        ) : profile === null ? (
          <div className="flex justify-center pt-4 pb-14">
            <Button variant="outline" onClick={load}><LuRotateCcw /> Try again</Button>
          </div>
        ) : (
          <PracticeHome profile={profile} history={history} busy={starting} busyId={busyId}
            onStart={startPractice} onResume={resumePractice} onReview={reviewPractice} onDiscard={discardPractice} />
        )}
      </main>
    </div>
  );
}
