// Deterministic plumbing for the evolve A/B eval harness. Kept OUT of the
// workflow script so it is unit-testable with node:test (the workflow globals
// agent/parallel/budget are not importable). The workflow imports these and does
// only the live orchestration (run arms, call the judge panel). Pure functions,
// no deps, no Math.random (banned in workflow scripts anyway — order is derived
// from problem index parity so it is reproducible across a resumed run).

// Present two arms to a blind judge as `first`/`second`, swapping order by problem
// index parity so position bias cancels across the set. The judge must never see
// which arm is which, so we strip everything except the recommendation payload
// the judge needs — explicitly NOT any `arm` marker.
export function swapForProblem(index, recA, recB) {
  const strip = (r) => { const { arm, ...rest } = r; return rest }  // drop arm identity
  const aFirst = index % 2 === 0
  return aFirst
    ? { first: strip(recA), second: strip(recB), firstArm: 'A', secondArm: 'B' }
    : { first: strip(recB), second: strip(recA), firstArm: 'B', secondArm: 'A' }
}

// Map a panel of first/second votes back to the real arm using the swap record.
// Majority wins; an even split is a tie (no winner) rather than a silent pick.
export function tallyVotes(votes, swap) {
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

// Aggregate per-problem outcomes into a verdict on whether evolve (arm B) is worth
// its tokens. Ties are excluded from the win-rate (nothing was decided); win-rate
// over zero decided problems is null, not 0, so an all-tie set is not read as
// "evolve always loses". meanTokenDeltaB is the average EXTRA tokens the evolve
// arm spent (B - A), averaged over ALL problems (cost is paid even on ties).
export function aggregate(perProblem) {
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
