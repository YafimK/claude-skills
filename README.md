# claude-skills

A Claude Code **plugin marketplace** (`progressive-research`) of reusable, general-purpose
skills for agent orchestration and research. Public-clean: no project-internal
content ships here.

## Layout

```
.claude-plugin/marketplace.json        # the marketplace
progressive-dynamic-research/          # plugin: progressive-dynamic-research
├── .claude-plugin/plugin.json
└── skills/progressive-dynamic-research/SKILL.md   # the skill (+ scripts/, references/)
```

## Plugins

- **progressive-dynamic-research** — multi-tier agent funnel for research and architecture
  decisions. Cheap models discover breadth; an adversarial tier kills weak
  options; the strong model only synthesizes the few survivors. Ships a guidance
  skill, a canonical dynamic-workflow template, and per-tier JSON schemas +
  harness gotchas. **For how the funnel works — stages, concepts, one diagram —
  see the [skill README](progressive-dynamic-research/skills/progressive-dynamic-research/README.md).**

> **Note on names:** the *marketplace* is `progressive-research` and the *plugin*
> inside it is `progressive-dynamic-research`. The install string is always
> `plugin@marketplace` — hence `progressive-dynamic-research@progressive-research`.

## Install

From GitHub (`owner/repo` shorthand):

```
/plugin marketplace add YafimK/claude-skills
/plugin install progressive-dynamic-research@progressive-research
```

Or from a local checkout (no remote needed) — point at the repo root:

```
/plugin marketplace add .
/plugin install progressive-dynamic-research@progressive-research
```

After install the skill is invocable as `/progressive-dynamic-research:progressive-dynamic-research`, and
triggers automatically on research / comparison / architecture-decision tasks and
when you're about to fan out subagents or author a dynamic Workflow.

To pick up changes during development: `/plugin marketplace update progressive-research`
(bump `version` in `plugin.json` for pinned-release consumers).

## Development

The workflow templates ship with a zero-dependency `node:test` suite that catches
the token-wasting bugs (budget gate not firing, KILL quorum math, APEX running on
an empty survivor set, FIT looping) *before* a real run spends anything. From the
skill directory:

```
cd progressive-dynamic-research/skills/progressive-dynamic-research
node --test scripts/pyramid-template.test.mjs   # 38 tests, ~100ms
node --check scripts/pyramid-template.js         # syntax gate before launch
```

CI runs both on every push and pull request (`.github/workflows/test.yml`).
