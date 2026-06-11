// ============================================================================
// PYRAMID RESEARCH — canonical dynamic-workflow template (args-driven)
// Reusable across topics: pass the problem framing, priorities, and discovery
// angles in via `args` instead of editing the file. The mechanics (pall helper,
// dedup-in-code, per-tier schemas, budget guard) are load-bearing — see
// ../references/harness-notes.md for why each one is here. Do NOT inline the
// content into source; passing it via args also sidesteps the apostrophe hazard.
//
// Funnel:  BASE (haiku, wide) -> DEDUP (code) -> FIT (haiku) -> KILL (sonnet,
//          adversarial, optionally web-grounded) -> APEX (opus synthesis).
//
// Invoke:  Workflow({ scriptPath: <this file>, args: {
//            problem:  "one-paragraph problem statement",
//            priorities: ["P1 ...", "P2 ...", "P3 ..."],   // in priority order
//            angles:   [{ key: "cost", lens: "cost-first framing" }, ...],
//            webTiers: ["base","kill"],// which tiers may fetch. base=recall
//                                      //   (single-pass), kill=verify-vs-sources.
//                                      //   FIT never fetches. webGrounded:true is
//                                      //   a back-compat alias for ["kill"].
//            killVotes:   3,           // adversarial votes per survivor (1 = single)
//            killThreshold: 2,         // kill if >= this many votes say "refute"
//            maxKill:     10,          // cap survivors entering the KILL tier
//            hard: 300000, warn: 220000  // optional budget override
//          } })
// ============================================================================

export const meta = {
  name: 'progressive-dynamic-research',
  description: 'Wide cheap discovery -> dedup -> fit-filter -> adversarial kill -> strong-model apex synthesis (args-driven)',
  phases: [
    { title: 'Base',  detail: 'wide low-tier candidate discovery (haiku)' },
    { title: 'Dedup', detail: 'collapse near-duplicates (code, no agent)' },
    { title: 'Fit',   detail: 'cheap fit-check vs fixed priorities (haiku)' },
    { title: 'Kill',  detail: 'adversarial refutation of survivors (sonnet)' },
    { title: 'Critic', detail: 'coverage check: missing angle / unverified discriminator (haiku)' },
    { title: 'Apex',  detail: 'deep synthesis over survivors only (opus)' },
  ],
}

// --- helper: parallel() can resolve to undefined; always hand back an array.
// This is THE fix for the `.filter is not a function` bug — never inline
// `(await parallel(...)).filter(...)`; go through pall and assign in two steps.
const pall = async (thunks) => (await parallel(thunks)) || []
const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// === args-driven framing — no hardcoded content, so any topic is just a payload ===
// Robust to the harness delivering args as a JSON string (a known boundary footgun)
// as well as a parsed object; self-reporting if it arrives empty.
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { /* leave as string; guard below reports it */ } }
A = A || {}
if (!A.problem) throw new Error('progressive-dynamic-research: args.problem is required. typeof args=' + typeof args +
  ' raw=' + (typeof args === 'string' ? args.slice(0, 120) : JSON.stringify(args)))
const PRIORITIES = (A.priorities && A.priorities.length) ? A.priorities : ['P1 fit for purpose', 'P2 operational simplicity', 'P3 cost']
const ANGLES = (A.angles && A.angles.length) ? A.angles : [
  { key: 'angle-a', lens: 'fit-for-purpose first' },
  { key: 'angle-b', lens: 'operational-simplicity first' },
  { key: 'angle-c', lens: 'cost first' },
  { key: 'angle-d', lens: 'resilience / failure-mode first' },
  { key: 'angle-e', lens: 'obscure / non-obvious options' },
]
// Per-tier web. webTiers is an array naming which tiers may fetch — e.g.
// ['base','kill']. BASE web buys discovery RECALL (cheap, 5-7 agents, must stay
// single-pass); KILL web buys fact CORRECTNESS (verify claims vs primary sources).
// FIT is deliberately never web (it is the wide tier that loops — the cost lever).
// Back-compat: webGrounded:true is an alias for webTiers:['kill'].
const WEB_TIERS = Array.isArray(A.webTiers) ? A.webTiers
  : (A.webGrounded === true ? ['kill'] : [])
const WEB_BASE = WEB_TIERS.includes('base')
const WEB_KILL = WEB_TIERS.includes('kill')
const WEB = WEB_TIERS.length > 0   // any tier fetches → budget sizes for fetch cost
const KILL_VOTES = A.killVotes || (WEB_KILL ? 3 : 1)
const KILL_THRESHOLD = A.killThreshold || Math.ceil(KILL_VOTES / 2)
const MAX_KILL = A.maxKill || 10
// Cap FIT width. The dominant cost is the big PROBLEM context re-sent to every
// agent (cache-read scales with width x context size), so an unbounded FIT over
// dozens of candidates is the real budget lever — not web fetching. 0 = no cap.
const MAX_FIT = A.maxFit || 24

// The fixed framing the WHOLE funnel optimizes. Restating the LIVE constraints
// here (via args) is what stops a spike answering a stale question.
const PROBLEM = A.problem + '\nPriorities, in order: ' +
  PRIORITIES.map((p, i) => '(' + (i + 1) + ') ' + p).join('; ') + '.'

// Schemas live near the workflow so the model never returns prose. See
// ../references/schemas.md for the rationale and a triage-only variant.
const CAND_SCHEMA = {
  type: 'object', required: ['candidates'],
  properties: { candidates: { type: 'array', items: {
    type: 'object', required: ['name', 'oneLine'],
    properties: { name: { type: 'string' }, oneLine: { type: 'string' } },
  } } },
}
const FIT_SCHEMA = {
  type: 'object', required: ['name', 'fitScore', 'keep', 'reason'],
  properties: {
    name: { type: 'string' },
    fitScore: { type: 'integer', minimum: 0, maximum: 15, description: 'sum of per-priority 0-5 scores' },
    keep: { type: 'boolean' }, reason: { type: 'string' },
  },
}
const VERDICT_SCHEMA = {
  type: 'object', required: ['name', 'survives', 'fatalFlaws'],
  properties: {
    name: { type: 'string' }, survives: { type: 'boolean' },
    fatalFlaws: { type: 'array', items: { type: 'string' } },
    caveats: { type: 'array', items: { type: 'string' } },
    sources: { type: 'array', items: { type: 'string' } },
  },
}

// --- Budget guard. Sized for the run shape: a web-grounded KILL tier costs
// multiples of a reasoning one (every fetched page dumps into context), so the
// default cap lifts when webGrounded. Gate BEFORE the expensive tier, never
// between it and a load-bearing tier behind it. A cap that FIRES is information.
// budget.spent() is a SHARED, session-cumulative, OUTPUT-only counter (main loop
// + all workflows) — so it is contaminated by prior session spend and blind to
// input/cache cost. Gate on the DELTA since this script started, not the raw value.
const START = budget.spent()
const HARD = A.hard || (WEB ? 320_000 : 220_000)
const WARN = A.warn || (WEB ? 240_000 : 150_000)
function gate(where) {
  const s = budget.spent() - START   // this run's own output spend
  if (s >= HARD) { log('HARD CAP at ' + where + ': ' + Math.round(s / 1000) + 'k (this run)'); return 'STOP' }
  if (s >= WARN) log('WARN at ' + where + ': ' + Math.round(s / 1000) + 'k (this run)')
  return 'OK'
}

// ----- TIER 0: BASE — wide, cheap, high recall (optionally web for recall) -----
phase('Base')
log('Base: ' + ANGLES.length + ' haiku agents discovering candidates from distinct angles' + (WEB_BASE ? ' (web-enabled, single-pass)' : ''))
const baseRuns = (await pall(ANGLES.map(a => () =>
  agent(
    PROBLEM + '\n\nThrough the lens of: ' + a.lens + '.\n' +
    'Brainstorm for high RECALL (not precision): list every plausible concrete ' +
    'approach/tool/option, common and obscure. Name each + a one-sentence description. 6-12 items.' +
    (WEB_BASE
      ? '\nYou MAY use WebSearch to surface options you would not recall (newer/obscure tools). '
        + 'IMPORTANT: at most one or two searches, then STOP and answer — do NOT loop or deep-read; '
        + 'a wide tier that loops is the dominant budget cost. Verification happens later, not here.'
      : '\nReason from your own knowledge; do NOT use web tools (this tier is for recall, not verification).'),
    { label: 'base:' + a.key, phase: 'Base', model: 'haiku', schema: CAND_SCHEMA }
  )
))).filter(Boolean)

// ----- DEDUP — plain code, never an agent -----
phase('Dedup')
const byKey = new Map()
for (const r of baseRuns) for (const c of (r.candidates || [])) {
  const k = norm(c.name).split(' ').slice(0, 3).join(' ')  // collapse by leading tokens
  if (!byKey.has(k)) byKey.set(k, c)
}
const unique = [...byKey.values()]
log('Dedup: ' + baseRuns.reduce((n, r) => n + (r.candidates?.length || 0), 0) + ' raw -> ' + unique.length + ' unique')

// ----- TIER 1: FIT / TRIAGE — gate before you deep-dive (the product) -----
// Cap the width: scoring every one of dozens of unique candidates re-sends the
// big PROBLEM context per agent, which is the dominant (cache-read) cost. If
// discovery overflows MAX_FIT, the surplus is logged as dropped, never silent.
phase('Fit')
const toFit = (MAX_FIT > 0 && unique.length > MAX_FIT) ? unique.slice(0, MAX_FIT) : unique
if (toFit.length < unique.length) log('Fit: capping ' + unique.length + ' unique -> ' + toFit.length + ' scored (MAX_FIT=' + MAX_FIT + '); ' + (unique.length - toFit.length) + ' dropped')
const fitsRaw = await pall(toFit.map(c => () =>
  agent(
    PROBLEM + '\n\nScore this ONE option against the priorities for THIS problem.\n' +
    'Option: "' + c.name + '" — ' + c.oneLine + '.\n' +
    'Score each priority 0-5, set fitScore = sum. keep=true only if a credible contender ' +
    '(fitScore >= 8 OR uniquely strong on one priority). Be strict — this is a cheap filter.\n' +
    'IMPORTANT: this is fast triage. Do NOT use WebSearch or WebFetch and do NOT loop — ' +
    'reason from the description and your own knowledge, answer in a single pass. ' +
    'Fetching here is the dominant budget cost (tool-use loops re-read page content every ' +
    'turn) and adds little at triage; save the web for the KILL tier.',
    { label: 'fit:' + norm(c.name).slice(0, 16), phase: 'Fit', model: 'haiku', schema: FIT_SCHEMA }
  ).then(f => (f ? { ...f, src: c } : null))
))
const survivorsT1 = fitsRaw.filter(Boolean).filter(f => f.keep).sort((a, b) => b.fitScore - a.fitScore)
log('Fit: ' + toFit.length + ' scored -> ' + survivorsT1.length + ' survivors')
const toKill = survivorsT1.slice(0, MAX_KILL)   // cap to keep the pyramid narrowing

// Gate BEFORE the expensive (optionally web-grounded) KILL tier — sized for the
// whole run. Never gate between KILL and APEX (would starve the synthesis).
if (gate('pre-kill') === 'STOP') {
  return { recommendation: null, stopped: 'pre-kill: budget cap hit before adversarial tier',
    funnel: { raw: baseRuns.reduce((n, r) => n + (r.candidates?.length || 0), 0), unique: unique.length, afterFit: survivorsT1.length } }
}

// ----- TIER 2: KILL — adversarial; default to refute. Web-grounded if facts are
//                load-bearing. Multi-vote quorum (kill on >= KILL_THRESHOLD). -----
phase('Kill')
log('Kill: ' + toKill.length + ' survivors x ' + KILL_VOTES + ' votes (kill on >= ' + KILL_THRESHOLD + ' refutes' + (WEB_KILL ? ', web-grounded)' : ')'))
const verdictsRaw = await pall(toKill.map(f => () =>
  pall(Array.from({ length: KILL_VOTES }, (_, vi) => () =>
    agent(
      PROBLEM + '\n\nYou are ADVERSARIAL reviewer #' + (vi + 1) + '. Default to skepticism — try to ' +
      'REFUTE this option; only let it survive if it withstands attack on the priorities.\n' +
      'Option: "' + f.src.name + '" — ' + f.src.oneLine + '.\n' +
      'Attack hidden costs, operational traps, and whether its claims actually hold against the priorities. ' +
      (WEB_KILL ? 'Verify the load-bearing facts against PRIMARY sources using WebSearch and WebFetch, and cite the URLs you checked. ' : '') +
      'Decide survives true/false; list fatalFlaws and caveats.',
      { label: 'kill:' + norm(f.src.name).slice(0, 12) + ':v' + (vi + 1), phase: 'Kill', model: 'sonnet', schema: VERDICT_SCHEMA }
    )
  )).then(votes => {
    const vs = votes.filter(Boolean)
    const refutes = vs.filter(v => v.survives === false).length
    const survives = refutes < KILL_THRESHOLD && vs.length > 0
    return {
      name: f.src.name, src: f.src, survives,
      votes: vs.length, refutes,
      fatalFlaws: [...new Set(vs.flatMap(v => v.fatalFlaws || []))],
      caveats: [...new Set(vs.flatMap(v => v.caveats || []))],
      sources: [...new Set(vs.flatMap(v => v.sources || []))],
    }
  })
))
const survivors = verdictsRaw.filter(Boolean).filter(v => v.survives)
log('Kill: ' + toKill.length + ' -> ' + survivors.length + ' survive')

// Nothing survived the adversary — short-circuit. Running the strong-model APEX
// (and the critic) over an empty set is pure waste: opus on [] produces no
// recommendation, only spend. Return the rejected list so the caller can see what
// died and why, and re-run with a looser FIT/KILL or new angles.
if (survivors.length === 0) {
  return {
    recommendation: null,
    stopped: 'no survivors: every candidate was refuted in the KILL tier — loosen FIT/KILL or add angles',
    coverage: null,
    funnel: {
      raw: baseRuns.reduce((n, r) => n + (r.candidates?.length || 0), 0),
      unique: unique.length, afterFit: survivorsT1.length, survivors: 0,
      spentK: Math.round((budget.spent() - START) / 1000),
    },
    rejected: verdictsRaw.filter(Boolean).map(v => ({ name: v.name, refutes: v.refutes, fatalFlaws: v.fatalFlaws })),
  }
}

// ----- COMPLETENESS CRITIC — one cheap agent checks coverage before synthesis.
// Builds the coverage guarantee INTO the funnel: did an angle go unexplored, a
// priority/discriminator go unverified, the set get over-narrowed? Its findings
// feed the apex prompt so gaps are surfaced, not silently dropped. Skippable. ---
phase('Critic')
const CRITIC_SCHEMA = {
  type: 'object', required: ['gaps', 'verdict'],
  properties: {
    verdict: { type: 'string', enum: ['adequate', 'gaps-found'] },
    gaps: { type: 'array', items: { type: 'string', description: 'a specific coverage gap: missing angle, unverified discriminator, over-narrowed set' } },
    suggestedAngles: { type: 'array', items: { type: 'string' } },
  },
}
const critic = (A.skipCritic === true) ? null : await agent(
  PROBLEM + '\n\nYou are a COVERAGE critic — you do NOT pick a winner. Given the funnel below, find what is MISSING: '
  + 'an obvious approach no angle surfaced, a priority/discriminator the survivors were never actually tested against, '
  + 'or a set that was over-narrowed (a strong option killed on weak grounds). Be specific and concrete.\n\n'
  + 'Discovery angles used: ' + ANGLES.map(a => a.lens).join(' | ') + '\n'
  + 'Unique candidates found: ' + unique.map(c => c.name).join(', ') + '\n'
  + 'Survivors: ' + survivors.map(s => s.name).join(', ') + '\n'
  + 'Rejected (with refute counts): ' + JSON.stringify(verdictsRaw.filter(Boolean).filter(v => !v.survives).map(v => ({ name: v.name, refutes: v.refutes }))),
  { label: 'critic:coverage', phase: 'Critic', model: 'haiku', schema: CRITIC_SCHEMA }
)
if (critic) log('Critic: ' + critic.verdict + (critic.gaps?.length ? ' (' + critic.gaps.length + ' gaps)' : ''))

// ----- TIER 3: APEX — strong model, survivors only -----
phase('Apex')
const recommendation = await agent(
  PROBLEM + '\n\nYou are the apex synthesizer. Below are adversarially-filtered survivors. ' +
  'Produce: (1) the recommendation up front, (2) justification against each priority, ' +
  '(3) a scored comparison table of survivors, (4) what was REJECTED and why (name them), ' +
  '(5) address the coverage gaps the critic raised (confirm or rebut each). ' +
  'Cite sources where you have them.\n\n' +
  'SURVIVORS:\n' + JSON.stringify(survivors, null, 2) + '\n\n' +
  'REJECTED in kill tier:\n' +
  JSON.stringify(verdictsRaw.filter(Boolean).filter(v => !v.survives).map(v => ({ name: v.name, refutes: v.refutes, fatalFlaws: v.fatalFlaws })), null, 2) +
  (critic ? '\n\nCOVERAGE CRITIC findings:\n' + JSON.stringify(critic, null, 2) : ''),
  { label: 'apex:synthesis', phase: 'Apex' }   // inherits the strong main-loop model
)

return {
  recommendation,
  coverage: critic,
  funnel: {
    raw: baseRuns.reduce((n, r) => n + (r.candidates?.length || 0), 0),
    unique: unique.length,
    afterFit: survivorsT1.length,
    survivors: survivors.length,
    spentK: Math.round((budget.spent() - START) / 1000),   // this run only
  },
  rejected: verdictsRaw.filter(Boolean).filter(v => !v.survives).map(v => ({ name: v.name, refutes: v.refutes, fatalFlaws: v.fatalFlaws })),
}
