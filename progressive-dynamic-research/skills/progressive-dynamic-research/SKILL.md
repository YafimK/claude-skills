---
name: progressive-dynamic-research
description: >-
  Multi-tier agent funnel for research and architecture decisions — cheap models
  discover breadth, an adversarial tier kills weak options, the strong model only
  synthesizes the few survivors. Use this whenever a question needs broad,
  fact-checked comparison across many options or sources and you're about to
  fan out subagents or author a dynamic Workflow: "compare these N approaches",
  "what's the best way to X", "research and recommend", "evaluate this
  architecture", "audit / decide between candidates". Also use it to decide
  WHETHER to fan out at all (vs. just reason), how to budget-cap a sweep, and how
  to avoid the classic failure modes (stale constraints, re-opening filtered
  sets, trusting a surface search, fanning out for thinking you're avoiding).
  Pulls in the canonical workflow template, JSON schemas, and the pall() helper
  that avoids the common `parallel(...).filter is not a function` paren bug.
---

# Progressive Dynamic Research

A progressively-narrowing (pyramid-shaped) funnel for turning a vague "research
this and decide" into a deterministic,
cost-bounded, parallel sweep whose output is a structured object you can act on.
The governing idea: **breadth is bought with the cheapest tokens; depth is spent
only on what survived an adversary.**

```
         ▲  APEX     1 strong agent (opus)  — deep synthesis over survivors only
        ███ KILL     N skeptics (sonnet)    — try to REFUTE each survivor
       █████ FIT     N scorers (haiku)      — score vs fixed priorities, drop misfits
      ███████ DEDUP  plain code (no agent)  — collapse near-duplicates
     █████████ BASE  ~5 cheap agents (haiku)— wide, high-recall option discovery
```

> ⚠️ **READ THIS BEFORE YOU WRITE ANY WORKFLOW — the one bug everyone hits.**
> `await parallel(x.map(...)).filter(...)` binds `.filter` to the **Promise**, not
> the array, so you get **`.filter is not a function`**. It cost one author *three
> failed launches* from the same line copy-pasted into four tiers. **Always** route
> through the `pall()` helper and assign in two steps — never inline the await-wrap —
> and run `node --check` before launching:
> ```js
> const pall = async (thunks) => (await parallel(thunks)) || []   // always an array
> const raw  = await pall(items.map(it => () => agent(/* ... */)))
> const kept = raw.filter(Boolean)                                 // safe
> ```
> The bundled `scripts/pyramid-template.js` already does this correctly — start from
> it and you avoid the trap. Full list of harness gotchas: `references/harness-notes.md`.

## Before you fan out: should you?

A workflow is for **breadth you cannot hold in one context** — not for thinking
you're avoiding. Run this check first; it's the highest-leverage decision here.

- **Reasoning, not search?** A mechanical fact, a tie only one axis breaks, a
  deduction from things already known → answer it directly. Fanning out burns
  tokens to re-derive what one careful step settles.
- **Do you know the *shape* of the work yet?** If not, **scout inline first**
  (list the candidates, find the files, fetch the one source) to discover the
  work-list, *then* fan out over it. Don't fan out before you know the shape.
- **Is the constraint set live?** A workflow optimizes the *prompt*, not your
  intent. Stale constraints → a confident, well-cited, wrong answer. Restate the
  live constraints in every spike's prompt.

If it passes all three, fan out. Otherwise, reason inline.

## Step 0: present the plan and get approval before you launch

A pyramid spawns dozens of agents and can spend a lot; decide the spend *before* it
runs, not after it overshoots. Skipping this is the single most expensive mistake —
a real run sized a budget for reasoning agents, then ran web-grounded ones, blew the
cap mid-flight, and the load-bearing tier silently never ran.

**Default (a user is in the loop): present a PLAN, then put the launch decision in
an `AskUserQuestion` MENU and WAIT. Do not launch in the same turn.** The decision
must be tappable, not a "reply to adjust" paragraph the user has to reverse-engineer
into prose. Two parts, in this order:

1. **A short text plan** — a few scannable lines (not a wide table), each with a
   one-clause *why*, covering all four: **Scale** (agents per tier), **Budget**
   (HARD/WARN + the run shape that set it), **Priorities** (the 2–3 decisive
   discriminators), **Web + models** (which tiers fetch + model per tier). This is
   reference detail that does not fit in menu chips.
2. **One `AskUserQuestion` with a SINGLE question** — so a user happy with the
   defaults approves the whole run in **one tap**. The levers do NOT each get their
   own question up front (that forces 4 taps on someone who just wants to go). The
   one question is the accept/change choice:
   - **"Run with these defaults?"** →
     "Run as planned (recommended)" / "Cheaper, smaller run" / "Let me change something"
   Tailor labels to the run; the recommended default is first. If — and only if —
   the user picks "Let me change something," THEN present the per-lever menu (web /
   priorities / budget / scale as parallel questions in one follow-up call) and
   launch on their response. So: **one tap to accept; drill-down only on request.**
   **Never** end the plan with only a typed-reply prompt, and **never** make the
   default-accepting user answer a question per lever — both are the friction this
   gate exists to prevent. A wrong-but-confident run is more expensive than one tap.

**Exception — explicitly autonomous runs only** (a cron/headless/loop context, or
the user said "just run it / don't ask"): announce the same four items in one line
and proceed without blocking. If a user is present and has *not* waived approval,
the default gate applies — "they can always veto later" is **not** a substitute for
waiting (the run is already spending by then).

If the user already gave a token target (a `+Nk` directive), use it as the budget
and say so in the plan instead of proposing your own.

**Pick the cap from the run's shape, not a habit:**

- **Reasoning-only tiers** (no WebSearch/WebFetch): a fan-out + a kill tier +
  synthesis lands around **150–250k**. Use `HARD ≈ 220k, WARN ≈ 150k`.
- **Any web-grounded tier**: every fetched page dumps full content into the agent's
  context, so a fetching agent costs **5–10× a reasoning one**. A ~10-agent
  fetching discovery feeding a ~15-agent fetching verify needs **800k+**, not 200k.
  Size for fetch cost or the run dies behind a gate.
- **Opus-heavy** (deep-dives on the strong model): opus runs cost ~5× a haiku run —
  scale the cap up accordingly (a 3×opus-deepdive + verify + synth run was ~210k).
- **`evolve:true` (the optional COMPOSE step):** budget for one extra sonnet
  composer plus a *second* KILL pass over the hybrids — and if KILL is
  web-grounded, that re-vet inherits the same fetch cost. Add roughly one
  KILL-tier's worth of headroom; if the cap is tight, the pre-compose gate simply
  degrades and you synthesize the originals.
- **Wide tiers that *loop* (the sneaky one):** cost ≈ width × turns-per-agent ×
  context-per-turn. Measured: a 45-agent FIT triage tier booked ~900k tokens by
  **looping ~8 turns each** (re-reading fetched content every turn) — not the web
  per se, not the model. Make cheap tiers single-pass and tool-free, and cap their
  width. Most of the cost was *baseline* looping, not web: the no-web FIT agents
  still looped ~6 turns and were 58% of the spend (web made the worst tail worse).
  The load-bearing fix is "single-pass, do not loop" — the web ban and width cap
  reinforce it. See `references/harness-notes.md` → "The dominant cost is tool-use
  LOOPS on a wide tier."

**Three rules that keep the cap from backfiring:**

1. **Gate on the *delta*, not raw `budget.spent()`.** It is a shared,
   session-cumulative, output-only counter — a raw gate trips on whatever the
   session spent before you launched. Capture `START = budget.spent()` at the top
   and gate on `budget.spent() - START`. (A real run tripped a 150k gate at "500k"
   when the workflow itself had spent ~90k — the rest was prior session output.)
2. **Gate *before* discovery, sized for the whole run — never between the
   expensive fetch tier and the cheap load-bearing tier behind it.** The discovery
   fetch is the costly part; don't let it eat the budget the verify tier needs.
3. **A cap that fires is information, not failure.** `log()` *where* it stopped
   (`HARD CAP at post-verify: 812k`) so you know the result is complete enough to
   use — or exactly which tier got starved.

If a token target was set for the turn (a `+Nk` directive), read it off the global
`budget` and scale the fan-out to it. Mechanics + the `gate()` helper:
`references/harness-notes.md` → "Budget guard". Both bundled templates ship a
guard already sized for their funnel — the option-selection one for reasoning, the
claim-verification one for web-grounded.

## The shape that works

Map the funnel to the task; don't run all five tiers mechanically.

1. **BASE — wide cheap discovery.** ~5 haiku agents, each from a *different angle*
   (e.g. cost-first / simplicity-first / resilience-first / tooling-first), high
   recall. For a known candidate set, replace with one discovery agent that
   enumerates and a triage tier (below).
2. **DEDUP — in code, not an agent.** Normalize and collapse near-duplicates.
   Never pay an LLM to do a string-normalize.
3. **FIT / TRIAGE — gate before you deep-dive.** *This is the product.* A cheap
   tier that kills 80% of candidates against **one decisive question** is worth
   more than a bigger deep-dive budget. Score against the *fixed* priorities;
   keep only credible contenders.
4. **KILL — adversarial refutation.** Each survivor faces a skeptic told to
   *refute* it; default the verifier to "assume false unless proven." A verifier
   told to confirm will confirm. Where facts are load-bearing, make the verifier
   **web-grounded against primary sources**. Prefer a small **multi-vote quorum**
   (e.g. kill on 2 of 3) and **diverse lenses per voter** (correctness / cost /
   ops) over N identical skeptics.
5. **APEX — strong-model synthesis over survivors only.** The expensive model
   never sees the junk — only the handful that survived. Output a recommendation,
   a scored comparison, and an explicit *rejected-with-reasons* list.

The return object carries `recommendation`, `coverage`, `funnel`, and two distinct
lists: **`rejected`** (options an adversary actually *refuted* — with refute counts
and flaws) and **`degraded`** (options whose KILL votes *crashed below quorum* — the
verdict is unknown, NOT a refutation). Never read a degraded option as rejected: a
degraded result means "could not evaluate — re-run with more budget", not "this is
bad". If every option ends up degraded the run stops with a `could not evaluate`
message rather than a false `everything was refuted`.

**Optional — COMPOSE / EVOLVE (between KILL and APEX).** Opt in (`evolve:true`)
to insert one cheap (sonnet) composer with **two modes**, picked by how many
survived KILL:

- **Hybridize (≥2 survivors).** The best answer is sometimes a *hybrid* of two —
  not either alone. The composer proposes hybrid options combining the survivors'
  strengths.
- **Compensating controls (<2 survivors, but some were refuted).** The failure
  that motivated this: a multi-constraint problem where *no single option*
  satisfies everything, so KILL nukes them all — yet a real answer exists as
  "best base option **+ controls that cover its residual flaws**." Those controls
  are usually **not other candidates** — the KILL tier already *named* them inside
  each rejected option's `fatalFlaws` (e.g. "the only way to satisfy X is a Y").
  So instead of dead-ending at `null`, the composer reads the refuted set + its
  flaws and proposes a base+compensating-controls hybrid. *(Without `evolve`, a
  <2-survivor outcome stays a hard stop — the funnel remains a strict
  down-selector; this rescue is opt-in.)*

The non-negotiable for **both** modes: **COMPOSE generates, re-KILL judges.** The
composer only *invents* a hybrid — it is not an adversary, so it cannot be trusted to
approve its own creation. Each hybrid therefore **re-enters the KILL tier** and must
survive the same adversarial quorum before APEX sees it; an un-vetted hybrid would
smuggle a confirmation bias straight into synthesis (APEX's invariant is that it only
ever sees options an adversary tried to kill and failed). A hybrid the *same* adversary
re-kills is a **true finding** (some constraint sets have no composite that survives
review), not a bug. The composer defaults to the **strong model** (`composeModel`,
default opus) because inventing a good hybrid — especially "base + the mitigation each
flaw names" — is real synthesis, not cheap legwork; re-KILL stays the cheaper
adversarial backstop, and re-KILL can only *reject* a weak hybrid, never *upgrade* one.
The pre-compose gate *degrades* (skip the enhancement, synthesize whatever survived)
rather than aborting. Default off; skip it when one clear winner already dominates.

## Non-negotiables that make it work

- **Structured (schema) output, always.** Force each agent to return validated
  JSON, not prose — so results are directly tabulatable and you don't re-read the
  answer five times arguing about what it said. See `references/schemas.md`.
- **Tier models by where quality matters.** Legwork is cheap (haiku/sonnet);
  verdicts are not (opus). The expensive model touching ~5 of ~60 agents is the
  whole cost lever — far more than the per-token price gap (opus is ~5× haiku,
  not the order-of-magnitude people assume).
- **Budget every spike; read where it stops.** Declare a hard cap + a warning,
  and a per-worker self-check. A cap that *fires* is information ("stopped at
  post-scale: 64k"), not failure — it tells you the result is complete enough.
- **Make the discriminator the agent's central question, not a footnote.** A
  surface search happily answers the easy question ("does X exist? yes!") and
  skips the one that actually decides ("does X scope per-tenant without a
  per-tenant object?"). Ask the discriminator directly.
- **Convergence is a decision, not a default.** Workflows make re-running free,
  which quietly incentivizes never closing a set. Once a phase filters a set, it
  stays closed unless *new evidence* reopens it. Name the close explicitly.

## Authoring the workflow

Use the bundled template as the starting point — it encodes the hard-won
mechanics so you don't rediscover them:

- **`scripts/pyramid-template.js`** — the canonical **option-selection** funnel:
  BASE → DEDUP → FIT → KILL → CRITIC → APEX, with the `pall()` helper,
  dedup-in-code, per-tier schemas, a multi-vote KILL quorum, a coverage critic,
  and a delta-based budget guard. It is **args-driven**: don't edit the file —
  invoke it with `Workflow({ scriptPath, args: { problem, priorities, angles,
  webTiers, killVotes, maxFit, maxKill, evolve, composeModel, hard, warn } })`.
  `composeModel` sets the COMPOSE tier's model (default `opus` — compose is
  generative synthesis where quality matters; re-KILL stays the sonnet backstop;
  set `sonnet` for a cheaper compose). `webTiers` is a
  per-tier list — `['base','kill']` lets BASE fetch for discovery *recall*
  (single-pass — it must not loop) and KILL fetch to *verify* facts, while FIT
  (the wide, loop-prone tier) never fetches. `webGrounded:true` is a back-compat
  alias for `['kill']`. `evolve:true` adds the optional two-mode COMPOSE step above
  (hybridize ≥2 survivors, or compose base+compensating-controls when <2 survive —
  both re-vetted through KILL). Use when the task is
  "choose among N candidate approaches". Read the header block for the full args.
- **`scripts/pyramid-template.test.mjs`** — the **$0 test suite** (`node:test`, no
  deps). Runs the workflow body under mocked `agent`/`parallel`/`budget` (no LLM
  calls) across many scenarios — args validation, funnel shape + return contract,
  model tiering, kill-quorum math, per-tier web wiring (FIT never fetches),
  FIT-width cap, and the budget gate firing on the *delta*. Each asserts an
  invariant whose failure would burn real tokens. Run **`node --test scripts/*.test.mjs`**
  after any edit and before spending on a real run — it catches structural bugs the
  way `node --check` catches syntax ones. (`scripts/harness-lib.mjs` is the shared
  runner; `scripts/stub-harness.mjs` is a quick single-scenario visual check.)
- **`scripts/claim-verification-template.js`** — the **claim-verification** funnel:
  DISCOVER → DEDUP → web-grounded VERIFY → cited SYNTH, **no FIT tier**. Use when
  the task is "research these N questions and give me verified, cited facts /
  hard numbers / prior art" rather than down-selecting options. Encodes the two
  fixes a real run cost us: a **fetch-sized budget** (web-grounded tiers cost
  5–10× reasoning tiers) and a **per-bucket verify cap** (a global slice silently
  starves some questions → false "evidence gaps" at the apex). See
  `references/harness-notes.md` → "Web-grounded tiers" and "Per-bucket caps".
- **`scripts/evolve-eval.js`** (dev tool, not shipped behavior) — answers "does
  `evolve:true` actually beat leaving it off?". For each problem it runs
  BASE→FIT→KILL **once**, then branches over the *same* survivors: arm A = APEX
  only, arm B = COMPOSE+re-KILL→APEX — so any delta isolates the COMPOSE tier with
  no discovery confound. A blind, order-swapped judge panel scores A vs B against
  the priorities; it reports evolve win-rate, mean token delta, and the free
  in-run signal (did a hybrid survive re-KILL and coincide with the win). Its
  deterministic plumbing is unit-tested (`evolve-eval-lib.test.mjs`) and its wiring
  smoke-tested (`evolve-eval-smoke.mjs`). Prove it on ONE problem before scaling.
- **`references/schemas.md`** — the JSON schemas for each tier (candidate, fit,
  verdict, deep-dive, hybrid) and a minimal triage variant.
- **`references/harness-notes.md`** — runtime gotchas of the dynamic-workflow
  harness: the `pall()` fix for `parallel()`, `pipeline()` vs `parallel()`
  (barrier) choice, no `Date.now()`/`Math.random()`, no apostrophes in prompts,
  `node --check` before launch, and resume-from-cache. Read this when a workflow
  errors or stalls.

### The one bug you will hit

See the ⚠️ callout at the top: the `await parallel(...).filter(...)` precedence trap
that yields `.filter is not a function`. Route through `pall()`, assign in two steps,
`node --check` before launch. The template already does this.

## Keep vs delegate (the meta-lesson)

The harness scales the **legwork**; it does not scale the **thinking**. Keep these
in your own loop and delegate the rest to the fan-out:

| Keep in the main loop (thinking) | Delegate to the fan-out (legwork) |
|----------------------------------|-----------------------------------|
| Choosing the decisive gate       | Breadth you can't hold in context |
| Keeping the constraint set live  | Parallel scorecards vs a rubric   |
| Closing sets once filtered       | Adversarial refutation of survivors |
| Knowing reasoning vs search      | Web-grounded fact-checks at scale |

Use the advisor as a pre-commit reviewer before any substantive write — it sees
the full transcript and catches framing errors a self-review won't.

## The pattern in practice

Across many real runs the reliable shape was: a triage tier that kills ~80% of
candidates against one decisive gate, a parallel deep-dive over the survivors, and
an adversarial verify + strong-model synthesis. The funnel typically narrows on
the order of *dozens of raw candidates → a handful of survivors → one
recommendation*, with the expensive model touching only the final handful. Keep a
rejected-with-reasons list so a reviewer can see what died and why.
