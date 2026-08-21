# Baseline — Phase 1 single agent

> The recorded run below used Islamabad simply because that is where the
> developer was testing. Nothing in the system is region-specific — the same
> comparison works for any city — but the numbers here are left exactly as they
> were measured rather than re-run with a prettier destination.

**This file is a control, not documentation.** docs/PLAN.md Phase 3 requires the
multi-agent graph to beat this on the same prompt. Without a saved baseline that
claim is unfalsifiable, and plenty of multi-agent systems are slower and worse
than one good prompt.

Do not update this file when the agent improves. Add a new one alongside it.

```
Prompt   : plan a weekend in Islamabad under 20000 PKR
User     : demo-user  (stored prefs: home_city=Lahore, currency=PKR)
Agent    : lifepilot_baseline (single LlmAgent, all 8 tools)
Model    : gemini-flash-latest
Date     : 2026-08-18
Result   : 18.0s, 3 tool calls
```

## Tool calls made

```
-> get_preferences({"userId":"demo-user"})
-> get_weather({"days":3,"location":"Islamabad"})
<- get_preferences: 2 preferences
<- get_weather: 3 days
-> web_search({"query":"budget trip weekend Islamabad itinerary costs Faisal Mosque Daman-e-Koh Lok Virsa"})
<- web_search: 5 hits
```

Note the first two run in the same turn — the model requested them together, so
even the single agent gets some concurrency. That matters when judging Phase 3:
the parallel research swarm has to beat *this*, not a strictly serial strawman.

## What it got right

- **Used stored memory unprompted.** Nothing in the prompt mentioned Lahore, but
  the plan is costed from Lahore because `home_city` was saved in Phase 0. This
  is the cross-session memory requirement working end to end.
- **Fed weather into the plan** rather than reporting it separately: thunderstorm
  forecast produced an umbrella line and indoor wet-weather alternatives
  (Lok Virsa, Centaurus) against outdoor stops.
- **Respected the honesty rules.** It closed with an "Unconfirmed / Variable
  Items" section flagging bus and hotel rates as unverified, instead of
  presenting estimates as observed prices.
- Budget totals to ~16,200–19,600 PKR, inside the 20,000 constraint.

## Weaknesses — the openings Phase 3 should exploit

1. **One search for the entire trip.** A single query covered attractions,
   costs, transport and food. A parallel research swarm can afford a dedicated
   query per concern.
2. **No `find_places` call at all.** Every venue came from the model's own
   knowledge plus search snippets, so no address, distance, or opening-hours
   data backs any recommendation. A dedicated PlaceResearch agent would.
3. **Prices are estimates presented in a precise-looking table.** Ranges like
   "4,500 – 5,200" are model priors, not observed fares. Honest in the footnote,
   but a BudgetAgent should separate observed from estimated per line.
4. **No verification pass.** Nothing checked the total against the constraint or
   the itinerary against the forecast; it happened to be consistent.

## The comparison to run in Phase 3

Same prompt, same user, same stored preferences. Record tool calls, wall clock,
and then judge on: are venues backed by real place data, are estimated and
observed costs distinguished, and does the verifier catch a deliberately
over-budget variant (try 8,000 PKR).

If the graph is not better on those, the fix is prompt specialisation, not more
agents.
