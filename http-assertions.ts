/**
 * Response assertions for http checks (Monitor Phase 4, feature 1 of 3;
 * the Monitor design notes). Today a check is up if the HTTP status is
 * acceptable; this module is the "and the body/headers prove it's actually
 * working" half, run on the customer's own machine.
 *
 * This is the AGENT half. `packages/checker/http-assertions.ts` is the
 * fleet's copy of the SAME evaluation rule. This program takes zero
 * workspace imports (see README.md and `wire-contract.test.ts`'s
 * "dependency hygiene" suite, which fails the build if that ever changes),
 * so it cannot import the fleet's module -- this file is a deliberate,
 * hand-kept duplicate instead. `http-assertions.test.ts` runs the same table
 * of test vectors `packages/checker/http-assertions.test.ts` runs, so a
 * change to one implementation that isn't mirrored in the other shows up as
 * a failing assertion rather than a silent divergence between how the fleet
 * and an agent judge the SAME check.
 *
 * The four assertion groups: (a) body contains/does-not-contain a literal
 * string with a case-sensitive toggle, (b) response header equals/contains,
 * (c) an HTTP status exact-or-range override, and (d) a JSON-path
 * equals/contains/exists (REA-176), evaluated through `./json-path.ts` --
 * this program's own duplicate of the shared path module.
 *
 * NO regex, still and permanently: a ReDoS surface running an untrusted,
 * customer-authored pattern. See `json-path.ts`'s header for why a path
 * expression is not the same bet.
 */

/** The response-body byte cap this feature reads under. Mirrors
 * `packages/checker/http-assertions.ts`'s `MAX_ASSERTION_BODY_BYTES`, which
 * in turn reuses `packages/db/outage-feed.ts`'s existing `MAX_FEED_BODY_BYTES`
 * -- "the checker's existing response-size limit," not a new ceiling picked
 * for this feature. This program cannot import either of those (zero
 * workspace imports), so the literal is duplicated here; `http-assertions.
 * test.ts` pins it to the same value. */
export const MAX_ASSERTION_BODY_BYTES = 262_144;

import { evaluateJsonAssertion, type JsonAssertionOp } from "./json-path.ts";

export type AssertionBodyOp = "contains" | "not_contains";
export type AssertionHeaderOp = "equals" | "contains";

/** Mirrors `AgentCheck`'s assertion fields (types.ts). Callers pass a check
 * directly. */
export interface HttpAssertionConfig {
  assertionBodyOp?: AssertionBodyOp | null;
  assertionBodyValue?: string | null;
  assertionBodyCaseSensitive?: boolean | null;
  assertionHeaderName?: string | null;
  assertionHeaderOp?: AssertionHeaderOp | null;
  assertionHeaderValue?: string | null;
  assertionStatusMin?: number | null;
  assertionStatusMax?: number | null;
  assertionJsonPath?: string | null;
  assertionJsonOp?: JsonAssertionOp | null;
  assertionJsonValue?: string | null;
}

/** Whether this check has ANY assertion configured. */
export function hasHttpAssertions(config: HttpAssertionConfig): boolean {
  return (
    (config.assertionBodyOp ?? null) !== null ||
    (config.assertionHeaderOp ?? null) !== null ||
    (config.assertionStatusMin ?? null) !== null ||
    (config.assertionJsonOp ?? null) !== null
  );
}

/** Whether evaluating this config could require the response body. A body
 * assertion needs it, and so does a JSON-path assertion, which parses that
 * same body. */
export function needsAssertionBody(config: HttpAssertionConfig): boolean {
  return (config.assertionBodyOp ?? null) !== null || (config.assertionJsonOp ?? null) !== null;
}

export interface HttpAssertionInput {
  status: number;
  /** Whether the DEFAULT (2xx) up/down rule would call this response up.
   * Only consulted when no status override is configured. */
  nativeOk: boolean;
  /** Case-insensitive response header lookup. Returns null when the header
   * was not present. */
  getHeader: (name: string) => string | null;
  /** Read up to `MAX_ASSERTION_BODY_BYTES` of the response body as text, or
   * null when it was never read. */
  bodyText: string | null;
  bodyTruncated: boolean;
}

export interface HttpAssertionResult {
  ok: boolean;
  /** Present only on failure, and only when this module produced the
   * failure. Always starts with "Assertion failed: " -- a stable,
   * content-free prefix a public-facing classifier (if this program ever
   * grows one) could match before generic keyword heuristics, the same
   * reason `packages/checker/friendly-error.ts` matches it on the fleet
   * side. When the default (non-overridden) status rule failed, `error` is
   * undefined and the caller keeps its own existing status-failure message. */
  error?: string;
}

/**
 * The one evaluation rule, run identically by every installed agent and the
 * fleet (packages/checker/http-assertions.ts). See that file's doc comment
 * for the full reasoning on evaluation order (status, then body, then
 * header) and why a failing status short-circuits before body/header are
 * ever evaluated -- this function's body is a line-for-line mirror of it.
 */
export function evaluateHttpAssertions(
  config: HttpAssertionConfig,
  input: HttpAssertionInput,
): HttpAssertionResult {
  const statusMin = config.assertionStatusMin ?? null;
  const statusMax = config.assertionStatusMax ?? null;
  const statusOk = statusMin !== null ? input.status >= statusMin && input.status <= (statusMax as number) : input.nativeOk;

  if (!statusOk) {
    if (statusMin !== null) {
      const range = statusMin === statusMax ? `${statusMin}` : `${statusMin}-${statusMax}`;
      return { ok: false, error: `Assertion failed: expected status ${range}, got ${input.status}` };
    }
    return { ok: false };
  }

  const bodyOp = config.assertionBodyOp ?? null;
  if (bodyOp !== null) {
    const caseSensitive = config.assertionBodyCaseSensitive ?? true;
    const value = config.assertionBodyValue as string;
    const haystack = input.bodyText ?? "";
    const needle = caseSensitive ? value : value.toLowerCase();
    const searchable = caseSensitive ? haystack : haystack.toLowerCase();
    const found = searchable.includes(needle);
    if (bodyOp === "contains" && !found) {
      return { ok: false, error: `Assertion failed: body is missing "${value}"` };
    }
    if (bodyOp === "not_contains" && found) {
      return { ok: false, error: `Assertion failed: body still contains "${value}"` };
    }
  }

  const headerOp = config.assertionHeaderOp ?? null;
  if (headerOp !== null) {
    const name = config.assertionHeaderName as string;
    const expected = config.assertionHeaderValue as string;
    const actual = input.getHeader(name);
    if (actual === null) {
      return { ok: false, error: `Assertion failed: header "${name}" was not present` };
    }
    if (headerOp === "equals" && actual !== expected) {
      return { ok: false, error: `Assertion failed: header "${name}" was "${actual}", expected "${expected}"` };
    }
    if (headerOp === "contains" && !actual.includes(expected)) {
      return { ok: false, error: `Assertion failed: header "${name}" did not contain "${expected}"` };
    }
  }

  // JSON path last, matching the fleet's order (see
  // `packages/checker/http-assertions.ts`): it is the most expensive of the
  // four, and there is no reason to parse a body when a cheaper assertion has
  // already decided the check is down.
  //
  // The wire contract is camelCase while `evaluateJsonAssertion` takes the
  // column-shaped snake_case names, so the three fields are mapped here
  // rather than by giving this program a divergent copy of that module. The
  // duplicate in `./json-path.ts` stays byte-for-byte identical to
  // `packages/db/json-path.ts` below its header, which is what makes the
  // shared test vectors able to pin the two.
  const jsonOp = config.assertionJsonOp ?? null;
  if (jsonOp !== null) {
    const json = evaluateJsonAssertion(
      {
        assertion_json_path: config.assertionJsonPath ?? null,
        assertion_json_op: jsonOp,
        assertion_json_value: config.assertionJsonValue ?? null,
      },
      input.bodyText,
      input.bodyTruncated,
      MAX_ASSERTION_BODY_BYTES,
    );
    if (!json.ok) {
      return { ok: false, error: `Assertion failed: ${json.reason}` };
    }
  }

  return { ok: true };
}

/**
 * Reads up to `maxBytes` of a response body as text, bounded and streaming.
 * `controller.abort()` (never an awaited `reader.cancel()`) tears the
 * connection down immediately once the cap is hit -- the same reason
 * `check-http.ts`'s status-only path aborts rather than gracefully cancels: a
 * peer that sends headers and then stalls mid-body would leave an awaited
 * cancel pending forever.
 */
export async function readAssertionBody(
  res: Response,
  controller: AbortController,
  maxBytes: number = MAX_ASSERTION_BODY_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };

  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: false });
      truncated = true;
      controller.abort();
      void reader.cancel().catch(() => {});
      break;
    }
    text += decoder.decode(value, { stream: true });
    total += value.byteLength;
  }
  text += decoder.decode();
  return { text, truncated };
}
