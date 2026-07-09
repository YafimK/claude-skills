// $0 structural smoke test for evolve-eval.js — runs the workflow body under
// mocked agent/parallel/budget (NO LLM calls) and asserts the wiring that, if
// broken, would invalidate the eval: both arms branch from the SAME survivors,
// the judge is blind + order-swapped, the panel size is honored, AND the no-effect
// short-circuit fires (when no hybrid survives, arm-B APEX + judges are skipped).
// Analog of stub-harness.mjs for the eval tool. Run: node scripts/evolve-eval-smoke.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'evolve-eval.js')
// The script is self-contained (helpers inlined, no import) — mirror the Workflow
// runtime by wrapping it with the globals injected. This exercises the REAL inlined
// helpers, so a drift between them and the lib would surface here too.
const src = readFileSync(SCRIPT, 'utf8').replace(/export const meta/, 'const meta')

async function run(fake) {
  const calls = []
  let spent = 0
  const agent = async (prompt, o = {}) => {
    if (typeof prompt !== 'string' || !prompt.length) throw new Error('agent() got non-string prompt for ' + o.label)
    spent += 4000
    calls.push({ label: o.label || '(none)', model: o.model || '(inherit)', phase: o.phase, prompt })
    return fake(o.schema, o.label || '')
  }
  const parallel = async (thunks) => Promise.all(thunks.map(t => t()))
  const phase = () => {}
  const log = () => {}
  const budget = { total: 9e9, spent: () => spent, remaining: () => 9e9 - spent }
  const args = { problems: [{ problem: 'pick one approach for a system', priorities: ['p1', 'p2'], angles: [{ key: 'k', lens: 'one' }] }],
    judges: 3, killVotes: 1, killThreshold: 1 }
  const fn = new Function('agent', 'parallel', 'phase', 'log', 'budget', 'args',
    '"use strict"; return (async () => {\n' + src + '\n})()')
  const result = await fn(agent, parallel, phase, log, budget, args)
  return { result, calls }
}

const reqHas = (schema, k) => (schema?.required || []).includes(k)

// ---- scenario 1: CONTESTED — hybrid survives, both arms + judge panel run ----
function contestedFake(schema, label) {
  if (!schema) return 'APEX RECOMMENDATION TEXT for ' + (label || '')
  if (reqHas(schema, 'candidates')) return { candidates: [{ name: 'Opt One', oneLine: 's1' }, { name: 'Opt Two', oneLine: 's2' }] }
  if (reqHas(schema, 'fitScore')) return { name: String(label).replace('fit:', ''), fitScore: 12, keep: true, reason: 'k' }
  if (reqHas(schema, 'hybrids')) return { hybrids: [{ name: 'Hybrid OneTwo', oneLine: 'combo', combines: ['Opt One', 'Opt Two'] }] }
  if (reqHas(schema, 'survives')) return { name: label, survives: true, fatalFlaws: [], caveats: [] }
  if (reqHas(schema, 'winner')) return { winner: 'first', why: 'mock' }
  return {}
}
{
  const { result, calls } = await run(contestedFake)
  const apexCalls = calls.filter(c => c.label === 'apex')
  assert.equal(apexCalls.length, 2, 'contested: exactly two APEX calls (one per arm)')
  const armA = apexCalls.find(c => !/Hybrid/.test(c.prompt))
  const armB = apexCalls.find(c => /Hybrid/.test(c.prompt))
  assert.ok(armA && armB, 'contested: arm A (originals) and arm B (with hybrid) both present')
  assert.ok(/Opt One/.test(armA.prompt) && /Opt Two/.test(armA.prompt), 'arm A has both shared survivors')
  assert.ok(/Opt One/.test(armB.prompt) && /Opt Two/.test(armB.prompt), 'arm B has the SAME shared survivors')
  const judges = calls.filter(c => /^judge:/.test(c.label))
  assert.equal(judges.length, 3, 'contested: panel size honored')
  for (const j of judges) {
    assert.ok(!/"arm"/.test(j.prompt), 'judge must not leak the arm field')
    assert.ok(!/evolve|baseline|compose/i.test(j.prompt), 'judge must not see arm identity by name')
    assert.ok(/FIRST/.test(j.prompt) && /SECOND/.test(j.prompt), 'judge sees blind first/second framing')
  }
  assert.equal(result.summary.problems, 1)
  assert.equal(result.summary.noEffect, 0, 'contested: not a no-effect problem')
  assert.equal(result.summary.decided, 1, 'contested: counted as decided')
  assert.equal(typeof result.summary.meanTokenDeltaB, 'number', 'token delta computed')
  console.log('contested: 2 apex, 3 judges, decided=1 ✓')
}

// ---- scenario 2: NO-EFFECT — every hybrid refuted; arm-B APEX + judges skipped ----
function noEffectFake(schema, label) {
  if (!schema) return 'APEX RECOMMENDATION TEXT for ' + (label || '')
  if (reqHas(schema, 'candidates')) return { candidates: [{ name: 'Opt One', oneLine: 's1' }, { name: 'Opt Two', oneLine: 's2' }] }
  if (reqHas(schema, 'fitScore')) return { name: String(label).replace('fit:', ''), fitScore: 12, keep: true, reason: 'k' }
  if (reqHas(schema, 'hybrids')) return { hybrids: [{ name: 'Hybrid OneTwo', oneLine: 'combo', combines: ['Opt One', 'Opt Two'] }] }
  if (reqHas(schema, 'survives')) {
    // originals survive; the hybrid is refuted on re-vet
    const dies = /hybrid/i.test(label)
    return { name: label, survives: !dies, fatalFlaws: dies ? ['fatal'] : [], caveats: [] }
  }
  if (reqHas(schema, 'winner')) return { winner: 'first', why: 'mock' }
  return {}
}
{
  const { result, calls } = await run(noEffectFake)
  assert.equal(calls.filter(c => c.label === 'apex').length, 1, 'no-effect: only arm-A APEX runs (arm-B skipped)')
  assert.equal(calls.filter(c => /^judge:/.test(c.label)).length, 0, 'no-effect: NO judges spawned (nothing to compare)')
  assert.equal(result.summary.noEffect, 1, 'no-effect problem is counted in noEffect')
  assert.equal(result.summary.decided, 0, 'no-effect is excluded from decided')
  assert.equal(result.summary.evolveWinRate, null, 'no-effect-only set has no verdict (null), not a 100% win')
  assert.equal(result.perProblem[0].hybridSurvived, false, 'per-problem records hybridSurvived:false')
  console.log('no-effect: 1 apex, 0 judges, noEffect=1, winRate=null ✓')
}

console.log('ALL smoke assertions passed ✓')
