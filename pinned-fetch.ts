import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { createPinnedLookup, type PinnedAddress } from "./egress-guard.ts";

/**
 * A `fetch` whose socket can only land on addresses the egress guard approved.
 *
 * Node's global `fetch` resolves the hostname again on its own, so a check
 * whose name answers privately for the guard's lookup and publicly a moment
 * later (DNS rebinding, a zero-TTL record the check's author controls) is
 * dialled at the public address. For an ordinary check that costs a reading.
 * For a check carrying a credential resolved on this machine it would hand
 * the credential to whoever owns the name, so `check-http.ts` sends every
 * credentialed request through this instead.
 *
 * Built on `node:http`/`node:https` with the same `lookup` replay
 * `check-tcp.ts` uses. TLS still verifies the certificate against the
 * hostname in the URL (that is the SNI name and the name checked), so the pin
 * changes where the socket goes and nothing about what it trusts.
 *
 * It implements exactly the slice of `fetch` `runHttpCheck` uses: one request,
 * `redirect: "manual"` semantics (a 3xx is returned, never followed), request
 * headers as a plain object, an abort signal, and a streamed body decoded the
 * way `fetch` decodes it (gzip, deflate, br). Failures reject the way `fetch`
 * rejects, a `TypeError` whose `cause` carries the socket error's code, so
 * `describeFetchError` reads them unchanged.
 */
export function createPinnedFetch(pinned: readonly PinnedAddress[]): typeof fetch {
  const lookup = createPinnedLookup(pinned);
  return ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const transport = url.protocol === "https:" ? https : http;
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {
      "accept-encoding": "gzip, deflate, br",
      ...(init.headers as Record<string, string> | undefined),
    };
    return new Promise<Response>((resolve, reject) => {
      const fail = (err: unknown) => reject(Object.assign(new TypeError("fetch failed"), { cause: err }));
      let req: http.ClientRequest;
      try {
        req = transport.request(
          url,
          // agent: false, so no pooled socket from another check (resolved
          // some other way) can ever carry this request.
          { method, headers, lookup: lookup as never, signal: init.signal ?? undefined, agent: false },
          (res) => {
            try {
              resolve(toResponse(res, method));
            } catch (err) {
              res.destroy();
              fail(err);
            }
          },
        );
      } catch (err) {
        fail(err);
        return;
      }
      req.on("error", fail);
      req.end();
    });
  }) as typeof fetch;
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function toResponse(res: http.IncomingMessage, method: string): Response {
  const status = res.statusCode ?? 0;
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) {
      try {
        headers.append(name, one);
      } catch {
        // A header value `Headers` refuses is one `fetch` would refuse too;
        // the reading does not depend on it.
      }
    }
  }
  if (NULL_BODY_STATUSES.has(status) || method === "HEAD") {
    res.resume();
    return new Response(null, { status, statusText: res.statusMessage, headers });
  }
  const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  let body: Readable = res;
  if (encoding === "gzip" || encoding === "x-gzip") body = res.pipe(zlib.createGunzip());
  else if (encoding === "deflate") body = res.pipe(zlib.createInflate());
  else if (encoding === "br") body = res.pipe(zlib.createBrotliDecompress());
  if (body !== res) {
    // A decoder that fails ends the body with an error instead of hanging it.
    res.on("error", (err) => body.destroy(err));
  }
  return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
    status,
    statusText: res.statusMessage,
    headers,
  });
}
