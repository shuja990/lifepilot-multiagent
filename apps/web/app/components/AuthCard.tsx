'use client';

/**
 * Sign in, sign up, or reset a password.
 *
 * Shown after someone has already typed a goal, so it arrives as the last step
 * of something they started rather than a wall in front of a product they have
 * not seen. `pendingPrompt` is echoed back for exactly that reason — it makes
 * the ask read as a continuation instead of an interruption.
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
  /** The goal they typed before being asked to sign up, if any. */
  pendingPrompt?: string | null;
  onAuthed: (user: AuthedUser, token: string) => void;
  onDismiss?: () => void;
}

export function AuthCard({ api, pendingPrompt, onAuthed, onDismiss }: Props) {
  const [mode, setMode] = useState<'register' | 'login' | 'forgot'>(
    // Someone arriving with a goal in hand is almost certainly new.
    pendingPrompt ? 'register' : 'login',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waking, setWaking] = useState(false);

  const call = async (path: string, body?: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const wakeTimer = setTimeout(() => setWaking(true), 3000);
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

      // The reset flow returns a message rather than a session, and always the
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
        setError(data.error ?? 'That did not work. Try again.');
        return;
      }
      onAuthed(data.user, data.token);
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      clearTimeout(wakeTimer);
      setWaking(false);
      setBusy(false);
    }
  };

  const heading =
    mode === 'forgot'
      ? 'Reset your password'
      : mode === 'login'
        ? 'Welcome back'
        : pendingPrompt
          ? 'Create your free account'
          : 'Create your account';

  const lede =
    mode === 'forgot'
      ? 'Enter your email and we will send you a link to choose a new one.'
      : mode === 'login'
        ? 'Sign in to pick up your plans and preferences.'
        : 'Free to use. No card, no payment, no trial to cancel.';

  return (
    <div className="auth-card">
      <div className="brand" style={{ padding: 0, marginBottom: '1rem' }}>
        <span className="mark" aria-hidden="true">L</span>
        <strong>LifePilot</strong>
      </div>

      <h1>{heading}</h1>
      <p className="lede">{lede}</p>

      {pendingPrompt && mode !== 'forgot' && (
        <div className="pending-goal">
          <span className="label">Your goal</span>
          {pendingPrompt}
          <span className="follow-up">Planning starts the moment you are in.</span>
        </div>
      )}

      {error && <div className="auth-error">{error}</div>}
      {notice && <div className="auth-notice">{notice}</div>}
      {waking && <div className="auth-notice">Starting up, one moment…</div>}

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
            : mode === 'forgot'
              ? 'Send reset link'
              : mode === 'login'
                ? 'Sign in'
                : pendingPrompt
                  ? 'Create account and see my plan'
                  : 'Create account'}
        </button>
      </form>

      <div style={{ marginTop: '.9rem', fontSize: '.85rem', color: 'var(--muted)' }}>
        {mode === 'register' ? 'Already have an account? ' : mode === 'login' ? 'New here? ' : ''}
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
            setNotice(null);
          }}
        >
          {mode === 'login' ? 'Create one' : mode === 'register' ? 'Sign in' : 'Back to sign in'}
        </button>
      </div>

      {onDismiss && (
        <div className="auth-alt">
          <button type="button" className="link" onClick={onDismiss}>
            Not now
          </button>
        </div>
      )}
    </div>
  );
}
