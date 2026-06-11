// Unit tests for pyramid-template.js — catch the "dumb errors that cost lost
// tokens" before a real run spends money. Zero deps (node:test + node:assert).
// Run:  node --test scripts/*.test.mjs   (from the skill dir), or  node --test <this file>
//
// Each test asserts a structural invariant whose failure would burn tokens:
// the budget gate not firing, FIT looping (web on the wrong tier), kill-quorum
// math wrong, caps ignored, or the run dying after agents have already spent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, BASE_ARGS } from './harness-lib.mjs'

// ---------- args validation: must fail CHEAP (before any agent spends) ----------
test('missing args.problem throws before any agent runs (0 spend)', async () => {
  const { error, calls } = await runWorkflow({ priorities: ['a'], angles: [{ key: 'k', lens: 'l' }] })
  assert.ok(error, 'should throw when problem is missing')
  assert.match(error.message, /args\.problem is required/)
  assert.equal(calls.length, 0, 'no agents may run when args are invalid')
})

test('args delivered as a JSON string is parsed (boundary footgun)', async () => {
  const { error, result } = await runWorkflow(JSON.stringify({ ...BASE_ARGS, webTiers: [] }))
  assert.equal(error, null, 'stringified args should parse, not throw')
  assert.ok(result && result.funnel, 'run completes with stringified args')
})

// ---------- funnel shape + return contract (apex must produce a result) ----------
test('happy path: full funnel runs and returns the contract', async () => {
  const { result, byPhase, error } = await runWorkflow({ ...BASE_ARGS })
  assert.equal(error, null)
  assert.equal(typeof result.recommendation, 'string', 'apex synthesis ran')
  assert.ok(result.funnel, 'funnel stats present')
  assert.ok('coverage' in result, 'coverage critic carried')
  assert.ok(Array.isArray(result.rejected), 'rejected list present')
  assert.equal(byPhase('Base').length, BASE_ARGS.angles.length, 'one BASE agent per angle')
  assert.equal(byPhase('Apex').length, 1, 'exactly one apex')
  assert.equal(byPhase('Critic').length, 1, 'exactly one critic')
})

// ---------- model tiering: opus only at apex (the cost lever) ----------
test('cheap tiers use cheap models; apex inherits strong model', async () => {
  const { byPhase } = await runWorkflow({ ...BASE_ARGS })
  assert.ok(byPhase('Base').every(c => c.model === 'haiku'), 'BASE haiku')
  assert.ok(byPhase('Fit').every(c => c.model === 'haiku'), 'FIT haiku')
  assert.ok(byPhase('Kill').every(c => c.model === 'sonnet'), 'KILL sonnet')
  assert.equal(byPhase('Apex')[0].model, '(inherit)', 'APEX must NOT override model (inherits opus)')
})

// ---------- kill-quorum math: agents = survivors * votes, capped ----------
test('KILL spawns votes-per-survivor and respects maxKill', async () => {
  const { byPhase } = await runWorkflow({ ...BASE_ARGS, killVotes: 3, maxKill: 8 })
  const kill = byPhase('Kill').length
  assert.equal(kill % 3, 0, 'KILL count is a multiple of killVotes')
  assert.ok(kill <= 8 * 3, 'KILL respects maxKill * votes')
})

// ---------- per-tier web wiring: FIT must NEVER fetch (it loops = $$$) ----------
test('webTiers controls fetching per tier; FIT never fetches', async () => {
  const { byPhase } = await runWorkflow({ ...BASE_ARGS, webTiers: ['base', 'kill'] })
  assert.ok(byPhase('Base').every(c => c.usesWeb), 'BASE fetches when listed')
  assert.ok(byPhase('Kill').every(c => c.usesWeb), 'KILL fetches when listed')
  assert.ok(byPhase('Fit').every(c => !c.usesWeb), 'FIT must be tool-free even when other tiers fetch')
})

test('webGrounded:true is a back-compat alias for kill-only', async () => {
  const { byPhase } = await runWorkflow({ ...BASE_ARGS, webTiers: undefined, webGrounded: true })
  assert.ok(byPhase('Base').every(c => !c.usesWeb), 'BASE off under the alias')
  assert.ok(byPhase('Kill').every(c => c.usesWeb), 'KILL on under the alias')
})

test('no web flag => no tier fetches', async () => {
  const { byPhase } = await runWorkflow({ ...BASE_ARGS, webTiers: [] })
  assert.ok([...byPhase('Base'), ...byPhase('Kill')].every(c => !c.usesWeb), 'nothing fetches')
})

// ---------- FIT width cap: the dominant cost lever must not be unbounded ----------
test('FIT width is capped and surplus is logged (not silent)', async () => {
  const { byPhase, logs } = await runWorkflow({ ...BASE_ARGS, maxFit: 24 }, { distinctCandidates: true })
  assert.ok(byPhase('Fit').length <= 24, 'FIT respects maxFit')
  assert.ok(logs.some(l => /capping/.test(l)), 'dropped surplus is logged, never silent')
})

// ---------- budget gate: must fire on THIS run's delta, before the kill tier ----------
test('budget gate fires before KILL and short-circuits (no kill/apex spend)', async () => {
  // hard cap below what BASE+FIT will spend, so the pre-kill gate trips
  const { result, byPhase } = await runWorkflow({ ...BASE_ARGS, hard: 1, warn: 1 })
  assert.ok(result.stopped && /pre-kill/.test(result.stopped), 'stopped at pre-kill gate')
  assert.equal(result.recommendation, null, 'no apex when gated')
  assert.equal(byPhase('Kill').length, 0, 'no KILL agents spent after the gate fired')
  assert.equal(byPhase('Apex').length, 0, 'no APEX after the gate fired')
})

test('gate reads the DELTA, not raw spent: prior session spend does not false-trip', async () => {
  // seed a large pre-existing session spend; the run itself is small and must NOT trip
  const { result, error } = await runWorkflow({ ...BASE_ARGS, webTiers: [], hard: 220_000, warn: 150_000 }, { startSpent: 500_000 })
  assert.equal(error, null)
  assert.ok(!result.stopped, 'must not stop: 500k was prior session output, not this run')
  assert.equal(typeof result.recommendation, 'string', 'run completes despite high baseline')
})

// ---------- KILL quorum OUTCOME: the comparator that decides survive/kill ----------
// Test 5 only counts spawns. This pins the decision math (template L205:
// survives = refutes < KILL_THRESHOLD && vs.length > 0). A flipped comparator
// burns all KILL + APEX tokens and returns the WRONG recommendation, silently.
//
// fakeFor drives the refute COUNT per candidate by name, so a candidate sits
// EXACTLY ON the threshold (refutes == KILL_THRESHOLD). That boundary is what
// distinguishes the correct `refutes < THRESHOLD` (boundary => dies) from a
// flipped `refutes <= THRESHOLD` (boundary => lives) — without a candidate on the
// line, the comparator flip is invisible. With killVotes:3, killThreshold:2:
//   "Boundary" => exactly 2 refutes (votes 1,2 refute; vote 3 clears) => MUST die
//   "Survivor" => 1 refute (under threshold)                          => MUST live
function quorumFake(schema, label) {
  if (!schema) return 'APEX SYNTH TEXT (mock)'
  const req = schema.required || []
  if (req.includes('candidates')) {
    return { candidates: [
      { name: 'Survivor Option', oneLine: 'one refute, under the threshold => lives' },
      { name: 'Boundary Option', oneLine: 'exactly threshold refutes => must die' },
    ] }
  }
  if (req.includes('fitScore')) {
    return { name: String(label).replace('fit:', ''), fitScore: 12, keep: true, reason: 'keep both to reach KILL' }
  }
  if (req.includes('survives')) {
    // label is kill:<name>:vN — refute the first N votes per candidate
    const v = Number(String(label).match(/:v(\d+)$/)?.[1] || 1)
    const refutesUpTo = /boundary/i.test(label) ? 2 : (/survivor/i.test(label) ? 1 : 0)
    const refute = v <= refutesUpTo
    return { name: label, survives: !refute, fatalFlaws: refute ? ['fatal'] : [], caveats: [], sources: [] }
  }
  if (req.includes('verdict') && req.includes('gaps')) return { verdict: 'adequate', gaps: [] }
  return {}
}

test('KILL quorum kills a candidate AT the threshold and keeps one under it', async () => {
  const { result, error } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one angle' }], killVotes: 3, killThreshold: 2, webTiers: [] },
    { fakeFor: quorumFake }
  )
  assert.equal(error, null)
  // Boundary (2 refutes == threshold) must die; Survivor (1 refute < threshold) lives.
  assert.equal(result.funnel.survivors, 1, 'exactly one survivor: Boundary dies AT threshold, Survivor lives under it')
  assert.ok(result.rejected.some(r => /boundary/i.test(r.name)), 'Boundary Option (refutes == threshold) is rejected')
  assert.ok(result.rejected.every(r => !/survivor/i.test(r.name)), 'Survivor Option (under threshold) must NOT be rejected')
})

// ---------- APEX must NOT run on an empty survivor set (opus on [] = pure waste) ----------
// If FIT or KILL empties the set, the strong-model apex call must be skipped, not
// fired on nothing. fakeFor refutes EVERY candidate so survivors = [].
function killAllFake(schema, label) {
  if (!schema) return 'APEX SYNTH TEXT (mock)'
  const req = schema.required || []
  if (req.includes('candidates')) return { candidates: [{ name: 'Only Option', oneLine: 'gets killed' }] }
  if (req.includes('fitScore')) return { name: String(label).replace('fit:', ''), fitScore: 12, keep: true, reason: 'k' }
  if (req.includes('survives')) return { name: label, survives: false, fatalFlaws: ['fatal'], caveats: [], sources: [] }
  if (req.includes('verdict') && req.includes('gaps')) return { verdict: 'adequate', gaps: [] }
  return {}
}

test('APEX is skipped when no survivors remain (no opus on empty set)', async () => {
  const { result, byPhase, error } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], killVotes: 1, killThreshold: 1, webTiers: [] },
    { fakeFor: killAllFake }
  )
  assert.equal(error, null)
  assert.equal(result.funnel.survivors, 0, 'all candidates were killed')
  assert.equal(byPhase('Apex').length, 0, 'APEX (strong model) must NOT run on zero survivors')
  assert.equal(result.recommendation, null, 'no recommendation when nothing survived')
  assert.ok(result.stopped && /no survivors/i.test(result.stopped), 'result reports why it stopped')
})

// ---------- KILL_VOTES default derivation: web-kill => 3 votes, no-web => 1 ----------
// Wrong default = silent 3x KILL over-spend, or under-voting (no quorum). Asserted
// via spawn count for a known survivor count of 1 (single angle, both kept... here
// one candidate so votes == agent count).
test('KILL_VOTES defaults to 3 when KILL is web-grounded', async () => {
  const { byPhase } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], webTiers: ['kill'], killVotes: undefined, maxKill: 1 },
    { fakeFor: quorumFake }
  )
  // one candidate kept into KILL (maxKill 1) => agent count == default votes
  assert.equal(byPhase('Kill').length, 3, 'web-grounded KILL defaults to 3 votes per survivor')
})

test('KILL_VOTES defaults to 1 when no tier fetches', async () => {
  const { byPhase } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], webTiers: [], killVotes: undefined, maxKill: 1 },
    { fakeFor: quorumFake }
  )
  assert.equal(byPhase('Kill').length, 1, 'no-web KILL defaults to a single vote per survivor')
})

// ---------- skipCritic: no critic agent, apex still runs, no throw ----------
test('skipCritic:true skips the coverage critic without breaking apex', async () => {
  const { byPhase, result, error } = await runWorkflow({ ...BASE_ARGS, skipCritic: true })
  assert.equal(error, null)
  assert.equal(byPhase('Critic').length, 0, 'no critic agent spawned')
  assert.equal(byPhase('Apex').length, 1, 'apex still runs')
  assert.equal(result.coverage, null, 'coverage is null when critic skipped')
})
