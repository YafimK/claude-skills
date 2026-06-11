# Progressive Dynamic Research — how it works

A research-and-decide funnel that turns *"compare these N options and recommend
one"* into a deterministic, cost-bounded, parallel sweep returning a structured
result. The governing idea:

> **Breadth is bought with the cheapest tokens; depth is spent only on what
> survived an adversary.**

Dozens of candidates are discovered cheaply, most are killed by a cheap filter and
then an adversary, and the expensive model only ever sees the handful that survive.

## The shape

```
         ▲  APEX     1 strong agent (opus)   — deep synthesis over survivors only
        ███ CRITIC   1 cheap agent (haiku)   — coverage check: what got missed?
       ████ KILL     N skeptics (sonnet)     — try to REFUTE each survivor (quorum vote)
      █████ FIT      N scorers (haiku)        — score vs fixed priorities, drop misfits
     ██████ DEDUP    plain code (no agent)    — collapse near-duplicates
    ███████ BASE     ~5 cheap agents (haiku)  — wide, high-recall option discovery
```

Read it bottom-up: **wide and cheap at the base, narrow and expensive at the apex.**
A typical run goes *dozens of raw candidates → a handful of survivors → one
recommendation*, with the strong model touching only the final handful.

## The stages

| Stage | Who | Does | Why it's there |
|-------|-----|------|----------------|
| **BASE** | ~5 haiku agents, each a *different angle* (cost-first, simplicity-first, resilience-first…) | Discover options widely; high recall | Breadth is cheap — spend the cheapest tokens here |
| **DEDUP** | plain code, no LLM | Normalize names, collapse near-duplicates | Never pay a model to string-normalize |
| **FIT** | N haiku scorers, single-pass, tool-free | Score each option against the *fixed priorities*; drop misfits | The product: a cheap gate that kills ~80% against one decisive question |
| **KILL** | N sonnet skeptics, multi-vote quorum, optionally web-grounded | Try to **refute** each survivor; kill on a quorum of refutes | A verifier told to confirm will confirm — so tell it to attack |
| **CRITIC** | 1 haiku agent | Ask "what did we miss?" — an unexplored angle, an untested discriminator, an over-narrowed set | Builds the coverage guarantee *into* the funnel |
| **APEX** | 1 strong agent (inherits the main model, e.g. opus) | Synthesize over survivors only: recommendation, scored comparison, rejected-with-reasons | The expensive model never sees the junk |

## The concepts that make it work

- **Tier the models by where quality matters.** Legwork is cheap (haiku/sonnet);
  verdicts are not (opus). The expensive model touching ~5 of ~60 agents is the
  whole cost lever.
- **Structured output, always.** Every agent returns validated JSON (see
  [`references/schemas.md`](references/schemas.md)), so results are directly
  tabulatable — no re-reading prose to argue about what it said.
- **Adversarial verification beats confirmation.** The KILL tier defaults each
  verifier to "assume false unless proven," uses a small **multi-vote quorum**
  (e.g. kill on 2 of 3), and gives voters **diverse lenses** (correctness / cost /
  ops). Where facts are load-bearing, voters are **web-grounded against primary
  sources**.
- **Budget before you launch.** A pyramid spawns dozens of agents; the spend is
  sized from the run's *shape* (reasoning-only ≈ 220k; web-grounded ≈ 800k+ because
  fetched pages dump into context) and gated on the run's **delta**, not the shared
  session counter. A cap that fires is *information*, not failure.
- **The dominant cost is tool-use loops on a wide tier** — not the web itself.
  That's why FIT is single-pass, tool-free, and width-capped. See
  [`references/harness-notes.md`](references/harness-notes.md).
- **Convergence is a decision.** Workflows make re-running free, which tempts you
  to never close a set. Once a phase filters, it stays closed unless *new evidence*
  reopens it.

## What's in this skill

| File | What it is |
|------|------------|
| [`SKILL.md`](SKILL.md) | The operational guide: when to fan out (vs. just reason), budget mechanics, the gotchas, and how to author a run |
| [`scripts/pyramid-template.js`](scripts/pyramid-template.js) | The canonical **option-selection** funnel — args-driven, don't edit it; invoke with `Workflow({ scriptPath, args })` |
| [`scripts/claim-verification-template.js`](scripts/claim-verification-template.js) | A variant for *"verify these N questions and cite the facts"* — DISCOVER → web VERIFY → cited SYNTH, no FIT tier |
| [`scripts/pyramid-template.test.mjs`](scripts/pyramid-template.test.mjs) | A \$0, zero-dep `node:test` suite (16 tests) that catches token-wasting bugs before a real run. `node --test scripts/*.test.mjs` |
| [`scripts/harness-lib.mjs`](scripts/harness-lib.mjs) | Shared test runner (mocks `agent`/`parallel`/`budget` — no LLM calls) |
| [`references/schemas.md`](references/schemas.md) | JSON schemas per tier |
| [`references/harness-notes.md`](references/harness-notes.md) | Dynamic-workflow harness gotchas (the `pall()` fix, budget guard, web-grounded sizing) |

## The one bug everyone hits

`await parallel(x.map(...)).filter(...)` binds `.filter` to the **Promise**, not the
array → `.filter is not a function`. Always route through the `pall()` helper and
assign in two steps; run `node --check` before launching. The template already does
this correctly.
