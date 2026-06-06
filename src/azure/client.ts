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

export interface RequestOptions {
  project?: string;
  query?: Record<string, QueryValue>;
  /**
   * Per-call override of the configured `api-version`. Needed for endpoints
   * that are only available under a preview version (e.g. collection-wide
   * "Get All Teams" requires `7.1-preview.3`).
   */
  apiVersion?: string;
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

  constructor(opts: AzureClientOptions) {
    this.opts = opts;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, undefined, options);
  }

  async post<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, body, options);
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
    const cap = Math.min(Math.max(limit, 0), this.opts.maxResults);
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
