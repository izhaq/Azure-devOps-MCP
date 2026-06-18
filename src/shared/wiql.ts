/**
 * WIQL (Work Item Query Language) builder for the task-level work-items tools.
 *
 * The point of this helper is that the *harness* authors WIQL, never the model.
 * It encodes the matching rules that a weak model gets wrong when left to write
 * raw WIQL:
 *  - "my" tickets use the server-side `@Me` macro, so the model never types a
 *    username and bilingual (Hebrew+English) identity strings never matter.
 *  - human-entered / identity fields default to `CONTAINS` (substring), never a
 *    strict `=`, because exact equality on a display string is the exact failure
 *    we are fixing. Strict `=` is offered only for callers that have already
 *    resolved a value (e.g. the `@Me` path is separate).
 *  - state filtering defaults to an "open" set and is overridable.
 *
 * Source: https://learn.microsoft.com/en-us/azure/devops/boards/queries/wiql-syntax
 */

/** States treated as "closed" when the caller asks for open items by default. */
const DEFAULT_CLOSED_STATES = ["Closed", "Done", "Removed", "Resolved", "Completed"];

export interface WorkItemQueryOptions {
  /** Restrict to the caller's own items via the `@Me` macro. Wins over `assignedTo`. */
  mine?: boolean;
  /** Match on `System.AssignedTo`. `contains` (default) is substring; `equals` is strict. */
  assignedTo?: { value: string; match?: "contains" | "equals" };
  /** Explicit state set → `IN (...)`. Omit for the default "open" set. */
  states?: string[];
  /** Skip state filtering entirely. */
  allStates?: boolean;
  /** Substring match on `System.Title`. */
  titleContains?: string;
}

/** Escape a value for a single-quoted WIQL string literal. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build a `SELECT [System.Id] FROM WorkItems WHERE …` WIQL string. Only ids are
 * selected; the heavy field payload is fetched separately via `workItemsBatch`
 * with an explicit projection, keeping this query cheap and the result compact.
 */
export function buildWorkItemQuery(options: WorkItemQueryOptions = {}): string {
  const conditions: string[] = [];

  if (options.mine) {
    conditions.push("[System.AssignedTo] = @Me");
  } else if (options.assignedTo) {
    const op = options.assignedTo.match === "equals" ? "=" : "CONTAINS";
    conditions.push(`[System.AssignedTo] ${op} ${quote(options.assignedTo.value)}`);
  }

  if (!options.allStates) {
    if (options.states && options.states.length > 0) {
      conditions.push(`[System.State] IN (${options.states.map(quote).join(", ")})`);
    } else {
      conditions.push(`[System.State] NOT IN (${DEFAULT_CLOSED_STATES.map(quote).join(", ")})`);
    }
  }

  if (options.titleContains) {
    conditions.push(`[System.Title] CONTAINS ${quote(options.titleContains)}`);
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  return `SELECT [System.Id] FROM WorkItems${where} ORDER BY [System.ChangedDate] DESC`;
}
