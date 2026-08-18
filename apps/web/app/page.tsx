'use client';

/**
 * The app shell: identity, conversation history, transcript, approvals.
 *
 * On identity — this deliberately does NOT put a login wall in front of the
 * product. The Phase 7 acceptance check is that a stranger with the link and
 * no account can complete a full plan including an approval; a sign-in screen
 * fails that outright, and it is the same reasoning that kept Google Calendar
 * off the critical path.
 *
 * So identity is a claimed handle stored locally, not an authenticated account.
 * It is enough to keep conversations and preferences separate per person, and
 * it is honest about what it is: the UI says so rather than implying security
 * that is not there. Real auth belongs on the roadmap, not faked in the client.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:8080';

interface TraceEntry {
  author: string;
  kind: 'text' | 'tool-call' | 'tool-result' | 'error' | 'other' | 'user';
  tool?: string;
  args?: Record<string, unknown>;
  text?: string;
  ok?: boolean;
  summary?: string;
}

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

const EXAMPLES = [
  'plan a weekend in Islamabad under 20000 PKR',
  'what is 5000 PKR in USD?',
  'help me buy noise cancelling headphones',
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
  const [userId, setUserId] = useState('');
  const [message, setMessage] = useState('');
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [showPrefs, setShowPrefs] = useState(false);
  const [prefKey, setPrefKey] = useState(PREFERENCE_KEYS[0]);
  const [prefValue, setPrefValue] = useState('');
  const [reason, setReason] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  /* Identity is restored before anything is fetched, so no request goes out
     under the wrong user. */
  useEffect(() => {
    const stored = window.localStorage.getItem('lifepilot.userId');
    const id = stored ?? `guest-${Math.random().toString(36).slice(2, 8)}`;
    if (!stored) window.localStorage.setItem('lifepilot.userId', id);
    setUserId(id);
  }, []);

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      const [sessionsRes, approvalsRes, prefsRes] = await Promise.all([
        fetch(`${API}/sessions?userId=${encodeURIComponent(userId)}`),
        fetch(`${API}/approvals?userId=${encodeURIComponent(userId)}`),
        fetch(`${API}/preferences?userId=${encodeURIComponent(userId)}`),
      ]);
      setConversations(((await sessionsRes.json()) as { sessions?: Conversation[] }).sessions ?? []);
      setApprovals(((await approvalsRes.json()) as { approvals?: PendingApproval[] }).approvals ?? []);
      setPreferences(((await prefsRes.json()) as { preferences?: Preference[] }).preferences ?? []);
    } catch {
      // Sidebar data is secondary — a hiccup here must never interrupt a run.
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries, running]);

  const openConversation = useCallback(
    async (id: string) => {
      setMenuOpen(false);
      setSessionId(id);
      setEntries([]);
      try {
        const res = await fetch(
          `${API}/sessions/${id}?userId=${encodeURIComponent(userId)}`,
        );
        const data = (await res.json()) as { entries?: TraceEntry[] };
        setEntries(data.entries ?? []);
      } catch {
        setEntries([{ author: 'system', kind: 'error', summary: 'Could not load that conversation.' }]);
      }
    },
    [userId],
  );

  const newConversation = useCallback(() => {
    setSessionId(null);
    setEntries([]);
    setMenuOpen(false);
  }, []);

  /**
   * Streams a run.
   *
   * EventSource cannot POST and the run needs a JSON body, so the response is
   * read as a stream by hand: split on blank lines, then read event/data.
   */
  const send = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || running || !userId) return;

      setRunning(true);
      setMessage('');
      // Appended, not replaced — the transcript is the history of this session.
      setEntries((prev) => [...prev, { author: 'you', kind: 'user', text: prompt }]);

      try {
        const res = await fetch(`${API}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: prompt, userId, sessionId }),
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
              setEntries((prev) => [...prev, JSON.parse(data) as TraceEntry]);
            }
          }
        }
      } catch (error) {
        setEntries((prev) => [
          ...prev,
          { author: 'system', kind: 'error', summary: error instanceof Error ? error.message : String(error) },
        ]);
      } finally {
        setRunning(false);
        void refresh();
      }
    },
    [running, sessionId, userId, refresh],
  );

  const decide = useCallback(
    async (approvalId: string, status: 'approved' | 'rejected') => {
      // Removed immediately so the button cannot be pressed twice; the server
      // also refuses a second decision, so this is only about the UI.
      setApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId));
      try {
        const res = await fetch(`${API}/approvals/${approvalId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
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
    [reason, refresh],
  );

  const savePreference = useCallback(async () => {
    if (!prefValue.trim()) return;
    await fetch(`${API}/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, key: prefKey, value: prefValue.trim() }),
    });
    setPrefValue('');
    void refresh();
  }, [prefKey, prefValue, userId, refresh]);

  const changeIdentity = useCallback((next: string) => {
    const id = next.trim() || 'guest';
    window.localStorage.setItem('lifepilot.userId', id);
    setUserId(id);
    setSessionId(null);
    setEntries([]);
  }, []);

  return (
    <div className="app">
      <aside className={menuOpen ? 'sidebar open' : 'sidebar'}>
        <div className="brand">
          <span className="mark" aria-hidden="true">L</span>
          <strong>LifePilot</strong>
        </div>

        <button type="button" onClick={newConversation}>New conversation</button>

        <div className="side-label">History</div>
        <div className="convo-list">
          {conversations.length === 0 && (
            <div style={{ fontSize: '.8rem', color: 'var(--faint)', padding: '.25rem .5rem' }}>
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
              <span>{conversation.title}</span>
            </button>
          ))}
        </div>

        <div className="identity">
          <div className="side-label" style={{ padding: 0 }}>Signed in as</div>
          <input
            defaultValue={userId}
            onBlur={(e) => changeIdentity(e.target.value)}
            aria-label="Your handle"
            spellCheck={false}
          />
          <p className="hint">
            A local handle, not an account — there is no password and nothing is
            protected. It keeps your history and preferences separate so the demo
            works without a sign-up.
          </p>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
            <button
              type="button"
              className="quiet menu-toggle"
              onClick={() => setMenuOpen((open) => !open)}
              aria-label="Toggle conversation list"
            >
              ☰
            </button>
            <div>
              <h1>{conversations.find((c) => c.sessionId === sessionId)?.title ?? 'New conversation'}</h1>
              <div className="sub">
                {sessionId ? 'Saved — this survives a restart' : 'Nothing sent yet'}
              </div>
            </div>
          </div>
          <div className="right">
            <button type="button" className="ghost" onClick={() => setShowPrefs((v) => !v)}>
              Preferences{preferences.length > 0 ? ` (${preferences.length})` : ''}
            </button>
          </div>
        </div>

        <div className="thread">
          <div className="thread-inner">
            {showPrefs && (
              <section className="prefs">
                <h3>What LifePilot remembers about you</h3>
                {preferences.length === 0 ? (
                  <p style={{ margin: '0 0 .6rem', color: 'var(--muted)', fontSize: '.85rem' }}>
                    Nothing saved yet. Agents only store what you actually tell them.
                  </p>
                ) : (
                  <ul>
                    {preferences.map((preference) => (
                      <li key={preference.key}>
                        <strong>{preference.key.replace(/_/g, ' ')}:</strong> {preference.value}
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
                    placeholder="e.g. Lahore"
                    aria-label="Preference value"
                  />
                  <button type="button" onClick={() => void savePreference()} disabled={!prefValue.trim()}>
                    Save
                  </button>
                </div>
              </section>
            )}

            {approvals.map((approval) => (
              <section className="approval" key={approval.approvalId} aria-live="polite">
                <h3>Approval needed — {approval.action.replace(/_/g, ' ')}</h3>
                <div>{approval.summary}</div>
                <div className="details">{approval.details}</div>
                <div style={{ fontSize: '.85rem' }}>
                  <strong>Cost:</strong> {approval.estimatedCost ?? 'none stated'}
                </div>
                <div className="row" style={{ marginTop: '.7rem' }}>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Reason (needed to reject)"
                    aria-label="Reason"
                  />
                  <button type="button" onClick={() => void decide(approval.approvalId, 'approved')}>
                    Approve
                  </button>
                  <button type="button" className="ghost" onClick={() => void decide(approval.approvalId, 'rejected')}>
                    Reject
                  </button>
                </div>
              </section>
            ))}

            {entries.length === 0 && !running && (
              <div className="empty">
                <h2>What are you trying to do?</h2>
                <p>
                  Describe a real goal. Specialised agents research it, cost it and
                  schedule it — and stop for your approval before anything real happens.
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

            {entries.map((entry, index) => (
              <Entry key={index} entry={entry} />
            ))}

            {running && (
              <div className="thinking">
                <span className="dot" aria-hidden="true" />
                Agents are working…
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
            Booking and payment are simulated. Saving a plan, generating a calendar
            file and scheduling reminders are real.
          </p>
        </div>
      </main>
    </div>
  );
}

function Entry({ entry }: { entry: TraceEntry }) {
  if (entry.kind === 'user') return <div className="bubble">{entry.text}</div>;

  if (entry.kind === 'text') {
    return (
      <article className="entry">
        <div className="entry-head"><span className="badge">{entry.author}</span></div>
        <div className="answer">{entry.text}</div>
      </article>
    );
  }

  if (entry.kind === 'error') {
    return (
      <article className="entry error">
        <div className="entry-head">
          <span className="badge">{entry.author}</span>
          <span className="status-err">failed</span>
        </div>
        <div className="answer">{entry.summary}</div>
      </article>
    );
  }

  const isCall = entry.kind === 'tool-call';
  return (
    <article className="entry">
      <div className="entry-head">
        <span className="badge">{entry.author}</span>
        <span className="tool">{isCall ? '→' : '←'} {entry.tool}</span>
        {!isCall && (
          <span className={entry.ok ? 'status-ok' : 'status-err'}>
            {entry.ok ? entry.summary : `failed — ${entry.summary ?? ''}`}
          </span>
        )}
      </div>
      {isCall && entry.args && Object.keys(entry.args).length > 0 && (
        <pre className="args">{JSON.stringify(entry.args, null, 1)}</pre>
      )}
    </article>
  );
}
