import type { Logger } from "../logger.js";
import { buildBasicAuthHeader } from "./auth.js";
import { adoErrorFromResponse } from "./errors.js";

export interface AzureClientOptions {
  serverUrl: string;
  collection: string;
  apiVersion: string;
  pat: string;
  timeoutMs: number;
  pageSize: number;
  maxResults: number;
  /** Injectable for testing; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export type QueryValue = string | number | boolean | undefined;

/**
 * Clamp a caller's requested result count to `[0, maxResults]`.
 *
 * A caller's `top` is intent ("give me at most N"); the configured
 * `maxResults` is a hard ceiling that protects memory and payload size. When
 * `requested` is omitted the ceiling itself becomes the limit. Shared by
 * `getAll` and by list tools that bound results client-side, so every list
 * path applies the same `min(requested ?? maxResults, maxResults)` rule.
 */
export function boundLimit(requested: number | undefined, maxResults: number): number {
  return Math.min(Math.max(requested ?? maxResults, 0), maxResults);
}

export interface RequestOptions {
  project?: string;
  query?: Record<string, QueryValue>;
  /**
   * Per-call override of the configured `api-version`. Needed for endpoints
   * that are only available under a preview version (e.g. collection-wide
   * "Get All Teams" requires `7.1-preview.3`).
   */
  apiVersion?: string;
  /**
   * Extra request headers (e.g. `If-Match` for wiki page edits). Cannot
   * override `Authorization` or `Accept`, which the client always controls.
   */
  headers?: Record<string, string>;
}

/**
 * Thin REST client for Azure DevOps Server (on-prem).
 *
 * URL structure (Azure DevOps Server):
 *   {serverUrl}/{collection}/{project?}/_apis/{area}/{resource}?api-version={version}
 * Source: https://learn.microsoft.com/en-us/azure/devops/integrate/how-to/call-rest-api#url-structure
 */
export class AzureDevOpsClient {
  private readonly opts: AzureClientOptions;
  private readonly doFetch: typeof fetch;
  /** Cache for `getAuthenticatedIdentity` within this client's lifetime. */
  private cachedIdentity?: { displayName?: string } | null;

  constructor(opts: AzureClientOptions) {
    this.opts = opts;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, undefined, options);
  }

  async post<T>(
    path: string,
    body: unknown,
    options: RequestOptions = {},
    contentType = "application/json",
  ): Promise<T> {
    return this.request<T>("POST", path, body, options, contentType);
  }

  async patch<T>(
    path: string,
    body: unknown,
    options: RequestOptions = {},
    contentType = "application/json",
  ): Promise<T> {
    return this.request<T>("PATCH", path, body, options, contentType);
  }

  /**
   * Perform a request and return both the parsed body and the response `ETag`.
   * Used by endpoints that drive optimistic concurrency through ETags — e.g.
   * Azure DevOps wiki pages, whose version is returned only in the `ETag`
   * header and must be echoed back via `If-Match` to edit the page.
   */
  async requestWithEtag<T>(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions = {},
    contentType = "application/json",
  ): Promise<{ data: T; etag?: string }> {
    const { body: parsed, headers } = await this.requestRaw(method, path, body, options, contentType);
    return { data: parsed as T, etag: headers.get("etag") ?? undefined };
  }

  /**
   * Fetch every item of a paged list endpoint, following the
   * `x-ms-continuationtoken` response header.
   *
   * The total number of items returned is bounded by `limit` (the caller's
   * intent, e.g. a tool's `top` argument) and hard-capped at the configured
   * `maxResults`. The caller's own `$top` in `options.query` is ignored —
   * `getAll` derives the per-page `$top` from the remaining budget so paging
   * never overshoots the cap.
   */
  async getAll<T>(
    path: string,
    options: RequestOptions = {},
    limit = this.opts.maxResults,
  ): Promise<T[]> {
    const cap = boundLimit(limit, this.opts.maxResults);
    const callerQuery = { ...options.query };
    delete callerQuery.$top;

    const items: T[] = [];
    let continuationToken: string | undefined;
    let previousToken: string | undefined;
    do {
      const remaining = cap - items.length;
      if (remaining <= 0) break;
      const query: Record<string, QueryValue> = {
        ...callerQuery,
        $top: Math.min(this.opts.pageSize, remaining),
        continuationToken,
      };
      const { body, headers } = await this.requestRaw("GET", path, undefined, {
        ...options,
        query,
      });
      const page = (body as { value?: T[] } | undefined)?.value ?? [];
      for (const item of page) {
        if (items.length >= cap) break;
        items.push(item);
      }
      previousToken = continuationToken;
      continuationToken = headers.get("x-ms-continuationtoken") ?? undefined;
      // Safety valves against a non-advancing server: stop if a page added
      // nothing or if the continuation token did not change.
      if (page.length === 0 || continuationToken === previousToken) break;
    } while (continuationToken);
    return items;
  }

  /**
   * Fetch a projection of many work items in one call via
   * `POST /_apis/wit/workitemsbatch`. `fields` is an explicit allow-list and
   * deliberately excludes `System.Description` so list output stays compact;
   * `fields` and `$expand=relations` are mutually exclusive server-side, and a
   * thin list never needs relations. Ids beyond ADO's 200-per-batch limit are
   * chunked transparently and the results concatenated in order.
   * Source: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-items-batch
   */
  async workItemsBatch<T>(ids: number[], fields: string[]): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      if (chunk.length === 0) continue;
      const body = await this.post<{ value?: T[] }>("/_apis/wit/workitemsbatch", {
        ids: chunk,
        fields,
      });
      out.push(...(body?.value ?? []));
    }
    return out;
  }

  /**
   * Best-effort resolution of a display name to the server's canonical identity
   * display name, so a caller can match `System.AssignedTo` using the server's
   * own spelling rather than whatever (possibly bilingual) string the model
   * typed. Returns `undefined` on no match or any error — callers fall back to
   * matching the raw input, so identity resolution never breaks the tool.
   *
   * NOTE (on-prem — verify live): the identity search route/version varies by
   * Azure DevOps Server build; this uses the classic Identities read endpoint.
   * Source: https://learn.microsoft.com/en-us/rest/api/azure/devops/ims/identities/read-identities
   */
  async resolveIdentity(name: string): Promise<string | undefined> {
    try {
      const result = await this.get<{ value?: Array<Record<string, unknown>> }>(
        "/_apis/identities",
        { query: { searchFilter: "General", filterValue: name } },
      );
      const candidates = result?.value ?? [];
      if (candidates.length === 0) return undefined;
      const displayOf = (c: Record<string, unknown>): string | undefined =>
        (c["providerDisplayName"] ?? c["displayName"]) as string | undefined;
      // A "General" search is fuzzy and can return several identities. Prefer
      // one that case-insensitively matches the input on a stable field, so an
      // ambiguous name doesn't silently resolve to an arbitrary person; fall
      // back to the first result only when nothing matches exactly.
      const needle = name.trim().toLowerCase();
      const exact = candidates.find((c) =>
        [displayOf(c), c["displayName"], c["mailAddress"], c["mail"], c["uniqueName"]]
          .some((v) => typeof v === "string" && v.toLowerCase() === needle),
      );
      const display = displayOf(exact ?? candidates[0]!);
      return display && display.length > 0 ? display : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Best-effort resolution of the authenticated user (the PAT owner) to the
   * server's canonical display name, via the collection `connectionData`
   * endpoint. Used to default a new work item's assignee to "@Me". Cached for
   * this client's lifetime; returns `undefined` on any error so callers never
   * block on it.
   * Source: https://learn.microsoft.com/en-us/rest/api/azure/devops/core/connection-data
   */
  async getAuthenticatedIdentity(): Promise<{ displayName?: string } | undefined> {
    if (this.cachedIdentity !== undefined) return this.cachedIdentity ?? undefined;
    try {
      const data = await this.get<{
        authenticatedUser?: { providerDisplayName?: string; customDisplayName?: string };
      }>("/_apis/connectionData");
      const user = data?.authenticatedUser;
      const displayName = user?.customDisplayName ?? user?.providerDisplayName;
      this.cachedIdentity = displayName ? { displayName } : null;
    } catch {
      this.cachedIdentity = null;
    }
    return this.cachedIdentity ?? undefined;
  }

  /**
   * List a work item type's fields (with allowed values) for a project. Used to
   * discover required fields + pick-lists when creating a work item, so the
   * harness can auto-fill or offer choices instead of guessing.
   * Source: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-item-types-field/list
   */
  async getWorkItemTypeFields(
    project: string,
    type: string,
  ): Promise<
    Array<{
      referenceName: string;
      name?: string;
      alwaysRequired?: boolean;
      allowedValues?: string[];
      defaultValue?: unknown;
    }>
  > {
    const res = await this.get<{ value?: Array<Record<string, unknown>> }>(
      `/_apis/wit/workitemtypes/${encodeURIComponent(type)}/fields`,
      { project, query: { $expand: "allowedValues" } },
    );
    return (res?.value ?? []).map((f) => ({
      referenceName: String(f["referenceName"] ?? ""),
      name: f["name"] as string | undefined,
      alwaysRequired: f["alwaysRequired"] as boolean | undefined,
      allowedValues: Array.isArray(f["allowedValues"]) ? (f["allowedValues"] as string[]) : undefined,
      defaultValue: f["defaultValue"],
    }));
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
    contentType?: string,
  ): Promise<T> {
    const { body: parsed } = await this.requestRaw(method, path, body, options, contentType);
    return parsed as T;
  }

  private async requestRaw(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
    contentType = "application/json",
  ): Promise<{ body: unknown; headers: Headers }> {
    const url = this.buildUrl(path, options);
    const headers: Record<string, string> = {
      ...options.headers,
      Authorization: buildBasicAuthHeader(this.opts.pat),
      Accept: "application/json",
    };
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    };
    if (body !== undefined) {
      headers["Content-Type"] = contentType;
      init.body = JSON.stringify(body);
    }

    this.opts.logger?.debug(`ADO ${method} ${path}`, { project: options.project });
    const response = await this.doFetch(url, init);

    if (response.status === 204) {
      return { body: undefined, headers: response.headers };
    }
    if (!response.ok) {
      const text = await response.text();
      throw adoErrorFromResponse(response.status, text);
    }
    const text = await response.text();
    const data = text.length > 0 ? JSON.parse(text) : undefined;
    return { body: data, headers: response.headers };
  }

  private buildUrl(path: string, options: RequestOptions): string {
    const base = trimTrailingSlash(this.opts.serverUrl);
    const segments = [base, encodeURIComponent(this.opts.collection)];
    if (options.project) {
      segments.push(encodeURIComponent(options.project));
    }
    const prefix = segments.join("/");
    const url = new URL(`${prefix}${ensureLeadingSlash(path)}`);

    url.searchParams.set("api-version", options.apiVersion ?? this.opts.apiVersion);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}
