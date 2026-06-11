// $0 stub harness for pyramid-template.js — validates control flow with mocked
// agent/parallel/budget/log. NO LLM calls. Catches structural bugs (funnel shape,
// kill-quorum math, budget gate, FIT-width cap, return contract) before any real
// run spends money. Run:  node scripts/stub-harness.mjs   (from the skill dir)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'pyramid-template.js')
let src = readFileSync(SCRIPT, 'utf8')

// The workflow body uses top-level `export const meta`, top-level `await`, and a
// top-level `return`. Wrap it as an async function body: drop the `export`, keep
// `meta` as a local, and the trailing `return` becomes the function's return.
src = src.replace(/export const meta/, 'const meta')

// --- mock harness state ---
const calls = []                 // every agent() invocation: {label, model, phase, schema}
const logs = []
let phases = []
let spent = 0
const SPEND_PER_AGENT = 4000     // pretend each agent costs ~4k tokens

// Produce a schema-shaped fake result so .then() chains in the script work.
function fakeFor(schema, label) {
  if (!schema) return 'APEX SYNTH TEXT (mock)'
  const req = schema.required || []
  if (req.includes('candidates')) {
    // BASE tier: return a few candidates; vary names by label so dedup has work
    const base = label.replace('base:', '')
    return { candidates: [
      { name: 'Option Alpha', oneLine: 'candidate one, ' + base },
      { name: 'Option Beta', oneLine: 'candidate two, ' + base },
      { name: 'Option Gamma', oneLine: 'candidate three, ' + base },
      { name: 'Option Alpha', oneLine: 'dup to test dedup' },
    ] }
  }
  if (req.includes('fitScore')) {
    // FIT tier: keep ~half
    const keep = label.length % 2 === 0
    return { name: label.replace('fit:', ''), fitScore: keep ? 11 : 5, keep, reason: 'mock' }
  }
  if (req.includes('survives')) {
    // KILL vote: refute ~1/3 of the time, deterministically by label
    const survives = (label.charCodeAt(label.length - 1) % 3) !== 0
    return { name: label, survives, fatalFlaws: survives ? [] : ['mock flaw'], caveats: ['mock caveat'], sources: ['https://example.test/doc'] }
  }
  if (req.includes('verdict') && req.includes('gaps')) {
    return { verdict: 'gaps-found', gaps: ['an angle was not explored'], suggestedAngles: ['some-missing-angle'] }
  }
  return {}
}

const agent = async (prompt, opts = {}) => {
  spent += SPEND_PER_AGENT
  const usesWeb = /WebSearch|WebFetch/.test(prompt) && !/do NOT use web|do NOT use WebSearch/i.test(prompt)
  calls.push({ label: opts.label || '(none)', model: opts.model || '(inherit)', phase: opts.phase, hasSchema: !!opts.schema, usesWeb })
  if (typeof prompt !== 'string' || !prompt.length) throw new Error('agent() got non-string prompt for ' + opts.label)
  return fakeFor(opts.schema, opts.label || '')
}
const parallel = async (thunks) => {
  if (!Array.isArray(thunks)) throw new Error('parallel() got non-array')
  return Promise.all(thunks.map(t => t()))
}
const pipeline = async (items, ...stages) => {
  return Promise.all(items.map(async (it, i) => {
    let v = it
    for (const s of stages) v = await s(v, it, i)
    return v
  }))
}
const phase = (t) => { phases.push(t) }
const log = (m) => { logs.push(m) }
const budget = { total: 360000, spent: () => spent, remaining: () => 360000 - spent }

// A generic, topic-neutral args payload — the funnel logic under test is
// independent of the research topic. Shape-identical to a real invocation.
const args = {
  problem: 'Choose the best approach among several candidates for some system, under fixed priorities.',
  priorities: ['priority one (the decisive discriminator)', 'priority two', 'priority three'],
  angles: [
    { key: 'angle-a', lens: 'framing A' },
    { key: 'angle-b', lens: 'framing B' },
    { key: 'angle-c', lens: 'framing C' },
    { key: 'angle-d', lens: 'framing D' },
    { key: 'angle-e', lens: 'framing E' },
  ],
  webTiers: ['base', 'kill'], killVotes: 3, killThreshold: 2, maxKill: 8, hard: 360000, warn: 270000,
}

// Build the async function and run it.
const body = src + '\n//# end'
const fn = new Function('agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'args',
  '"use strict"; return (async () => {\n' + body + '\n})()')

const result = await fn(agent, parallel, pipeline, phase, log, budget, args)

// --- assertions ---
const errs = []
const ok = (cond, msg) => { if (!cond) errs.push('FAIL: ' + msg); else console.log('  ok  ' + msg) }

console.log('\n=== ASSERTIONS ===')
ok(result && typeof result === 'object', 'workflow returns an object')
ok(result.funnel, 'result has funnel stats')
ok(typeof result.recommendation === 'string', 'recommendation is text (apex ran)')
ok('coverage' in result, 'result carries coverage critic output')
ok(Array.isArray(result.rejected), 'rejected is an array')

const byPhase = (p) => calls.filter(c => c.phase === p)
ok(byPhase('Base').length === args.angles.length, 'BASE ran one agent per angle (' + byPhase('Base').length + ')')
ok(byPhase('Base').every(c => c.model === 'haiku'), 'BASE agents are haiku')
ok(byPhase('Fit').every(c => c.model === 'haiku'), 'FIT agents are haiku')
ok(byPhase('Kill').every(c => c.model === 'sonnet'), 'KILL agents are sonnet')
ok(byPhase('Kill').every(c => c.hasSchema), 'KILL votes use a schema')

// Multi-vote math: kill agents = survivors entering kill * killVotes
const killAgents = byPhase('Kill').length
ok(killAgents % args.killVotes === 0, 'KILL agent count is a multiple of killVotes (' + killAgents + ' / ' + args.killVotes + ')')
ok(killAgents <= args.maxKill * args.killVotes, 'KILL respects maxKill*votes cap')

ok(byPhase('Critic').length === 1, 'exactly one completeness critic ran')
ok(byPhase('Apex').length === 1, 'exactly one apex synthesis ran')
ok(byPhase('Apex')[0].model === '(inherit)', 'APEX inherits strong main-loop model (no override)')

ok(phases.includes('Base') && phases.includes('Kill') && phases.includes('Critic') && phases.includes('Apex'), 'all phases announced')
ok(logs.some(l => l.startsWith('Dedup:')), 'dedup logged a raw->unique count')
ok(logs.some(l => l.startsWith('Kill:')), 'kill logged survivor count')

// Per-tier web wiring (webTiers: ['base','kill']) — BASE and KILL fetch, FIT never.
ok(byPhase('Base').every(c => c.usesWeb), 'BASE agents got web (webTiers includes base)')
ok(byPhase('Fit').every(c => !c.usesWeb), 'FIT agents are tool-free (never web, even when other tiers fetch)')
ok(byPhase('Kill').every(c => c.usesWeb), 'KILL agents got web (webTiers includes kill)')
ok(byPhase('Base').some(c => /single-pass/.test(JSON.stringify(logs))) || logs.some(l => /single-pass/.test(l)), 'BASE web announced as single-pass')

console.log('\nfunnel:', JSON.stringify(result.funnel))
console.log('agents spawned:', calls.length, '| mock spend:', spent, 'tokens')
console.log('phase counts:', ['Base','Fit','Kill','Critic','Apex'].map(p => p + '=' + byPhase(p).length).join(' '))

if (errs.length) { console.error('\n' + errs.join('\n')); process.exit(1) }
console.log('\nALL ' + (calls.length, 'assertions passed') + ' ✓')
