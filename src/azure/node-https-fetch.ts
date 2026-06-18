import * as https from "node:https";
import * as http from "node:http";

/**
 * A fetch-compatible implementation backed by Node's built-in https/http
 * modules instead of undici (Node's native fetch engine).
 *
 * Why this exists: undici has a hard 10-second TCP/TLS connect timeout that
 * fires before AbortSignal.timeout() gets a chance to work. On corporate
 * networks where internal ADO Server TLS handshakes are slow this causes every
 * tool call to fail with a generic "fetch failed". Node's https.request has no
 * such internal connect limit, so it waits for the full ADO_TIMEOUT_MS budget.
 *
 * This implementation covers exactly what AzureDevOpsClient needs:
 * - GET / POST / PATCH with a text body
 * - Response status, ok, text(), and headers (ETag, x-ms-continuationtoken)
 * - AbortSignal support (used for ADO_TIMEOUT_MS)
 * - NODE_TLS_REJECT_UNAUTHORIZED and NODE_EXTRA_CA_CERTS are honoured
 *   automatically because Node's tls stack reads those env vars at runtime.
 */
export function createNodeHttpsFetch(): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url,
    );

    // Collect headers into a plain object for http.request
    const reqHeaders: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          reqHeaders[k] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers as [string, string][]) {
          reqHeaders[k] = v;
        }
      } else {
        Object.assign(reqHeaders, init.headers);
      }
    }

    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? null;
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: (init?.method ?? "GET").toUpperCase(),
        headers: reqHeaders,
      };

      const lib: typeof https = url.protocol === "https:" ? https : (http as unknown as typeof https);
      const req = lib.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;

          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            if (Array.isArray(v)) {
              for (const item of v) responseHeaders.append(k, item);
            } else {
              responseHeaders.set(k, v);
            }
          }

          resolve(
            new Response(status === 204 ? null : bodyText, {
              status,
              headers: responseHeaders,
            }),
          );
        });
        res.on("error", reject);
      });

      req.on("error", reject);

      if (signal) {
        const onAbort = () => {
          req.destroy(new DOMException("Aborted", "AbortError"));
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        req.on("close", () => signal.removeEventListener("abort", onAbort));
      }

      const body = init?.body;
      if (body !== undefined && body !== null) {
        req.write(typeof body === "string" ? body : String(body));
      }
      req.end();
    });
  };
}
