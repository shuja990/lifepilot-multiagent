# LifePilot — Build Plan (TypeScript)

Multi-agent personal planning assistant on Google ADK for TypeScript (`@google/adk`).
Portfolio project, optimised for **near-zero running cost** and **maximum visible sophistication**.

Status: **Phases 0–4 complete**, verified against live APIs. Phases 5–8 outstanding.

Phase 4 was pulled forward: Phase 3's graph could not run without failover,
because a free-tier model being briefly unavailable stops the whole pipeline at
its first agent.
**Stack is TypeScript end-to-end — no Python anywhere.**

Start at §6 Phase 0. Everything before it is the reasoning behind the decisions;
everything after it is what to watch out for.

---

## 1. What this actually has to prove

The recruiter/client looking at this repo needs to see four things working *live*, not described:

1. **Real orchestration** — a graph of specialised agents, not one prompt with tools bolted on.
2. **Real tools** — actual API calls returning real data (weather, places, prices, FX), not stubs.
3. **Model routing** — the same agent graph running across ≥3 providers, chosen per task.
4. **Human-in-the-loop** — an action that *stops and waits* for approval, and on approval
   does something **real and autonomous** (§4.3), not a logged stub.

Everything else (auth, polish, multi-tenant) is secondary. If the budget forces a cut,
cut features — never cut one of those four, because they are the demo.

---

## 2. What TypeScript changes

`@google/adk` is the official Google TS SDK (not a community port), **v1.6.0 as installed**,
and publishing frequently. Verified as shipping in the TS package:

| Capability | TS status |
|---|---|
| `LlmAgent`, `Runner.runAsync()` event stream | ✅ ships |
| `SequentialAgent`, `ParallelAgent`, `LoopAgent` | ✅ ships |
| `LongRunningFunctionTool` (the HITL primitive) | ✅ ships |
| `InMemorySessionService` / `InMemoryMemoryService` | ✅ ships |
| `DatabaseSessionService` (MikroORM: Postgres/MySQL/SQLite) | ✅ ships (`core/src/sessions/database_session_service.ts`) |
| `LOAD_MEMORY` / `PRELOAD_MEMORY` memory tools | ✅ ships |
| `RoutedLlm` + `LlmRouter` (native model routing w/ failover) | ✅ ships |
| `LLMRegistry`, `BaseLlm` (custom provider interface) | ✅ ships |
| Zod-typed tool parameters | ✅ ships |
| `@google/adk-devtools` local trace/inspection UI | ✅ ships |
| **Anthropic / OpenAI / LiteLLM model classes** | ❌ **do not ship** |

**The one real gap: non-Gemini providers.** LiteLLM is a Python library and has no TS
equivalent in the SDK. The shipped model implementations are Gemini (`google_llm.ts`) and
Apigee gateway (`apigee_llm.ts`) — that's it.

**This is good news, and §3.2 explains why.** The workaround is better portfolio material
than the Python one-liner it replaces.

Two other consequences, both mild:
- Tool params are **Zod schemas**, not Pydantic. Those exact schemas get shared with the
  frontend — a genuine TS advantage Python could not offer (see §4).
- ADK's persistence layer is **MikroORM**. Use it for the app's own tables too rather than
  adding Prisma/Drizzle alongside it — one ORM, one migration story.

---

## 3. Cost decisions

### 3.1 Google Places — drop it

Google retired the pooled $200/month credit in March 2025. It is now per-SKU free counts:
~10,000 calls/month for Essentials, 5,000 for Pro, 1,000 for Enterprise, no pooling, no
rollover. Place Details / Text Search sit in the Pro and Enterprise bands, so a chatty
agent firing 3–5 place lookups per turn burns the free band fast.

**Decision: use Geoapify Places as the primary POI/geocoding tool.**

- OSM-derived, global, free plan is **3,000 credits/day, no credit card**.
- 1 credit per request + 1 per extra 20 results returned.
- One key covers Geocoding, Places, Place Details, Routing — one integration, four tools.
- Tradeoff, stated plainly: **no user reviews, no ratings, no photos.** OSM completeness
  varies by region. Fine for "find 5 cafés near the venue"; not for "which is rated highest".

**Fallback for ratings-shaped questions:** let the Research agent answer them via web
search (Tavily) rather than pretending the POI API has ratings. Honest, and it demos tool
selection — a better story than a ratings column.

**Zero-cost escape hatch:** Nominatim (geocoding) + Overpass (POI) need no key at all.
Hard rate limits and a usage policy that forbids heavy automated traffic, so keep them as
the documented fallback, not the default.

*Not chosen:* Foursquare — after their June 2026 repricing it is ~$15/1,000 calls beyond
500 free/month. Rich data, wrong price for a portfolio piece.

### 3.2 The LLMs — and the adapter you're going to write

Do **not** default to Claude or GPT. Wire them, route to them, don't let the happy path spend.

| Tier | Model | Cost | Used for |
|---|---|---|---|
| Default (free) | **Gemini Flash / Flash-Lite** | Free tier, ~1,500 req/day | Every agent's default. Native `Gemini` class, no adapter. |
| Fast/cheap (free) | **Groq** (Llama-class) | Free tier | High-fan-out, low-judgement work: extraction, classification. Sub-second. |
| Cheap paid | **DeepSeek V4-Flash** | ~$0.14/M in, ~$0.28/M out | Long-context reasoning when Gemini free tier rate-limits. ~$2–3 covers months. |
| Premium (off by default) | Claude / GPT via **OpenRouter** | Real money | Router *can* select it; `PREMIUM_ENABLED=false` in the deployed demo. |

Two facts that shape this:
- Gemini **Pro-series went paid-only around April 2026** — the free tier is Flash and
  Flash-Lite only. Every agent must be *good enough on Flash*. If an agent only works on
  Pro, that agent's prompt is the bug.
- Free-tier Gemini prompts **may be used to improve Google products**. Fine for a demo;
  put a line in the README and never send real personal data through it.

#### The centrepiece: `OpenAICompatibleLlm extends BaseLlm`

Since ADK-TS ships no third-party model classes, you implement `BaseLlm` yourself and
register it. Groq, DeepSeek, and OpenRouter are **all OpenAI-compatible**, so **one
adapter class (~200–250 lines) unlocks all three providers** — plus Ollama/vLLM/Azure for free.

```ts
// apps/api/src/models/openai-compatible.ts
import { BaseLlm, LLMRegistry, type LlmRequest, type LlmResponse } from '@google/adk';

export class OpenAICompatibleLlm extends BaseLlm {
  constructor(private cfg: { model: string; baseUrl: string; apiKey: string }) { super(); }
  async *generateContentAsync(req: LlmRequest, stream = false): AsyncGenerator<LlmResponse> {
    // map ADK LlmRequest -> OpenAI chat/completions (incl. tool declarations)
    // stream SSE back, map deltas + tool_calls -> LlmResponse
  }
}

LLMRegistry.register(/^(groq|deepseek|openrouter)\//, OpenAICompatibleLlm);
```

Why this is the right call rather than a shortcut:
- The community `adk-llm-bridge` package does this already, but it sits at ~13 stars.
  **Read it as reference; don't make it the backbone of the headline feature.** A
  13-star dependency breaking is a bad way to lose a portfolio demo.
- Implementing a framework's model interface — request/response mapping, streaming deltas,
  tool-call translation — is the **most senior-looking code in the whole repo**. In Python
  this was `LiteLlm(model="groq/...")`, a one-liner nobody is impressed by.
- Budget ~1 day and write real tests for it. It is the highest-value day in the plan.

#### Routing: use `RoutedLlm`, it's native

ADK-TS ships `RoutedLlm` with an `LlmRouter` signature — model selection per request, with
automatic failover and `errorContext.failedKeys` so a failed model isn't re-picked:

```ts
type LlmRouter = (
  models: Readonly<Record<string, BaseLlm>>,
  request: LlmRequest,
  errorContext?: { failedKeys: ReadonlySet<string>; lastError: unknown },
) => Promise<string | undefined> | string | undefined;
```

This is *literally* the "intelligent model routing" in the brief, and it's a first-class
primitive rather than something you bolt on. It gives you quota-failover for free, which
directly de-risks the biggest operational threat in §8 (burning Gemini's daily quota
mid-demo). Router policy lives in `config/models.ts` and nowhere else.

There is also `RoutedAgent` for when instructions/tools/sub-agents vary, not just the model.

**Per-agent model policy:**

| Agent | Model | Why |
|---|---|---|
| Orchestrator, Intake | Gemini Flash | Instruction-following + function calling; free |
| ResearchSwarm members | Groq | High volume, low judgement, latency-sensitive; free |
| Recommender, Planner | Gemini Flash | Judgement work, Flash handles it |
| Budget | Gemini Flash, `temperature: 0` | Arithmetic — never let this be creative |
| Verifier | DeepSeek (or Claude if `PREMIUM_ENABLED`) | Deliberately a **different provider** from the author, so critique isn't self-confirming |

The Verifier-on-a-different-provider choice deserves a README paragraph. It is a real
engineering argument, not a gimmick, and it justifies multi-LLM far better than "we
support many models".

Add a UI provider selector that forces the whole graph onto one provider — that's the
multi-LLM demo made tangible in about 20 lines.

### 3.3 Everything else — free, no card

| Need | Service | Terms |
|---|---|---|
| Web search | **Tavily** (`@tavily/core` JS SDK) | 1,000 credits/month, no card |
| Weather | **Open-Meteo** | Free, no key, no card |
| Currency | **ExchangeRate-API** (open endpoint) | Free, no key, 160+ currencies |
| Places / geocoding | **Geoapify** | 3,000 credits/day free |
| Calendar out | **`ics` npm** (file generation) | Free, no OAuth, no scopes — the default path (§4.3) |
| Calendar sync | **Google Calendar API** (`googleapis` npm) | Free, but sensitive scope + unverified-app cap — optional upgrade only |
| Notifications | **`web-push` (VAPID)** | Free, self-hosted, no third party |
| Scheduler | **GitHub Actions cron → `POST /tick`** | Free on public repos; also wakes the sleeping Space |
| Database | **Neon Postgres** | Free: 100 projects, 0.5 GB each, branching, scale-to-zero |
| Backend host | **HF Spaces (Docker)** or **Render free** | See §7 |
| Frontend host | **Vercel** | Free hobby tier |

*Avoid:* Brave Search API — free tier killed Feb 2026, replaced with $5/month credits
against a saved card. Render's free Postgres — **expires after 90 days** and will silently
kill your demo months from now. Use Neon.

**Product search is the one genuinely awkward tool.** No good free structured product API
exists. In order of preference:
1. eBay Browse API — free developer keyset, real listings. *Assumption: still free at demo
   volumes; confirm on their developer portal before committing a milestone to it.*
2. Tavily search scoped to retail domains + an LLM extraction pass into a **Zod schema**.
   Fuzzier, but zero extra signup and it demos structured extraction.

Ship option 2 first (no new account), add option 1 if the free keyset checks out.

---

## 4. Architecture

### 4.1 Agent graph

```
                       ┌─────────────────────┐
   user goal  ────────▶│  Orchestrator       │  LlmAgent, Gemini Flash
   (natural language)  │  (root)             │  routes by goal type
                       └──────────┬──────────┘
                                  │
                       ┌──────────▼──────────┐
                       │  IntakeAgent        │  clarifies goal → typed GoalSpec (Zod)
                       │  + PRELOAD_MEMORY   │  pulls user prefs from memory
                       └──────────┬──────────┘
                                  │
                       ┌──────────▼──────────┐
                       │  ParallelAgent      │  fan-out, concurrent
                       │  "ResearchSwarm"    │
                       └──────────┬──────────┘
                    ┌─────────────┼─────────────┬──────────────┐
              WebResearch    PlaceResearch   PriceResearch   ContextAgent
              (Tavily)       (Geoapify)      (eBay/extract)  (weather+FX)
                    └─────────────┼─────────────┴──────────────┘
                                  │  findings merged into session state
                       ┌──────────▼──────────┐
                       │  SequentialAgent    │
                       │  "PlanPipeline"     │
                       └──────────┬──────────┘
                 ┌────────────────┼────────────────┐
          RecommenderAgent   BudgetAgent      PlannerAgent
          (ranks options)    (costs + FX)     (itinerary/schedule)
                 └────────────────┼────────────────┘
                                  │
                       ┌──────────▼──────────┐
                       │  LoopAgent          │  maxIterations: 2–3
                       │  VerifierAgent      │  critiques → escalate to exit
                       └──────────┬──────────┘
                                  │
                       ┌──────────▼──────────┐
                       │  ActionAgent        │  LongRunningFunctionTool
                       │  ⏸ HUMAN APPROVAL   │  suspends, waits for user decision
                       └─────────────────────┘
```

Why these primitives:
- `ParallelAgent` for research — four concurrent tool calls is a visible latency win and
  makes the live "agents working" UI genuinely interesting to watch.
- `SequentialAgent` for the pipeline — recommend → budget → schedule has a hard dependency
  order; state flows via `outputKey`.
- `LoopAgent` for verification — the piece most portfolio agent projects skip, and the one
  that visibly improves output. Exit via an `escalate: true` event from a small custom
  `BaseAgent` checker. Cap `maxIterations`, or Flash free-tier quota evaporates.
- `LongRunningFunctionTool` for approval — the ADK-native HITL mechanism. The tool returns
  `{ status: 'pending', ... }`, the run suspends, and the UI resumes it with the decision.
  Do not fake this with a boolean prompt.

### 4.2 The approval lifecycle — what happens *after* the human says yes

The pause is the easy half. This is the half that makes or breaks the feature.

**Mechanically it resumes, it does not re-run.** The flow is a multi-turn exchange on the
same session:

1. Agent calls the approval tool. The event carries `event.longRunningToolIds` — that's
   your signal to render the approval UI instead of a normal tool card. **Capture the
   `functionCall.id`** and the `invocationId`, and persist both.
2. Run suspends. Nothing is executing. State lives in Postgres.
3. Human decides in the UI, possibly minutes or days later.
4. You send a `FunctionResponse` back with **the same `functionCall.id`**, wrapped in a
   `Content` with `role: 'user'`, through `runner.runAsync()`:

```ts
// apps/api/src/server.ts — POST /approve
const decision = { status: 'approved', bookingRef, approvedBy, approvedAt };
await runner.runAsync({
  userId, sessionId,
  invocationId: saved.invocationId,          // ⚠️ see trap below
  newMessage: {
    role: 'user',
    parts: [{ functionResponse: { name: 'ask_for_approval', id: saved.functionCallId, response: decision } }],
  },
});
```

The agent picks up with the decision in context and proceeds to the real action. It does
**not** re-plan, re-research, or re-spend tokens on everything upstream.

> **⚠️ The trap:** with ADK's Resume feature you must pass the **`invocationId` matching the
> one that produced the approval request**. If it doesn't match, ADK **starts a brand-new
> invocation** — silently. Symptom: approval "works" but the agent appears to start over
> and re-runs the whole research swarm. Persist `invocationId` alongside `functionCallId`
> in the same row, and this never bites you.

**Three outcomes, not two.** A binary approve/reject is a weak demo:

| Decision | Behaviour |
|---|---|
| **Approve** | Resume; ActionAgent executes the real side effect (§4.3). |
| **Reject (with reason)** | Resume with `{ status: 'rejected', reason }`. The reason must route **back into PlanPipeline**, not dead-end in an apology. "Too expensive" → BudgetAgent re-runs with a tighter cap. This is the single most impressive thing the approval flow can do. |
| **Edit, then approve** | Resume with `{ status: 'approved', modifications }`. The schema-driven modal (§4.5) makes this nearly free — the user edits the same Zod-validated object the tool already declares. |

**Idempotency is mandatory, not polish.** The action is by definition consequential, and
there are three ways to fire it twice: the user double-clicks Approve, the browser retries,
or the process restarts mid-execution and replays. Every action carries an idempotency key
(`sessionId + functionCallId`), the executed-actions table has a unique constraint on it,
and the ActionAgent's tool checks it before executing. A demo that double-books is a worse
look than one with no booking at all.

### 4.3 What "go ahead" should actually *do*

Do not fake-book a hotel, and do not spend real money. But **do not simulate everything
either** — an approval gate guarding a `console.log` is theater and a reviewer will spot it.

An approval gate is only justified when the action is **outward-facing, durable, or
autonomous**. That is the bar the action has to clear.

#### ❌ Not Google Calendar as the default path

Calendar-write looked like the obvious primary action, but it fails the demo's hardest
constraint — *a stranger with a link and no account must be able to complete the flow*:

- `calendar.events` is a **sensitive scope**. An unverified app shows the "Google hasn't
  verified this app" warning **before** the consent screen. Nobody grants calendar write
  to an unknown portfolio app after seeing that.
- Unverified apps are capped at **100 new users for the lifetime of the project**, and the
  cap cannot be reset. In `Testing` publishing status you must add each user's email by hand.

Keep Google Calendar as an **optional "Connect Google" upgrade** that you exercise in a
recorded demo video. Do not put it on the critical path.

#### ✅ The recommendation: one `commitPlan` action, three real effects

| # | Effect | Login needed? | Why it earns the gate |
|---|---|---|---|
| **A** | Persist the plan to a **permanent, publicly shareable URL** | None | Real durable write. Outward-facing — the plan becomes something you can send to someone. |
| **B** | Generate **`.ics` + PDF** itinerary | None | Real artifacts. The `.ics` is calendar integration **without any OAuth scope** — the user imports it into whatever calendar they already use. |
| **C** | **Schedule real future notifications** at the plan's own milestone times | None | The one that actually matters. Approving causes the system to act **later, autonomously, without you**. That is a genuinely consequential capability and it cannot be faked. |

**C is the star.** "Approve → your phone buzzes 30 seconds later with the first itinerary
step" is a demo nobody forgets, and it is the honest justification for a human gate: you
are authorising the agent to act on its own in the future.

Delivery for C is **Web Push (VAPID, `web-push` npm)** — free, no email address, no spam
vector (push only reaches the device that subscribed), one browser permission click.

> **iOS caveat:** Safari delivers Web Push only to **installed PWAs** (Add to Home Screen).
> So never let push be the *only* evidence the scheduled action fired — the plan page must
> also show `notification sent 14:03 ✓` from the DB. Push is the delight; the timeline
> entry is the proof. Offer email as an opt-in second channel.

#### It generalises across all four goal types

One tool, four goal shapes — worth stating in the README, because it shows the design isn't
trip-planner-shaped with the rest bolted on:

| Goal type | What `commitPlan` schedules |
|---|---|
| **Trip** | Milestone nudges ("book the flight by Friday"), `.ics` of the itinerary |
| **Buying a product** | Price-watch checks → "target price hit" push |
| **Organising an event** | `.ics` + shareable invite URL for guests |
| **Managing a budget** | Recurring check-ins at budget checkpoints |

#### Still simulated, and labelled as such

**Booking and payment stay simulated**, clearly marked in the UI. Nobody expects a portfolio
to charge a card. Saying plainly which actions are real and which are simulated reads as
judgement, not as a missing feature.

#### Infrastructure consequence — read before Phase 6

Scheduled notifications need something to fire them, and **HF Spaces free tier sleeps after
~48h of inactivity**, so an in-process `setTimeout` or node-cron will silently not run.

Use a **GitHub Actions scheduled workflow** hitting a `POST /tick` endpoint that drains due
notifications. Free on public repos (this one is public), and it wakes the sleeping Space as
a side effect — one mechanism solving both problems. Two caveats: GH Actions cron is
best-effort and can be delayed several minutes under load (fine here — don't promise
to-the-second delivery), and scheduled workflows are disabled after a long period of repo
inactivity, so `/tick` must be idempotent and catch up on a backlog rather than assuming it
runs exactly once per interval.

### 4.7 Prompt caching — what applies, and what does not

**Implicit caching is already active and already free.** It is on by default for
Gemini 2.5 and newer (we run 3.6-flash and 3.5-flash-lite), gives a **90%
discount on cached input tokens**, and has **no storage cost**. The minimum
cacheable prefix is around 1,024 tokens on Flash. Nothing needs enabling.

**But our prompts are currently built backwards for it.** Implicit caching
matches on a shared *prefix*. The pipeline agents are assembled as:

```
FINDINGS_BLOCK   <- changes every single run
...task text...
HONESTY_RULES    <- identical across every agent and every run
```

The stable part sits at the end, where a prefix match can never reach it, so
every agent pays full price for text that never changes. **Fix: put the constant
block first** — HONESTY_RULES, then task text, then the per-run findings last.
That is a reordering, not a rewrite.

**It will NOT fix the free-tier quota problem.** Free-tier limits are counted in
requests per day, not tokens, so a cache hit still burns a request. Caching buys
latency and cost, not headroom. The fix for quota is fewer agent calls — which
is what the orchestrator addresses.

**It does not apply to Groq at all.** Its 8,000 tokens-per-minute ceiling counts
the full request either way, so caching cannot rescue the fan-out tier there.
That constraint is why research runs on Flash-Lite.

**Explicit caching (`cachedContent`) is available but probably not worth it
here.** `GenerateContentConfig.cachedContent` is exposed by the genai SDK and
reachable through `LlmAgent.generateContentConfig`, so wiring it is easy. It
guarantees the 90% discount rather than hoping for a prefix hit, but it bills
storage — roughly **$1.00 per million tokens per hour** on Flash. For bursty
demo traffic, storage would likely cost more than it saves. Revisit only if a
large system prompt gets reused continuously.

**Measure, do not assume.** `usageMetadata.cachedContentTokenCount` reports how
many tokens actually came from cache. The trace layer already reads
`usageMetadata`, so surfacing cache hits per call turns this from a claim into a
number — worth doing in Phase 7 beside the token counts the UI already shows.

**Verdict: do the prompt reordering in Phase 7 and measure it. Skip explicit
caching** unless the numbers say otherwise.

### 4.4 Memory and preferences

- **Session state** (within a run): ADK session state, `outputKey` between agents.
- **Persistence**: `DatabaseSessionService` against Neon Postgres (MikroORM under the hood).
  Locally, SQLite via the same service — no code change, just a connection string.
- **Long-term memory**: `InMemoryMemoryService` for dev; for production either
  `VertexAiMemoryBankService` (GCP, has cost) or — better for this project — **your own
  `BaseMemoryService` against the same Neon DB**. Same argument as the model adapter: a
  small, self-contained implementation of a framework interface is strong portfolio code,
  and it keeps you off GCP billing.
- Preferences are **written explicitly**, never silently inferred. When Intake learns
  something durable ("always economy", "vegetarian", "budget in PKR"), it calls a
  `savePreference` tool. Visible, auditable, deletable in the UI.

### 4.5 The TypeScript payoff: one schema, both ends

Every tool's params are Zod schemas. Put them in a shared workspace package and the
frontend imports the *same* objects:

```
packages/shared/src/schemas.ts   →  backend: ADK tool parameters
                                 →  frontend: approval-modal form + validation
                                 →  both:    inferred TS types, zero drift
```

An approval modal that renders straight from the tool's own schema — so adding a tool
automatically gets a correct approval UI — is a thing the Python version structurally
could not do. Lead with it in the README.

### 4.6 Streaming agent activity to the UI

```
runner.runAsync() → async generator of Events → Hono SSE endpoint → EventSource → timeline UI
```

Render each event as a timeline card: agent name, **model badge colour-coded per provider**,
tool called, arguments, duration, result summary, token count. This UI *is* the portfolio
piece — the plan output is generic, the visible orchestration is not. The provider colour
badges are what make multi-model routing legible at a glance.

---

## 5. Stack and layout

**Backend** — Node 20+, TypeScript strict, `@google/adk`, **Hono** (tiny, first-class SSE,
runs anywhere), MikroORM + Postgres, Zod everywhere.

**Frontend** — Next.js App Router + Tailwind + shadcn/ui on Vercel. Shell is server-rendered;
the agent stream is a client component on `EventSource`.

**Monorepo** — npm workspaces:

```
lifepilot/
├── docs/PLAN.md
├── package.json                     # npm workspaces: apps/*, packages/*
├── .github/workflows/tick.yml       # cron → POST /tick (§4.3)
├── packages/
│   └── shared/src/schemas.ts        # Zod schemas + inferred types, used by BOTH ends
└── apps/
    ├── api/
    │   ├── src/
    │   │   ├── config/
    │   │   │   └── models.ts        # ← ONLY place model names + router policy live
    │   │   ├── models/
    │   │   │   └── openai-compatible.ts   # BaseLlm impl — the centrepiece (§3.2)
    │   │   ├── agents/                  # one file per agent, no cross-imports
    │   │   │   ├── orchestrator.ts  intake.ts  research/
    │   │   │   ├── recommender.ts  budget.ts  planner.ts
    │   │   │   ├── verifier.ts  action.ts
    │   │   │   └── pipeline.ts          # composes Sequential/Parallel/Loop
    │   │   ├── tools/                   # one file per external API, each CLI-runnable
    │   │   │   ├── search.ts  places.ts  weather.ts  currency.ts
    │   │   │   ├── products.ts  preferences.ts
    │   │   │   ├── approval.ts          # LongRunningFunctionTool (§4.2)
    │   │   │   └── commit-plan.ts       # the approved action (§4.3)
    │   │   ├── actions/                 # what commit-plan actually performs
    │   │   │   ├── persist.ts           # A: shareable plan URL
    │   │   │   ├── ics.ts  pdf.ts       # B: downloadable artifacts
    │   │   │   ├── schedule.ts          # C: queue future notifications
    │   │   │   └── notify.ts            # C: web-push delivery (VAPID)
    │   │   ├── memory/                  # session + preference services
    │   │   └── server.ts                # Hono: /chat (SSE), /approve, /prefs,
    │   │                                #       /plan/:id, /tick
    │   ├── tests/
    │   └── Dockerfile
    └── web/                             # Next.js on Vercel
```

Three rules that will save the project later:
- **Model names appear in exactly one file** (`config/models.ts`). Any agent hardcoding
  `'gemini-...'` is a bug.
- **Every tool is runnable standalone** (`npm run tool:places -- "cafes in Lahore"`).
  You will debug tools far more than agents, and shouldn't need an LLM in the loop to do it.
- **`strict: true`, no `any` in tool boundaries.** ADK derives function declarations from
  your Zod schemas; sloppy schemas produce sloppy tool calls. This is the TS equivalent of
  the Pydantic discipline and it matters just as much.
- **Anything with a real side effect goes in `actions/`, never in `agents/`.** Agents decide;
  actions execute. That separation is what makes the approval gate auditable — there is
  exactly one directory to read to answer "what can this thing actually do to the world?"

---

## 6. Milestones

**Decisions locked** — if you change one of these, the phases below change with it:
TypeScript + `@google/adk` (pinned exact) · Geoapify over Google Places · Gemini Flash
default with a hand-written `OpenAICompatibleLlm` covering Groq/DeepSeek/OpenRouter ·
`RoutedLlm` for routing and quota failover · Neon Postgres via `DatabaseSessionService` ·
`commitPlan` (shareable URL + `.ics`/PDF + scheduled push) as the approved action ·
Hono API on HF Spaces, Next.js on Vercel.


Each phase has a pass/fail check to run before moving on.

**Phase 0 — Tool layer, no agents** — ✅ **DONE**
Six tools as plain async functions with Zod-validated returns; schemas in
`packages/shared`, implementations in `apps/api/src/tools`, all CLI-runnable.
*Check passed:* every tool executed against its live API and returned typed data.
Latencies recorded in the README (weather 1.7s · currency 0.4s · geocode 0.9s ·
places 1.3s · search 2.5s · products 3.9s · prefs 5ms).

**What Phase 0 changed in this plan — the reason it goes first:**
- **Frankfurter is out, ExchangeRate-API is in.** Frankfurter serves ECB reference rates,
  which cover ~30 currencies and **do not include PKR** — the demo's home currency. It
  returned a bare 404. Swapped to `open.er-api.com` (166 currencies, no key, PKR present).
  Cost: one file, because providers sit behind thin adapters. This is the single best
  argument for tools-before-agents — a plan review would never have caught it.
- **Geoapify coverage for the demo city is fine.** The §8 risk "data too thin for the demo
  city" is retired: real named cafés with addresses and distances came back for Islamabad.
- **ADK is at 1.6.0**, not the ~1.4.x the plan assumed. Pinned exact.

**Phase 1 — Single agent, real tools (≈half day)**
One `LlmAgent` on Gemini Flash with all tools. Inspect with `@google/adk-devtools`.
*Check:* "plan a weekend in Islamabad under 20k PKR" gives a coherent answer using ≥3 real
tool calls. **Save this output** — it's the baseline Phase 2 must beat.

**Phase 2 — The `BaseLlm` adapter (≈1 day)** ← *the differentiator*
`OpenAICompatibleLlm`, registered via `LLMRegistry`, working against Groq + DeepSeek +
OpenRouter. Unit-test request mapping, streaming deltas, and tool-call translation.
*Check:* the Phase 1 agent runs unchanged on all three providers **including tool calls**.
Tool calling is where OpenAI-compat adapters break — test it explicitly, not just chat.

**Phase 3 — The agent graph (≈2 days)**
Split into the §4.1 graph: ParallelAgent research, SequentialAgent pipeline, LoopAgent verifier.
*Check:* (a) research calls run concurrently — visible in timestamps, (b) the verifier
rejects at least one draft on some input, (c) output beats the Phase 1 baseline side-by-side.
If multi-agent isn't better, the prompts are wrong — fix that before adding anything.

**Phase 4 — `RoutedLlm` routing + quota failover (≈half day)**
Router policy in `config/models.ts`; Gemini 429 → automatic DeepSeek failover.
*Check:* revoke/expire the Gemini key mid-run and the graph completes on the fallback
provider. This is both the demo *and* the production safety net.

**Phase 5 — Persistence + memory (≈1 day)**
`DatabaseSessionService` on Neon, preference read/write tools, resume-a-session.
*Check:* set a preference in session A, start session B fresh, and the plan respects it.

**Phase 6 — Human-in-the-loop (≈1.5 days)**
`LongRunningFunctionTool` approval; `/approve` resumes the run per §4.2. Persist
`functionCallId` **and** `invocationId`. Three outcomes (approve / reject-with-reason /
edit-then-approve). Idempotency key with a unique constraint. The approved action is the
`commitPlan` action of §4.3 — shareable plan URL, `.ics` + PDF, and a scheduled
future notification drained by `POST /tick`.

*Checks — all five must pass, they catch different bugs:*
1. **Suspend:** a booking-shaped request halts in a pending state and executes nothing.
2. **Restart-safe:** kill the process mid-approval, restart it, approve — the run still
   resumes from the DB. If approval state lives in a JS `Map`, this feature is a prop.
3. **Resumes, not restarts:** on approve, the research swarm does **not** re-run. If it
   does, your `invocationId` isn't matching and ADK has silently opened a new invocation.
4. **Idempotent:** double-click Approve → exactly one plan record and one scheduled job.
5. **Autonomous:** the scheduled notification actually fires later via `/tick`, and the plan
   page shows it was sent. This is the part that makes the gate meaningful — test it with a
   milestone 60 seconds out, not 3 days out.

**Phase 7 — Frontend + deploy (≈2–3 days)**
SSE timeline with provider colour badges, schema-driven approval modal (approve /
reject-with-reason / edit), preferences panel, provider selector, the public
`/plan/:id` page, and the push opt-in prompt. Deploy.
*Check:* a stranger with the URL, **no account and no sign-in**, completes a full plan
including an approval, on a phone. If any step asks them to log in, the demo has failed.

**Phase 8 — README, and it matters**
Architecture diagram, the `BaseLlm` adapter write-up, the model-routing rationale, real
cost-per-plan numbers from Phase 0, Phase 1 vs Phase 3 output comparison, honest limitations
(no place ratings, Flash-tier quality ceiling, free-tier data usage, which actions are real
vs simulated). The honesty section separates a portfolio project from a tutorial follow-along.

Roughly **10–12 focused days** — about two more than the Python version would have taken,
spent on the `BaseLlm` adapter and the richer approval flow. Both buy you the best code in
the repo, so it is a good trade.

**If time runs short, cut in this order:** Phase 8 polish → Phase 7 visual polish (keep the
timeline, drop the badges/selector) → Phase 5 long-term memory (keep session persistence,
it is load-bearing for Phase 6). **Never cut Phases 0–4 or 6** — those are the four things
§1 says this project exists to prove.

---

## 7. Deployment

**Backend — Hugging Face Spaces (Docker), free tier.** 2 vCPU / 16 GB, no card, and a
public URL that reads as an AI project. Node in Docker is fine there. Constraints to design
around: **only `/tmp` is writable** (hence external Postgres, which you have anyway), and
free CPU Spaces **sleep after ~48h of inactivity** — cold start on the recruiter's first
click. Mitigate with a free uptime pinger, and render the landing page instantly from
Vercel so the backend wake happens behind a loading state, not a blank screen.

*Alternative:* Render free web service — same sleep problem, less "AI-native" URL. Either is
fine; just **do not use Render's free Postgres** (90-day expiry).

**Frontend — Vercel free. Database — Neon free** (scale-to-zero adds ~100–300 ms to the
first query after idle; irrelevant here).

**Why not put everything in Next.js API routes on Vercel?** Tempting in an all-TS stack, but
a LoopAgent run with parallel research routinely exceeds Vercel Hobby's function duration
limits, and SSE through serverless is a poor fit for multi-minute agent runs. Keep the agent
runtime as a long-lived Node process. Revisit only if runs land consistently under ~30s.

**Secrets:** HF Space secrets / Vercel env vars. `.env.example` listing every var with a
comment on where to get the free key is the highest-value 15 minutes of README work —
it's what makes the project reproducible.

---

## 8. Risks, and what tells you early

| Risk | Signal to watch | Response |
|---|---|---|
| **Tool calling breaks on the OpenAI-compat adapter** | Phase 2 check fails on tools but passes on chat | The likeliest failure in the whole plan. Providers differ on `tool_calls` streaming deltas and parallel tool calls. Test per-provider; normalise in the adapter, never in agents. |
| **Gemini free-tier RPD exhausted mid-demo** (~1,500/day; a LoopAgent run costs 10–15 calls) | 429s in logs | Exactly what Phase 4's `RoutedLlm` failover exists for. Build it in Phase 4, not after it breaks. Cap loop iterations at 2. |
| **Geoapify data too thin for the demo city** | Sparse/empty POI results in Phase 0 | Test with *your* demo cities on day one. If Lahore/Islamabad OSM coverage is weak, that changes the tool choice — which is why tools are Phase 0. |
| **Multi-agent slower and no better than single-agent** | Phase 3 check fails | A real possibility. The fix is prompt specialisation, not more agents. Keep the Phase 1 baseline to settle it either way. |
| **HITL approval only works in-process** | Phase 6 check 2 fails | Persist approval state to Postgres keyed by session + invocation id. Never a JS `Map`. |
| **Approve silently starts a NEW invocation instead of resuming** | Phase 6 check 3 — agent re-runs the whole research swarm after approval | A mismatched (or missing) `invocationId` on the resume call. ADK does not warn; it just opens a fresh invocation. Persist `invocationId` next to `functionCallId` in the same row. See §4.2. |
| **Scheduled notifications never fire** | Phase 6 check 5 — nothing arrives at the milestone time | HF Spaces sleeps after ~48h, so in-process timers die silently. The GH Actions `/tick` cron is the fix, not an optimisation. Make `/tick` drain a backlog, never assume it ran on time. |
| **Approved action fires twice** | Phase 6 check 4 — duplicate plan records or jobs | Idempotency key (`sessionId + functionCallId`) with a DB unique constraint, checked inside the action tool. |
| **ADK-TS is young and moving fast** (~v1.4.x, frequent publishes) | A minor bump breaks a build | **Pin the exact `@google/adk` version.** Do not float `^`. Re-verify against release notes before upgrading; this SDK is newer than its Python sibling. |
| **Provider terms shift again** | Brave's free tier died Feb 2026, Foursquare repriced June, Gemini Pro went paid-only April | Every external service sits behind a thin adapter in `tools/`. Swapping a provider = one file. The single most valuable structural decision here. |
| **Product search has no good free API** | Phase 0 | Ship the Tavily-scoped-search + Zod extraction path. Treat eBay as an upgrade, not a dependency. |

---

## 9. Fact-check status

**Verified against current sources (Aug 2026):** `@google/adk` is the official Google TS
SDK, actively published; TS ships `SequentialAgent`/`ParallelAgent`/`LoopAgent`,
`LongRunningFunctionTool`, `RoutedLlm` + `LlmRouter` (with `errorContext.failedKeys`
failover), `LLMRegistry`, `BaseLlm`, `InMemorySessionService`, `InMemoryMemoryService`,
`LOAD_MEMORY`/`PRELOAD_MEMORY`, Zod tool params, and `@google/adk-devtools`.
`database_session_service.ts` **does** ship in `adk-js` (MikroORM; Postgres/MySQL/SQLite) —
older sources claiming TS is in-memory-only are stale. The shipped model implementations
are Gemini and Apigee only; **no Anthropic/OpenAI/LiteLLM classes in TS**.
Provider facts: Google Places per-SKU free tiers; Geoapify 3,000 credits/day; Foursquare
June 2026 repricing; Brave free-tier removal; Tavily 1,000/month; Gemini free tier
Flash-only with Pro paid-only; DeepSeek V4-Flash pricing; Neon vs Supabase free tiers;
Render free Postgres 90-day expiry; HF Spaces free-tier specs and `/tmp`-only writes.
Approval-flow facts: the resume contract is a `FunctionResponse` carrying the **same
`functionCall.id`**, and ADK's Resume feature requires a **matching `invocationId` or it
silently opens a new invocation**. `calendar.events` is a Google **sensitive scope** —
unverified apps show the warning screen and are capped at **100 new users for the project's
lifetime, non-resettable** — which is why §4.3 keeps Calendar off the critical path.

**Not verified — check before depending on it:** eBay Browse API free-keyset terms; exact
Groq free-tier rate limits (they change often); current Gemini Flash RPD for a *new* key
(Google varies it by account age and verification status); whether `VertexAiMemoryBankService`
has a usable free tier (assumed not — hence the custom `BaseMemoryService`); the precise
iOS Safari's Web Push restriction to installed PWAs (widely reported, but confirm against
the current Safari release before promising push on iPhone in the README); whether GitHub
Actions disables the `tick.yml` schedule after a long quiet period on this repo (design
`/tick` to be backlog-draining so it doesn't matter); the precise
`BaseLlm` method signature in your pinned version (read the `.d.ts` on day one of Phase 2 —
the sketch in §3.2 is illustrative, not copy-paste).

**Sources:**
[ADK TypeScript getting started](https://google.github.io/adk-docs/get-started/typescript/) ·
[@google/adk on npm](https://www.npmjs.com/package/@google/adk) ·
[adk-js repo](https://github.com/google/adk-js) ·
[adk-js session management](https://deepwiki.com/google/adk-js/2.5.2-session-management) ·
[ADK model routing (RoutedLlm)](https://adk.dev/agents/models/routing) ·
[ADK function tools](https://adk.dev/tools-custom/function-tools/index) ·
[ADK sessions](https://adk.dev/sessions/session/index) ·
[adk-llm-bridge (reference only)](https://github.com/pailat/adk-llm-bridge) ·
[Google Places usage & billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing) ·
[Places free-tier limits 2026](https://www.mapsleads.co/blog/google-places-api-free-tier-limits-2026) ·
[Geoapify pricing](https://www.geoapify.com/pricing/) ·
[Places API alternatives 2026](https://dev.to/geoapify-maps-api/google-places-api-alternatives-which-poi-api-should-you-use-in-2026-hd4) ·
[Foursquare pricing 2026](https://openplacesapi.com/compare/foursquare-places-api) ·
[Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) ·
[AI Studio free-tier limits 2026](https://docs.bswen.com/blog/2026-03-23-google-ai-studio-free-tier-limits/) ·
[LLM API pricing Aug 2026](https://costgoat.com/compare/llm-api) ·
[Free search APIs compared](https://www.itechguides.com/7-free-web-search-apis-for-ai-agents-free-tiers-compared/) ·
[Brave free tier removed](https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/) ·
[Neon vs Supabase free tiers](https://agentdeals.dev/neon-vs-supabase) ·
[Free backend hosting tested 2026](https://snapdeploy.dev/blog/free-backend-hosting-2026-apis-servers)
