/**
 * JSON-path assertions for http checks (REA-176; migrations/096), evaluated
 * on the customer's own machine for an agent-bound http check.
 *
 * This is the AGENT half. `packages/db/json-path.ts` is the same module for
 * the fleet and for save-time validation. This program takes zero workspace
 * imports (see README.md and `wire-contract.test.ts`'s "dependency hygiene"
 * suite, which fails the build if that ever changes), so it cannot import
 * that copy -- this file is a deliberate, hand-kept duplicate instead.
 * `json-path.test.ts` here runs the same table of test vectors
 * `packages/db/json-path.test.ts` runs, so a change to one implementation
 * that is not mirrored in the other shows up as a failing assertion rather
 * than a silent divergence between how the fleet and an agent judge the SAME
 * check.
 *
 * The duplicate is byte-for-byte identical below the header, which is
 * possible here and not for most modules because this one imports nothing at
 * all.
 *
 * ## Why this is not the regex we refused
 *
 * The ReDoS argument that killed regex does not reach this feature, and it
 * is worth being precise about why rather than asserting it.
 *
 * A regex is a customer-authored PROGRAM. Catastrophic backtracking makes
 * evaluation cost super-linear in the length of the input, so a check firing
 * every 60 seconds against a 256KB body can burn a probe process, and there
 * is no sandbox between "customer types a pattern" and "our fleet evaluates
 * it".
 *
 * A path expression is a customer-authored ADDRESS. `data.items[0].status`
 * is a finite list of literal key and index segments, walked exactly once
 * against an already-parsed object. Cost is O(number of segments) — bounded
 * below by MAX_PATH_SEGMENTS — and is independent of the size of the body.
 * There is no alternation, no repetition operator and no branch for a
 * customer to weaponise, because the grammar below has none.
 *
 * ## What is deliberately not supported
 *
 * Wildcards (`[*]`, `.*`), filter expressions (`[?(@.x > 1)]`) and recursive
 * descent (`$..name`) are the parts of the JSONPath standard that put SEARCH
 * — and, for filters, expression evaluation — back into what is otherwise a
 * lookup. All three are out.
 *
 * They are REFUSED rather than ignored. A parser that silently dropped a
 * `[*]` would evaluate a different assertion than the customer wrote and
 * report its result as though it were theirs, which is the worst outcome
 * available: a monitor that is confidently wrong. Every unsupported
 * construct returns a named error the form and the API surface show back.
 */

/** One resolved step of a path. */
export type JsonPathSegment = { kind: "key"; key: string } | { kind: "index"; index: number };

export type JsonPathParseResult =
  | { ok: true; segments: JsonPathSegment[] }
  | { ok: false; error: string };

/**
 * How many segments one path may have. A bound rather than a meaningful
 * limit: nothing legitimate nests 32 deep, and an unbounded segment count is
 * the only dimension of this grammar that a customer controls at all.
 */
export const MAX_PATH_SEGMENTS = 32;

/**
 * Parse a dot/bracket path into literal segments.
 *
 * Accepted grammar, in full:
 *
 *   - `foo`, `foo.bar`            object keys
 *   - `foo[0]`, `[0]`             array indices (non-negative integers)
 *   - `["foo.bar"]`, `['x']`      quoted keys, the escape hatch for a key
 *                                 that itself contains a dot or a bracket
 *   - a leading `$` is accepted and ignored, since it is what people type
 *
 * Everything else is an error with a message naming what was wrong.
 */
export function parseJsonPath(raw: string): JsonPathParseResult {
  const input = raw.trim();
  if (!input) {
    return { ok: false, error: "Enter a JSON path, for example data.status." };
  }

  // Recursive descent is checked before anything else so that `a..b` reports
  // the construct the customer actually typed rather than an empty-key error
  // from the generic dot handling below.
  if (input.includes("..")) {
    return {
      ok: false,
      error: 'Recursive descent (".." ) is not supported. Write the full path, for example data.items[0].status.',
    };
  }

  let i = 0;
  // A leading "$" is JSONPath convention for the document root. It is
  // accepted and contributes no segment, so "$.data.id" and "data.id" are the
  // same path.
  if (input[i] === "$") {
    i++;
    if (i < input.length && input[i] !== "." && input[i] !== "[") {
      return { ok: false, error: 'After "$", write a "." or a "[" .' };
    }
    if (input[i] === ".") i++;
  }

  const segments: JsonPathSegment[] = [];

  while (i < input.length) {
    if (segments.length >= MAX_PATH_SEGMENTS) {
      return { ok: false, error: `A JSON path can have at most ${MAX_PATH_SEGMENTS} segments.` };
    }

    if (input[i] === "[") {
      const close = input.indexOf("]", i);
      if (close === -1) {
        return { ok: false, error: 'Unclosed "[" in the path.' };
      }
      const inner = input.slice(i + 1, close);

      if (inner === "*") {
        return { ok: false, error: 'Wildcards ("[*]") are not supported. Name a specific index, for example [0].' };
      }
      if (inner.startsWith("?")) {
        return { ok: false, error: "Filter expressions are not supported. Name a specific index or key." };
      }
      if (inner === "") {
        return { ok: false, error: 'Empty "[]" in the path.' };
      }

      const quoted =
        (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) ||
        (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2);
      if (quoted) {
        const key = inner.slice(1, -1);
        if (!key) {
          return { ok: false, error: "A quoted key in the path is empty." };
        }
        segments.push({ kind: "key", key });
      } else {
        // Digits only. `Number()` would happily accept " 1", "1e3" and "0x10",
        // none of which is an array index anyone meant to write.
        if (!/^[0-9]+$/.test(inner)) {
          return {
            ok: false,
            error: `"[${inner}]" is not a valid index. Use a whole number, or quote it as a key: ["${inner}"].`,
          };
        }
        segments.push({ kind: "index", index: Number(inner) });
      }

      i = close + 1;
      // A "." directly after a "]" is the ordinary separator ("a[0].b"), so
      // it is consumed here. Anything else that is not another "[" is a
      // malformed path.
      if (i < input.length) {
        if (input[i] === ".") {
          i++;
          if (i >= input.length) return { ok: false, error: "The path ends with a \".\"." };
        } else if (input[i] !== "[") {
          return { ok: false, error: `Unexpected "${input[i]}" after "]" in the path.` };
        }
      }
      continue;
    }

    // A bare key runs until the next "." or "[".
    let end = i;
    while (end < input.length && input[end] !== "." && input[end] !== "[") end++;
    const key = input.slice(i, end);

    if (!key) {
      return { ok: false, error: 'The path has an empty segment (a stray "." ).' };
    }
    if (key === "*") {
      return { ok: false, error: 'Wildcards ("*") are not supported. Name a specific key.' };
    }
    if (key.includes("]")) {
      return { ok: false, error: 'Unexpected "]" in the path.' };
    }

    segments.push({ kind: "key", key });
    i = end;

    if (i < input.length && input[i] === ".") {
      i++;
      if (i >= input.length) return { ok: false, error: "The path ends with a \".\"." };
    }
  }

  if (segments.length === 0) {
    return { ok: false, error: "Enter a path to a field, for example data.status." };
  }

  return { ok: true, segments };
}

export type JsonPathResolution = { found: true; value: unknown } | { found: false };

/**
 * Walk parsed segments against a parsed JSON document.
 *
 * A path that runs off the end of the document is `found: false`, never a
 * thrown error and never `undefined`-as-a-value: the caller has to be able to
 * tell "the field is absent" from "the field is present and holds null", and
 * an `exists` assertion turns entirely on that distinction.
 *
 * `hasOwnProperty` rather than a plain property read, so a body containing a
 * key named `constructor` or `__proto__` resolves to that key's own value (or
 * to absent) instead of reaching an inherited prototype member. Without it,
 * `exists` on `constructor` would be true for every object on earth.
 */
export function resolveJsonPath(root: unknown, segments: JsonPathSegment[]): JsonPathResolution {
  let current: unknown = root;

  for (const segment of segments) {
    if (current === null || current === undefined) return { found: false };

    if (segment.kind === "index") {
      if (!Array.isArray(current)) return { found: false };
      if (segment.index >= current.length) return { found: false };
      current = current[segment.index];
      continue;
    }

    if (typeof current !== "object" || Array.isArray(current)) return { found: false };
    // `Object.hasOwn`, not `in` and not a plain property read: a body with a
    // key named `constructor` or `__proto__` must resolve to that key's OWN
    // value, never to an inherited prototype member.
    if (!Object.hasOwn(current, segment.key)) return { found: false };
    current = (current as Record<string, unknown>)[segment.key];
  }

  return { found: true, value: current };
}

/**
 * The comparable text form of a value at a path.
 *
 * A scalar (string, number, boolean, null) becomes its literal text: the
 * string `"ok"` is `ok`, the number `200` is `200`, `null` is `null`. That is
 * what a customer typing `equals: ok` means, and it keeps the assertion
 * value a plain string in the database rather than a typed union.
 *
 * An object or array becomes its compact JSON text. This exists for
 * `contains`, where "the array at data.tags contains urgent" is a real and
 * common thing to want; `equals` refuses a non-scalar separately (see
 * `describeNonScalar`), because comparing a whole object by exact
 * serialisation depends on key order and would be a trap.
 */
export function jsonValueToText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // Defensive only: a value that came out of JSON.parse cannot be cyclic.
    return "";
  }
}

/** Whether a value at a path is a scalar, i.e. something `equals` can
 * meaningfully compare against a customer-typed string. */
export function isScalarJsonValue(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** "an object" / "an array", for the equals-on-non-scalar error message. */
export function describeNonScalar(value: unknown): string {
  return Array.isArray(value) ? "an array" : "an object";
}

/**
 * How much of an actual value may appear in a failure reason.
 *
 * The reason string lands in `check_results.error` and flows to incident
 * copy, so a path pointing at a 200KB array must not put 200KB into a
 * database column on every tick. 120 characters is enough to diagnose "you
 * got the staging value" and short enough to stay readable in a row.
 * `probe-dns.ts` clips its own answer list at 200 for the same reason.
 */
export const MAX_REASON_VALUE_CHARS = 120;

export function clipForReason(text: string): string {
  return text.length <= MAX_REASON_VALUE_CHARS ? text : `${text.slice(0, MAX_REASON_VALUE_CHARS)}...`;
}

/** One check's (or one step's) JSON assertion, named exactly as the
 * `assertion_json_*` columns migrations/096 added. */
export interface JsonAssertionConfig {
  assertion_json_path: string | null;
  assertion_json_op: JsonAssertionOp | null;
  assertion_json_value: string | null;
}

export type JsonAssertionOp = "equals" | "contains" | "exists";

/** Bare reason, with NO "Assertion failed: " prefix. Each caller applies its
 * own convention: `http-assertions.ts` prefixes, `probe-multistep.ts` folds
 * the reason into its own `Step N ("name"): ` prefix instead. */
export type JsonAssertionResult = { ok: true } | { ok: false; reason: string };

/**
 * Evaluate one JSON-path assertion against a response body.
 *
 * The ONE implementation the fleet uses for both a whole http check
 * (`http-assertions.ts`) and a single journey step
 * (`probe-multistep.ts`) — those two mirror each other's status/body/header
 * logic by hand for historical reasons, but there was no reason to start a
 * third hand-mirrored copy here, and both live in this package and can
 * simply import this. `apps/agent/json-path.ts` remains a duplicate because
 * the agent takes zero workspace imports; that one copy is pinned by shared
 * test vectors.
 *
 * `bodyTruncated` matters more than it looks. A body cut off at the 256KB
 * cap is almost never parseable JSON, and reporting that as "the response
 * body is not valid JSON" would be a lie about the customer's API — their
 * JSON is fine, ours is the limitation. The two cases get different reasons.
 */
export function evaluateJsonAssertion(
  config: JsonAssertionConfig,
  bodyText: string | null,
  bodyTruncated: boolean,
  maxBodyBytes: number,
): JsonAssertionResult {
  if (config.assertion_json_op === null) return { ok: true };

  const path = config.assertion_json_path as string;

  // Parsed per evaluation rather than at save time. Save-time validation also
  // happens (api-schemas.ts refuses an unparseable path before it can be
  // stored), so this branch is unreachable for a row written through any
  // current surface; it exists because the executor must never throw on a row
  // it did not write, and a silent `ok` on an unreadable path would be a
  // monitor reporting green for an assertion it never ran.
  const parsed = parseJsonPath(path);
  if (!parsed.ok) {
    return { ok: false, reason: `JSON path "${clipForReason(path)}" is not valid: ${parsed.error}` };
  }

  let document: unknown;
  try {
    document = JSON.parse(bodyText ?? "");
  } catch {
    if (bodyTruncated) {
      return {
        ok: false,
        reason: `the response body is larger than ${Math.floor(maxBodyBytes / 1024)}KB, so it could not be parsed as JSON`,
      };
    }
    return { ok: false, reason: "the response body is not valid JSON" };
  }

  const resolved = resolveJsonPath(document, parsed.segments);

  if (config.assertion_json_op === "exists") {
    // An explicit JSON `null` at the path COUNTS as existing: the field is
    // present and the API deliberately said null. `resolveJsonPath`
    // distinguishes that from an absent key, which is the whole reason it
    // returns a discriminated union instead of `unknown | undefined`.
    return resolved.found ? { ok: true } : { ok: false, reason: `nothing at JSON path "${clipForReason(path)}"` };
  }

  if (!resolved.found) {
    return { ok: false, reason: `nothing at JSON path "${clipForReason(path)}"` };
  }

  const expected = config.assertion_json_value as string;

  if (config.assertion_json_op === "equals") {
    if (!isScalarJsonValue(resolved.value)) {
      return {
        ok: false,
        reason: `JSON path "${clipForReason(path)}" is ${describeNonScalar(resolved.value)}, which cannot equal "${clipForReason(expected)}"`,
      };
    }
    const actual = jsonValueToText(resolved.value);
    if (actual !== expected) {
      return {
        ok: false,
        reason: `JSON path "${clipForReason(path)}" was "${clipForReason(actual)}", expected "${clipForReason(expected)}"`,
      };
    }
    return { ok: true };
  }

  // contains: substring against the text form, which for an object or array
  // is its compact JSON. That makes "the tags array contains urgent" work,
  // which is the common case people reach for `contains` to express.
  const actual = jsonValueToText(resolved.value);
  if (!actual.includes(expected)) {
    return {
      ok: false,
      reason: `JSON path "${clipForReason(path)}" ("${clipForReason(actual)}") does not contain "${clipForReason(expected)}"`,
    };
  }
  return { ok: true };
}
