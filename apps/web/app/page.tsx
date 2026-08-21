'use client';

/**
 * The app shell.
 *
 * Two things changed the character of this screen:
 *
 * 1. Identity comes from a signed token now, not a string in localStorage, and
 *    every request carries it. Before, `?userId=` was the only thing separating
 *    one person's conversations from another's — a label, not a boundary.
 *
 * 2. The feed shows sentences, not events. `transfer_to_agent({"agentName":…})`
 *    and raw argument JSON are the inside of the machine; a person wants to know
 *    that it is checking the weather in Lisbon. The raw payload is one click
 *    away for anyone who wants it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthCard, type AuthedUser } from './components/AuthCard';
import { Markdown } from './lib/markdown';
import { toActivities, type Activity, type RawEntry } from './lib/activity';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:8080';
const TOKEN_KEY = 'lifepilot.token';

interface Conversation {
  sessionId: string;
  title: string;
  updatedAt: string;
}

interface PendingApproval {
  approvalId: string;
  action: string;
  summary: string;
  details: string;
  estimatedCost: string | null;
}

interface Preference {
  key: string;
  value: string;
}

interface Connections {
  googleCalendar: { available: boolean; connected: boolean };
}

/**
 * Deliberately spread across continents and goal types.
 *
 * The examples are the first thing anyone reads, so they double as a claim
 * about reach: the tools are worldwide (Open-Meteo, OpenStreetMap, 160+
 * currencies), and nothing about the system is tied to one country.
 */
const EXAMPLES = [
  'Plan a weekend in Lisbon under €400',
  'What is 250 USD in Japanese yen?',
  'Find quiet cafes near Shibuya, Tokyo',
  'Help me buy noise cancelling headphones',
];

const PREFERENCE_KEYS = [
  'home_city',
  'currency',
  'budget_style',
  'dietary',
  'travel_class',
  'accessibility',
  'interests',
  'avoid',
];

export default function Page() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthedUser | null>(null);
  const [booted, setBooted] = useState(false);

  const [message, setMessage] = useState('');
  const [entries, setEntries] = useState<RawEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [showPrefs, setShowPrefs] = useState(false);
  const [connections, setConnections] = useState<Connections | null>(null);
  const [calendarNotice, setCalendarNotice] = useState<string | null>(null);
  const [prefKey, setPrefKey] = useState(PREFERENCE_KEYS[0]!);
  const [prefValue, setPrefValue] = useState('');
  const [reason, setReason] = useState('');
  /**
   * One piece of state drives both layouts.
   *
   * On desktop the sidebar is a grid column that collapses to zero width; on
   * mobile it is an overlay drawer. Previously it could only be toggled on
   * mobile and there was no way to close it at all on desktop.
   *
   * Default differs by viewport: open on a wide screen, closed on a phone.
   */
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /**
   * True while a request is taking long enough that the API is probably asleep.
   *
   * Free hosting spins the service down after inactivity and the next request
   * waits about a minute for it to wake. Without this the app looks broken for
   * that minute, which is exactly the first minute a visitor ever sees.
   */
  const [waking, setWaking] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  /** Every authenticated call goes through here so the header cannot be forgotten. */
  const authed = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers ?? {}),
          authorization: `Bearer ${token ?? ''}`,
        },
      });
      // An expired or revoked token means the session is over; drop it rather
      // than leaving the UI half-working with 401s behind every panel.
      if (res.status === 401) {
        window.localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setUser(null);
      }
      return res;
    },
    [token],
  );

  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 52rem)');
    setSidebarOpen(!narrow.matches);

    // Escape closes the drawer — expected wherever an overlay covers content.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && narrow.matches) setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Closes the drawer after navigating, but only where it covers the content. */
  const closeIfOverlay = useCallback(() => {
    if (window.matchMedia('(max-width: 52rem)').matches) setSidebarOpen(false);
  }, []);

  /* Restore a saved session before rendering anything, so the sign-in card
     does not flash for someone who is already signed in. */
  useEffect(() => {
    const stored = window.localStorage.getItem(TOKEN_KEY);
    if (!stored) {
      setBooted(true);
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`${API}/auth/me`, {
          headers: { authorization: `Bearer ${stored}` },
        });
        if (res.ok) {
          const data = (await res.json()) as { user: AuthedUser };
          setToken(stored);
          setUser(data.user);
        } else {
          window.localStorage.removeItem(TOKEN_KEY);
        }
      } catch {
        // Offline or API down — show the sign-in card rather than a blank page.
      } finally {
        setBooted(true);
      }
    })();
  }, []);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [sessionsRes, approvalsRes, prefsRes, connRes] = await Promise.all([
        authed('/sessions'),
        authed('/approvals'),
        authed('/preferences'),
        authed('/connections'),
      ]);
      if (connRes.ok) setConnections((await connRes.json()) as Connections);
      if (sessionsRes.ok) {
        setConversations(((await sessionsRes.json()) as { sessions?: Conversation[] }).sessions ?? []);
      }
      if (approvalsRes.ok) {
        setApprovals(((await approvalsRes.json()) as { approvals?: PendingApproval[] }).approvals ?? []);
      }
      if (prefsRes.ok) {
        setPreferences(((await prefsRes.json()) as { preferences?: Preference[] }).preferences ?? []);
      }
    } catch {
      // Sidebar data is secondary — a hiccup must never interrupt a run.
    }
  }, [token, authed]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* The OAuth callback returns here with ?calendar=..., since a redirect cannot
     hand a result back to the page any other way. Read it, then strip it so a
     refresh does not repeat the message. */
  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get('calendar');
    if (!status) return;

    setCalendarNotice(
      status === 'connected'
        ? 'Google Calendar connected. Approved plans will now also create real calendar events.'
        : status === 'denied'
          ? 'Google Calendar was not connected — you declined the permission.'
          : 'Could not connect Google Calendar. Check the server log for the reason.',
    );
    setShowPrefs(true);
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries, running]);

  const activities = useMemo(() => toActivities(entries), [entries]);

  const signOut = useCallback(() => {
    window.localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setEntries([]);
    setSessionId(null);
    setConversations([]);
  }, []);

  const openConversation = useCallback(
    async (id: string) => {
      closeIfOverlay();
      setSessionId(id);
      setEntries([]);
      const res = await authed(`/sessions/${id}`);
      if (!res.ok) return;
      const data = (await res.json()) as { entries?: RawEntry[] };
      setEntries(data.entries ?? []);
    },
    [authed, closeIfOverlay],
  );

  const send = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || running || !token) return;

      setRunning(true);
      setMessage('');
      // Three seconds is comfortably longer than a warm response and far
      // shorter than a cold start, so it separates the two without guessing.
      const wakeTimer = setTimeout(() => setWaking(true), 3000);
      setEntries((prev) => [...prev, { author: 'user', kind: 'user', text: prompt }]);

      try {
        const res = await authed('/chat', {
          method: 'POST',
          body: JSON.stringify({ message: prompt, sessionId }),
        });
        if (!res.body) throw new Error('No response stream from the API.');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          // Keep the trailing fragment: a frame can straddle two chunks.
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            let event = 'message';
            let data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) continue;

            if (event === 'session') {
              setSessionId((JSON.parse(data) as { sessionId: string }).sessionId);
            } else if (event === 'done') {
              void refresh();
            } else if (event === 'error') {
              setEntries((prev) => [
                ...prev,
                { author: 'system', kind: 'error', summary: (JSON.parse(data) as { error: string }).error },
              ]);
            } else {
              setEntries((prev) => [...prev, JSON.parse(data) as RawEntry]);
            }
          }
        }
      } catch (error) {
        setEntries((prev) => [
          ...prev,
          {
            author: 'system',
            kind: 'error',
            summary: error instanceof Error ? error.message : String(error),
          },
        ]);
      } finally {
        clearTimeout(wakeTimer);
        setWaking(false);
        setRunning(false);
        void refresh();
      }
    },
    [running, sessionId, token, authed, refresh],
  );

  const decide = useCallback(
    async (approvalId: string, status: 'approved' | 'rejected') => {
      // Removed immediately so it cannot be pressed twice; the server also
      // refuses a second decision, so this is purely about the UI.
      setApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId));
      try {
        const res = await authed(`/approvals/${approvalId}`, {
          method: 'POST',
          body: JSON.stringify({ status, reason: reason || undefined }),
        });
        const data = (await res.json()) as { answer?: string };
        if (data.answer) {
          setEntries((prev) => [...prev, { author: 'commit_agent', kind: 'text', text: data.answer }]);
        }
      } finally {
        setReason('');
        void refresh();
      }
    },
    [reason, authed, refresh],
  );

  const savePref = useCallback(async () => {
    if (!prefValue.trim()) return;
    await authed('/preferences', {
      method: 'POST',
      body: JSON.stringify({ key: prefKey, value: prefValue.trim() }),
    });
    setPrefValue('');
    void refresh();
  }, [prefKey, prefValue, authed, refresh]);

  const toggleRaw = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (!booted) return <div className="auth-shell" />;

  if (!token || !user) {
    return (
      <AuthCard
        api={API}
        onAuthed={(nextUser, nextToken) => {
          window.localStorage.setItem(TOKEN_KEY, nextToken);
          setToken(nextToken);
          setUser(nextUser);
        }}
      />
    );
  }

  const activeTitle = conversations.find((c) => c.sessionId === sessionId)?.title;

  return (
    <div className={sidebarOpen ? 'app' : 'app collapsed'}>
      {/* Tapping the dimmed backdrop closes the drawer. Rendered always so the
          CSS decides when it is visible, rather than duplicating the breakpoint
          in JavaScript. */}
      <button
        type="button"
        className="scrim"
        aria-label="Close sidebar"
        tabIndex={-1}
        onClick={() => setSidebarOpen(false)}
      />

      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand">
            <span className="mark" aria-hidden="true">L</span>
            <strong>LifePilot</strong>
          </div>
          <button
            type="button"
            className="quiet"
            onClick={() => setSidebarOpen(false)}
            aria-label="Hide sidebar"
            title="Hide sidebar"
          >
            ⟨
          </button>
        </div>

        <button
          type="button"
          onClick={() => {
            setSessionId(null);
            setEntries([]);
            closeIfOverlay();
          }}
        >
          New conversation
        </button>

        <div className="side-label">History</div>
        <div className="convo-list">
          {conversations.length === 0 && (
            <div style={{ fontSize: '.8rem', color: 'var(--faint)', padding: '.25rem .55rem' }}>
              Nothing yet.
            </div>
          )}
          {conversations.map((conversation) => (
            <button
              key={conversation.sessionId}
              type="button"
              className={conversation.sessionId === sessionId ? 'convo active' : 'convo'}
              onClick={() => void openConversation(conversation.sessionId)}
              title={conversation.title}
            >
              {conversation.title}
            </button>
          ))}
        </div>

        <div className="account">
          <div className="who">{user.displayName}</div>
          <div className="sub">{user.isGuest ? 'Guest account' : user.email}</div>
          <button type="button" className="ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', minWidth: 0 }}>
            <button
              type="button"
              className="quiet"
              onClick={() => setSidebarOpen((open) => !open)}
              aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
              aria-expanded={sidebarOpen}
              title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            >
              ☰
            </button>
            <div style={{ minWidth: 0 }}>
              <h1>{activeTitle ?? 'New conversation'}</h1>
              <div className="sub">{sessionId ? 'Saved automatically' : 'Nothing sent yet'}</div>
            </div>
          </div>
          <button type="button" className="ghost" onClick={() => setShowPrefs((v) => !v)}>
            Preferences{preferences.length > 0 ? ` · ${preferences.length}` : ''}
          </button>
        </div>

        <div className="thread">
          <div className="thread-inner">
            {showPrefs && connections && (
              <section className="connections">
                <h3>Google Calendar</h3>
                <div className="sub">
                  Optional. Plans always produce a downloadable calendar file; connecting
                  Google also writes the milestones straight into your calendar.
                </div>

                {calendarNotice && <div className="auth-notice">{calendarNotice}</div>}

                {!connections.googleCalendar.available ? (
                  <div className="state">
                    <span className="pill off">Unavailable</span>
                    <span style={{ color: 'var(--muted)' }}>
                      No Google OAuth client is configured on this server.
                    </span>
                  </div>
                ) : connections.googleCalendar.connected ? (
                  <>
                    <div className="state">
                      <span className="pill on">Connected</span>
                    </div>
                    <button
                      type="button"
                      className="ghost"
                      onClick={async () => {
                        await authed('/connections/google', { method: 'DELETE' });
                        setCalendarNotice('Google Calendar disconnected.');
                        void refresh();
                      }}
                    >
                      Disconnect
                    </button>
                  </>
                ) : (
                  <>
                    <div className="state">
                      <span className="pill off">Not connected</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        // A top-level navigation, not fetch: the consent screen
                        // must be shown by the browser, and it cannot carry an
                        // Authorization header, so the token rides in the URL.
                        window.location.href = `${API}/connect/google?token=${encodeURIComponent(token)}`;
                      }}
                    >
                      Connect Google Calendar
                    </button>
                  </>
                )}
              </section>
            )}

            {showPrefs && (
              <section className="prefs">
                <h3>What LifePilot remembers about you</h3>
                {preferences.length === 0 ? (
                  <p style={{ margin: '0 0 .7rem', color: 'var(--muted)', fontSize: '.85rem' }}>
                    Nothing saved yet. Agents only store what you actually tell them.
                  </p>
                ) : (
                  <ul>
                    {preferences.map((preference) => (
                      <li key={preference.key}>
                        {preference.key.replace(/_/g, ' ')}: <strong>{preference.value}</strong>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="row">
                  <select value={prefKey} onChange={(e) => setPrefKey(e.target.value)} aria-label="Preference">
                    {PREFERENCE_KEYS.map((key) => (
                      <option key={key} value={key}>{key.replace(/_/g, ' ')}</option>
                    ))}
                  </select>
                  <input
                    value={prefValue}
                    onChange={(e) => setPrefValue(e.target.value)}
                    placeholder="e.g. Berlin"
                    aria-label="Preference value"
                  />
                  <button type="button" onClick={() => void savePref()} disabled={!prefValue.trim()}>
                    Save
                  </button>
                </div>
              </section>
            )}

            {approvals.map((approval) => (
              <section className="approval" key={approval.approvalId} aria-live="polite">
                <div className="tag">Needs your approval</div>
                <h3>{approval.summary}</h3>
                <div className="details">{approval.details}</div>
                <div className="cost">
                  <strong>Cost:</strong> {approval.estimatedCost ?? 'none stated'}
                </div>
                <div className="row">
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Reason (needed to reject)"
                    aria-label="Reason"
                  />
                  <button type="button" onClick={() => void decide(approval.approvalId, 'approved')}>
                    Approve
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void decide(approval.approvalId, 'rejected')}
                  >
                    Reject
                  </button>
                </div>
              </section>
            ))}

            {activities.length === 0 && !running && (
              <div className="empty">
                <h2>What are you trying to do?</h2>
                <p>
                  Describe a real goal. Specialised agents research it, cost it and put it in
                  order — and stop for your approval before anything real happens.
                </p>
                <div className="examples">
                  {EXAMPLES.map((example) => (
                    <button key={example} type="button" onClick={() => void send(example)}>
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Feed activities={activities} expanded={expanded} onToggleRaw={toggleRaw} />

            {running && (
              <div className="working">
                <span className="dot" aria-hidden="true" />
                {waking
                  ? 'Waking the server — free hosting sleeps when idle, so the first request can take a minute.'
                  : 'Working…'}
              </div>
            )}
            <div ref={endRef} />
          </div>
        </div>

        <div className="composer">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(message);
            }}
          >
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Describe a goal…"
              aria-label="Your goal"
              disabled={running}
            />
            <button type="submit" disabled={running || !message.trim()}>
              {running ? 'Working…' : 'Send'}
            </button>
          </form>
          <p className="note">
            Booking and payment are simulated. Saving a plan, generating a calendar file and
            scheduling reminders are real.
          </p>
        </div>
      </main>
    </div>
  );
}

/**
 * Groups consecutive steps into one quiet block.
 *
 * A planning run emits a dozen of these; as separate cards they drown the
 * answer, which is the thing the user actually came for.
 */
function Feed({
  activities,
  expanded,
  onToggleRaw,
}: {
  activities: Activity[];
  expanded: Set<string>;
  onToggleRaw: (id: string) => void;
}) {
  const blocks: Array<{ kind: 'steps'; items: Activity[] } | { kind: 'one'; item: Activity }> = [];

  for (const activity of activities) {
    if (activity.type === 'step' || activity.type === 'handoff') {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'steps') last.items.push(activity);
      else blocks.push({ kind: 'steps', items: [activity] });
    } else {
      blocks.push({ kind: 'one', item: activity });
    }
  }

  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === 'steps') {
          return (
            <div className="steps" key={`s-${index}`}>
              {block.items.map((step) => (
                <div key={step.id}>
                  <div
                    className={`step${step.ok === false ? ' failed' : ''}${
                      step.type === 'handoff' ? ' handoff' : ''
                    }`}
                  >
                    <span className="icon" aria-hidden="true">
                      {step.type === 'handoff' ? '⇢' : step.ok === false ? '×' : step.detail ? '✓' : '•'}
                    </span>
                    <span className="what">{step.label}</span>
                    {step.detail && <span className="got">{step.detail}</span>}
                    {step.raw != null && (
                      <button
                        type="button"
                        className="quiet peek"
                        onClick={() => onToggleRaw(step.id)}
                        aria-expanded={expanded.has(step.id)}
                      >
                        {expanded.has(step.id) ? 'hide' : 'details'}
                      </button>
                    )}
                  </div>
                  {expanded.has(step.id) && (
                    <pre className="raw">{JSON.stringify(step.raw, null, 2)}</pre>
                  )}
                </div>
              ))}
            </div>
          );
        }

        const item = block.item;

        if (item.type === 'user') return <div className="you" key={item.id}>{item.text}</div>;

        if (item.type === 'error') {
          return (
            <div className="failure" key={item.id}>
              <div className="title">Something went wrong</div>
              <div className="detail">{item.detail}</div>
            </div>
          );
        }

        return (
          <div className="answer" key={item.id}>
            <div className="by">{item.agent}</div>
            <Markdown>{item.text ?? ''}</Markdown>
          </div>
        );
      })}
    </>
  );
}
