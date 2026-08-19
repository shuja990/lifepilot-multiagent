'use client';

/**
 * Sign in, sign up, or continue as a guest.
 *
 * Guest is kept as a first-class option rather than a grudging escape hatch:
 * the acceptance requirement is that a stranger with the link can complete a
 * full plan, and a hard wall fails that. A guest still gets a real account row,
 * so their conversations and preferences are scoped exactly like anyone else's
 * — the only difference is they never chose a password.
 */
import { useState } from 'react';

export interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
  isGuest: boolean;
}

interface Props {
  api: string;
  onAuthed: (user: AuthedUser, token: string) => void;
}

export function AuthCard({ api, onAuthed }: Props) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const call = async (path: string, body?: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${api}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = (await res.json()) as {
        user?: AuthedUser;
        token?: string;
        error?: string;
        message?: string;
        emailConfigured?: boolean;
      };

      // The forgot flow returns a message rather than a session, and always the
      // same one, so it cannot be used to discover which addresses exist.
      if (path === '/auth/forgot') {
        if (!res.ok) {
          setError(data.error ?? 'That did not work.');
          return;
        }
        setNotice(
          data.emailConfigured === false
            ? 'If that email has an account, a reset link was generated. No email provider is configured on this server, so the link was written to the server log.'
            : (data.message ?? 'Check your email for a reset link.'),
        );
        return;
      }

      if (!res.ok || !data.user || !data.token) {
        // The API returns readable messages ("Wrong email or password."), so
        // show those rather than a status code.
        setError(data.error ?? 'That did not work. Try again.');
        return;
      }
      onAuthed(data.user, data.token);
    } catch {
      setError('Could not reach the server. Is the API running?');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand" style={{ padding: 0, marginBottom: '1rem' }}>
          <span className="mark" aria-hidden="true">L</span>
          <strong>LifePilot</strong>
        </div>

        <h1>
          {mode === 'login'
            ? 'Welcome back'
            : mode === 'register'
              ? 'Create your account'
              : 'Reset your password'}
        </h1>
        <p className="lede">
          {mode === 'login'
            ? 'Sign in to pick up your plans and preferences.'
            : mode === 'register'
              ? 'Your plans, preferences and approvals stay tied to your account.'
              : 'Enter your email and we will send you a link to choose a new one.'}
        </p>

        {error && <div className="auth-error">{error}</div>}
        {notice && <div className="auth-notice">{notice}</div>}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (mode === 'forgot') {
              void call('/auth/forgot', { email });
              return;
            }
            void call(mode === 'login' ? '/auth/login' : '/auth/register', {
              email,
              password,
              ...(mode === 'register' ? { displayName } : {}),
            });
          }}
        >
          {mode === 'register' && (
            <div className="field">
              <label htmlFor="name">Name</label>
              <input
                id="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                autoComplete="name"
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>

          {mode !== 'forgot' && (
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? 'At least 8 characters' : '••••••••'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
            {mode === 'login' && (
              <button
                type="button"
                className="link"
                style={{ marginTop: '.45rem', fontSize: '.8rem' }}
                onClick={() => {
                  setMode('forgot');
                  setError(null);
                  setNotice(null);
                }}
              >
                Forgot your password?
              </button>
            )}
          </div>
          )}

          <button type="submit" disabled={busy}>
            {busy
              ? 'Working…'
              : mode === 'login'
                ? 'Sign in'
                : mode === 'register'
                  ? 'Create account'
                  : 'Send reset link'}
          </button>
        </form>

        <div style={{ marginTop: '.9rem', fontSize: '.85rem', color: 'var(--muted)' }}>
          {mode === 'login' ? 'No account yet? ' : mode === 'register' ? 'Already have one? ' : ''}
          <button
            type="button"
            className="link"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
              setNotice(null);
            }}
          >
            {mode === 'login' ? 'Create one' : 'Back to sign in'}
          </button>
        </div>

        <div className="auth-alt">
          Just looking around?
          <button type="button" className="ghost" disabled={busy} onClick={() => void call('/auth/guest')}>
            Continue as guest
          </button>
        </div>
      </div>
    </div>
  );
}
