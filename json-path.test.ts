import { describe, expect, it } from "vitest";
import {
  MAX_PATH_SEGMENTS,
  MAX_REASON_VALUE_CHARS,
  evaluateJsonAssertion,
  parseJsonPath,
  resolveJsonPath,
} from "./json-path.ts";

/**
 * THE AGENT HALF of the shared vector table. This is a hand-copied duplicate
 * of `packages/db/json-path.test.ts`'s table, run against this program's own
 * hand-copied duplicate of the module, because the agent takes zero workspace
 * imports and cannot import either one. A change to one implementation that is
 * not mirrored in the other shows up here as a failing assertion rather than
 * as a silent divergence between how the fleet and an agent judge the SAME
 * check.
 *
 * If you are editing this table, edit the other one in the same commit.
 */
const JSON_ASSERTION_VECTORS: {
  name: string;
  body: string;
  path: string;
  op: "equals" | "contains" | "exists";
  value: string | null;
  truncated?: boolean;
  expectOk: boolean;
  /** Substring the failure reason must contain. */
  reasonIncludes?: string;
}[] = [
  {
    name: "equals on a nested string",
    body: '{"data":{"status":"ok"}}',
    path: "data.status",
    op: "equals",
    value: "ok",
    expectOk: true,
  },
  {
    name: "equals on an array element",
    body: '{"items":[{"state":"live"},{"state":"dead"}]}',
    path: "items[1].state",
    op: "equals",
    value: "dead",
    expectOk: true,
  },
  {
    name: "equals compares a number by its text form",
    body: '{"count":200}',
    path: "count",
    op: "equals",
    value: "200",
    expectOk: true,
  },
  {
    name: "equals compares a boolean by its text form",
    body: '{"healthy":true}',
    path: "healthy",
    op: "equals",
    value: "true",
    expectOk: true,
  },
  {
    name: "equals reports the actual value it found",
    body: '{"data":{"status":"degraded"}}',
    path: "data.status",
    op: "equals",
    value: "ok",
    expectOk: false,
    reasonIncludes: 'was "degraded"',
  },
  {
    name: "equals refuses a non-scalar rather than serialising it",
    body: '{"data":{"a":1}}',
    path: "data",
    op: "equals",
    value: "{}",
    expectOk: false,
    reasonIncludes: "is an object",
  },
  {
    name: "contains works on an array's JSON text",
    body: '{"tags":["urgent","billing"]}',
    path: "tags",
    op: "contains",
    value: "urgent",
    expectOk: true,
  },
  {
    name: "contains is a substring test on a scalar",
    body: '{"version":"v2.4.1-rc"}',
    path: "version",
    op: "contains",
    value: "2.4",
    expectOk: true,
  },
  {
    name: "exists is true for a present field",
    body: '{"data":{"id":"x"}}',
    path: "data.id",
    op: "exists",
    value: null,
    expectOk: true,
  },
  {
    name: "exists is TRUE for an explicit null -- the field is present",
    body: '{"data":{"id":null}}',
    path: "data.id",
    op: "exists",
    value: null,
    expectOk: true,
  },
  {
    name: "exists is false for an absent field",
    body: '{"data":{}}',
    path: "data.id",
    op: "exists",
    value: null,
    expectOk: false,
    reasonIncludes: "nothing at JSON path",
  },
  {
    name: "a missing path fails equals with the absence reason, not a mismatch",
    body: '{"data":{}}',
    path: "data.status",
    op: "equals",
    value: "ok",
    expectOk: false,
    reasonIncludes: "nothing at JSON path",
  },
  {
    name: "a non-JSON body fails honestly",
    body: "<html>nope</html>",
    path: "data.status",
    op: "equals",
    value: "ok",
    expectOk: false,
    reasonIncludes: "not valid JSON",
  },
  {
    name: "a TRUNCATED body blames our cap, not the customer's API",
    body: '{"data":{"status":"o',
    path: "data.status",
    op: "equals",
    value: "ok",
    truncated: true,
    expectOk: false,
    reasonIncludes: "larger than",
  },
  {
    name: "prototype members are not reachable through a path",
    body: '{"data":{}}',
    path: "data.constructor",
    op: "exists",
    value: null,
    expectOk: false,
    reasonIncludes: "nothing at JSON path",
  },
  {
    name: "__proto__ is not reachable either",
    body: '{"data":{}}',
    path: "data.__proto__",
    op: "exists",
    value: null,
    expectOk: false,
    reasonIncludes: "nothing at JSON path",
  },
  {
    name: "an index past the end of an array is absent, not an error",
    body: '{"items":[1]}',
    path: "items[5]",
    op: "exists",
    value: null,
    expectOk: false,
    reasonIncludes: "nothing at JSON path",
  },
  {
    name: "a key index against an array does not resolve",
    body: '{"items":[1,2]}',
    path: "items.length",
    op: "exists",
    value: null,
    expectOk: false,
  },
  {
    name: "a quoted key carries a dot without splitting",
    body: '{"a.b":"yes"}',
    path: '["a.b"]',
    op: "equals",
    value: "yes",
    expectOk: true,
  },
  {
    name: "a root-level array index works",
    body: '[{"n":1},{"n":2}]',
    path: "[1].n",
    op: "equals",
    value: "2",
    expectOk: true,
  },
  {
    name: "a leading $ is accepted and ignored",
    body: '{"data":{"status":"ok"}}',
    path: "$.data.status",
    op: "equals",
    value: "ok",
    expectOk: true,
  },
  {
    name: "an empty-string value is a legal comparison",
    body: '{"note":""}',
    path: "note",
    op: "equals",
    value: "",
    expectOk: true,
  },
];

describe("evaluateJsonAssertion (shared vectors)", () => {
  for (const v of JSON_ASSERTION_VECTORS) {
    it(v.name, () => {
      const result = evaluateJsonAssertion(
        { assertion_json_path: v.path, assertion_json_op: v.op, assertion_json_value: v.value },
        v.body,
        v.truncated ?? false,
        262_144,
      );
      expect(result.ok, `expected ok=${v.expectOk}, got ${JSON.stringify(result)}`).toBe(v.expectOk);
      if (!result.ok && v.reasonIncludes) {
        expect(result.reason).toContain(v.reasonIncludes);
      }
    });
  }

  it("is a no-op when no JSON assertion is configured", () => {
    const result = evaluateJsonAssertion(
      { assertion_json_path: null, assertion_json_op: null, assertion_json_value: null },
      "not json at all",
      false,
      262_144,
    );
    expect(result.ok).toBe(true);
  });

  it("clips a huge actual value out of the failure reason", () => {
    // The reason lands in check_results.error on every tick, so a path
    // pointing at a large value must not put that value in a database column.
    const big = "x".repeat(5_000);
    const result = evaluateJsonAssertion(
      { assertion_json_path: "v", assertion_json_op: "equals", assertion_json_value: "expected" },
      JSON.stringify({ v: big }),
      false,
      262_144,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeLessThan(MAX_REASON_VALUE_CHARS * 4);
      expect(result.reason).toContain("...");
    }
  });
});

describe("parseJsonPath", () => {
  it("parses dots and brackets into literal segments", () => {
    expect(parseJsonPath("data.items[0].status")).toEqual({
      ok: true,
      segments: [
        { kind: "key", key: "data" },
        { kind: "key", key: "items" },
        { kind: "index", index: 0 },
        { kind: "key", key: "status" },
      ],
    });
  });

  // The unsupported-syntax cases are the heart of this feature's honesty
  // promise: a construct we do not implement must be REFUSED, never quietly
  // dropped, because a dropped operator means we evaluated a different
  // assertion than the customer wrote and reported it as theirs.
  it.each([
    ["$..name", "Recursive descent"],
    ["items[*]", "Wildcards"],
    ["items[*].id", "Wildcards"],
    ["data.*", "Wildcards"],
    ["items[?(@.id==1)]", "Filter expressions"],
  ])("refuses unsupported syntax %s", (path, expected) => {
    const result = parseJsonPath(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(expected);
  });

  it.each([
    [""],
    ["   "],
    ["data."],
    ["data..x"],
    ["data[0"],
    ["data[]"],
    ["data[-1]"],
    ["data[1.5]"],
    ["data[0]x"],
  ])("rejects the malformed path %j", (path) => {
    expect(parseJsonPath(path).ok).toBe(false);
  });

  it("bounds the segment count", () => {
    const tooDeep = Array.from({ length: MAX_PATH_SEGMENTS + 5 }, (_, i) => `k${i}`).join(".");
    const result = parseJsonPath(tooDeep);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("at most");
  });

  it("accepts a path exactly at the segment limit", () => {
    const atLimit = Array.from({ length: MAX_PATH_SEGMENTS }, (_, i) => `k${i}`).join(".");
    expect(parseJsonPath(atLimit).ok).toBe(true);
  });
});

describe("resolveJsonPath", () => {
  it("tells an absent key apart from a present null", () => {
    const doc = { a: null };
    expect(resolveJsonPath(doc, [{ kind: "key", key: "a" }])).toEqual({ found: true, value: null });
    expect(resolveJsonPath(doc, [{ kind: "key", key: "b" }])).toEqual({ found: false });
  });

  it("stops at a scalar instead of throwing", () => {
    expect(
      resolveJsonPath({ a: 1 }, [
        { kind: "key", key: "a" },
        { kind: "key", key: "b" },
      ]),
    ).toEqual({ found: false });
  });
});
