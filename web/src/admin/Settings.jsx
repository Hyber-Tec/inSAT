// Institution settings: branding, and for a managed academy its own AI
// provider and API key, which reading uploads and writing questions for its
// custom tests run on (a self-guided institution serves insat's question pool
// alone, so it has no AI to configure). The key is encrypted at rest and never
// shown again (only a "…last4" hint). The provider (Anthropic, OpenAI, Gemini,
// xAI/Grok, DeepSeek) and an optional model id are chosen here.

import React, { useState, useEffect, useCallback } from 'react';
import { LuCircleCheck, LuCloudUpload, LuImage, LuKeyRound, LuPalette, LuTrash2 } from 'react-icons/lu';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { api, assetUrl } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ConfirmDialog, ErrorNote, Loading, SectionHeading, StatusBadge } from '../ui.jsx';

// The theme's own primary (mist 700), shown when no brand color is set.
const DEFAULT_ACCENT = '#394447';

function BrandingCard() {
  const { setUser } = useAuth();
  const [b, setB] = useState(null); // {logoAssetId, accent}
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refreshMe = async () => { try { const { user } = await api.get('/api/auth/me'); setUser(user); } catch { /* best effort */ } };

  const load = useCallback(async () => {
    try { const data = await api.get('/api/admin/settings/branding'); setB(data); setAccent(data.accent || DEFAULT_ACCENT); }
    catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onLogo = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const fd = new FormData(); fd.append('logo', file);
      const r = await api.upload('/api/admin/settings/branding/logo', fd);
      setB((x) => ({ ...x, logoAssetId: r.logoAssetId }));
      await refreshMe();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const removeLogo = async () => {
    setBusy(true);
    try { await api.del('/api/admin/settings/branding/logo'); setB((x) => ({ ...x, logoAssetId: null })); await refreshMe(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const saveAccent = async (value) => {
    setBusy(true); setError(null);
    try {
      await api.put('/api/admin/settings/branding', { accent: value });
      setB((x) => ({ ...x, accent: value }));
      if (!value) setAccent(DEFAULT_ACCENT);
      await refreshMe();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-semibold"><LuPalette className="size-4" /> Branding</CardTitle>
        <CardDescription>Your logo and color, shown to your students and staff in place of insat&apos;s.</CardDescription>
      </CardHeader>
      <CardContent className="gap-6">
        <ErrorNote>{error}</ErrorNote>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-muted">
            {b?.logoAssetId
              ? <img src={assetUrl(b.logoAssetId)} alt="" className="size-full object-cover" />
              : <LuImage className="size-5 text-muted-foreground" />}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild disabled={busy}>
              <label className="cursor-pointer">
                <LuCloudUpload /> {b?.logoAssetId ? 'Replace logo' : 'Upload logo'}
                <input type="file" accept="image/*" onChange={onLogo} className="hidden" disabled={busy} />
              </label>
            </Button>
            {b?.logoAssetId && <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={removeLogo} disabled={busy}><LuTrash2 /> Remove</Button>}
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="accent">Brand color</Label>
          <div className="flex flex-wrap items-center gap-3">
            <input id="accent" type="color" value={accent} onChange={(e) => setAccent(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded-md border bg-background p-1" />
            <span className="font-mono text-sm text-muted-foreground uppercase">{accent}</span>
            <Button size="sm" onClick={() => saveAccent(accent)} disabled={busy || accent === (b?.accent || DEFAULT_ACCENT)}>Save color</Button>
            {b?.accent && <Button variant="ghost" size="sm" onClick={() => saveAccent(null)} disabled={busy}>Use default</Button>}
          </div>
          <p className="text-xs text-muted-foreground">Used for buttons and highlights. Text on it switches between white and black to stay readable.</p>
        </div>
      </CardContent>
    </Card>
  );
}

function AiKeyCard() {
  const [status, setStatus] = useState(null);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await api.get('/api/admin/settings/llm-key');
      setStatus(s);
      if (s.provider) setProvider(s.provider);
      setModel(s.model || '');
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const providers = status?.providers || [];
  const sel = providers.find((p) => p.id === provider) || null;
  const providerLabel = sel?.label || provider;

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.put('/api/admin/settings/llm-key', { apiKey: apiKey.trim(), provider, model: model.trim() });
      setApiKey('');
      setSavedAt(Date.now());
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true); setError(null);
    try { await api.del('/api/admin/settings/llm-key'); setProvider('anthropic'); setModel(''); load(); }
    catch (e) { setError(e.message); throw e; } finally { setBusy(false); }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 font-semibold"><LuKeyRound className="size-4" /> AI provider &amp; API key</CardTitle>
          <CardDescription>
            Used only when your academy makes tests from uploads or with AI, and billed to you. Get a key at {sel?.console || 'your provider’s console'}.
          </CardDescription>
          {status && (
            <CardAction>
              {status.configured ? <StatusBadge tone="success">Configured</StatusBadge> : <StatusBadge tone="warning">Not set</StatusBadge>}
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="gap-5">
          <ErrorNote>{error}</ErrorNote>
          {status === null ? (
            !error && <Loading className="py-6" />
          ) : (
            <>
              {status.configured && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-emerald-800">
                    <LuCircleCheck className="size-4" /> {providerLabel} key on file: <code className="font-mono">{status.hint || '…'}</code>
                    {status.model && <span className="text-muted-foreground">· {status.model}</span>}
                  </div>
                  <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setConfirmingRemove(true)} disabled={busy}>
                    <LuTrash2 /> Remove
                  </Button>
                </div>
              )}

              <form onSubmit={save} className="grid gap-5">
                <div className="grid gap-2">
                  <Label htmlFor="provider">Provider</Label>
                  <NativeSelect id="provider" className="w-full" value={provider} onChange={(e) => setProvider(e.target.value)}>
                    {providers.length === 0 && <NativeSelectOption value="anthropic">Anthropic (Claude)</NativeSelectOption>}
                    {providers.map((p) => <NativeSelectOption key={p.id} value={p.id}>{p.label}</NativeSelectOption>)}
                  </NativeSelect>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="api-key">{status.configured ? 'Replace key' : 'API key'}</Label>
                  <Input id="api-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={sel?.placeholder || 'API key'} autoComplete="off" />
                  <p className="text-xs text-muted-foreground">Stored encrypted. We never display it again - only the last 4 characters.</p>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="model">Model <span className="font-normal text-muted-foreground">(optional)</span></Label>
                  <Input id="model" value={model} onChange={(e) => setModel(e.target.value)} placeholder={sel?.defaultModel ? `Default: ${sel.defaultModel}` : 'sonnet / opus / haiku'} autoComplete="off" />
                  <p className="text-xs text-muted-foreground">
                    {provider === 'anthropic'
                      ? 'Leave blank for per-task defaults (cheap draft, strong verify). Or pin one: sonnet, opus, haiku, or a claude-… id.'
                      : `Leave blank to use ${sel?.defaultModel || 'the provider default'}. Enter any model id the provider supports.`}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <Button type="submit" disabled={busy || apiKey.trim().length < 8}>
                    {busy && <Spinner />}
                    {busy ? 'Saving…' : 'Save'}
                  </Button>
                  {savedAt > 0 && <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700"><LuCircleCheck className="size-4" /> Saved</span>}
                </div>
              </form>

              {status.requireOwnKey && !status.configured && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
                  This platform requires each academy to use its own key: tests from uploads or AI stay off until you add one.
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {confirmingRemove && (
        <ConfirmDialog
          title="Remove API key?"
          body="Making tests from uploads or with AI falls back to the platform key, or stops until you add a key again. Tests already made stay."
          confirmLabel="Remove key"
          danger
          onCancel={() => setConfirmingRemove(false)}
          onConfirm={async () => { await remove(); setConfirmingRemove(false); }}
        />
      )}
    </>
  );
}

export default function Settings({ mode }) {
  const { user } = useAuth();
  const managed = mode === 'managed';
  return (
    <div className="max-w-2xl space-y-6">
      <SectionHeading
        as="h1"
        eyebrow={user?.institutionName || 'Institution'}
        title="Settings"
        description={managed
          ? 'Your AI key, for making tests from uploads or with AI, and how insat looks to your students.'
          : 'How insat looks to your students and staff.'}
      />
      {managed && <AiKeyCard />}
      <BrandingCard />
    </div>
  );
}
