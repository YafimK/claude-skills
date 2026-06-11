# Dynamic-workflow harness — runtime gotchas

Read this when authoring a pyramid workflow, and especially when one **errors or
stalls**. These are the things that cost real time in practice.

## The `pall()` fix — the bug you will hit

`parallel()` can resolve to a non-array, and operator precedence binds a trailing
`.filter` to the **Promise**, not the result:

```js
// ✗ WRONG — `.filter is not a function`, because `.filter` is read off the Promise
const xs = (await parallel(items.map(...))).filter(Boolean)   // looks fine, isn't, when nested/edited
```

This bit one workflow **three times** — the same mis-parenthesized line
copy-pasted into four tiers. The durable fix is a helper plus a two-step assign;
never inline the await-wrap:

```js
const pall = async (thunks) => (await parallel(thunks)) || []   // always an array
const raw  = await pall(items.map(it => () => agent(/* ... */)))
const kept = raw.filter(Boolean)
```

Run `node --check your-workflow.js` before launching — it catches the paren/brace
class instantly.

## `pipeline()` vs `parallel()` — pick the right one

- **`pipeline(items, stage1, stage2, ...)` is the default.** Each item flows
  through all stages independently, **no barrier** — item A can be in stage 3
  while item B is still in stage 1. Wall-clock = slowest single chain. Use it for
  multi-stage per-item work (review → verify, deep-dive → refute).
- **`parallel(thunks)` is a BARRIER** — it waits for *all* thunks. Use it ONLY
  when the next step genuinely needs the whole prior set at once: dedup/merge
  across all findings, early-exit on zero, or a prompt that references "the other
  results." "I need to flatten/map first" is **not** a reason — do that inside a
  pipeline stage.

A barrier where a pipeline would do wastes the fast agents' idle time waiting on
the slow one. When in doubt: pipeline.

## Tail latency

A fan-out is only as fast as its slowest agent at each barrier. One stalled
worker (observed: ~996s before retry) holds up a `parallel()`. Prefer
`pipeline()` so unaffected items keep flowing, and keep the concurrency in mind
(the harness caps concurrent agents at ~min(16, cores-2); excess queues).

## Plain-JS constraints

Scripts are plain JavaScript, not TypeScript — no type annotations, interfaces,
or generics. Also:

- **No `Date.now()` / `Math.random()` / argless `new Date()`** — they throw (they
  would break resume). Pass timestamps via `args`; vary by index for "randomness".
- **No apostrophes in agent prompt strings** — `user's` breaks the string with an
  `Unexpected token`. Reword, or build prompts with `+` concatenation of
  double-quoted/backtick parts. (A stray apostrophe once broke a whole run.)
- **`meta` must be a pure literal** — no variables, calls, or interpolation in it.

## Budget guard

Declare a hard cap, a warning, and a per-worker self-check. Read the global
`budget` (`budget.total`, `budget.spent()`, `budget.remaining()`); the pool is
shared across the main loop and all workflows, and the target is a hard ceiling.

**`budget.spent()` is a shared, session-cumulative, OUTPUT-only counter — gate on
the delta, not the raw value.** A real run set `HARD=150k` and saw the gate log
`HARD CAP at pre-kill: 500k` — but the *workflow's own* output was only ~90k. The
other ~410k was this long session's main-loop output, already counted before the
workflow began. A raw `budget.spent()` gate trips on whatever the session spent
before you launched. Capture a baseline at the top and gate on the difference:

```js
const START = budget.spent()             // baseline at script start
const HARD = 220_000, WARN = 150_000
function gate(where) {
  const s = budget.spent() - START       // THIS run's own output spend
  if (s >= HARD) { log('HARD CAP at ' + where + ': ' + Math.round(s/1000) + 'k (this run)'); return 'STOP' }
  if (s >= WARN) log('WARN at ' + where + ': ' + Math.round(s/1000) + 'k (this run)')
  return 'OK'
}
```

A cap that **fires** is information, not failure — log *where* it stopped so you
know the result is complete enough to use. Scale the cap by model tier (opus runs
cost ~5× a haiku run, and ~1.67× a sonnet run).

### The dominant cost is tool-use LOOPS on a wide tier — not the model, not "context"

Measured on a real run (numbers reconciled three times; the first two diagnoses
were wrong — see the cautionary note below). A 5-agent BASE + 45-agent FIT funnel
that **stopped before KILL even ran** booked **~932k billable tokens**. The driver:

- FIT ran **359 assistant turns across 45 agents** (~8 each, when triage should be
  ~1). Its cost was **5.16M `cache_read`** (vs 1.84M `cache_creation`) — and
  cache-*read* dominating is the signature of **multi-turn loops re-reading an
  accumulating context every turn**, not a static framing sent once.
- Turn-count is the lever, and **most of the cost was baseline looping, not web.**
  The 39 FIT agents that used **no web** still looped ~6 turns each (triage should
  be 1) and accounted for **58% of FIT cache_read** (3.0M); the single most
  expensive agent (960k, 40 turns) used zero web. The 6 web agents looped harder
  (~19 turns avg) and dominated the expensive *tail*, but did not carry the bulk.
- So: **web makes the worst offenders worse, but a wide tier loops and overspends
  even tool-free.** Removing web alone would not have fixed the 39 no-web loopers —
  the load-bearing instruction is *single-pass, do not loop*, with the web ban and
  width cap as reinforcement.

The lessons that actually follow:

- **A wide tier that loops is the budget lever.** Cost ≈ width × turns-per-agent ×
  context-per-turn. The wide tier (FIT, 45 agents) doing tool-use loops is what
  blows the budget — long before the expensive KILL/APEX tiers run.
- **Make cheap tiers single-pass and tool-free.** FIT is triage: score one
  candidate from its description in one turn. Tell it explicitly *do not use
  WebSearch/WebFetch and do not loop*. The template's FIT prompt now says this.
- **Cap fan-out WIDTH on the scoring tier** (`MAX_FIT`) and log the surplus dropped;
  never let discovery overflow into an unbounded, loop-prone scoring tier.
- **Keep web where it earns recall, drop it where it only loops.** Web on BASE (5
  agents, genuine discovery recall) cost little and helped. Web on FIT (45 agents,
  triage) was near-pure waste. Decide web per-tier by *does fetching change the
  answer here*, not by model tier.

> **Cautionary note — this finding took three reconciles to get right, and the
> wrong versions were each plausible.** v1: "fetched pages = huge *input*" (false —
> fresh input was only 16k; the tokens were cache, not input). v2: "cache-read of
> the big repeated `PROBLEM` context × width" (false — that is only ~2k/agent; it
> cannot make 156k/agent). v3 (correct): **multi-turn tool-use loops on a wide
> tier**, confirmed by splitting `cache_read` from `cache_creation` and correlating
> per-agent cache_read with turn-count and web-calls. **Lesson for diagnosing a
> budget blowout: split cache_read vs cache_creation, count assistant *turns* per
> agent, and correlate — do not infer cost from `input_tokens` or from a single
> lumped "cache" number.**

### Web-grounded tiers blow the default budget — and starve the tier behind the gate

A tier that calls **WebSearch/WebFetch costs multiples of a reasoning-only tier**,
because every fetched page dumps its full content into the agent context. Observed:
9 *fetching* haiku discovery agents burned **~530k tokens** — against a 240k cap sized
for the template's non-fetching discovery. The cap tripped at the `pre-verify` gate,
so the **load-bearing verify tier silently never ran**, and the apex correctly refused
to synthesize from empty arrays (a clean *no result*, not garbage — but a wasted run).

Two rules:
- **Size HARD/WARN for fetch cost when any tier is web-grounded** — assume each
  fetching agent costs 5–10× a reasoning agent. For a ~10-agent fetching tier feeding
  a ~15-agent fetching verify tier, budget ~800k+, not ~200k.
- **Never place a budget `gate()` between a fetch-heavy tier and the cheap-to-run
  load-bearing tier such that the load-bearing tier gets starved.** The discovery
  fetch is the expensive part; don't let it eat the budget the *verify* needs. If you
  must gate, gate *before* discovery (sized for the whole run), not between discovery
  and verify.

### Per-bucket caps for multi-question funnels — a global slice starves buckets

When the funnel serves **multiple independent questions** (not one option-set), a
single global cap on what reaches the next tier will **silently starve some
questions**. Observed: capping verify at "top 15 sorted by *has-a-number*" sent all 15
survivors into ONE question's bucket (the numeric-heavy one), leaving the other two
questions with **zero verified claims** — the apex then reported them as evidence gaps
though good discovery data existed. The discovery was fine; the *selection* killed two
questions.

Fix: **allocate the cap per-bucket, not globally** — e.g. `take(N_per_question)` from
each question's claim list, then concatenate, so every question reaches verify with a
fair share. Sort *within* a bucket, never across buckets, when the buckets are
independent deliverables.

## Resume from cache

Every run persists its script and journal. After a script fix, relaunch with
`{ scriptPath, resumeFromRunId }` — completed `agent()` calls with unchanged
`(prompt, opts)` return cached results instantly; only the edited/new call and
everything after it re-runs. So fixing a late tier replays the expensive base
tier for free. **Do not change a cached agent's prompt/label/schema** unless you
intend to bust its cache.

## Cost lever, stated honestly

The saving is **mostly agent placement, not the per-token price gap**: getting
the expensive model to touch ~5 of ~60 agents is the lever. Output prices
(2026-06): opus $25 / sonnet $15 / haiku $5 per MTok → ratio 5:3:1. So opus is
**5× haiku**, not the order-of-magnitude sometimes assumed. Don't overclaim the
ratio; claim the placement.
