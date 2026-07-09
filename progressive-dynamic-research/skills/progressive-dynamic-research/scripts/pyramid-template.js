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
//            evolve:      true,        // OPT-IN, two modes, both RE-VET through KILL
//                                      //   before APEX: with >=2 survivors, HYBRIDIZE
//                                      //   their strengths; with <2 but some refuted,
//                                      //   COMPENSATING mode composes a "best base +
//                                      //   controls named in the flaws" hybrid instead
//                                      //   of dead-ending. Default off.
//            composeModel: 'opus',     // model for the COMPOSE tier (default opus —
//                                      //   generative synthesis; re-KILL stays sonnet).
//                                      //   Set 'sonnet' for a cheaper compose.
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
    { title: 'Compose', detail: 'optional (evolve): hybridize >=2 survivors, OR compose "base + compensating controls" from the refuted set when <2 survive — re-vetted through KILL (sonnet)' },
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
// COMPOSE model. Compose is GENERATIVE synthesis (esp. compensating mode: read the
// fatal flaws and invent "base + the mitigation each names") — quality matters more
// than the cheap-legwork tiers. Default to the strong model; re-KILL is still the
// sonnet backstop, so a weak composite dies there, but re-KILL cannot UPGRADE a
// hybrid the composer was too weak to propose. Override to 'sonnet' for a cheap run.
const COMPOSE_MODEL = A.composeModel || 'opus'
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
const rawCount = baseRuns.reduce((n, r) => n + (r.candidates?.length || 0), 0)  // raw candidates across all BASE angles

// ----- DEDUP — plain code, never an agent -----
phase('Dedup')
const byKey = new Map()
for (const r of baseRuns) for (const c of (r.candidates || [])) {
  const k = norm(c.name).split(' ').slice(0, 3).join(' ')  // collapse by leading tokens
  if (!byKey.has(k)) byKey.set(k, c)
}
const unique = [...byKey.values()]
log('Dedup: ' + rawCount + ' raw -> ' + unique.length + ' unique')

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
    funnel: { raw: rawCount, unique: unique.length, afterFit: survivorsT1.length } }
}

// ----- TIER 2: KILL — adversarial; default to refute. Web-grounded if facts are
//                load-bearing. Multi-vote quorum (kill on >= KILL_THRESHOLD). -----
// Extracted as a function so the optional COMPOSE tier can RE-VET hybrids through
// the SAME adversarial quorum — a hybrid must earn its place exactly as an
// original did. `phaseLabel` keeps the re-vet votes in the Kill progress group.
async function killVote(cands, phaseLabel) {
  return (await pall(cands.map((f, ci) => () =>
    pall(Array.from({ length: KILL_VOTES }, (_, vi) => () =>
      agent(
        PROBLEM + '\n\nYou are ADVERSARIAL reviewer #' + (vi + 1) + '. Default to skepticism — try to ' +
        'REFUTE this option; only let it survive if it withstands attack on the priorities.\n' +
        'Option: "' + f.name + '" — ' + f.oneLine + '.\n' +
        'Attack hidden costs, operational traps, and whether its claims actually hold against the priorities. ' +
        (WEB_KILL ? 'Verify the load-bearing facts against PRIMARY sources using WebSearch and WebFetch, and cite the URLs you checked. ' : '') +
        'Decide survives true/false; list fatalFlaws and caveats.',
        // include the candidate index (ci) so two options with the same leading tokens
        // (e.g. two "Node-Proxy CSI Base + ..." hybrids) do NOT collapse to the same
        // label — a collision made two distinct re-KILL verdicts indistinguishable in a live run.
        { label: phaseLabel + ':c' + ci + ':' + norm(f.name).slice(0, 12) + ':v' + (vi + 1), phase: 'Kill', model: 'sonnet', schema: VERDICT_SCHEMA }
      )
    )).then(votes => {
      const vs = votes.filter(Boolean)          // votes that actually LANDED (nulls = crashed agents)
      const refutes = vs.filter(v => v.survives === false).length
      const missing = KILL_VOTES - vs.length    // votes that never came back (crashed)
      // A crashed vote is MISSING DATA, not a verdict. Resolve only when the missing
      // votes CANNOT change the outcome; otherwise the option is DEGRADED (unknown) —
      // an infra failure masquerading as survive OR kill. This closes the bug in BOTH
      // directions: all-crash (0 landed) no longer reads as a false KILL, AND a
      // swingable partial-crash (enough landed to look decided, but a missing refute
      // would tip it over threshold) no longer reads as a false SURVIVE.
      const determinedKill = refutes >= KILL_THRESHOLD                 // already killed; missing can't save it
      const determinedSurvive = (refutes + missing) < KILL_THRESHOLD  // even if ALL missing refuted, still under threshold
      const degraded = !determinedKill && !determinedSurvive
      return {
        name: f.name, src: f, survives: determinedSurvive, degraded,
        votes: vs.length, votesRequested: KILL_VOTES, refutes,
        fatalFlaws: [...new Set(vs.flatMap(v => v.fatalFlaws || []))],
        caveats: [...new Set(vs.flatMap(v => v.caveats || []))],
        sources: [...new Set(vs.flatMap(v => v.sources || []))],
      }
    })
  ))).filter(Boolean)
}
phase('Kill')
log('Kill: ' + toKill.length + ' survivors x ' + KILL_VOTES + ' votes (kill on >= ' + KILL_THRESHOLD + ' refutes' + (WEB_KILL ? ', web-grounded)' : ')'))
const verdictsRaw = await killVote(toKill.map(f => f.src), 'kill')
let survivors = verdictsRaw.filter(v => v.survives)
const degradedAfterKill = verdictsRaw.filter(v => v.degraded)
log('Kill: ' + toKill.length + ' -> ' + survivors.length + ' survive'
  + (degradedAfterKill.length ? ' (' + degradedAfterKill.length + ' DEGRADED: votes crashed below quorum — verdict unknown, not refuted)' : ''))

// ----- COMPOSE / EVOLVE (opt-in: args.evolve) — two modes, one tier. -----
// The composer schema is shared by both modes below.
const HYBRID_SCHEMA = {
  type: 'object', required: ['hybrids'],
  properties: { hybrids: { type: 'array', items: {
    type: 'object', required: ['name', 'oneLine'],
    properties: {
      name: { type: 'string' }, oneLine: { type: 'string' },
      combines: { type: 'array', items: { type: 'string' }, description: 'names of the options / controls this hybrid draws from' },
    },
  } } },
}

// Every hybrid COMPOSE proposes (both modes), captured for the return trace so a
// reviewer sees what was invented, not just the final counts. reVetHybrids fills it.
const proposedHybrids = []

// Re-vet a composed hybrid list through the SAME KILL quorum, fold the verdicts
// into verdictsRaw, and append any that survive to `survivors`. Shared by both
// compose modes so a hybrid always earns its place exactly as an original did.
async function reVetHybrids(hybrids) {
  // Bound the NAME (a label, never load-bearing) so an over-verbose composer cannot
  // bloat the re-KILL prompt. Do NOT hard-slice oneLine: in compensating mode it is
  // load-bearing structured content ("base + control A + control B + ...") and a mid-
  // string cut would silently drop a compensating control, making the composer refute
  // its own viable hybrid. Instead cap it generously and, if it is genuinely oversized,
  // keep it whole but flag it — the composer prompt already asks for a single sentence,
  // so a real overflow is a signal, not something to quietly truncate away.
  const OL_MAX = 1200
  const bounded = hybrids.map(h => {
    const ol = String(h.oneLine || '')
    if (ol.length > OL_MAX) log('Compose: hybrid "' + String(h.name).slice(0, 40) + '" description is ' + ol.length + ' chars (> ' + OL_MAX + ') — passing whole to re-KILL; composer should tighten it')
    return { ...h, name: String(h.name).slice(0, 120), oneLine: ol }
  })
  log('Compose: ' + bounded.length + ' hybrid(s) -> re-vetting through KILL')
  proposedHybrids.push(...bounded)   // record what COMPOSE proposed, for the return trace
  const hybridVerdicts = await killVote(bounded, 'kill-hybrid')
  for (const v of hybridVerdicts) v.hybrid = true   // tag so the return can separate re-KILL from the first KILL
  verdictsRaw.push(...hybridVerdicts)
  const hybridSurvivors = hybridVerdicts.filter(v => v.survives)
  survivors = survivors.concat(hybridSurvivors)
  log('Compose: ' + hybridSurvivors.length + ' of ' + hybrids.length + ' hybrid(s) survived re-vet')
}

// COMPENSATING-CONTROLS mode: fewer than 2 clean survivors, but a real answer may
// still exist as "best base mechanism + controls that cover its residual flaws".
// Those controls are NOT themselves candidates — the KILL tier named them inside
// each rejected option's fatalFlaws (e.g. "the only way to satisfy P7 is a
// networking-layer block"). So instead of dead-ending at null when evolve is on,
// feed the REJECTED options + their flaws into COMPOSE and let it propose a
// base+compensating-controls hybrid, re-vet it, and fall through to APEX. Without
// evolve, a <2-survivor outcome is still a hard stop (the funnel stays a strict
// down-selector — this rescue is opt-in and gated on args.evolve).
// A GENUINELY refuted verdict: the adversary landed enough votes to decide AND
// killed it. This EXCLUDES degraded verdicts (votes crashed below quorum — verdict
// unknown), which also have survives===false but are NOT evidence the option is bad.
// Every place that reports or reasons over "what was rejected" must use this, or a
// crashed-vote option gets mislabeled as adversarially refuted (empty/partial flaws
// fed to the composer/critic/apex, or returned to the caller as a false rejection).
const refutedOnly = (vv) => vv.filter(Boolean).filter(v => !v.survives && !v.degraded)
const degradedOnly = (vv) => vv.filter(Boolean).filter(v => v.degraded)

// Shared tail for both compose modes: run the composer, keep well-formed hybrids,
// re-vet them through KILL. Only the prompt/label/empty-message differ between modes
// (the source-set + payload shape genuinely diverge and stay at each call site).
async function composeAndReVet(prompt, label, emptyMsg) {
  const composed = await agent(prompt, { label, phase: 'Compose', model: COMPOSE_MODEL, schema: HYBRID_SCHEMA })
  const hybrids = (composed?.hybrids || []).filter(h => h && h.name)
  if (hybrids.length) await reVetHybrids(hybrids)
  else log(emptyMsg)
}

// Snapshot the CLEAN-survivor count BEFORE any compose. reVetHybrids mutates the
// shared `survivors` array, so gating the two modes on live `survivors.length` would
// let a compensating run (which can lift survivors from <2 to >=2) fall through into
// hybridize — a double-compose. Freezing nClean makes the two gates provably
// mutually exclusive without a separate flag.
const nClean = survivors.length
if (nClean < 2 && A.evolve === true && gate('pre-compose') !== 'STOP') {
  const rejected = refutedOnly(verdictsRaw)   // degraded options carry no real flaws — do not compose over them
  if (rejected.length) {
    phase('Compose')
    log('Compose(compensating): ' + nClean + ' clean survivor(s); composing base+controls from ' + rejected.length + ' refuted options + their flaws')
    await composeAndReVet(
      PROBLEM + '\n\nYou are a COMPOSER. NO single option below cleanly satisfies every priority — each was ' +
      'refuted on one or more. But a valid answer may still exist as a HYBRID: the least-bad BASE option, PLUS ' +
      'compensating controls that cover its residual flaws. CRUCIAL: those compensating controls are usually NOT ' +
      'other options in this list — they are named inside the fatalFlaws (e.g. "the only way to satisfy X is a Y"). ' +
      'Read the flaws, extract the mitigations they name, and propose 1-2 hybrids of the form ' +
      '"BASE option + <compensating control per unmet priority>". Only if a genuine composition exists ' +
      '(an empty list is a valid answer if the flaws are truly unfixable). Each hybrid: name, a single-sentence ' +
      'description (keep it under ~600 chars) spelling out base + each compensating control, and which options/controls it combines.\n\n' +
      'REFUTED OPTIONS (with the flaws that name the fixes):\n' +
      JSON.stringify(rejected.map(v => ({ name: v.name, oneLine: v.src?.oneLine, fatalFlaws: v.fatalFlaws })), null, 2),
      'compose:compensating',
      'Compose(compensating): no viable base+controls composition; flaws appear unfixable'
    )
  }
}

// If still nothing survived (no clean survivor, and either evolve is off or the
// compensating-controls compose produced nothing that survived re-vet) — short-
// circuit. Running APEX over an empty set is pure waste. Return the rejected list
// so the caller sees what died and why, and can loosen FIT/KILL or add angles.
if (survivors.length === 0) {
  // Separate GENUINELY refuted (an adversary landed >= THRESHOLD refutes) from
  // DEGRADED (too few votes landed to decide — infra failure, verdict unknown). A
  // degraded option is NOT evidence the option is bad; reporting it as "refuted"
  // would be the same lie as the eval win-rate counting an unjudged run. If every
  // remaining option is degraded, the honest terminal state is "could not evaluate
  // — retry", not "everything was refuted — loosen your filters".
  const degraded = degradedOnly(verdictsRaw)
  const refuted = refutedOnly(verdictsRaw)
  const allDegraded = degraded.length > 0 && refuted.length === 0
  // Message must stay honest per case: all-degraded => retry-with-budget (infra), some
  // refuted => loosen-filters, mixed => say BOTH without the self-contradiction of
  // claiming "every candidate was refuted" when some were only degraded.
  return {
    recommendation: null,
    stopped: allDegraded
      ? 'could not evaluate: every remaining option was DEGRADED — its KILL votes crashed below quorum (infra failure, not a refutation). Re-run (resume-from-cache) with more budget headroom; the verdict is unknown, not negative'
      : 'no survivors: ' + refuted.length + ' option(s) were refuted in the KILL tier' +
        (A.evolve === true ? ' and no compensating-controls hybrid survived re-vet' : '') +
        (degraded.length ? '; ' + degraded.length + ' other(s) were DEGRADED (votes crashed below quorum — verdict unknown, not refuted)' : '') +
        ' — loosen FIT/KILL or add angles' + (degraded.length ? ', or re-run for the degraded ones' : ''),
    coverage: null,
    funnel: {
      raw: rawCount,
      unique: unique.length, afterFit: survivorsT1.length, survivors: 0,
      degraded: degraded.length,
      spentK: Math.round((budget.spent() - START) / 1000),
    },
    degraded: degraded.map(v => ({ name: v.name, votes: v.votes, votesRequested: v.votesRequested })),
    rejected: refuted.map(v => ({ name: v.name, refutes: v.refutes, fatalFlaws: v.fatalFlaws })),
    // In compensating mode COMPOSE may have run and produced hybrids that all failed
    // re-KILL — surface that trace so the dead-end is explainable, not just "0 survivors".
    compose: proposedHybrids.length ? {
      proposed: proposedHybrids.map(h => ({ name: h.name, oneLine: h.oneLine, combines: h.combines })),
      reKill: verdictsRaw.filter(v => v.hybrid).map(v => ({
        name: v.name, survived: v.survives, refutes: v.refutes, fatalFlaws: v.fatalFlaws })),
    } : null,
  }
}

// HYBRIDIZE mode: >=2 clean survivors — propose hybrid(s) combining their
// strongest parts into something that beats any single survivor. Re-vetted through
// the SAME KILL quorum before it can reach APEX. The funnel invariant holds: APEX
// only ever sees adversarially-vetted options, hybrids included. COMPOSE is cheap
// on COMPOSE_MODEL (default opus, override-able) — re-KILL is the quality backstop.
if (A.evolve === true && nClean >= 2 && gate('pre-compose') !== 'STOP') {
  phase('Compose')
  log('Compose: proposing hybrids from ' + nClean + ' survivors (' + COMPOSE_MODEL + '); hybrids re-vetted through KILL')
  await composeAndReVet(
    PROBLEM + '\n\nYou are a COMPOSER. Below are options that each survived adversarial review. ' +
    'Propose 1-2 HYBRID options that combine their strongest parts into something that beats any single ' +
    'survivor on the priorities — only if a genuine synthesis exists (do NOT force a hybrid; an empty list is a valid answer). ' +
    'Each hybrid: a name, a single-sentence description (keep it under ~600 chars), and which survivors it combines.\n\n' +
    'SURVIVORS:\n' + JSON.stringify(survivors.map(s => ({ name: s.name, oneLine: s.src.oneLine, caveats: s.caveats })), null, 2),
    'compose:hybrids',
    'Compose: no viable hybrid proposed; proceeding with original survivors'
  )
}

// verdictsRaw is fully settled here (both compose modes done mutating it via
// reVetHybrids). Compute the refuted/degraded projections ONCE and reuse across the
// critic prompt, the apex prompt, and the return — one definition of "rejected".
const refuted = refutedOnly(verdictsRaw)
const degradedList = degradedOnly(verdictsRaw)

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
  + 'Rejected (with refute counts): ' + JSON.stringify(refuted.map(v => ({ name: v.name, refutes: v.refutes }))),
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
  JSON.stringify(refuted.map(v => ({ name: v.name, refutes: v.refutes, fatalFlaws: v.fatalFlaws })), null, 2) +
  (critic ? '\n\nCOVERAGE CRITIC findings:\n' + JSON.stringify(critic, null, 2) : ''),
  { label: 'apex:synthesis', phase: 'Apex' }   // inherits the strong main-loop model
)

return {
  recommendation,
  coverage: critic,
  funnel: {
    raw: rawCount,
    unique: unique.length,
    afterFit: survivorsT1.length,
    survivors: survivors.length,
    degraded: degradedList.length,
    spentK: Math.round((budget.spent() - START) / 1000),   // this run only
  },
  // rejected = GENUINELY refuted only. degraded (crashed-vote, verdict-unknown) options
  // are reported separately so a caller never mistakes "could not evaluate" for "refuted".
  rejected: refuted.map(v => ({ name: v.name, refutes: v.refutes, fatalFlaws: v.fatalFlaws })),
  degraded: degradedList.map(v => ({ name: v.name, votes: v.votes, votesRequested: v.votesRequested })),
  // COMPOSE trace (present only when evolve fired): what the composer proposed and how
  // each hybrid fared at re-KILL — so a reviewer can inspect the tier, not just the counts.
  compose: proposedHybrids.length ? {
    proposed: proposedHybrids.map(h => ({ name: h.name, oneLine: h.oneLine, combines: h.combines })),
    reKill: verdictsRaw.filter(v => v.hybrid).map(v => ({
      name: v.name, survived: v.survives, refutes: v.refutes, fatalFlaws: v.fatalFlaws })),
  } : null,
}
