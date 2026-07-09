// DRY guard: evolve-eval.js INLINES the deterministic helpers from
// evolve-eval-lib.mjs (the Workflow runtime cannot resolve a top-level import —
// it injects globals into a function wrap, like pyramid-template.js is built for).
// The lib stays the unit-tested source of truth; this test fails the moment the
// inlined copy drifts from it, so a fix to one must be mirrored in the other.
// Run: node --test <this file>
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const lib = readFileSync(join(HERE, 'evolve-eval-lib.mjs'), 'utf8')
const evalScript = readFileSync(join(HERE, 'evolve-eval.js'), 'utf8')

// Normalize: take each function body from the lib (stripping the `export`) and
// assert that exact text appears in evolve-eval.js between the sync markers.
function fnSource(text, name) {
  const start = text.indexOf('function ' + name + '(')
  assert.ok(start >= 0, name + ' not found in source')
  // walk braces to find the function end
  let i = text.indexOf('{', start), depth = 0, end = -1
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  return text.slice(start, end)
}

test('evolve-eval.js has the sync markers around the inlined helpers', () => {
  assert.match(evalScript, /BEGIN inlined from evolve-eval-lib\.mjs/)
  assert.match(evalScript, /END inlined from evolve-eval-lib\.mjs/)
})

for (const name of ['swapForProblem', 'tallyVotes', 'aggregate']) {
  test('inlined ' + name + ' is byte-identical to the lib (no drift)', () => {
    const libFn = fnSource(lib, name)
    const inlinedFn = fnSource(evalScript, name)
    assert.equal(inlinedFn, libFn, name + ' has drifted between evolve-eval.js and evolve-eval-lib.mjs — sync them')
  })
}

test('evolve-eval.js does NOT import the lib (runtime cannot resolve it)', () => {
  assert.ok(!/import\s+\{[^}]*\}\s+from\s+['"]\.\/evolve-eval-lib/.test(evalScript),
    'a top-level import would break in the Workflow function-wrap runtime; helpers must be inlined')
})

// The eval mirrors the template's killVote (it is NOT a shared lib fn, so the drift
// guard above cannot pin it). A code review found the eval still carried the OLD
// comparator after the template fixed the crashed-vote bug. Pin the integrity property
// directly: the eval killVote must use the determined-survive form, never the stale one.
test('evolve-eval.js killVote uses the crashed-vote-safe comparator (not the stale one)', () => {
  // must NOT contain the old comparator that reads all-crashed votes as a false verdict
  assert.ok(!/survives:\s*refutes\s*<\s*KILL_THRESHOLD\s*&&\s*vs\.length\s*>\s*0/.test(evalScript),
    'evolve-eval.js still has the pre-fix killVote comparator — mirror the template degraded/determined fix')
  // must contain the determined-survive guard that treats missing votes as unknown
  assert.match(evalScript, /const missing = KILL_VOTES - vs\.length/,
    'evolve-eval.js killVote must account for missing (crashed) votes')
  assert.match(evalScript, /determinedSurvive = \(refutes \+ missing\) < KILL_THRESHOLD/,
    'evolve-eval.js killVote must resolve survive only when missing votes cannot flip it')
})
