import {
  evaluateHttpAssertions,
  hasHttpAssertions,
  needsAssertionBody,
  readAssertionBody,
  type HttpAssertionConfig,
} from "./http-assertions.ts";

/**
 * The http check, run from inside the customer's network.
 *
 * ## No SSRF guard here, on purpose
 *
 * The cloud fleet (`packages/checker`) refuses private addresses, because a
 * customer could otherwise point our probes at our own internals or at someone
 * else's. That reasoning does not transfer: this process runs on hardware the
 * customer owns, was started by the customer, and exists precisely to reach
 * `10.0.3.14:8080`. Blocking private addresses here would block the product.
 *
 * What that removes is the address blocklist. Everything else the fleet probe
 * does for its own safety is kept, because those were never about SSRF:
 *
 * - A hard total deadline, so a stalled target cannot pin a scheduler slot.
 * - The body is never buffered UNLESS a response assertion needs it (Monitor
 *   Phase 4), and even then only up to `MAX_ASSERTION_BODY_BYTES`
 *   (http-assertions.ts) -- never the whole thing. A check with no
 *   assertions configured still never reads the body at all, exact prior
 *   behavior: the status line is all it needs, and a private target's body
 *   is customer data we have no business holding beyond what the customer
 *   explicitly asked this check to look for.
 * - Redirects are followed manually, capped, and only to http/https. An
 *   internal service redirecting to `file:///etc/shadow` is a real shape, and
 *   `fetch` with `redirect: "follow"` would happily chase whatever it got.
 */

export const MAX_REDIRECTS = 3;
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The up/down rule, behind a mutable holder so `check-http.test.ts` can swap in
 * a broken one and prove the assertion that depends on it actually fails. A
 * bare `const` would be untestable in that way, and a guard nobody has watched
 * fail is decoration. Only consulted when a check has no status-override
 * assertion configured -- see `runHttpCheck`.
 */
export const httpRules = {
  isUp: (status: number): boolean => status >= 200 && status < 300,
};

export interface HttpOutcome {
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  error?: string;
}

export async function runHttpCheck(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
  /** Response assertions (Monitor Phase 4). Omitted, or a check with no
   * assertion field set, means exact prior behavior: the body is never read
   * and only the status line (via `httpRules.isUp`) decides up/down. */
  assertions?: HttpAssertionConfig,
): Promise<HttpOutcome> {
  const withAssertions = assertions && hasHttpAssertions(assertions) ? assertions : undefined;
  const started = Date.now();
  // One deadline for the WHOLE chain, not per hop: three redirects each
  // sitting just under a per-hop timeout is the classic way a "10 second"
  // check spends forty.
  const deadline = started + timeoutMs;

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, latencyMs: Date.now() - started, error: "The request timed out" };
    }

    let target: URL;
    try {
      target = new URL(current);
    } catch {
      return { ok: false, latencyMs: Date.now() - started, error: "Invalid URL" };
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      const label = hop === 0 ? "Unsupported monitor target" : "Unsupported redirect target";
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: `${label}: ${target.protocol.replace(":", "")} is not http or https`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let res: Response;
    try {
      res = await fetchImpl(target.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "RealUptime-Monitor-Agent" },
      });
    } catch (err) {
      const latencyMs = Date.now() - started;
      if (controller.signal.aborted) {
        return { ok: false, latencyMs, error: "The request timed out" };
      }
      return { ok: false, latencyMs, error: describeFetchError(err) };
    } finally {
      clearTimeout(timer);
    }

    const status = res.status;
    if (status >= 300 && status < 400) {
      const location = res.headers.get("location");
      if (location) {
        // A real redirect hop: never reads the body, assertions or not -- an
        // assertion is evaluated against the FINAL response, not an
        // intermediate hop. The cancel() promise is deliberately NOT
        // awaited -- a server that returns headers and then stalls mid-body
        // would leave that await pending forever, which is the exact stall
        // this whole function is shaped to avoid.
        void res.body?.cancel().catch(() => {});
        if (hop === MAX_REDIRECTS) {
          return { ok: false, statusCode: status, latencyMs: Date.now() - started, error: "Too many redirects" };
        }
        try {
          current = new URL(location, target).toString();
        } catch {
          return {
            ok: false,
            statusCode: status,
            latencyMs: Date.now() - started,
            error: "Invalid redirect location",
          };
        }
        continue;
      }
      // A 3xx with no Location is not a redirect anyone can follow, so it
      // falls through to the terminal handling below, judged on its own
      // merits like any other status -- including, now, its assertions. The
      // body has NOT been cancelled yet at this point.
    }

    // Terminal response (not a redirect, or a 3xx with nowhere to go).
    const nativeOk = httpRules.isUp(status);
    const statusOk =
      withAssertions?.assertionStatusMin != null
        ? status >= withAssertions.assertionStatusMin && status <= (withAssertions.assertionStatusMax as number)
        : nativeOk;
    const readBody = statusOk && withAssertions !== undefined && needsAssertionBody(withAssertions);

    let bodyText: string | null = null;
    let bodyTruncated = false;
    if (readBody) {
      const result = await readAssertionBody(res, controller);
      bodyText = result.text;
      bodyTruncated = result.truncated;
    } else {
      void res.body?.cancel().catch(() => {});
    }

    const latencyMs = Date.now() - started;
    if (withAssertions === undefined) {
      // Exact prior behavior: no assertions configured, nothing evaluated.
      return nativeOk
        ? { ok: true, statusCode: status, latencyMs }
        : { ok: false, statusCode: status, latencyMs, error: `Unexpected status ${status}` };
    }

    const evaluated = evaluateHttpAssertions(withAssertions, {
      status,
      nativeOk,
      getHeader: (name) => res.headers.get(name),
      bodyText,
      bodyTruncated,
    });
    if (!evaluated.ok) {
      // evaluated.error is undefined when the default (non-overridden)
      // status rule is what failed -- fall back to this function's own
      // pre-existing status-failure message, unchanged.
      return { ok: false, statusCode: status, latencyMs, error: evaluated.error ?? `Unexpected status ${status}` };
    }
    return { ok: true, statusCode: status, latencyMs };
  }

  return { ok: false, latencyMs: Date.now() - started, error: "Too many redirects" };
}

/**
 * Node's fetch collapses connection and TLS failures into a bare
 * `TypeError: fetch failed`, with the distinguishing code hidden on
 * `err.cause`. Without this the customer sees "fetch failed" for a refused
 * connection, an expired certificate and an unresolvable name alike, which are
 * three completely different things to go fix.
 *
 * Only the error CODE is surfaced, never a message from the target's body.
 */
function describeFetchError(err: unknown): string {
  const cause = (err as { cause?: unknown })?.cause;
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code: unknown }).code)
      : undefined;
  const message = err instanceof Error ? err.message : String(err);
  return code ? `${message} (${code})` : message;
}
