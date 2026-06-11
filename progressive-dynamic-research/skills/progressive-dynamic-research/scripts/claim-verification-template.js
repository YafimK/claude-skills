// ============================================================================
// CLAIM-VERIFICATION FUNNEL — pyramid variant for cited prior-art / hard-numbers.
// Use when the task is "research these N questions and give me verified, cited
// facts" — NOT "choose among candidate options" (that is pyramid-template.js).
//
// Funnel:  DISCOVER (haiku, web, per question x angle -> CLAIMS+SOURCES) ->
//          DEDUP (code, grouped by question) -> VERIFY (sonnet, web-grounded,
//          adversarial, per claim, PER-BUCKET cap) -> SYNTH (opus, cited report).
//
// NO FIT TIER: you are gathering+verifying claims, not scoring options against
// fixed priorities. The KILL tier becomes a web-grounded CLAIM verifier.
//
// Two load-bearing fixes over the option-selection template (see harness-notes.md):
//  1. Budget sized for web-grounded fetch cost (~5-10x reasoning) and the gate is
//     placed BEFORE discovery, never between discovery and verify.
//  2. Verify cap allocated PER QUESTION, not globally — else one question starves
//     the others and the apex reports false "evidence gaps".
// ============================================================================

export const meta = {
  name: 'claim-verification',
  description: 'Discover cited claims per question, web-verify adversarially, synthesize a cited report — no option down-selection',
  phases: [
    { title: 'Discover', detail: 'wide claim+source discovery per question x angle (haiku, web)' },
    { title: 'Dedup',    detail: 'collapse near-duplicate claims, grouped by question (code)' },
    { title: 'Verify',   detail: 'web-grounded adversarial per-claim verification, per-bucket cap (sonnet)' },
    { title: 'Synth',    detail: 'cited report across all questions (opus)' },
  ],
}

const pall = async (thunks) => (await parallel(thunks)) || []
const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// === EDIT: live constraints, restated so no spike answers a stale question. ===
// Avoid apostrophes (they break the JS string).
const CONTEXT = `<<one-paragraph live context + the constraints every spike must respect>>`

// === EDIT: the questions, each with distinct discovery angles for recall. ===
const QUESTIONS = [
  { key: 'q1', ask: '<<question 1, ending with: name specific systems; cite docs>>',
    angles: ['<<angle a>>', '<<angle b>>', '<<angle c>>'] },
  { key: 'q2', ask: '<<question 2 — the load-bearing one; ask for the ACTUAL numbers>>',
    angles: ['<<angle a>>', '<<angle b>>', '<<angle c>>'] },
  { key: 'q3', ask: '<<question 3>>',
    angles: ['<<angle a>>', '<<angle b>>', '<<angle c>>'] },
]

const PER_Q_VERIFY = 6   // <-- per-bucket cap: each question gets a fair share of verify

const CLAIM_SCHEMA = {
  type: 'object', required: ['claims'],
  properties: { claims: { type: 'array', items: {
    type: 'object', required: ['claim', 'system'],
    properties: {
      claim:  { type: 'string', description: 'one falsifiable factual claim' },
      system: { type: 'string', description: 'the named system/vendor/tool it is about' },
      number: { type: 'string', description: 'any concrete number (ops/sec, latency, scale), or empty' },
      source: { type: 'string', description: 'URL or doc name if known, else empty' },
    },
  } } },
}
const VERIFY_SCHEMA = {
  type: 'object', required: ['claim', 'verdict', 'evidence'],
  properties: {
    claim:     { type: 'string' },
    verdict:   { type: 'string', enum: ['confirmed', 'refuted', 'partly-true', 'unverifiable'] },
    corrected: { type: 'string', description: 'the corrected/precise statement if the claim was off' },
    evidence:  { type: 'string', description: 'what primary sources actually say' },
    sources:   { type: 'array', items: { type: 'string', description: 'URL' } },
  },
}

// Budget sized for a fully web-grounded run (fetch cost ~5-10x reasoning).
// Gate BEFORE discovery only — never between discovery and the load-bearing verify.
const HARD = 900_000, WARN = 750_000
function gate(where) {
  const s = budget.spent()
  if (s >= HARD) { log('HARD CAP at ' + where + ': ' + Math.round(s/1000) + 'k'); return 'STOP' }
  if (s >= WARN) log('WARN at ' + where + ': ' + Math.round(s/1000) + 'k')
  return 'OK'
}

// ----- DISCOVER: wide claim+source discovery, haiku+web, per (question x angle) -----
phase('Discover')
const discoverThunks = []
for (const q of QUESTIONS) for (const lens of q.angles) {
  discoverThunks.push(() => agent(
    CONTEXT + '\n\nResearch question: ' + q.ask + '\n\nFocus your search through this lens: ' + lens + '. '
    + 'Use WebSearch and WebFetch. List 5-10 specific, falsifiable factual claims, each tied to a NAMED system and a concrete number where one exists, with a source URL. Prefer vendor docs and engineering blogs over secondary summaries.',
    { label: 'discover:' + q.key + ':' + norm(lens).slice(0, 12), phase: 'Discover', model: 'haiku', schema: CLAIM_SCHEMA }
  ).then(r => (r ? { q: q.key, claims: r.claims || [] } : null)))
}
const discovered = (await pall(discoverThunks)).filter(Boolean)

// ----- DEDUP: collapse near-duplicate claims in code, KEEP grouped by question -----
phase('Dedup')
const byQ = Object.fromEntries(QUESTIONS.map(q => [q.key, new Map()]))
let rawCount = 0
for (const d of discovered) for (const c of d.claims) {
  rawCount++
  const m = byQ[d.q]; if (!m) continue
  const k = norm((c.system || '') + ' ' + (c.claim || '')).split(' ').slice(0, 8).join(' ')
  if (!m.has(k)) m.set(k, c)
}
// PER-BUCKET cap: take PER_Q_VERIFY from EACH question (numeric claims first), then concat.
// A global slice here would starve some questions -> false "evidence gaps" at apex.
const toVerify = []
for (const q of QUESTIONS) {
  const cs = [...byQ[q.key].values()]
  const withNum = cs.filter(c => c.number && c.number.trim())
  const noNum   = cs.filter(c => !(c.number && c.number.trim()))
  for (const c of [...withNum, ...noNum].slice(0, PER_Q_VERIFY)) toVerify.push({ ...c, q: q.key })
}
log('Dedup: ' + rawCount + ' raw -> ' + toVerify.length + ' to verify (<= ' + PER_Q_VERIFY + '/question)')

// ----- VERIFY: web-grounded adversarial per-claim verification, sonnet -----
phase('Verify')
const verifyThunks = toVerify.map(c => () => agent(
  CONTEXT + '\n\nYou are an ADVERSARIAL fact-checker. Default to skepticism: assume the claim is WRONG until primary sources prove it. '
  + 'Verify this ONE claim against PRIMARY sources (vendor docs, standards, named engineering blogs) using WebSearch and WebFetch.\n'
  + 'Claim: "' + (c.claim || '') + '"\nAbout system: ' + (c.system || '') + (c.number ? ('\nStated number: ' + c.number) : '') + (c.source ? ('\nClaimed source: ' + c.source) : '') + '\n'
  + 'Decide verdict (confirmed / refuted / partly-true / unverifiable). If a number is off or imprecise, give the corrected precise value. Cite the actual URLs you checked.',
  { label: 'verify:' + norm(c.system || c.claim).slice(0, 16), phase: 'Verify', model: 'sonnet', schema: VERIFY_SCHEMA }
).then(v => (v ? { ...v, q: c.q } : null)))
const verified = (await pall(verifyThunks)).filter(Boolean)
const kept = verified.filter(v => v.verdict === 'confirmed' || v.verdict === 'partly-true')
log('Verify: ' + toVerify.length + ' checked -> ' + kept.length + ' confirmed/partly-true')
gate('post-verify')

// ----- SYNTH: strong model, cited report across all questions -----
phase('Synth')
const grouped = QUESTIONS.map(q => '## ' + q.key + '\n' + JSON.stringify(kept.filter(v => v.q === q.key), null, 2)).join('\n\n')
const report = await agent(
  CONTEXT + '\n\nYou are the apex synthesizer. Below are adversarially verified claims (confirmed or partly-true only), grouped by question. '
  + 'For EACH question: (1) the direct answer with named systems and concrete numbers, (2) inline source cites, (3) state explicitly whether the EXACT combination is common in the wild vs whether the ingredients are proven but the specific assembly is rare/novel. '
  + 'Mark confidence per major claim. If a question bucket is empty, say so as an evidence gap; do NOT backfill from your own knowledge.\n\n' + grouped,
  { label: 'synth:report', phase: 'Synth' }
)

return {
  report,
  funnel: { rawClaims: rawCount, toVerify: toVerify.length, verified: verified.length, kept: kept.length },
  refuted: verified.filter(v => v.verdict === 'refuted' || v.verdict === 'unverifiable').map(v => ({ q: v.q, claim: v.claim, verdict: v.verdict, corrected: v.corrected || '' })),
}
