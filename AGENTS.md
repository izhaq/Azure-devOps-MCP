# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

**Azure-devOps-MCP** — a Model Context Protocol (MCP) server that exposes **Azure DevOps Server (on-premises)** functionality to AI agents.

- Target is **on-prem Azure DevOps Server**, not the cloud (`https://<server>/<collection>`, optionally `.../tfs/<collection>`). No outbound internet is assumed — everything runs on the local network.
- The implementation wraps the **official Azure DevOps REST APIs**. The REST `api-version` must be configurable (on-prem server versions map to specific API versions, e.g. `6.0`, `7.0`, `7.1`).
- Auth: **Personal Access Token (PAT)** via Basic auth (empty username + PAT).
- Stack: TypeScript / Node.js.

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
