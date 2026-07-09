// ============================================================================
// EVOLVE A/B EVAL — does the optional COMPOSE/EVOLVE tier actually produce a
// better recommendation than leaving it off? This is a DEV tool (not shipped to
// end users): run it to decide whether `evolve:true` earns its tokens for a
// problem class. It does NOT modify pyramid-template.js.
//
// Design — isolate the COMPOSE tier with NO discovery confound:
//   For each problem, run BASE -> FIT -> KILL ONCE, then BRANCH over the SAME
//   survivors:
//     arm A (baseline)  = APEX on survivors only            (evolve OFF)
//     arm B (evolve)    = COMPOSE + re-KILL -> APEX          (evolve ON)
//   Because both arms start from identical survivors, any delta is the COMPOSE
//   tier, not BASE nondeterminism (which would conflate discovery variance with
//   the effect under test).
//
// Then a BLIND, order-swapped judge panel scores arm-vs-arm against the problem
// priorities (not prose sophistication). The judge sees "first"/"second", never
// the arm name; presentation order swaps by problem-index parity so position bias
// cancels across the set. Plus the FREE in-run signal: did a hybrid survive
// re-KILL and outrank the originals in arm B itself?
//
// Invoke:  Workflow({ scriptPath: <this file>, args: {
//            problems: [ { problem, priorities, angles }, ... ],  // 1+ problems
//            judges:  3,                 // blind panel size (odd => no ties)
//            killVotes: 1, killThreshold: 1, maxKill: 6,
//            hard: 600000, warn: 450000  // sized for 2 arms x N problems x panel
//          } })
// Start with ONE problem to prove the pipe end-to-end before scaling the set.
//
// NOTE on the inlined helpers below: the Workflow runtime executes a script by
// wrapping it in a function with agent/parallel/budget/args injected as globals
// (the same model pyramid-template.js is self-contained for) — a top-level
// `import` is not resolvable there. So the deterministic helpers are INLINED here
// from scripts/evolve-eval-lib.mjs, which remains the unit-tested source of truth.
// They MUST stay byte-identical to the lib; evolve-eval-dry.test.mjs enforces that.
// (The helpers are defined AFTER `meta` below — the runtime requires `meta` to be
// the script's first statement.)
// ============================================================================

export const meta = {
  name: 'evolve-eval',
  description: 'A/B eval of the COMPOSE/EVOLVE tier: branch after KILL, blind judge panel, win-rate + token delta (dev tool)',
  phases: [
    { title: 'Survivors', detail: 'BASE -> FIT -> KILL once per problem (shared by both arms)' },
    { title: 'Arms', detail: 'arm A = APEX-only; arm B = COMPOSE + re-KILL -> APEX' },
    { title: 'Judge', detail: 'blind, order-swapped panel scores A vs B on priorities' },
  ],
}

// >>> BEGIN inlined from evolve-eval-lib.mjs (keep in sync; enforced by test) >>>
function swapForProblem(index, recA, recB) {
  const strip = (r) => { const { arm, ...rest } = r; return rest }  // drop arm identity
  const aFirst = index % 2 === 0
  return aFirst
    ? { first: strip(recA), second: strip(recB), firstArm: 'A', secondArm: 'B' }
    : { first: strip(recB), second: strip(recA), firstArm: 'B', secondArm: 'A' }
}
function tallyVotes(votes, swap) {
  let firstCount = 0, secondCount = 0
  for (const v of votes) {
    if (v.winner === 'first') firstCount++
    else if (v.winner === 'second') secondCount++
  }
  if (firstCount === secondCount) {
    return { arm: null, tie: true, votesFor: firstCount, votesAgainst: secondCount }
  }
  const firstWins = firstCount > secondCount
  return {
    arm: firstWins ? swap.firstArm : swap.secondArm,
    tie: false,
    votesFor: Math.max(firstCount, secondCount),
    votesAgainst: Math.min(firstCount, secondCount),
  }
}
function aggregate(perProblem) {
  // A problem where NO hybrid survived re-KILL is "no effect": arm B synthesized
  // the SAME survivors as arm A, so any judge verdict is a coin-flip between two
  // runs of the identical experiment. Such problems are EXCLUDED from the decided
  // set — counting a hollow B-win would make the headline win-rate lie.
  const noEffect = perProblem.filter(p => p.hybridSurvived === false).length
  const contested = perProblem.filter(p => p.hybridSurvived !== false)
  const decided = contested.filter(p => p.winner === 'A' || p.winner === 'B')
  const evolveWins = decided.filter(p => p.winner === 'B').length
  const totalDelta = perProblem.reduce((n, p) => n + ((p.tokensB || 0) - (p.tokensA || 0)), 0)
  return {
    problems: perProblem.length,
    noEffect,
    decided: decided.length,
    evolveWins,
    baselineWins: decided.length - evolveWins,
    evolveWinRate: decided.length ? evolveWins / decided.length : null,
    meanTokenDeltaB: perProblem.length ? totalDelta / perProblem.length : 0,
  }
}
// <<< END inlined from evolve-eval-lib.mjs <<<

const pall = async (thunks) => (await parallel(thunks)) || []
const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { /* guarded below */ } }
A = A || {}
const PROBLEMS = (A.problems && A.problems.length) ? A.problems : null
if (!PROBLEMS) throw new Error('evolve-eval: args.problems must be a non-empty array. typeof args=' + typeof args)
const JUDGES = A.judges || 3
const KILL_VOTES = A.killVotes || 1
const KILL_THRESHOLD = A.killThreshold || Math.ceil(KILL_VOTES / 2)
const MAX_KILL = A.maxKill || 6

const START = budget.spent()
const HARD = A.hard || 600_000
const WARN = A.warn || 450_000
function gate(where) {
  const s = budget.spent() - START
  if (s >= HARD) { log('HARD CAP at ' + where + ': ' + Math.round(s / 1000) + 'k (this run)'); return 'STOP' }
  if (s >= WARN) log('WARN at ' + where + ': ' + Math.round(s / 1000) + 'k (this run)')
  return 'OK'
}

const CAND_SCHEMA = { type: 'object', required: ['candidates'], properties: { candidates: { type: 'array', items: {
  type: 'object', required: ['name', 'oneLine'], properties: { name: { type: 'string' }, oneLine: { type: 'string' } } } } } }
const FIT_SCHEMA = { type: 'object', required: ['name', 'fitScore', 'keep', 'reason'], properties: {
  name: { type: 'string' }, fitScore: { type: 'integer' }, keep: { type: 'boolean' }, reason: { type: 'string' } } }
const VERDICT_SCHEMA = { type: 'object', required: ['name', 'survives', 'fatalFlaws'], properties: {
  name: { type: 'string' }, survives: { type: 'boolean' }, fatalFlaws: { type: 'array', items: { type: 'string' } },
  caveats: { type: 'array', items: { type: 'string' } } } }
const HYBRID_SCHEMA = { type: 'object', required: ['hybrids'], properties: { hybrids: { type: 'array', items: {
  type: 'object', required: ['name', 'oneLine'], properties: { name: { type: 'string' }, oneLine: { type: 'string' },
  combines: { type: 'array', items: { type: 'string' } } } } } } }
// The judge scores against priorities, decides a winner, and reports margin. It
// never learns which arm is which — it only sees "first" and "second".
const JUDGE_SCHEMA = { type: 'object', required: ['winner', 'why'], properties: {
  winner: { type: 'string', enum: ['first', 'second', 'tie'] },
  why: { type: 'string', description: 'which recommendation scores higher against the stated priorities, and why' } } }

function problemText(p) {
  const pr = (p.priorities && p.priorities.length) ? p.priorities : ['fit', 'simplicity', 'cost']
  return p.problem + '\nPriorities, in order: ' + pr.map((x, i) => '(' + (i + 1) + ') ' + x).join('; ') + '.'
}

// Shared KILL quorum — used for the initial cull AND arm B re-vet, like the template.
async function killVote(PROBLEM, cands, phaseLabel) {
  return (await pall(cands.map((c, ci) => () =>
    pall(Array.from({ length: KILL_VOTES }, (_, vi) => () =>
      agent(
        PROBLEM + '\n\nYou are ADVERSARIAL reviewer #' + (vi + 1) + '. Default to skepticism — try to REFUTE this option; '
        + 'only let it survive if it withstands attack on the priorities.\nOption: "' + c.name + '" — ' + c.oneLine + '.\n'
        + 'Attack hidden costs, operational traps, and whether its claims hold against the priorities. Decide survives true/false.',
        // ci in the label so options with the same leading tokens do not collide (mirrors the template).
        { label: phaseLabel + ':c' + ci + ':' + norm(c.name).slice(0, 12) + ':v' + (vi + 1), phase: 'Survivors', model: 'sonnet', schema: VERDICT_SCHEMA }
      )
    )).then(votes => {
      // Same crashed-vote integrity fix as the template killVote: a crashed vote is
      // MISSING DATA, not a verdict. Resolve only when the missing votes cannot change
      // the outcome; otherwise the verdict is degraded (unknown) and must NOT count as a
      // survive OR a kill — else a crash silently biases the eval win-rate this tool exists to measure.
      const vs = votes.filter(Boolean)
      const refutes = vs.filter(v => v.survives === false).length
      const missing = KILL_VOTES - vs.length
      const determinedSurvive = (refutes + missing) < KILL_THRESHOLD
      const degraded = !(refutes >= KILL_THRESHOLD) && !determinedSurvive
      return { name: c.name, src: c, survives: determinedSurvive, degraded,
        caveats: [...new Set(vs.flatMap(v => v.caveats || []))] }
    })
  ))).filter(Boolean)
}

async function apex(PROBLEM, survivors) {
  return agent(
    PROBLEM + '\n\nYou are the apex synthesizer. Below are adversarially-filtered survivors. Produce a clear recommendation '
    + 'up front, justification against each priority, and a scored comparison.\n\nSURVIVORS:\n' + JSON.stringify(survivors, null, 2),
    { label: 'apex', phase: 'Arms' }   // inherits strong main-loop model
  )
}

// Run one problem through both arms over a shared survivor set; return the two
// recommendations, the token cost of each arm, and the free in-run hybrid signal.
async function evalProblem(p, index) {
  const PROBLEM = problemText(p)
  const angles = (p.angles && p.angles.length) ? p.angles : [
    { key: 'a', lens: 'fit-for-purpose first' }, { key: 'b', lens: 'operational-simplicity first' }, { key: 'c', lens: 'cost first' }]

  // --- shared discovery (run once; both arms see the same survivors) ---
  const baseRuns = await pall(angles.map(a => () => agent(
    PROBLEM + '\n\nThrough the lens of: ' + a.lens + '. List 6-10 plausible concrete options, name + one sentence each. '
    + 'Reason from your own knowledge; do NOT use web tools.',
    { label: 'base:' + a.key, phase: 'Survivors', model: 'haiku', schema: CAND_SCHEMA })))
  const byKey = new Map()
  for (const r of baseRuns) for (const c of (r.candidates || [])) {
    const k = norm(c.name).split(' ').slice(0, 3).join(' '); if (!byKey.has(k)) byKey.set(k, c)
  }
  const unique = [...byKey.values()]
  const fits = (await pall(unique.map(c => () => agent(
    PROBLEM + '\n\nScore this ONE option against the priorities. Option: "' + c.name + '" — ' + c.oneLine + '. '
    + 'keep=true only if a credible contender. Single pass, no web tools.',
    { label: 'fit:' + norm(c.name).slice(0, 12), phase: 'Survivors', model: 'haiku', schema: FIT_SCHEMA }
  ).then(f => (f ? { ...f, src: c } : null))))).filter(Boolean)
  const kept = fits.filter(f => f.keep).sort((a, b) => b.fitScore - a.fitScore).slice(0, MAX_KILL)
  const verdicts = await killVote(PROBLEM, kept.map(f => f.src), 'kill')
  const survivors = verdicts.filter(v => v.survives).map(v => ({ name: v.name, oneLine: v.src.oneLine, caveats: v.caveats }))

  if (survivors.length < 2) {
    // COMPOSE needs >=2 survivors — eval is meaningless here; record and skip.
    return { problem: p.problem, skipped: 'fewer than 2 survivors; COMPOSE would not trigger', survivors: survivors.length }
  }

  // --- arm A: baseline (APEX on survivors only) ---
  const beforeA = budget.spent()
  const recA = await apex(PROBLEM, survivors)
  const tokensA = budget.spent() - beforeA

  // --- arm B: evolve (COMPOSE + re-KILL) over the SAME survivors ---
  const beforeB = budget.spent()
  const composed = await agent(
    PROBLEM + '\n\nYou are a COMPOSER. Below are options that each survived adversarial review. Propose 1-2 HYBRID options '
    + 'combining their strongest parts to beat any single survivor on the priorities — only if a genuine synthesis exists '
    + '(an empty list is valid). Each hybrid: name, one-sentence description, which survivors it combines.\n\nSURVIVORS:\n'
    + JSON.stringify(survivors, null, 2),
    { label: 'compose', phase: 'Arms', model: 'sonnet', schema: HYBRID_SCHEMA })
  const hybrids = (composed?.hybrids || []).filter(h => h && h.name)
  let survivingHybrids = []
  if (hybrids.length) {
    const hv = await killVote(PROBLEM, hybrids, 'kill-hybrid')
    survivingHybrids = hv.filter(v => v.survives).map(v => ({ name: v.name, oneLine: v.src.oneLine, hybrid: true }))
  }

  // NO-EFFECT short-circuit: if no hybrid survived re-KILL, arm B would synthesize
  // the IDENTICAL survivor set arm A already did — the same experiment twice. Running
  // arm-B APEX and the judge panel would only produce a coin-flip "win" that lies in
  // the win-rate. Skip both, record noEffect, and save an APEX + JUDGES agents.
  if (survivingHybrids.length === 0) {
    return {
      problem: p.problem,
      hybridSurvived: false,
      noEffect: 'no hybrid survived re-KILL — arm B == arm A; APEX + judges skipped',
      tokensA, tokensB: budget.spent() - beforeB,   // compose + re-KILL cost, no B-apex/judges
    }
  }

  const recB = await apex(PROBLEM, survivors.concat(survivingHybrids))
  const tokensB = budget.spent() - beforeB

  // --- blind, order-swapped judge panel: A vs B against the priorities ---
  const swap = swapForProblem(index, { arm: 'A', text: recA }, { arm: 'B', text: recB })
  const votes = await pall(Array.from({ length: JUDGES }, (_, ji) => () => agent(
    PROBLEM + '\n\nYou are blind judge #' + (ji + 1) + '. Two candidate recommendations follow, labelled FIRST and SECOND. '
    + 'Decide which better satisfies the priorities ABOVE (judge substance against the priorities, NOT which sounds more '
    + 'elaborate or longer). If they are genuinely equal, answer tie.\n\nFIRST:\n' + JSON.stringify(swap.first)
    + '\n\nSECOND:\n' + JSON.stringify(swap.second),
    { label: 'judge:p' + index + ':j' + (ji + 1), phase: 'Judge', model: 'sonnet', schema: JUDGE_SCHEMA })))
  const tally = tallyVotes(votes.filter(Boolean), swap)

  return {
    problem: p.problem,
    winner: tally.arm,                 // 'A' (baseline), 'B' (evolve), or null (tie)
    tie: tally.tie,
    votesFor: tally.votesFor, votesAgainst: tally.votesAgainst,
    hybridSurvived: true,              // a hybrid genuinely competed — this problem is contested
    tokensA, tokensB,
  }
}

// ----- drive the problem set; one problem proves the pipe before scaling -----
phase('Survivors')
log('Evolve A/B eval: ' + PROBLEMS.length + ' problem(s), ' + JUDGES + '-judge blind panel; arms branch after a shared KILL')
const results = []
for (let i = 0; i < PROBLEMS.length; i++) {
  if (gate('problem ' + i) === 'STOP') { log('stopped before problem ' + i + ' (budget)'); break }
  results.push(await evalProblem(PROBLEMS[i], i))
}

const scored = results.filter(r => !r.skipped)
const agg = aggregate(scored)
log('Eval done: evolve win-rate ' + (agg.evolveWinRate === null ? 'n/a' : Math.round(agg.evolveWinRate * 100) + '%')
  + ' over ' + agg.decided + ' contested (' + agg.noEffect + ' no-effect); mean extra tokens for evolve ' + Math.round(agg.meanTokenDeltaB))

return {
  summary: {
    ...agg,
    skippedFewSurvivors: results.filter(r => r.skipped).length,
    note: 'win-rate is over CONTESTED problems only — those where a hybrid actually survived re-KILL and competed. '
      + 'Problems where no hybrid survived are counted in noEffect (arm B == arm A; their APEX + judges are skipped, not '
      + 'coin-flipped into the win-rate). Arms branch after a SHARED KILL, so the token delta isolates the COMPOSE tier with '
      + 'no discovery confound; the delta is OUTPUT tokens only (budget.spent() is output-only — it omits the dominant '
      + 'input/cache cost). Judges are blind; order swaps by problem-index PARITY, so position bias only cancels across an '
      + 'EVEN split — a single-problem or odd-N run is a pipe-check, NOT a verdict. This tool REIMPLEMENTS the funnel inline '
      + '(it does not invoke pyramid-template.js); keep the compose path in sync with the template if either changes.',
  },
  perProblem: results,
}
