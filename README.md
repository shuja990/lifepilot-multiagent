# LifePilot

A multi-agent personal planning assistant built on **Google ADK for TypeScript**.

Describe a real-world goal in plain language — *"plan a weekend in Islamabad
under 20,000 PKR"*, *"help me buy noise-cancelling headphones"* — and a graph of
specialised agents researches it, prices it, schedules it, checks its own work,
and then **stops and asks before doing anything consequential**.

> **Status:** Phase 0 of 8 complete — the tool layer works against live APIs.
> No agents wired yet. See [docs/PLAN.md](docs/PLAN.md) for the full build plan.

---

## Why this project exists

It is a portfolio piece with four things to prove, live rather than described:

1. **Real orchestration** — a graph of specialised agents, not one prompt with tools bolted on
2. **Real tools** — actual API calls returning real data, not stubs
3. **Model routing** — the same agent graph running across several LLM providers
4. **Human-in-the-loop** — an action that pauses for approval, then acts autonomously later

It also runs on **almost nothing**: every service in the stack has a free tier,
and the deployed demo's happy path spends $0.

---

## Stack

| Layer | Choice |
|---|---|
| Agents | `@google/adk` **1.6.0** (pinned exact — the SDK moves fast) |
| LLM default | Gemini Flash (free tier) |
| Additional providers | Groq, DeepSeek, OpenRouter via a hand-written `BaseLlm` adapter |
| API | Node 22 + TypeScript (strict) + Hono |
| Web | Next.js App Router + Tailwind |
| Data | Postgres (Neon) via ADK `DatabaseSessionService` |
| Contracts | Zod schemas shared by API **and** web |

---

## Quick start

```bash
npm install
cp .env.example .env       # fill in the free keys — every link is in the file
npm run build --workspace @lifepilot/shared
npm run typecheck
```

### Try the tools

Every tool runs standalone, with no agent and no LLM in the loop. This is a
project rule, not a convenience: tools get debugged far more often than agents.

```bash
npm run tool -- weather Islamabad 3
npm run tool -- places Islamabad cafe 3000 5
npm run tool -- currency 20000 PKR USD
npm run tool -- geocode "Blue Area Islamabad"
npm run tool -- search "best time to visit Hunza valley"
npm run tool -- products "noise cancelling headphones"
npm run tool -- prefs:set demo-user home_city Lahore
npm run tool -- prefs:get demo-user
```

---

## Tool layer (Phase 0)

All six tools verified against their live APIs. Latencies are real measurements
from a single run, not estimates.

| Tool | Provider | Key needed | Free tier | Latency |
|---|---|---|---|---|
| `weather` | Open-Meteo | **none** | unlimited in practice | ~1.7 s |
| `currency` | ExchangeRate-API (open) | **none** | unlimited in practice | ~0.4 s |
| `geocode` | Geoapify | `GEOAPIFY_API_KEY` | 3,000 credits/day | ~0.9 s |
| `places` | Geoapify | `GEOAPIFY_API_KEY` | 3,000 credits/day | ~1.3 s |
| `search` | Tavily | `TAVILY_API_KEY` | 1,000 credits/month | ~2.5 s |
| `products` | Tavily (retail-scoped) | `TAVILY_API_KEY` | shares the search quota | ~3.9 s |
| `prefs` | local JSON → Postgres in Phase 5 | none | — | ~5 ms |

Three deliberate design choices in that table:

**No Google Places.** Google retired the pooled $200/month credit in March 2025;
it is now per-SKU free counts that a chatty agent burns through fast. Geoapify is
OSM-derived, 3,000 credits/day, no credit card. The tradeoff is real and is
surfaced *to the agent* in a `dataNotes` field rather than hidden: OSM has no
ratings, reviews, or photos, so anything ranking-shaped is answered by web search
instead of invented from place data.

**No price extraction in the tool layer.** `products` returns retrieval only and
leaves `priceApprox` null. No LLM runs inside a tool, so nothing in a tool result
is ever hallucinated. Extraction happens in a named agent against a shared
schema, where a wrong number is at least attributable.

**Tools never throw across the agent boundary.** Every tool returns
`{ ok: true, data }` or `{ ok: false, error }`. An LLM recovers from an error
object far better than a `ParallelAgent` branch recovers from an exception.

---

## Documentation

| Document | What it is |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | The full build plan — decisions, costs, architecture, phases, risks |
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | How this gets built: the review/verify agent pipeline per phase |

---

## Honest limitations

Kept here on purpose. A portfolio project that hides its edges is a tutorial.

- **Place data has no ratings, reviews, or photos** — an OpenStreetMap
  consequence, surfaced to agents rather than papered over.
- **Product prices are not extracted yet** — Phase 0 is retrieval only.
- **Free-tier Gemini prompts may be used by Google to improve their products.**
  Do not put real personal data through the deployed demo.
- **Gemini's free tier is Flash-class only** (Pro went paid-only around April
  2026), so every agent is designed to be good enough on Flash.
- Booking and payment will be **simulated and labelled as such**. Everything else
  the approval gate guards is a real side effect.
