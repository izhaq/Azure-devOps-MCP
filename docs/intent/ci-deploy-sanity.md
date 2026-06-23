# Intent: Agent-driven deploy + sanity for feature branches

> Output of an `interview-me` session (confirmed by the user). This is the
> source of truth for *what* we're building and *why*; the spec
> (`tasks/ci-deploy-sanity/spec.md`) is downstream and defines *how*.

## Confirmed intent

- **Outcome:** Close the deploy + sanity loop *inside this MCP* with four
  weak-LLM-friendly tools layered over the existing pipeline primitives:
  - `list_deploy_envs` — return the valid envs for the agent to **offer** the
    user; resolves from **config if set, else discovered** by reading the
    deploy pipeline's YAML and parsing the `env` parameter's `values:`.
  - `deploy_feature_branch(branch, env)` — run the deploy pipeline with the
    branch as source ref + `env` template parameter; return a short run handle.
  - `run_sanity(env)` — run the sanity pipeline against `env`; return a handle.
  - `pipeline_run_status(runId)` — `running / succeeded / failed`; on failure
    return only the failing step's log tail (curated, not the whole log).
- **User:** A dev driving the weak agent (Tabnine CLI), replacing the manual
  ADO-web-UI steps 2–3 of today's flow.
- **Why now:** The agent already handles work-items/PRs; deploy + sanity are
  the last manual gap in the loop.
- **Success:** Each action is one call returning a handle (no babysitting); the
  status check gives green/red + curated logs; env is **offered from a real
  source** (config or pipeline YAML) and **validated**; no hand-written
  WIQL/pipeline/log calls; no context flooding.
- **Constraint:** Weak LLM + weak harness + air-gapped; runs take minutes →
  trigger-then-check, never block; deploys hit **shared** team envs → env is
  human-chosen from the offered list (AI never auto-picks) and validated;
  org-specifics (deploy/sanity pipeline IDs, optional static env list) come
  from config.
- **Out of scope (v1):** Webhook / push "notify on finish" (v2 — needs an
  inbound receiver, impractical air-gapped for now); auto-chaining
  deploy→sanity into one call; a separate project; the AI auto-selecting an env
  without the user choosing.

## Decision: this project, not a new one

The mechanics (run a pipeline with branch + parameters, poll a run, pull the
failing step's logs, read a file from a repo) are generic Azure DevOps and sit
beside the existing `pipelines` tools. Only *data* is org-specific (pipeline
IDs, optional env list) and lives in config. A separate project isn't warranted.

## Today's manual flow (for reference)

1. Dev opens a PR (or just pushes a feature branch — PR optional).
2. Dev manually triggers, via the ADO web UI, a **deployment** of the feature
   branch into a selected env (one pipeline, ~14 envs chosen from a dropdown).
3. Dev manually triggers a **sanity** check on a specific env (usually the same
   env just deployed).

The dropdown's env values come from the deploy pipeline's YAML `parameters`.
