/** Helpers shared across tool domains. */

/**
 * Wrap an arbitrary value in the MCP tool result shape: a single text block
 * holding the pretty-printed JSON. Centralised so every domain returns the
 * same output shape.
 */
export function asText(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
