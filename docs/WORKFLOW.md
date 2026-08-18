# Development Workflow

How LifePilot gets built. This is not generic advice — it maps the specific
sub-agents and skills configured in this environment onto the phases in
[PLAN.md](./PLAN.md), so the same pipeline runs every time instead of being
re-improvised per task.

The short version: **nothing is called "done" until a reviewer agent and a
verifier agent have both looked at it.**

---

## The standing pipeline

Every non-trivial change goes through these stages in order. Stages may be
skipped, but a skip is announced, never silent.

| # | Stage | Agent / skill | Runs when |
|---|---|---|---|
| 1 | **Spec** | `requirements-analyst` | The input is a vague goal, not a buildable task |
| 2 | **Plan** | `planner` | Any multi-file or non-obvious change |
| 3 | **Build** | — | After the plan is approved |
| 4 | **Review** | `code-reviewer` | Before anything is presented as done |
| 5 | **Verify** | `qa-verifier` | Same gate — review finds bugs, verify proves it runs |
| 6 | **UI check** | `ui-brand-reviewer` + `/verify-ui` | Any change that renders pixels |
| 7 | **Hand-off** | `qa-notes-maker` | Work is finished and someone else must test it |
| 8 | **Ship** | `/preflight` → `/commit` | Before any deploy or delivery |

Out-of-band, as needed:

- **`debugger`** — every bug gets a *confirmed root cause* before a fix is
  written. No pattern-matched fixes; a symptom that looks like a known issue may
  have a different cause in this codebase.
- **`/bugfix`** — the wrapper that runs debugger → minimal fix → regression check.
- **`code-auditor` / `/audit`** — only relevant if we ever inherit code. Not used
  for code we wrote ourselves.
- **`Explore`** — broad "where does X live" searches once the repo outgrows a
  single mental model.
- **`/simplify`** — quality-only pass (reuse, dead code, altitude). Does not hunt
  bugs; that is `/code-review`.

**Trivial one-line changes skip the pipeline** — but the skip is stated out loud.

---

## Per-phase mapping

Which agents actually matter for each phase of PLAN.md §6. Applying every agent
to every phase is theatre; these are the ones that earn their cost.

### Phase 0 — Tool layer ✅ done
`code-reviewer` on the tool implementations. No `qa-verifier` yet — there was no
test suite to run, so verification was **live CLI execution against every real
API**, which is the stronger check at this stage.

> Phase 0 immediately justified the pipeline: running the tools for real found
> that Frankfurter (ECB) does not carry PKR, the demo's home currency. A plan
> review would never have caught that. See [PLAN.md §9](./PLAN.md).

### Phase 1 — Single agent baseline
`qa-verifier` to confirm the agent completes with ≥3 real tool calls. Save the
output — it is the baseline Phase 3 has to beat.

### Phase 2 — The `BaseLlm` adapter ← *highest review value in the project*
`planner` first (the request/response mapping is genuinely non-obvious), then
`code-reviewer` **specifically on tool-call translation**, then `qa-verifier`
across all three providers. This is the most defect-prone code in the repo and
the most load-bearing for the portfolio story.

### Phase 3 — Agent graph
`planner` for the composition, `qa-verifier` for the "is multi-agent actually
better than Phase 1" comparison. If it is not better, that is a prompt problem —
route it to `debugger`, not to more agents.

### Phase 4 — Model routing
`qa-verifier` driving the failover check: revoke the Gemini key mid-run and prove
the graph completes on the fallback provider.

### Phase 5 — Persistence
`code-reviewer` on the session/preference boundary. `qa-verifier` on the
cross-session preference check.

### Phase 6 — Human-in-the-loop ← *highest verification value*
All five checks in PLAN.md Phase 6 go to `qa-verifier`, especially **resumes-not-
restarts** (the `invocationId` trap) and **idempotency**. `code-reviewer` on the
approval-state persistence, since an in-memory `Map` here silently reduces the
whole feature to a prop.

### Phase 7 — Frontend + deploy
`ui-brand-reviewer` and **`/verify-ui`** (screenshot desktop + mobile and
actually look) before any UI is called done. Then `/preflight` before deploying.
`/web-design-guidelines` for the accessibility pass.
`/vercel-react-best-practices` when writing the Next.js app.

### Phase 8 — README and hand-off
`qa-notes-maker` for a short, non-technical test sheet. `/client-update` if this
ever needs a progress summary in plain language.

---

## Rules that override defaults

Carried in from hard-won experience; they apply to every phase.

1. **Never guess design tokens or brand colours.** Read the project's actual
   theme/token files before writing or judging styling.
2. **Prefer the real solution over a lookalike hack.** A true vector PDF from a
   PDF library, not headless-browser HTML-to-PDF that reflows per screen. This
   applies directly to the itinerary PDF in PLAN.md §4.3.
3. **When two surfaces show the same data, name the source of truth** and align
   the others to it. Derivation logic goes in ONE shared helper — which is the
   entire reason `packages/shared` exists.
4. **Verify against actual code paths, not pattern-matching.**
5. **QA and hand-off notes are short and non-technical.** One page, no code
   references, runnable by a non-developer.
6. **Commits are conventional** (`type(scope): imperative summary`) and only
   happen when asked. Never commit `.env` or any secret.

---

## Definition of done

A phase is done when all of these hold:

- [ ] Its pass/fail check in [PLAN.md §6](./PLAN.md) passes, demonstrated by real output
- [ ] `code-reviewer` has reviewed the diff and findings are resolved or logged
- [ ] `qa-verifier` has run the relevant tests and triaged any failures
- [ ] `npm run typecheck` is clean across all workspaces
- [ ] UI work has been screenshotted at desktop **and** mobile and looked at
- [ ] Anything discovered that contradicts PLAN.md has been written back into it

That last one matters most. The plan is a living document — Phase 0 already
rewrote part of it.
