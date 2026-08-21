# Architecture

How LifePilot is put together, and the constraints that shaped it.

---

## Layers

```
apps/web        Next.js UI — chat, activity feed, approvals, preferences
apps/api        Hono HTTP + SSE, the agent graph, the tool layer
packages/shared Zod schemas used by both
```

The tool layer is agent-agnostic and runnable from a CLI. Only
`apps/api/src/tools/index.ts` knows ADK exists. Tools get debugged far more
often than agents, and needing a model in the loop to check whether an API call
works is a bad place to be.

---

## The agent graph

The root is an `LlmAgent` with sub-agents, so ADK's delegation applies and the
model chooses the path:

| Destination | For |
|---|---|
| `quick_answer` | A fact or a single lookup. One tool call, one sentence. |
| `commit_agent` | Anything with a real-world effect. Always asks for approval first. |
| `lifepilot_graph` | Work that needs research, costing, sequencing and checking. |

`lifepilot_graph` is deterministic: a `ParallelAgent` of four researchers, then a
`SequentialAgent` that recommends, costs and schedules, then a `LoopAgent` that
critiques and revises up to twice, then a presenter.

Both shapes earn their place. Routing adapts to intent so a currency question
does not run a dozen agents; the pipeline stays predictable where the work
genuinely needs every stage.

### Model assignment

Models are chosen per task, in `apps/api/src/config/routing.ts`:

- **Routing and research** run on Flash-Lite. Routing is classification, and it
  is the most frequent call in the system since every request pays for it.
- **Judgement work** — recommending, costing, planning — runs on Flash.
- **The verifier** runs on a different provider from the agents that wrote the
  plan, so its critique cannot be self-confirming.

Every tier has a fallback chain, and fallbacks are matched to context size.
Groq's free tier caps a request at 8,000 tokens, so it backs the small fan-out
agents and never the late pipeline agents, which carry roughly 12k of findings.

Model ids are pinned. `-latest` aliases drift onto newer models whose free tier
can be a fraction of the size.

---

## Multi-provider support

ADK for TypeScript ships model classes for Gemini and an Apigee gateway. There
is no LiteLLM equivalent, so `apps/api/src/models/openai-compatible.ts`
implements `BaseLlm` directly. Groq, DeepSeek, OpenRouter, Ollama and vLLM all
speak chat-completions, so one adapter covers them; adding a provider is one
entry in `PROVIDERS`.

Two translation details matter:

- **Message shape.** genai carries `functionCall` and `functionResponse` as
  parts of a turn; OpenAI wants tool calls as an array on an assistant message
  and each tool result as its own message keyed by `tool_call_id`. One `Content`
  can become several messages.
- **Schema dialect.** ADK emits Gemini's function-declaration format, which
  writes types as upper-case names (`OBJECT`, `STRING`) and serialises numeric
  constraints as strings. Strict JSON Schema validators reject both, so
  `geminiSchemaToJsonSchema` converts them. Without it, multi-provider support
  silently means text-only with no tools.

The adapter throws on upstream failure rather than yielding an error response,
because `RoutedLlm` only fails over when a model throws before yielding.

---

## The approval gate

`request_approval` is a `LongRunningFunctionTool`. The tool returns
`{ status: 'pending' }`, the event carries the call id in `longRunningToolIds`,
and nothing further executes until the application feeds a `FunctionResponse`
back with that same id.

That is stronger than asking the model "shall I proceed?" and reading its reply,
which leaves the decision inside the model's context where a persuasive turn can
talk it into yes. Here the run is genuinely stopped, and only a decision written
to Postgres restarts it.

Requirements the implementation holds to:

- **Durable.** The approval, the function call id and the session id are all in
  Postgres, so the pause survives a restart or a deploy.
- **Enforced in code.** `commit_plan` re-reads the approval and refuses unless it
  is approved, so an agent that forgets to ask still cannot act.
- **Idempotent.** Execution is keyed on the approval id with a unique
  constraint, so a double-click, a retry or a replay collapses onto one run. The
  check is the `INSERT` itself, not a preceding `SELECT` — two concurrent
  callers both see an empty table.
- **Three outcomes.** Approve, reject with a reason that routes back into
  planning, or approve with edits.
- **Owner-only.** An approval can only be decided by the person it was raised
  for.

### What approval actually does

`commitPlan` performs three real effects, none of which require the user to be
signed in to anything external:

1. The plan is persisted to a shareable URL.
2. An `.ics` file is generated — calendar integration with no OAuth scope.
3. Future notifications are scheduled at the plan's own milestone times.

The third is what justifies the gate: approving means the system will act later,
on its own, without the user present.

Google Calendar writes are a fourth, optional effect. `calendar.events` is a
sensitive scope — an unverified app shows a security warning and is capped at
100 users for the project's lifetime — so it sits behind a Connect button rather
than on the critical path.

Booking and payment are simulated and labelled as such. An approval gate
guarding a `console.log` would be theatre; the rest of these are real writes.

---

## Scheduling

Reminders are drained by `POST /tick`, called by a GitHub Actions cron.

The trigger is external because free hosting sleeps when idle: an in-process
timer would not fire late, it would not fire at all, and the autonomous
behaviour that justifies the approval gate would quietly stop existing. One ping
drives the schedule and wakes the host.

`/tick` drains everything due rather than assuming it ran on time, since cron is
best-effort. Claiming is a single `UPDATE … RETURNING` with `SKIP LOCKED`, so
two overlapping ticks cannot both deliver the same reminder.

---

## Data

| Table | Holds |
|---|---|
| ADK-managed | sessions, events, app and user state |
| `users`, `password_resets` | accounts and reset tokens |
| `user_preferences` | one row per user per key |
| `pending_approvals` | what is waiting, and the ids needed to resume |
| `executed_actions` | the idempotency ledger |
| `plans`, `scheduled_notifications` | committed plans and their reminders |
| `conversations` | titles for the history sidebar |
| `calendar_connections` | Google refresh tokens, server-side only |

Everything is created on first use, so there are no migrations to run.

Preference writes are a single `INSERT … ON CONFLICT DO UPDATE`, so correctness
is enforced by the database rather than by a read-modify-write that has to be
serialised by hand — which matters because the research stage is a
`ParallelAgent` and concurrent writes are the normal case.

---

## Tool layer rules

- **Missing data stays missing.** Where a provider returns null, the tool returns
  null. Substituting a plausible number produces values nothing downstream can
  detect as wrong.
- **No model runs inside a tool**, so no tool result can be invented. Product
  search returns listings with no price rather than guessing one from a title.
- **Tools never throw across the agent boundary.** They return
  `{ ok, data | error }`, because a model recovers from an error object far
  better than a parallel branch recovers from an exception.
- **Providers sit behind thin adapters.** Swapping one is a single file.
- **Model names appear in one file.** Any agent hardcoding a model id is a bug.
- **Anything with a real side effect lives in `actions/`**, never in `agents/`.
  Agents decide; actions execute. That separation is what makes the blast radius
  reviewable.

---

## Frontend

The activity feed turns raw events into sentences. `transfer_to_agent`,
argument objects and internal agent names are the inside of the machine; the
feed says "Checking the 3-day forecast for Lisbon" and keeps the payload one
click away.

Answers are markdown — headed sections, bullet lists, budget tables — rendered
by walking marked's token tree into React elements. Nothing passes through
`dangerouslySetInnerHTML`, which matters because model output is ultimately
shaped by whatever a web search returned.

Identity comes from a signed token carried on every request.

The planner itself is visible without an account — the sign-up is asked for at
the point of running a goal, not at the door, and the typed goal is held and
started automatically once the account exists. Showing the product before asking
for an email is worth more than the handful of visitors who bounce at the form.
