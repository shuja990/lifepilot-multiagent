# LifePilot

A multi-agent planning assistant built on Google ADK for TypeScript.

Describe a goal in plain language — *"plan a weekend in Lisbon under €400"*,
*"help me buy noise-cancelling headphones"* — and an orchestrator routes it to
the right specialists. They research it in parallel, cost it, put it in order,
check each other's work, and stop for approval before anything with a real-world
effect.

![The agent timeline](docs/screenshots/desktop-timeline.png)

---

## What it does

- **Routes by intent.** A root `LlmAgent` picks between a single-tool quick
  answer, a full planning pipeline, and an action agent — so a currency question
  does not run a dozen agents.
- **Uses real tools.** Weather, places, web search, product listings, currency
  and stored preferences. Every result comes from a live API.
- **Runs across providers.** Gemini by default, with Groq, DeepSeek and
  OpenRouter through a `BaseLlm` adapter, and automatic failover between them.
- **Stops for approval.** Anything consequential suspends the run until a person
  approves it, then acts — including on a schedule, after the fact.
- **Remembers.** Preferences and conversations persist per account.

Weather, places and currency come from worldwide sources, so the same prompt
works for Lisbon, Tokyo or Nairobi with no configuration.

---

## Architecture

```
                        orchestrator  (decides, does not answer)
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   quick_answer         commit_agent          lifepilot_graph
   one lookup,          asks approval,        the full pipeline
   one answer           then acts                    │
                                                     ▼
                                        intake ─ reads memory, writes a spec
                                                     │
                                        ParallelAgent ─ 4 researchers at once
                                        web · places · context · price
                                                     │
                                        SequentialAgent ─ recommend → budget → plan
                                                     │
                                        LoopAgent ─ verify and revise, ≤2 passes
                                                     │
                                        presenter ─ renders the answer
```

Models are assigned by task shape. Routing and research run on Flash-Lite;
judgement work runs on Flash. The verifier runs on a different provider from the
agents that wrote the plan, so its critique is not self-confirming.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Stack

| Layer | Choice |
|---|---|
| Agents | `@google/adk` 1.6.0 |
| Models | Gemini Flash / Flash-Lite, Groq, DeepSeek, OpenRouter |
| API | Node 22 · TypeScript · Hono · SSE |
| Web | Next.js App Router |
| Data | Postgres via ADK `DatabaseSessionService` |
| Auth | scrypt hashing, HMAC tokens, single-use password reset |
| Contracts | Zod schemas shared by API and web |

---

## Running it

```bash
npm install
cp .env.example .env          # every key has a free tier; links are in the file
npm run build --workspace @lifepilot/shared
npm test

npm run dev --workspace @lifepilot/api    # API → :8080
npm run dev --workspace @lifepilot/web    # web → :3100
```

Every layer also runs from the terminal, without the UI:

```bash
# tools, with no agent and no model involved
npm run tool -- weather Lisbon 3
npm run tool -- places Tokyo cafe 3000 5
npm run tool -- currency 250 USD JPY

# agents
npm run agent -- "what is 250 USD in yen?"             # orchestrator
npm run agent -- --graph "plan a weekend in Lisbon"    # full pipeline
npm run agent -- --model groq/openai/gpt-oss-120b "…"  # another provider

# approvals and the scheduler
npm run approve -- list
npm run approve -- approve <approvalId>
npm run tick
```

---

## Code worth reading

**`apps/api/src/models/openai-compatible.ts`** — ADK for TypeScript ships model
classes for Gemini only, so multi-provider support meant implementing `BaseLlm`
directly. One adapter covers Groq, DeepSeek and OpenRouter. Most of the work is
translating between the genai `Content` shape and OpenAI's messages and tool
calls in both directions, and converting Gemini's schema dialect to strict JSON
Schema.

**`apps/api/src/tools/approval.ts`** — the approval gate. The run suspends, the
decision lives in Postgres, and the gate is enforced in code rather than only in
the prompt, so an agent that skips asking still cannot act.

**`apps/web/app/lib/activity.ts`** — turns the raw agent event stream into
sentences a person would want to read, with the underlying payload one click
away.

**`packages/shared/src/schemas.ts`** — one set of Zod schemas feeding both the
tool declarations and the web app.

---

## Tools

| Tool | Source | Key needed |
|---|---|---|
| `weather` | Open-Meteo | no |
| `currency` | ExchangeRate-API | no |
| `geocode` / `places` | Geoapify | yes |
| `search` | Tavily | yes |
| `products` | Tavily, retail-scoped | yes |
| `preferences` | Postgres | — |

Three rules the tool layer holds to:

- **Missing data stays missing.** Where a provider returns null, the tool returns
  null rather than a plausible substitute.
- **No model runs inside a tool**, so nothing a tool returns is invented.
  `products` returns listings without prices rather than guessing them.
- **Tools return `{ ok, data | error }`** instead of throwing, so one failed
  branch does not take down a parallel run.

---

## Deploying

See [docs/DEPLOY.md](docs/DEPLOY.md). [`render.yaml`](render.yaml) provisions
both services — the UI as a static site, the API as a Docker service — with
Postgres on Neon and a GitHub Actions cron driving the scheduler.

The API sleeps after 15 minutes idle and takes about a minute to wake. The UI is
static, so it loads instantly and shows a waking notice while the API returns.

---

## Screenshots

| Sign in | Desktop | Mobile |
|---|---|---|
| ![](docs/screenshots/sign-in.png) | ![](docs/screenshots/desktop-timeline.png) | ![](docs/screenshots/mobile-timeline.png) |

---

## Limitations

- No email verification, and no rate limiting on sign-in.
- Password reset needs `RESEND_API_KEY`; without it the link goes to the server
  log rather than an inbox.
- Google Calendar is optional and needs your own OAuth client. Plans always
  produce a downloadable `.ics`, which needs no OAuth at all.
- Place data has no ratings, reviews or photos, and OpenStreetMap coverage is
  thinner outside cities. Ranking questions go to web search instead.
- Product prices are not extracted yet.
- Booking and payment are simulated and labelled as such. Saving a plan,
  generating a calendar file and scheduling reminders are real.
- Model free tiers are the binding constraint; model ids are pinned rather than
  using `-latest` aliases.
