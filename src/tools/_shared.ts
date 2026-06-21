/** Helpers shared across tool domains. */

/**
 * Normalise a branch name to a full Git ref. Accepts either a short name
 * (`main`) or an already-qualified ref (`refs/heads/main`, `refs/...`).
 */
export function toRefName(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

/** The MCP tool result shape every formatter returns. */
export type ToolResult = { content: Array<{ type: "text"; text: string }> };

/** ADO reviewer vote integer → human-readable label (0 = no vote, omitted). */
const VOTE_LABELS = new Map<number, string>([
  [10, "approved"],
  [5, "approved with suggestions"],
  [-5, "waiting for author"],
  [-10, "rejected"],
]);

/**
 * Recursively clean an ADO API response for model consumption:
 * - Strip `_links` at every level (internal navigation URLs — never useful to the model).
 * - Flatten ADO identity objects (those that carry a `displayName` property) to just
 *   the display-name string, removing URL, GUID, uniqueName, imageUrl, and descriptor
 *   noise. Exception: PR reviewer objects also carry `vote`; when the vote is non-zero
 *   (i.e. not "no vote") it is appended as a readable label so approval state is
 *   preserved: e.g. `"Alice Smith (approved)"`.
 */
export function cleanAdo(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cleanAdo);

  const obj = value as Record<string, unknown>;

  // ADO identity object: has `displayName`. Reduce to name string (± vote label).
  if ("displayName" in obj) {
    const name = String(obj.displayName ?? "");
    if ("vote" in obj && typeof obj.vote === "number" && obj.vote !== 0) {
      const label = VOTE_LABELS.get(obj.vote) ?? String(obj.vote);
      return `${name} (${label})`;
    }
    return name;
  }

  // Non-identity object: strip `_links` and bare `url` string fields
  // (ADO uses `url` for internal REST API self-links — never useful to the model;
  // user-facing URLs appear as `webUrl`, `remoteUrl`, `sshUrl`, etc.).
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key === "_links") continue;
    if (key === "url" && typeof val === "string") continue;
    // Strip the `refs/heads/` prefix from Git ref name fields so a model sees
    // "main" rather than "refs/heads/main" in PR source/target branch fields.
    if (key.endsWith("RefName") && typeof val === "string" && val.startsWith("refs/heads/")) {
      result[key] = val.slice("refs/heads/".length);
      continue;
    }
    result[key] = cleanAdo(val);
  }
  return result;
}

/**
 * Apply {@link cleanAdo} then emit compact (no-indent) JSON. Use this on all
 * read paths: it strips ADO navigation noise and saves 30-50% tokens vs the
 * pretty-printed {@link asText}.
 */
export function asCleanText(data: unknown): ToolResult {
  return textResult(JSON.stringify(cleanAdo(data)));
}

/**
 * Wrap a plain string in the MCP tool result shape. Exported so size-guard
 * fallbacks in the domain tools build the same shape instead of re-declaring
 * the literal.
 */
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Wrap an arbitrary value in the MCP tool result shape: a single text block
 * holding the pretty-printed JSON. Centralised so every domain returns the
 * same output shape. Retained for create/update/metadata tools where the
 * full object is the answer; the high-volume list/detail paths use the
 * compact formatters below to stay within a small model's context window.
 */
export function asText(data: unknown): ToolResult {
  return textResult(JSON.stringify(data, null, 2));
}

/**
 * Like {@link asText} but without pretty-print indentation. Indentation and
 * repeated whitespace are pure token cost to a model; compact JSON keeps the
 * same information in ~30–50% fewer tokens. Use on paths a weak, small-context
 * model hits often.
 */
export function asCompactText(data: unknown): ToolResult {
  return textResult(JSON.stringify(data));
}

/**
 * Truncate a string to at most `max` characters of the original value,
 * followed by a short marker stating how many characters were dropped (so the
 * model knows the value was cut, not ended). The returned string is therefore
 * slightly longer than `max` by the marker length. Non-strings pass through.
 */
export function truncateField<T>(value: T, max: number): T | string {
  if (typeof value !== "string" || value.length <= max) return value;
  const dropped = value.length - max;
  return `${value.slice(0, max)} …[truncated ${dropped} chars]`;
}

/** A work item as returned by the WIQL→batch projection path. */
interface ProjectedWorkItem {
  id?: number;
  fields?: Record<string, unknown>;
}

/** Render an Azure DevOps identity field (object or string) to a name. */
function identityName(value: unknown): string {
  if (!value) return "Unassigned";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const v = value as { displayName?: string; uniqueName?: string };
    return v.displayName ?? v.uniqueName ?? "Unassigned";
  }
  return String(value);
}

/**
 * Render a projected work-item list as one compact line per ticket plus a
 * leading "showing N of M" line. This is the token-shaped replacement for
 * dumping full JSON objects: a small model gets exactly id, type, title,
 * state, and assignee — enough to pick the next action — and nothing else.
 *
 * `meta.total` is the pre-cap match count (from the WIQL result) so the line
 * can tell the model when results were capped and to refine or paginate.
 */
export function asTicketList(items: ProjectedWorkItem[], meta?: { total?: number }): ToolResult {
  const shown = items.length;
  const total = meta?.total ?? shown;
  const header =
    total > shown
      ? `Showing ${shown} of ${total} work items — refine your filter or raise "top" to see more.`
      : `Showing ${shown} work item${shown === 1 ? "" : "s"}.`;
  const lines = items.map((item) => {
    const f = item.fields ?? {};
    const id = item.id ?? f["System.Id"] ?? "?";
    const type = (f["System.WorkItemType"] as string) ?? "WorkItem";
    const title = (f["System.Title"] as string) ?? "(no title)";
    const state = (f["System.State"] as string) ?? "?";
    const assignee = identityName(f["System.AssignedTo"]);
    return `#${id} [${type}] ${title} — ${state} · ${assignee}`;
  });
  return textResult([header, ...lines].join("\n"));
}
