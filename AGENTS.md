# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

**Azure-devOps-MCP** — a Model Context Protocol (MCP) server that exposes **Azure DevOps Server (on-premises)** functionality to AI agents.

- Target is **on-prem Azure DevOps Server**, not the cloud (`https://<server>/<collection>`, optionally `.../tfs/<collection>`). No outbound internet is assumed — everything runs on the local network.
- The implementation wraps the **official Azure DevOps REST APIs**. The REST `api-version` must be configurable (on-prem server versions map to specific API versions, e.g. `6.0`, `7.0`, `7.1`).
- Auth: **Personal Access Token (PAT)** via Basic auth (empty username + PAT).
- Stack: TypeScript / Node.js.

## Current status

**In progress (T1–T13 done).** Implemented: project scaffolding, config + logger (PAT redaction),
REST client (`src/azure/`), per-request context, MCP server + domain orchestrator, **stdio** and
**Streamable HTTP** transports, and the `core`, `work-items`, `repositories` (Git **read** + pull
requests), `pipelines` (builds), `work` (boards/iterations), and `wiki` tool domains. Next up: T14
`test-plans`, then packaging/docs/CI. The live checklist is `tasks/todo.md`; spec is
`SPEC.md`; plan is `tasks/plan.md`.

When adding a domain, follow the existing pattern: `src/tools/<domain>.ts` exports
`configure<Domain>Tools(server, deps)`, register it in `src/tools.ts` behind its `Domain`,
read the per-request PAT via `deps.clientFor(patFromExtra(extra))`, validate inputs with `zod`,
and add mocked-fetch unit tests under `tests/unit/`.

### Quickstart

```bash
npm ci && npm run build
node dist/index.js --stdio                       # local
node dist/index.js --http --port 3000            # hosted
npm run typecheck && npm run lint && npm test    # verify
```

## Engineering Workflow (agent-skills)

This repo vendors the [agent-skills](https://github.com/addyosmani/agent-skills) pack under `.cursor/`. Skills auto-activate from context; you can also invoke them by name. **Always check for an applicable skill before implementing.**

### Intent → Skill mapping

| Intent | Skill(s) |
|--------|----------|
| New feature / functionality | `spec-driven-development` → `planning-and-task-breakdown` → `incremental-implementation` + `test-driven-development` |
| Planning / breakdown | `planning-and-task-breakdown` |
| Bug / failure / unexpected behavior | `debugging-and-error-recovery` |
| Code review | `code-review-and-quality` |
| Refactoring / simplification | `code-simplification` |
| API or interface design | `api-and-interface-design` (use for the MCP tool contracts + REST wrappers) |
| Security-sensitive work (auth, PAT handling, input) | `security-and-hardening` |
| Grounding decisions in official docs | `source-driven-development` (cite Azure DevOps REST docs) |
| High-stakes / unfamiliar decisions | `doubt-driven-development` |
| Shipping | `shipping-and-launch` |

### Lifecycle

DEFINE → `spec-driven-development` · PLAN → `planning-and-task-breakdown` · BUILD → `incremental-implementation` + `test-driven-development` · VERIFY → `debugging-and-error-recovery` · REVIEW → `code-review-and-quality` · SHIP → `shipping-and-launch`

### Anti-rationalization

Ignore these excuses: "too small for a skill", "I'll just quickly implement this", "I'll add tests later". Check for and follow the applicable skill first, and follow it fully (don't partially apply it).

## Layout

```
.cursor/
├── skills/      # 23 agent-skills (auto-discovered). Referenced checklists live in
│                #   each skill's own references/ subfolder.
├── commands/    # Slash commands, namespaced iz-* (see below)
└── agents/      # 3 specialist personas (reference docs for /iz-ship fan-out)
```

## Slash commands (namespaced `iz-*`)

Namespaced with `iz-` to avoid collision with this workspace's separate SDD command system.

| Command | Purpose |
|---------|---------|
| `/iz-spec` | Write a structured spec before code |
| `/iz-plan` | Break work into small verifiable tasks |
| `/iz-build` | Implement the next task incrementally |
| `/iz-test` | TDD workflow / Prove-It bug pattern |
| `/iz-review` | Five-axis code review |
| `/iz-code-simplify` | Reduce complexity, preserve behavior |
| `/iz-ship` | Parallel specialist fan-out → go/no-go decision |

## Coexistence with the SDD system

This workspace also has an always-applied SDD system (`/brief`, `/specify`, `/plan`, `/tasks`, `/implement`, …). The agent-skills pack is complementary: prefer SDD commands for SDD-style planning artifacts, and use the `iz-*` commands / skills for the engineering-discipline workflows above. The two never share command names.
