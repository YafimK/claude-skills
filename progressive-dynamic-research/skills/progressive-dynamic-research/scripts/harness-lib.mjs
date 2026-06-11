// Reusable $0 test harness for pyramid-template.js — runs the workflow body under
// mocked agent/parallel/pipeline/budget/log/phase (NO LLM calls). Returns a record
// of everything that happened so tests can assert structural invariants — the ones
// that, if broken, would burn real tokens before failing. Pure JS, no deps.
//
// runWorkflow(args, opts?) -> { result, calls, logs, phases, spent, error }
//   - calls: [{ label, model, phase, hasSchema, usesWeb, turns }]  (one per agent() call)
//   - error: the thrown Error if the script threw (e.g. bad args), else null
//
// opts.startSpent  : seed budget.spent() baseline (test the delta gate / session contamination)
// opts.fakeFor     : override the canned per-tier responses (test odd discovery shapes)
// opts.distinctCandidates : if true, BASE emits many uniquely-named candidates (test FIT cap)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'pyramid-template.js')

function defaultFakeFor(schema, label, opts) {
  if (!schema) return 'APEX SYNTH TEXT (mock)'
  const req = schema.required || []
  if (req.includes('candidates')) {
    if (opts.distinctCandidates) {
      // many uniquely-named candidates so dedup keeps them all -> exercises MAX_FIT cap
      return { candidates: Array.from({ length: 30 }, (_, i) => ({ name: 'opt' + i + ' alpha beta', oneLine: 'x' })) }
    }
    const base = String(label).replace('base:', '')
    return { candidates: [
      { name: 'Option Alpha', oneLine: 'candidate one, ' + base },
      { name: 'Option Beta', oneLine: 'candidate two, ' + base },
      { name: 'Option Gamma', oneLine: 'candidate three, ' + base },
      { name: 'Option Alpha', oneLine: 'dup to test dedup' },
    ] }
  }
  if (req.includes('fitScore')) {
    const keep = String(label).length % 2 === 0
    return { name: String(label).replace('fit:', ''), fitScore: keep ? 11 : 5, keep, reason: 'mock' }
  }
  if (req.includes('survives')) {
    const survives = (String(label).charCodeAt(String(label).length - 1) % 3) !== 0
    return { name: label, survives, fatalFlaws: survives ? [] : ['mock flaw'], caveats: ['mock caveat'], sources: ['https://example.test/doc'] }
  }
  if (req.includes('verdict') && req.includes('gaps')) {
    return { verdict: 'gaps-found', gaps: ['an angle was not explored'], suggestedAngles: ['some-missing-angle'] }
  }
  return {}
}

export async function runWorkflow(args, opts = {}) {
  let src = readFileSync(SCRIPT, 'utf8').replace(/export const meta/, 'const meta')
  const calls = []
  const logs = []
  const phases = []
  let spent = opts.startSpent || 0
  const SPEND_PER_AGENT = opts.spendPerAgent || 4000
  const fake = opts.fakeFor || ((schema, label) => defaultFakeFor(schema, label, opts))

  const agent = async (prompt, o = {}) => {
    if (typeof prompt !== 'string' || !prompt.length) throw new Error('agent() got non-string prompt for ' + o.label)
    spent += SPEND_PER_AGENT
    const usesWeb = /WebSearch|WebFetch/.test(prompt) && !/do NOT use web|do NOT use WebSearch/i.test(prompt)
    calls.push({ label: o.label || '(none)', model: o.model || '(inherit)', phase: o.phase, hasSchema: !!o.schema, usesWeb })
    return fake(o.schema, o.label || '')
  }
  const parallel = async (thunks) => {
    if (!Array.isArray(thunks)) throw new Error('parallel() got non-array')
    return Promise.all(thunks.map(t => t()))
  }
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (it, i) => {
    let v = it
    for (const s of stages) v = await s(v, it, i)
    return v
  }))
  const phase = (t) => { phases.push(t) }
  const log = (m) => { logs.push(m) }
  const budget = { total: opts.budgetTotal ?? 9e9, spent: () => spent, remaining: () => (opts.budgetTotal ?? 9e9) - spent }

  const fn = new Function('agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'args',
    '"use strict"; return (async () => {\n' + src + '\n})()')

  let result = null, error = null
  try {
    result = await fn(agent, parallel, pipeline, phase, log, budget, args)
  } catch (e) {
    error = e
  }
  return { result, calls, logs, phases, spent, error, byPhase: (p) => calls.filter(c => c.phase === p) }
}

// A known-good baseline args payload tests can spread + override.
export const BASE_ARGS = {
  problem: 'Choose the best approach among several candidates for some system, under fixed priorities.',
  priorities: ['priority one (the decisive discriminator)', 'priority two', 'priority three'],
  angles: [
    { key: 'angle-a', lens: 'framing A' }, { key: 'angle-b', lens: 'framing B' },
    { key: 'angle-c', lens: 'framing C' }, { key: 'angle-d', lens: 'framing D' },
    { key: 'angle-e', lens: 'framing E' },
  ],
  webTiers: ['base', 'kill'], killVotes: 3, killThreshold: 2, maxKill: 8,
}
