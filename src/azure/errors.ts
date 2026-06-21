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
 * Map of known TF/VS error code patterns to plain-language remediation hints.
 * A weak model sees "TF401495" and has no idea what to do; appending a hint
 * tells it which tool to use to recover.
 */
const ADO_ERROR_HINTS: Array<[RegExp, string]> = [
  [
    /TF401495/,
    "The iteration path does not exist in this project. Use work_list_iterations to find valid iteration paths.",
  ],
  [
    /TF400499/,
    "The team or project was not found. Check the project name and team name with core_list_projects and core_list_teams.",
  ],
  [
    /TF200016/,
    "The work item type does not exist in this project. Use wit_list_types to see available types.",
  ],
  [
    /VS402335|TF401349/,
    "Access denied. Your PAT may lack the required scope, or you do not have permission for this operation.",
  ],
  [/TF401232/, "The repository was not found. Use repo_list to see available repositories."],
  [/TF401019/, "The branch was not found. Use repo_list_branches to see available branches."],
  [
    /TF400898/,
    "Completing this pull request failed because of a policy violation (e.g. required reviewers, linked work items).",
  ],
  [
    /TF401003|TF401004/,
    "Authentication failed. Check that your PAT is valid and has not expired.",
  ],
  [
    /TF26027/,
    "The field reference name is not valid for this work item type. Use wit_list_types or see the ADO field reference name list.",
  ],
];

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

  // Append a remediation hint when the message carries a known error code.
  for (const [pattern, hint] of ADO_ERROR_HINTS) {
    if (pattern.test(message)) {
      message = `${message} — Hint: ${hint}`;
      break;
    }
  }

  return new AdoApiError(status, `Azure DevOps API error ${status}: ${message}`, details);
}
