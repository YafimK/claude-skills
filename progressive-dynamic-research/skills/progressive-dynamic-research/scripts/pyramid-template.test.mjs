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

// ===========================================================================
// EVOLVE / COMPOSE tier (opt-in). Between KILL and APEX, propose hybrid(s) that
// combine survivor strengths, then RE-VET them through KILL before APEX. The
// funnel invariant the compose tier must NOT break: APEX only ever sees
// adversarially-vetted options. A hybrid that skips re-KILL, or COMPOSE running
// on opus, or compose firing by default, each silently breaks the cost thesis.
// ===========================================================================

// A composeFake that (a) emits two survivors so compose triggers, (b) returns a
// hybrid from COMPOSE, and (c) lets EVERYTHING survive KILL — so we can prove the
// hybrid reaches APEX *via* a re-KILL pass (not by bypassing it).
function composeFake(schema, label) {
  if (!schema) return 'APEX SYNTH TEXT (mock)'
  const req = schema.required || []
  if (req.includes('candidates')) {
    return { candidates: [
      { name: 'Option Alpha', oneLine: 'survivor one' },
      { name: 'Option Beta', oneLine: 'survivor two' },
    ] }
  }
  if (req.includes('fitScore')) return { name: String(label).replace('fit:', ''), fitScore: 12, keep: true, reason: 'keep both' }
  if (req.includes('hybrids')) return { hybrids: [{ name: 'Hybrid AB', oneLine: 'combines Alpha + Beta', combines: ['Option Alpha', 'Option Beta'] }] }
  if (req.includes('survives')) return { name: label, survives: true, fatalFlaws: [], caveats: [], sources: [] }
  if (req.includes('verdict') && req.includes('gaps')) return { verdict: 'adequate', gaps: [] }
  return {}
}

test('evolve is OFF by default: no compose agent, funnel unchanged', async () => {
  const { byPhase, error } = await runWorkflow({ ...BASE_ARGS })
  assert.equal(error, null)
  assert.equal(byPhase('Compose').length, 0, 'no COMPOSE agent spawns unless evolve:true')
})

test('evolve:true with >=2 survivors runs COMPOSE on the strong model (opus) by default', async () => {
  // Compose is GENERATIVE synthesis (esp. compensating mode: read fatal flaws, invent
  // "base + the mitigation each names"). A live discriminator run showed composites being
  // refuted — a weak composer is the plausible cause, and re-KILL can only reject a bad
  // hybrid, never upgrade it. So the default composer is opus; re-KILL stays the sonnet
  // backstop and APEX still inherits the strong model. Cost is bounded because compose is
  // 1-2 calls, not a wide tier.
  const { byPhase, error } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], evolve: true, webTiers: [], killVotes: 1, killThreshold: 1 },
    { fakeFor: composeFake }
  )
  assert.equal(error, null)
  assert.equal(byPhase('Compose').length, 1, 'one COMPOSE agent runs with >=2 survivors')
  assert.ok(byPhase('Compose').every(c => c.model === 'opus'), 'COMPOSE defaults to opus — the generative synthesis is where model quality matters')
  // re-KILL of the hybrid stays sonnet (the cheap adversarial backstop)
  assert.ok(byPhase('Kill').filter(c => /kill-hybrid/.test(c.label)).every(c => c.model === 'sonnet'), 're-KILL stays sonnet')
})

test('composeModel arg overrides the compose model (e.g. back to sonnet for a cheap run)', async () => {
  const { byPhase, error } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], evolve: true, webTiers: [], killVotes: 1, killThreshold: 1, composeModel: 'sonnet' },
    { fakeFor: composeFake }
  )
  assert.equal(error, null)
  assert.ok(byPhase('Compose').every(c => c.model === 'sonnet'), 'composeModel:sonnet forces the cheap composer')
})

test('hybrid is RE-VETTED through KILL before APEX (funnel invariant)', async () => {
  // With composeFake everything survives, so the hybrid must appear as a KILL
  // target (proof of re-vet) AND in the APEX input (proof it passed).
  const { byPhase, calls, error } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], evolve: true, webTiers: [], killVotes: 1, killThreshold: 1 },
    { fakeFor: composeFake }
  )
  assert.equal(error, null)
  const killLabels = byPhase('Kill').map(c => c.label).join('|')
  assert.match(killLabels, /hybrid/i, 'the hybrid must pass through the KILL tier (re-vetted, not injected raw)')
  // The hybrid survived re-vet, so APEX's prompt must actually contain it —
  // proving it reached synthesis THROUGH kill, not bypassing it.
  const apex = calls.find(c => c.phase === 'Apex')
  assert.ok(apex, 'apex ran')
  assert.match(apex.prompt, /Hybrid AB/, 'the re-vetted hybrid reaches APEX input')
})

test('a hybrid that FAILS re-KILL never reaches APEX', async () => {
  // survivors survive; the hybrid is refuted on re-vet. APEX input must not list it.
  function hybridDiesFake(schema, label) {
    if (!schema) return 'APEX SYNTH TEXT (mock)'
    const req = schema.required || []
    if (req.includes('candidates')) return { candidates: [{ name: 'Option Alpha', oneLine: 's1' }, { name: 'Option Beta', oneLine: 's2' }] }
    if (req.includes('fitScore')) return { name: String(label).replace('fit:', ''), fitScore: 12, keep: true, reason: 'k' }
    if (req.includes('hybrids')) return { hybrids: [{ name: 'Hybrid AB', oneLine: 'combo', combines: ['Option Alpha', 'Option Beta'] }] }
    if (req.includes('survives')) {
      const dies = /hybrid/i.test(label)   // only the hybrid is refuted on re-vet
      return { name: label, survives: !dies, fatalFlaws: dies ? ['hybrid fatal'] : [], caveats: [], sources: [] }
    }
    if (req.includes('verdict') && req.includes('gaps')) return { verdict: 'adequate', gaps: [] }
    return {}
  }
  const { result, byPhase, error } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], evolve: true, webTiers: [], killVotes: 1, killThreshold: 1 },
    { fakeFor: hybridDiesFake }
  )
  assert.equal(error, null)
  // the hybrid WAS re-vetted (appears as a kill target) ...
  assert.ok(byPhase('Kill').some(c => /hybrid/i.test(c.label)), 'hybrid was sent through re-KILL')
  // ... but it was refuted, so it must show up REJECTED, never as a survivor.
  assert.ok(result.rejected.some(r => /hybrid/i.test(r.name)), 'refuted hybrid is listed as rejected')
  assert.equal(result.funnel.survivors, 2, 'survivors stay at the 2 originals; the dead hybrid is NOT counted')
})

test('return.compose traces what the composer proposed and how it fared at re-KILL', async () => {
  // hybridize mode, hybrid survives: result.compose.proposed lists it, reKill marks survived:true
  const { result, error } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], evolve: true, webTiers: [], killVotes: 1, killThreshold: 1 },
    { fakeFor: composeFake }
  )
  assert.equal(error, null)
  assert.ok(result.compose, 'compose trace present when evolve fired')
  assert.ok(result.compose.proposed.some(h => /Hybrid AB/.test(h.name)), 'proposed hybrid is named in the trace')
  assert.ok(result.compose.reKill.some(v => /Hybrid AB/.test(v.name) && v.survived === true),
    're-KILL verdict records the hybrid as survived')
})

test('return.compose is null when evolve never fired', async () => {
  const { result, error } = await runWorkflow({ ...BASE_ARGS })   // evolve OFF by default
  assert.equal(error, null)
  assert.equal(result.compose, null, 'no compose trace without evolve')
})

test('pre-compose gate DEGRADES (skip hybrid) — never aborts synthesis', async () => {
  // Tune hard so the run clears the pre-kill gate but trips pre-compose:
  // base(1)+fit(2)=12k at pre-kill (passes), +kill(2)=20k at pre-compose (trips).
  const { byPhase, result, error } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], evolve: true, webTiers: [], killVotes: 1, killThreshold: 1, hard: 18000, warn: 1 },
    { fakeFor: composeFake }
  )
  assert.equal(error, null)
  assert.equal(byPhase('Compose').length, 0, 'compose is skipped when its gate trips')
  // The whole point of degrade: APEX still runs on the ORIGINAL survivors.
  assert.equal(byPhase('Apex').length, 1, 'APEX still runs — the gate must NOT abort synthesis')
  assert.equal(typeof result.recommendation, 'string', 'a recommendation is still produced from the originals')
  assert.ok(!result.stopped, 'a tripped pre-compose gate is not a stop — it is a skipped enhancement')
})

test('evolve:true, 1 clean survivor + NO rejected => neither compose mode fires (nothing to do)', async () => {
  // Exactly one candidate, and it SURVIVES. There is no second survivor to hybridize
  // with, AND no refuted option to compose compensating controls from — so BOTH compose
  // modes must stay quiet and APEX runs on the lone survivor. (Isolates the hybridize
  // path from compensating mode: the latter is covered by its own test below.)
  function loneSurvivorNoRejects(schema, label) {
    if (!schema) return 'APEX SYNTH TEXT (mock)'
    const req = schema.required || []
    if (req.includes('candidates')) return { candidates: [{ name: 'Lone Option', oneLine: 'the only candidate, and it survives' }] }
    if (req.includes('fitScore')) return { name: String(label).replace('fit:', ''), fitScore: 12, keep: true, reason: 'k' }
    if (req.includes('hybrids')) return { hybrids: [{ name: 'Hybrid X', oneLine: 'should not be asked for', combines: [] }] }
    if (req.includes('survives')) return { name: label, survives: true, fatalFlaws: [], caveats: [], sources: [] }
    if (req.includes('verdict') && req.includes('gaps')) return { verdict: 'adequate', gaps: [] }
    return {}
  }
  const { byPhase, error, result } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], evolve: true, webTiers: [], killVotes: 1, killThreshold: 1 },
    { fakeFor: loneSurvivorNoRejects }
  )
  assert.equal(error, null)
  assert.equal(byPhase('Compose').length, 0, 'no hybridize (needs >=2) and no compensating (needs rejected) — compose must stay quiet')
  assert.equal(byPhase('Apex').length, 1, 'apex still runs on the lone survivor')
  assert.equal(typeof result.recommendation, 'string', 'lone survivor still yields a recommendation')
})

test('hybridize mode does NOT fire with <2 survivors (that is compensating mode, distinct label)', async () => {
  // 1 clean survivor + 1 rejected. Compensating mode SHOULD fire (there is a rejected
  // option), but the >=2-survivor HYBRIDIZE mode must NOT — assert by the distinct label.
  function oneSurvivorOneReject(schema, label) {
    if (!schema) return 'APEX SYNTH TEXT (mock)'
    const req = schema.required || []
    if (req.includes('candidates')) return { candidates: [{ name: 'Lone Option', oneLine: 'this one keeps' }, { name: 'Other Option', oneLine: 'this one dies' }] }
    if (req.includes('fitScore')) return { name: String(label).replace('fit:', ''), fitScore: 12, keep: true, reason: 'k' }
    if (req.includes('hybrids')) return { hybrids: [{ name: 'Compensated Lone', oneLine: 'lone + a control', combines: ['Lone Option'] }] }
    if (req.includes('survives')) {
      const dies = /other/i.test(label)
      // the compensating hybrid survives re-vet
      if (/compensated/i.test(label)) return { name: label, survives: true, fatalFlaws: [], caveats: [], sources: [] }
      return { name: label, survives: !dies, fatalFlaws: dies ? ['P2 unmet: needs a compensating control Z'] : [], caveats: [], sources: [] }
    }
    if (req.includes('verdict') && req.includes('gaps')) return { verdict: 'adequate', gaps: [] }
    return {}
  }
  const { calls, byPhase, error } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], evolve: true, webTiers: [], killVotes: 1, killThreshold: 1 },
    { fakeFor: oneSurvivorOneReject }
  )
  assert.equal(error, null)
  const composeLabels = byPhase('Compose').map(c => c.label)
  assert.ok(composeLabels.includes('compose:compensating'), 'compensating mode fires (there is a rejected option)')
  assert.ok(!composeLabels.includes('compose:hybrids'), 'the >=2-survivor hybridize mode must NOT fire with one survivor')
  assert.equal(byPhase('Apex').length, 1, 'apex runs')
})

// ---------- COMPENSATING CONTROLS: everything dies, but flaws name out-of-set fixes ----------
// The real-world failure that motivated this: a multi-constraint problem where NO single
// candidate satisfies all constraints (every one is refuted on >=1), yet a valid answer
// exists — "best base mechanism + compensating controls that cover its residual flaws".
// Those compensating controls are NOT themselves candidates; they are named inside the
// KILL tier's fatalFlaws (e.g. "the only way to satisfy P7 is a networking-layer block").
// Under evolve:true, a 0/<2-survivor outcome must NOT dead-end at `null`: it must feed the
// REJECTED candidates + their flaws into COMPOSE, which proposes a base+compensating-controls
// hybrid, re-vet it, and reach APEX. The fixture below deliberately has NO candidate that
// covers the gaps — so a design that only glues candidate-A to candidate-B would still fail.
function allDieButFlawsComplementary(schema, label) {
  if (!schema) return 'APEX SYNTH TEXT (mock over compensated hybrid)'
  const req = schema.required || []
  if (req.includes('candidates')) return { candidates: [
    { name: 'CSI Mount', oneLine: 'mounts a per-tenant blob into pods' },
    { name: 'Sidecar Puller', oneLine: 'sidecar pulls secrets to a shared volume' },
    { name: 'In-App SDK', oneLine: 'app fetches secrets at runtime' },
  ] }
  if (req.includes('fitScore')) return { name: String(label).replace('fit:', ''), fitScore: 12, keep: true, reason: 'contender' }
  if (req.includes('survives')) {
    // EVERY original candidate is refuted. Each flaw NAMES an out-of-set compensating control.
    if (/hybrid/i.test(label)) {
      // the composed base+compensating-controls hybrid DOES survive re-vet
      return { name: label, survives: true, fatalFlaws: [], caveats: ['residual ops complexity'], sources: [] }
    }
    return { name: label, survives: false,
      fatalFlaws: ['P7 unmet: the only way to block direct store access is a networking-layer private endpoint + deny egress',
                   'P6 unmet: per-read audit needs an append-only WORM log external to the delivery mechanism'],
      caveats: [], sources: [] }
  }
  if (req.includes('hybrids')) {
    // COMPOSE, given the rejected candidates + their flaws, proposes a compensated base
    return { hybrids: [{ name: 'CSI Mount + Compensating Controls', combines: ['CSI Mount'],
      oneLine: 'CSI delivery, plus a networking private-endpoint egress block for P7 and an append-only WORM audit log for P6' }] }
  }
  if (req.includes('verdict') && req.includes('gaps')) return { verdict: 'adequate', gaps: [] }
  return {}
}

test('evolve:true + ALL candidates refuted => COMPOSE compensating controls, reach APEX (no null dead-end)', async () => {
  const { result, byPhase, error, logs } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'a', lens: 'one' }, { key: 'b', lens: 'two' }], evolve: true, webTiers: [], killVotes: 1, killThreshold: 1 },
    { fakeFor: allDieButFlawsComplementary }
  )
  assert.equal(error, null, 'should not throw')
  // THE defect being fixed: 0 real survivors must NOT dead-end at recommendation:null / stopped.
  assert.notEqual(result.recommendation, null, 'must not dead-end: evolve should compose compensating controls')
  assert.ok(!result.stopped, 'must NOT return the "no survivors — loosen FIT/KILL" stop under evolve')
  // COMPOSE must have fired even though survivors < 2 (it works off the REJECTED set + flaws).
  assert.ok(byPhase('Compose').length >= 1, 'COMPOSE must run over the rejected candidates + their flaws')
  // The composer prompt must carry the fatalFlaws (the out-of-set mitigations live there).
  const composePrompt = byPhase('Compose')[0].prompt
  assert.match(composePrompt, /networking-layer|WORM|compensat/i, 'COMPOSE must see the flaws that name the compensating controls')
  // APEX runs, and it synthesizes over the compensated hybrid.
  assert.equal(byPhase('Apex').length, 1, 'APEX runs on the compensated hybrid')
})

// ---------- BACKWARD-COMPAT: evolve OFF must remain a STRICT down-selector ----------
// The compensating-controls rescue is opt-in (gated on A.evolve === true). With evolve
// OFF, an all-refuted outcome MUST still dead-end at recommendation:null + stopped, with
// ZERO Compose calls — the funnel stays the strict down-selector it always was. If the
// `&& A.evolve === true` guard on the compensating block is ever dropped, THIS goes RED.
test('evolve:false + ALL candidates refuted => strict dead-end (null + stopped, no compose)', async () => {
  const { result, byPhase, error } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'a', lens: 'one' }, { key: 'b', lens: 'two' }], evolve: false, webTiers: [], killVotes: 1, killThreshold: 1 },
    { fakeFor: allDieButFlawsComplementary }
  )
  assert.equal(error, null)
  assert.equal(result.recommendation, null, 'evolve OFF must NOT rescue via compensating controls')
  assert.ok(result.stopped, 'evolve OFF keeps the "no survivors" hard stop')
  assert.ok(!/compensating/.test(result.stopped), 'the stop message must be the plain down-selector one (no compensating wording)')
  assert.equal(byPhase('Compose').length, 0, 'evolve OFF must spawn ZERO compose agents')
  assert.equal(byPhase('Apex').length, 0, 'evolve OFF must not run APEX over an empty survivor set')
})

// ---------- KILL vote INTEGRITY: infra failure (crashed votes) is NOT a verdict ----------
// A live run crashed all re-KILL votes on a hybrid (API "connection closed"). The old
// comparator `survives = refutes < THRESHOLD && vs.length > 0` silently converted
// "no votes landed" into "refuted" (a false KILL), and — the mirror bug — a partial
// crash where fewer votes land than the quorum needs can fold into a false SURVIVE.
// A degraded vote set (landed < THRESHOLD) is UNKNOWN: never survive, never kill, and
// surfaced. This is the SAME killVote the original down-select KILL tier uses.

// Drive per-vote outcomes by the vote label (…:vN). null == a crashed/failed agent
// (production parallel() yields null for a thrown thunk; vs.filter(Boolean) drops it).
function votePlan(plan) {
  return function fake(schema, label) {
    if (!schema) return 'APEX SYNTH TEXT (mock)'
    const req = schema.required || []
    if (req.includes('candidates')) return { candidates: [{ name: 'Solo Cand', oneLine: 'the only candidate' }] }
    if (req.includes('fitScore')) return { name: String(label).replace('fit:', ''), fitScore: 12, keep: true, reason: 'k' }
    if (req.includes('verdict') && req.includes('gaps')) return { verdict: 'adequate', gaps: [] }
    if (req.includes('survives')) {
      const v = Number(String(label).match(/:v(\d+)$/)?.[1] || 1)
      const key = Object.keys(plan).find(k => String(label).toLowerCase().includes(k))
      const outcome = key ? plan[key][v - 1] : 'survive'
      if (outcome === null) return null                     // crashed vote
      if (outcome === 'refute') return { name: label, survives: false, fatalFlaws: ['flaw'], caveats: [], sources: [] }
      return { name: label, survives: true, fatalFlaws: [], caveats: [], sources: [] }
    }
    return {}
  }
}

test('KILL: ALL votes crash => degraded/unknown, NOT a silent kill', async () => {
  const { result, error } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], evolve: false, webTiers: [], killVotes: 3, killThreshold: 2 },
    { fakeFor: votePlan({ 'solo cand': [null, null, null] }) }
  )
  assert.equal(error, null)
  const stopped = result.stopped || ''
  // must NOT claim adversarial refutation when zero votes landed
  assert.ok(!/refuted in the KILL tier/.test(stopped) || /degrad|could not|unknown|unevaluat/i.test(stopped),
    'all-crashed votes must NOT be reported as "refuted in the KILL tier". stopped=' + stopped)
  assert.ok(/degrad|could not|unknown|unevaluat/i.test(stopped) || (Array.isArray(result.degraded) && result.degraded.length),
    'a candidate whose votes all crashed must surface as degraded/unknown. stopped=' + stopped)
})

test('KILL: partial crash below quorum => NOT a false survive (mirror bug)', async () => {
  // 3 requested; votes 1,2 crash; vote 3 refutes. landed=1 < threshold=2 => UNKNOWN, not survive.
  const { result, error, byPhase } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], evolve: false, webTiers: [], killVotes: 3, killThreshold: 2 },
    { fakeFor: votePlan({ 'solo cand': [null, null, 'refute'] }) }
  )
  assert.equal(error, null)
  assert.notEqual(typeof result.recommendation, 'string',
    'fewer landed votes than the quorum needs must NOT be treated as a clean survivor')
  assert.equal(byPhase('Apex').length, 0, 'no APEX over a candidate never legitimately vetted')
})

test('KILL: landed >= threshold but outcome SWINGABLE by missing vote => degraded, not survive', async () => {
  // killVotes 3, threshold 2. Votes: v1 refute, v2 survive, v3 CRASH. landed=2 (>= threshold),
  // refutes=1. A landed v3 that refuted would make refutes=2 => KILL. So the verdict depends on
  // the missing vote: it must DEGRADE, not resolve to survive. This is the residual mirror bug:
  // `vs.length < THRESHOLD` (landed<2) does NOT catch it (landed==2). The correct guard is
  // "could the missing votes still flip it?" => degraded unless (refutes+missing) < THRESHOLD.
  const { result, error, byPhase } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], evolve: false, webTiers: [], killVotes: 3, killThreshold: 2 },
    { fakeFor: votePlan({ 'solo cand': ['refute', 'survive', null] }) }
  )
  assert.equal(error, null)
  assert.notEqual(typeof result.recommendation, 'string',
    'a swingable verdict (missing vote could tip it to a kill) must NOT resolve to a clean survive')
  assert.equal(byPhase('Apex').length, 0, 'no APEX when the verdict hinges on a crashed vote')
})

test('KILL: landed >= threshold AND outcome DETERMINED (missing cannot flip) => resolves, not degraded', async () => {
  // killVotes 3, threshold 2. Votes: v1 survive, v2 survive, v3 CRASH. landed=2, refutes=0.
  // Even if the missing v3 refuted, refutes would be 1 < 2 => still survives. Outcome is
  // DETERMINED despite the crash, so it must NOT degrade — it survives and reaches APEX.
  const { result, error, byPhase } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], evolve: false, webTiers: [], killVotes: 3, killThreshold: 2 },
    { fakeFor: votePlan({ 'solo cand': ['survive', 'survive', null] }) }
  )
  assert.equal(error, null)
  assert.equal(typeof result.recommendation, 'string',
    'when the missing vote cannot change the outcome, a crash must NOT degrade a determined survive')
  assert.equal(byPhase('Apex').length, 1, 'determined survivor reaches APEX despite one crashed vote')
})

test('re-KILL labels are unique across hybrids that share leading tokens', async () => {
  // A live run had COMPOSE emit two hybrids both named "Node-Proxy CSI Base + ..." —
  // their norm() slugs collided on the first 12 chars, so the re-KILL votes got the
  // SAME label and the two distinct verdicts became indistinguishable. Hybrids reach
  // killVote directly (NO dedup — dedup only runs on the BASE discovery output), so the
  // re-vet path is exactly where the collision bit. The candidate index (c0/c1) in the
  // label keeps them distinct. (The main KILL tier can't hit this: DEDUP collapses
  // same-prefixed candidates before they ever reach it.)
  function twoCollidingHybrids(schema, label) {
    if (!schema) return 'APEX SYNTH TEXT (mock)'
    const req = schema.required || []
    // one clean survivor + one refuted, so compensating compose fires over the rejected one
    if (req.includes('candidates')) return { candidates: [{ name: 'Keeper', oneLine: 'survives' }, { name: 'Doomed', oneLine: 'refuted' }] }
    if (req.includes('fitScore')) return { name: String(label).replace('fit:', ''), fitScore: 12, keep: true, reason: 'k' }
    if (req.includes('verdict') && req.includes('gaps')) return { verdict: 'adequate', gaps: [] }
    if (req.includes('hybrids')) return { hybrids: [
      { name: 'Node Proxy CSI Base plus per-read logging ALPHA', oneLine: 'a', combines: ['Doomed'] },
      { name: 'Node Proxy CSI Base plus per-read logging BETA', oneLine: 'b', combines: ['Doomed'] },
    ] }
    if (req.includes('survives')) {
      if (/kill-hybrid/.test(label)) return { name: label, survives: true, fatalFlaws: [], caveats: [], sources: [] }
      const dies = /doomed/i.test(label)
      return { name: label, survives: !dies, fatalFlaws: dies ? ['f'] : [], caveats: [], sources: [] }
    }
    return {}
  }
  const { calls, error } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], evolve: true, webTiers: [], killVotes: 3, killThreshold: 2 },
    { fakeFor: twoCollidingHybrids }
  )
  assert.equal(error, null)
  const reKillLabels = calls.filter(c => /^kill-hybrid:/.test(c.label)).map(c => c.label)
  assert.ok(reKillLabels.length >= 6, 'both colliding hybrids must reach re-KILL (2 hybrids x 3 votes = 6)')
  assert.equal(reKillLabels.length, new Set(reKillLabels).size, 'every re-KILL vote label must be unique — colliding hybrid names must not merge')
})

// ---------- DEGRADED must not leak into `rejected` on the happy path (>=1 survivor) ----------
// The degraded/refuted split was applied only in the survivors===0 branch. On a normal run
// (>=1 survivor) a degraded option (votes crashed) was reported inside `rejected` as if
// adversarially refuted, and had no place in a `degraded` field. A caller then drops an
// option that was never actually evaluated. Reachable at killVotes:1 (threshold 1): one
// crashed vote => refutes 0, missing 1 => degraded.
test('happy path: a DEGRADED option is reported as degraded, NOT inside rejected', async () => {
  function oneSurvivorOneDegraded(schema, label) {
    if (!schema) return 'APEX SYNTH TEXT (mock)'
    const req = schema.required || []
    if (req.includes('candidates')) return { candidates: [{ name: 'Keeper', oneLine: 'survives clean' }, { name: 'Crashed', oneLine: 'its vote crashes' }] }
    if (req.includes('fitScore')) return { name: String(label).replace('fit:', ''), fitScore: 12, keep: true, reason: 'k' }
    if (req.includes('verdict') && req.includes('gaps')) return { verdict: 'adequate', gaps: [] }
    if (req.includes('survives')) {
      if (/crashed/i.test(label)) return null            // the only vote for "Crashed" crashes => degraded
      return { name: label, survives: true, fatalFlaws: [], caveats: [], sources: [] }
    }
    return {}
  }
  const { result, error } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], evolve: false, webTiers: [], killVotes: 1, killThreshold: 1 },
    { fakeFor: oneSurvivorOneDegraded }
  )
  assert.equal(error, null)
  assert.equal(typeof result.recommendation, 'string', 'the clean survivor still reaches APEX')
  const rejNames = (result.rejected || []).map(r => r.name)
  assert.ok(!rejNames.some(n => /Crashed/.test(n)), 'a degraded option must NOT appear in rejected (it was never evaluated)')
  const degNames = (result.degraded || []).map(r => r.name)
  assert.ok(degNames.some(n => /Crashed/.test(n)), 'a degraded option must be surfaced in result.degraded')
})

test('terminal message is not self-contradictory in the mixed refuted+degraded case', async () => {
  // 1 genuinely refuted + 1 degraded, 0 survivors. Old message: "every candidate was
  // refuted ... (1 were DEGRADED, not refuted)" — contradicts itself.
  function refutedPlusDegraded(schema, label) {
    if (!schema) return 'APEX SYNTH TEXT (mock)'
    const req = schema.required || []
    if (req.includes('candidates')) return { candidates: [{ name: 'Refuted One', oneLine: 'really dies' }, { name: 'Crashed One', oneLine: 'vote crashes' }] }
    if (req.includes('fitScore')) return { name: String(label).replace('fit:', ''), fitScore: 12, keep: true, reason: 'k' }
    if (req.includes('verdict') && req.includes('gaps')) return { verdict: 'adequate', gaps: [] }
    if (req.includes('survives')) {
      if (/crashed/i.test(label)) return null                  // degraded
      return { name: label, survives: false, fatalFlaws: ['real flaw'], caveats: [], sources: [] }  // refuted
    }
    return {}
  }
  const { result, error } = await runWorkflow(
    { ...BASE_ARGS, angles: [{ key: 'k', lens: 'one' }], evolve: false, webTiers: [], killVotes: 1, killThreshold: 1 },
    { fakeFor: refutedPlusDegraded }
  )
  assert.equal(error, null)
  assert.equal(result.recommendation, null)
  const s = result.stopped || ''
  // must NOT claim "every candidate was refuted" while also reporting a degraded one
  assert.ok(!/every candidate was refuted/.test(s) || !/DEGRADED/.test(s),
    'message must not say "every candidate was refuted" and then admit some were degraded. stopped=' + s)
})
