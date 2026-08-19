'use client';

/**
 * Choose a new password from an emailed link.
 *
 * The token arrives in the query string. It is never displayed and never
 * stored — it goes straight back to the API, which invalidates it on use.
 */
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:8080';

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!token) {
    return (
      <div className="auth-card">
        <h1>Link is missing its token</h1>
        <p className="lede">
          Open the link from your email exactly as it was sent, or request a new one from the
          sign-in page.
        </p>
        <a href="/">
          <button type="button" className="ghost" style={{ width: '100%' }}>
            Back to sign in
          </button>
        </a>
      </div>
    );
  }

  if (done) {
    return (
      <div className="auth-card">
        <h1>Password updated</h1>
        <p className="lede">You can sign in with your new password now.</p>
        <a href="/">
          <button type="button" style={{ width: '100%' }}>Go to sign in</button>
        </a>
      </div>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    // Checked here purely to save a round trip; the API enforces the length.
    if (password !== confirm) {
      setError('Those two passwords do not match.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/auth/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'That did not work.');
        return;
      }
      setDone(true);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-card">
      <div className="brand" style={{ padding: 0, marginBottom: '1rem' }}>
        <span className="mark" aria-hidden="true">L</span>
        <strong>LifePilot</strong>
      </div>

      <h1>Choose a new password</h1>
      <p className="lede">This link works once and expires an hour after it was sent.</p>

      {error && <div className="auth-error">{error}</div>}

      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="password">New password</label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
          />
        </div>
        <div className="field">
          <label htmlFor="confirm">Confirm password</label>
          <input
            id="confirm"
            type="password"
            required
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Update password'}
        </button>
      </form>
    </div>
  );
}

export default function ResetPage() {
  return (
    <div className="auth-shell">
      {/* useSearchParams needs a Suspense boundary during prerender. */}
      <Suspense fallback={<div className="auth-card">Loading…</div>}>
        <ResetForm />
      </Suspense>
    </div>
  );
}
