/** Error thrown when the Azure DevOps REST API returns a non-2xx response. */
export class AdoApiError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "AdoApiError";
    this.status = status;
    this.details = details;
  }
}

/**
 * Map a failed REST response into an AdoApiError.
 * Azure DevOps error bodies are usually JSON of the shape `{ message, typeKey, ... }`.
 */
export function adoErrorFromResponse(status: number, bodyText: string): AdoApiError {
  let message = bodyText?.trim() || `HTTP ${status}`;
  let details: unknown = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as { message?: string };
    if (parsed && typeof parsed.message === "string" && parsed.message.length > 0) {
      message = parsed.message;
    }
    details = parsed;
  } catch {
    // body was not JSON — keep the raw text
  }
  return new AdoApiError(status, `Azure DevOps API error ${status}: ${message}`, details);
}
