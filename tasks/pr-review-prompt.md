# Reviewer Agent Prompts — Azure DevOps MCP

Each PR has its own standalone prompt below. Hand each block to a **separate**
reviewer agent (recommended subagent: `code-reviewer`, or run `/iz-review`).
Every block is self-contained — a reviewer does NOT see this chat or the other
prompts.

Repo: `izhaq/Azure-devOps-MCP`. Recommended merge order: **#4 → #3 → #5**.

---

## Prompt for PR #4 — Streamable HTTP transport (T7)

```
You are a senior code reviewer. Review ONE pull request: #4 in the GitHub repo
izhaq/Azure-devOps-MCP. Do NOT write or fix code — produce a written review only.
Use the GitHub MCP (or `gh`) to read the PR's diff, files, and description, and
read the surrounding source for context.

SKILLS TO USE (read and follow before reviewing):
- .cursor/skills/code-review-and-quality/SKILL.md  → five-axis review
  (correctness, readability, architecture, security, performance) + severity
  labels: Critical / (required, no prefix) / Optional / Nit / FYI.
- .cursor/skills/security-and-hardening/SKILL.md   → secrets, transport security,
  untrusted input at boundaries.
- .cursor/skills/source-driven-development/SKILL.md → verify claims (MCP transport
  spec, headers) against authoritative behavior; flag anything unverifiable.
- .cursor/skills/test-driven-development/SKILL.md   → judge test quality.

PROJECT CONTEXT:
MCP server exposing an ON-PREM Azure DevOps Server to AI agents via official ADO
REST APIs. Runs fully OFFLINE — the only allowed outbound destination is the
on-prem ADO instance (no internet, no telemetry). Stack: TypeScript strict ESM,
Node >= 20, @modelcontextprotocol/sdk, zod, native fetch, vitest. Auth is a
per-user PAT (HTTP Basic ":{PAT}" base64). In hosted HTTP mode the PAT arrives
PER REQUEST via the `X-ADO-PAT` header and must NEVER be stored, cached across
requests, or logged.

NON-NEGOTIABLE CHECKS:
1. PAT/secret safety: never logged/persisted/leaked; stays request-scoped.
2. Offline guarantee: no new outbound calls or phone-home dependencies.
3. Untrusted input validated at boundaries (HTTP headers are untrusted).
4. Tests present, behavior-focused, cover error paths, catch regressions.
5. Cross-platform + Node >= 20 safe; ESM imports use .js specifiers.

THIS PR (#4) — "fix: bring Streamable HTTP transport (T7) into main",
branch feat/http-transport-to-main → main:
Adds hosted-mode transport: single POST /mcp (stateless, JSON-response
Web-standard Streamable HTTP via the SDK's WebStandardStreamableHTTPServerTransport).
Key files: src/transports/http.ts, tests/unit/http-transport.test.ts,
src/index.ts (wires --http/--port), src/config.ts + .env.example (ADO_HTTP_HOST).
Focus on:
- Security guards run BEFORE the MCP layer: Origin allowlist → 403, Host
  allowlist (DNS-rebinding defense) → 403, POST-only → 405, missing X-ADO-PAT →
  401. Confirm the order and that no path bypasses them.
- Security headers (HSTS, X-Content-Type-Options: nosniff, X-Frame-Options:
  DENY) on EVERY response, including error responses.
- Per-request isolation: fresh server+transport per request, proper teardown,
  PAT does not leak between requests.
- Host/Origin allowlist logic behind a reverse proxy: is the fallback to
  hostname-without-port reasonable, not a hole?
- FYI: this is a re-land — same code reviewed as PR #2 but merged to the wrong
  base, so it never reached main.

OUTPUT FORMAT:
- One-line verdict: APPROVE or REQUEST CHANGES.
- Findings as a list, each tagged Critical / (required) / Optional / Nit / FYI,
  with file:line references and a concrete fix suggestion.
- Only list axes that have findings. Be direct and honest — no rubber-stamping;
  quantify issues where you can. Approve when the PR clearly improves code health
  even if imperfect.
```

---

## Prompt for PR #3 — work-items domain tools (T8)

```
You are a senior code reviewer. Review ONE pull request: #3 in the GitHub repo
izhaq/Azure-devOps-MCP. Do NOT write or fix code — produce a written review only.
Use the GitHub MCP (or `gh`) to read the PR's diff, files, and description, and
read the surrounding source for context.

SKILLS TO USE (read and follow before reviewing):
- .cursor/skills/code-review-and-quality/SKILL.md  → five-axis review
  (correctness, readability, architecture, security, performance) + severity
  labels: Critical / (required, no prefix) / Optional / Nit / FYI.
- .cursor/skills/security-and-hardening/SKILL.md   → secrets, untrusted input.
- .cursor/skills/source-driven-development/SKILL.md → VERIFY every Azure DevOps
  REST endpoint, route shape, HTTP verb, and api-version against the official
  ADO REST docs and the behavior claimed in code comments/PR text. Flag anything
  unverifiable.
- .cursor/skills/test-driven-development/SKILL.md   → judge test quality.

PROJECT CONTEXT:
MCP server exposing an ON-PREM Azure DevOps Server to AI agents via official ADO
REST APIs. Runs fully OFFLINE — only allowed outbound destination is the on-prem
ADO instance. Stack: TypeScript strict ESM, Node >= 20, @modelcontextprotocol/sdk,
zod, native fetch, vitest. Auth is a per-user PAT (HTTP Basic ":{PAT}" base64);
must never be logged or persisted. Architecture: domain-based tools; a thin
AzureDevOpsClient handles URL building, api-version, auth, pagination, and error
mapping; ToolDeps.clientFor(pat) builds a per-request client; tools are
registered only when their domain is enabled. api-version is configurable
(default 7.1); some sub-resources need a derived "-preview.N" version.

NON-NEGOTIABLE CHECKS:
1. PAT/secret safety: never logged/persisted/leaked.
2. Offline guarantee: no new outbound calls or phone-home dependencies.
3. Input validation at boundaries (zod schemas on tool inputs).
4. Tests present, behavior-focused, cover error paths, catch regressions.
5. Cross-platform + Node >= 20 safe; ESM imports use .js specifiers.

THIS PR (#3) — "feat: work-items domain tools (T8)",
branch feat/work-items → main:
Adds six tools: wit_query (WIQL), wit_get, wit_create, wit_update,
wit_add_comment, wit_list_types. Also extends AzureDevOpsClient.post() with an
optional content-type so create can send application/json-patch+json.
Key files: src/tools/work-items.ts, src/azure/client.ts, src/tools.ts,
tests/unit/work-items-tools.test.ts.
Focus on:
- REST correctness vs official ADO docs: endpoints, project-scoped vs collection
  routing, HTTP verbs, the "$Type" segment on create, JSON-Patch body shape, and
  the preview api-version used for comments.
- The post() content-type change: backward-compatible default? parity with patch()?
- Field-map → JSON-Patch conversion: values passed through safely; any injection
  or encoding concern in path/segment building (encodeURIComponent)?
- Tools registered only under the work-items domain.
- KNOWN INTEGRATION ISSUE: PR #4 makes `httpHost` a REQUIRED field on
  ServerConfig. This PR's test config object does not set httpHost, so after #4
  merges this PR fails typecheck until rebased. Confirm this is the only
  collision and note the merge order (#4, then rebase #3).

OUTPUT FORMAT:
- One-line verdict: APPROVE or REQUEST CHANGES.
- Findings as a list, each tagged Critical / (required) / Optional / Nit / FYI,
  with file:line references and a concrete fix suggestion.
- Only list axes that have findings. Be direct and honest — no rubber-stamping;
  quantify issues where you can. Approve when the PR clearly improves code health
  even if imperfect.
```

---

## Prompt for PR #5 — "explain simply" Cursor rule

```
You are a senior code reviewer. Review ONE pull request: #5 in the GitHub repo
izhaq/Azure-devOps-MCP. Do NOT write or fix code — produce a written review only.
Use the GitHub MCP (or `gh`) to read the PR's diff and files.

SKILLS TO USE:
- .cursor/skills/code-review-and-quality/SKILL.md → severity labels
  Critical / (required) / Optional / Nit / FYI.

CONTEXT:
This repo is an MCP server for on-prem Azure DevOps. This PR is a tiny,
non-code change.

THIS PR (#5) — "chore: add \"explain simply\" Cursor rule",
branch chore/explain-simply-rule → main:
Adds .cursor/rules/explain-simply.mdc — a project-scoped agent communication rule
asking the agent to explain/summarize/analyze in short, junior-friendly language.
Check only:
- Valid Cursor rule frontmatter (description, alwaysApply).
- Scope and wording are reasonable; rule applies to explanations only, not to
  code/commit/PR text.
- No unintended side effects; no other files touched.

OUTPUT FORMAT:
- One-line verdict: APPROVE or REQUEST CHANGES.
- Findings (if any) tagged Critical / (required) / Optional / Nit / FYI with
  file:line references.
```

---

## Reusable template (for future PRs)

```
You are a senior code reviewer. Review ONE pull request: #<NUMBER> in the GitHub
repo izhaq/Azure-devOps-MCP. Do NOT write or fix code — produce a written review
only. Use the GitHub MCP (or `gh`) to read the PR's diff, files, and description,
and read the surrounding source for context.

SKILLS TO USE (read and follow before reviewing):
- .cursor/skills/code-review-and-quality/SKILL.md   → five-axis review + severity
  labels: Critical / (required) / Optional / Nit / FYI.
- .cursor/skills/security-and-hardening/SKILL.md    → secrets, untrusted input.
- .cursor/skills/source-driven-development/SKILL.md → verify ADO REST endpoints /
  api-versions against official docs.
- .cursor/skills/test-driven-development/SKILL.md   → judge test quality.

PROJECT CONTEXT:
MCP server exposing an ON-PREM Azure DevOps Server to AI agents via official ADO
REST APIs. Fully OFFLINE (only outbound destination = on-prem ADO). TypeScript
strict ESM, Node >= 20, @modelcontextprotocol/sdk, zod, native fetch, vitest.
Per-user PAT auth (HTTP Basic ":{PAT}" base64); PAT never logged/persisted, and in
HTTP mode it is request-scoped via the X-ADO-PAT header. Domain-based tools over a
thin AzureDevOpsClient (URL/api-version/auth/pagination/errors).

NON-NEGOTIABLE CHECKS:
1. PAT/secret safety.  2. Offline guarantee.  3. Input validated at boundaries.
4. Behavior-focused tests covering error paths.  5. Cross-platform + Node >= 20.

THIS PR (#<NUMBER>) — "<TITLE>", branch <BRANCH> → <BASE>:
<1–3 sentence summary of what it does.>
Key files: <list>.
Focus on:
- <PR-specific concern 1>
- <PR-specific concern 2>
- <any known integration/ordering issue>

OUTPUT FORMAT:
- One-line verdict: APPROVE or REQUEST CHANGES.
- Findings tagged Critical / (required) / Optional / Nit / FYI with file:line refs
  and concrete fixes. Only list axes with findings. Be direct; no rubber-stamping.
```
