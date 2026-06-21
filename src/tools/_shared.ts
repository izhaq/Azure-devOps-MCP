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
