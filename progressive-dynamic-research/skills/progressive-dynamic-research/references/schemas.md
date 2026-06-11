# Per-tier JSON schemas

Force every agent to return validated JSON, never prose. Structured output is
non-negotiable for decision work: results become directly tabulatable (the
comparison tables in a report come straight from agent output), and you never
re-read the answer five times arguing about what it said. Pass these as the
`schema` option to `agent()`; the harness validates and the model retries on
mismatch.

## Table of contents
- Candidate (BASE)
- Fit / triage (FIT)
- Verdict (KILL)
- Deep-dive (APEX inputs)
- Triage-only variant (known candidate set)

---

## Candidate — BASE tier
High-recall discovery. Keep it thin; precision comes later.
```json
{
  "type": "object", "required": ["candidates"],
  "properties": { "candidates": { "type": "array", "items": {
    "type": "object", "required": ["name", "oneLine"],
    "properties": {
      "name":    { "type": "string", "description": "canonical name" },
      "oneLine": { "type": "string", "description": "one-sentence what-it-is" },
      "phase":   { "type": "string", "enum": ["A", "B", "both"], "description": "optional: which sub-phase it fits" }
    } } } }
}
```

## Fit / triage — FIT tier
Score against the FIXED priorities; `keep` is the gate. Be strict — this is the
cheap filter that should kill ~80%.
```json
{
  "type": "object", "required": ["name", "fitScore", "keep", "reason"],
  "properties": {
    "name":     { "type": "string" },
    "p1":       { "type": "integer", "minimum": 0, "maximum": 5 },
    "p2":       { "type": "integer", "minimum": 0, "maximum": 5 },
    "p3":       { "type": "integer", "minimum": 0, "maximum": 5 },
    "fitScore": { "type": "integer", "minimum": 0, "maximum": 15, "description": "p1+p2+p3" },
    "keep":     { "type": "boolean" },
    "reason":   { "type": "string" }
  }
}
```

## Verdict — KILL tier
Adversarial. Default the verifier to "assume false unless proven." For
load-bearing facts, require web-grounded verdicts with citations. The 4-way
`verdict` enum is better than a boolean when you want to keep partly-true claims.
```json
{
  "type": "object", "required": ["name", "verdict", "evidence"],
  "properties": {
    "name":     { "type": "string" },
    "verdict":  { "type": "string", "enum": ["confirmed", "refuted", "partly-true", "unverifiable"] },
    "survives": { "type": "boolean", "description": "false if a fatal misfit" },
    "fatalFlaws": { "type": "array", "items": { "type": "string" } },
    "caveats":  { "type": "array", "items": { "type": "string" } },
    "evidence": { "type": "string", "description": "what primary sources actually say" },
    "sources":  { "type": "array", "items": { "type": "string", "description": "URL" } }
  }
}
```

## Deep-dive — APEX inputs (optional)
When survivors deserve a full deep-dive analysis before synthesis. Adapt the
property set to the domain.
```json
{
  "type": "object", "required": ["name", "phaseFit"],
  "properties": {
    "name":      { "type": "string" },
    "notes":     { "type": "string", "description": "the deep technical findings" },
    "integrity": { "type": "string", "description": "correctness / idempotency / guarantees" },
    "opBurden":  { "type": "string", "description": "what you actually have to run/babysit" },
    "phaseFit":  { "type": "string" },
    "sources":   { "type": "array", "items": { "type": "string" } }
  }
}
```

## Triage-only variant — known candidate set
When the candidates are already known (no BASE discovery needed), skip straight to
a single decisive gate. This is the cheapest, highest-leverage shape: one
discovery agent enumerates, then one triage agent per candidate answers ONE
yes/no question. **The gate is the product** — spend design effort choosing it.
```json
{
  "type": "object", "required": ["name", "gate_passes", "verdict", "reason"],
  "properties": {
    "name":        { "type": "string" },
    "gate_passes": { "type": "boolean", "description": "the ONE decisive question" },
    "verdict":     { "type": "string", "enum": ["SURVIVE", "SURVIVE-baseline", "KILL"] },
    "reason":      { "type": "string" },
    "citations":   { "type": "array", "items": { "type": "string" } }
  }
}
```
