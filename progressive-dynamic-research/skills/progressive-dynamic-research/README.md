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

**Optional insert — COMPOSE/EVOLVE** (between KILL and APEX, `evolve:true`): a
strong-model (`composeModel`, default opus) composer with two modes. When **≥2
survivors** remain it proposes *hybrids* of their strengths. When **<2 survive but
some were refuted** it instead composes "best base option **+ compensating controls**"
— reading the mitigations the KILL tier named inside the refuted options' flaws — so
an all-refuted, multi-constraint problem produces an answer instead of dead-ending.
The rule is **COMPOSE generates, re-KILL judges**: the composer only *invents* a
hybrid, so every hybrid **re-enters KILL** before APEX can see it and must earn its
place through the same quorum (a hybrid the same adversary re-kills is a *true
finding*, not a bug). Compose defaults to the strong model because inventing a good
hybrid is real synthesis; re-KILL is the cheaper backstop and can only reject a weak
hybrid, never upgrade one. The gate here *degrades* (skip the enhancement, synthesize
whatever survived); it never starves synthesis. Without `evolve`, a <2-survivor
outcome stays a hard stop. Default off.

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
