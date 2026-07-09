// Unit tests for evolve-eval-lib.mjs — the DETERMINISTIC plumbing of the evolve
// A/B eval harness (blind order-swap, vote tally back to arms, win-rate aggregate).
// These are the pieces that, if wrong, silently bias the eval — so they get teeth
// BEFORE any live judge call. Zero deps (node:test). Run: node --test <this file>
//
// The harness compares two arms over the SAME survivors (no discovery confound):
//   arm A = APEX on survivors only        (evolve OFF)
//   arm B = COMPOSE + re-KILL -> APEX      (evolve ON)
// A blind judge panel sees them as "first"/"second" (never the arm name), with
// presentation order swapped per problem so position bias cancels across the set.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { swapForProblem, tallyVotes, aggregate } from './evolve-eval-lib.mjs'

// ---------- blind order-swap: parity-based, no Math.random (banned in workflows) ----------
test('even problem index => arm A shown first; odd => arm B first (deterministic)', () => {
  const even = swapForProblem(0, { text: 'A-rec' }, { text: 'B-rec' })
  assert.equal(even.firstArm, 'A', 'even index shows A first')
  assert.equal(even.first.text, 'A-rec')
  assert.equal(even.secondArm, 'B')

  const odd = swapForProblem(1, { text: 'A-rec' }, { text: 'B-rec' })
  assert.equal(odd.firstArm, 'B', 'odd index shows B first (order swapped)')
  assert.equal(odd.first.text, 'B-rec')
  assert.equal(odd.secondArm, 'A')
})

test('swap never leaks the arm identity into the presented payload', () => {
  const s = swapForProblem(1, { text: 'A-rec', arm: 'A' }, { text: 'B-rec', arm: 'B' })
  // the judge gets .first/.second — neither should carry an `arm` field
  assert.ok(!('arm' in s.first), 'presented "first" must not reveal which arm it is')
  assert.ok(!('arm' in s.second), 'presented "second" must not reveal which arm it is')
})

// ---------- tally: judge votes are about first/second; map back to the real arm ----------
test('tally maps a "first wins" vote back to whichever arm was shown first', () => {
  // odd index => B shown first. A judge voting "first" is voting for B.
  const swap = swapForProblem(1, { text: 'A' }, { text: 'B' })
  const winner = tallyVotes([{ winner: 'first' }, { winner: 'first' }, { winner: 'second' }], swap)
  assert.equal(winner.arm, 'B', '2 of 3 voted "first" which (odd index) is arm B')
  assert.equal(winner.votesFor, 2)
  assert.equal(winner.votesAgainst, 1)
})

test('tally handles a tie as no-winner (margin 0), not a silent pick', () => {
  const swap = swapForProblem(0, { text: 'A' }, { text: 'B' })
  const r = tallyVotes([{ winner: 'first' }, { winner: 'second' }], swap)
  assert.equal(r.arm, null, 'an even split has no majority winner')
  assert.equal(r.tie, true)
})

// ---------- aggregate: win-rate for B (evolve) + token delta across the set ----------
test('aggregate computes evolve(B) win-rate and mean token delta, ignoring ties', () => {
  const per = [
    { winner: 'B', tokensA: 100, tokensB: 160 },  // evolve won
    { winner: 'A', tokensA: 100, tokensB: 150 },  // evolve lost
    { winner: 'B', tokensA: 100, tokensB: 140 },  // evolve won
    { winner: null, tokensA: 100, tokensB: 100 }, // tie: excluded from win-rate
  ]
  const agg = aggregate(per)
  assert.equal(agg.decided, 3, 'ties are excluded from the decided count')
  assert.equal(agg.evolveWins, 2)
  assert.equal(agg.evolveWinRate, 2 / 3, 'B won 2 of 3 decided problems')
  // mean extra tokens evolve costs: (60 + 50 + 40 + 0)/4 = 37.5
  assert.equal(agg.meanTokenDeltaB, 37.5, 'mean extra cost of the evolve arm')
})

test('aggregate over an all-tie set reports winRate null (not 0) — nothing decided', () => {
  const agg = aggregate([{ winner: null, tokensA: 10, tokensB: 10 }])
  assert.equal(agg.decided, 0)
  assert.equal(agg.evolveWinRate, null, 'no decided problems => win-rate is undefined, not 0')
})

// ---------- no-effect exclusion: a problem where NO hybrid survived is not a B-win ----------
// When re-KILL kills every hybrid, arm B synthesizes the SAME survivors as arm A —
// it is the identical experiment run twice. Counting a judge coin-flip there as an
// "evolve win" makes the headline win-rate lie. Such problems must be EXCLUDED from
// the decided set and surfaced as noEffect, not folded into evolveWins.
test('aggregate excludes no-effect problems (no surviving hybrid) from win-rate', () => {
  const per = [
    { winner: 'B', hybridSurvived: true, tokensA: 100, tokensB: 160 },   // real evolve win
    { winner: 'B', hybridSurvived: false, tokensA: 100, tokensB: 105 },  // hollow: no hybrid survived
    { winner: 'A', hybridSurvived: true, tokensA: 100, tokensB: 150 },   // real evolve loss
  ]
  const agg = aggregate(per)
  assert.equal(agg.noEffect, 1, 'the no-surviving-hybrid problem is counted as no-effect')
  assert.equal(agg.decided, 2, 'only the two problems where a hybrid actually competed are decided')
  assert.equal(agg.evolveWins, 1, 'the hollow B-win must NOT count toward evolveWins')
  assert.equal(agg.evolveWinRate, 1 / 2, 'win-rate is over genuinely-contested problems only')
})

test('aggregate: a set with only no-effect problems has winRate null, not 1', () => {
  const agg = aggregate([{ winner: 'B', hybridSurvived: false, tokensA: 100, tokensB: 101 }])
  assert.equal(agg.noEffect, 1)
  assert.equal(agg.decided, 0)
  assert.equal(agg.evolveWinRate, null, 'no contested problems => no verdict, not a 100% win')
})
