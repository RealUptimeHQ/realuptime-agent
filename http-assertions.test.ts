import { describe, expect, it } from "vitest";
import { evaluateHttpAssertions, hasHttpAssertions, needsAssertionBody, type HttpAssertionConfig } from "./http-assertions.ts";

const NO_ASSERTIONS: HttpAssertionConfig = {
  assertionBodyOp: null,
  assertionBodyValue: null,
  assertionBodyCaseSensitive: null,
  assertionHeaderName: null,
  assertionHeaderOp: null,
  assertionHeaderValue: null,
  assertionStatusMin: null,
  assertionStatusMax: null,
};

/**
 * The pinning table: every entry here is mirrored EXACTLY, name for name and
 * expectation for expectation, in
 * `packages/checker/http-assertions.test.ts`. This program takes zero
 * workspace imports and cannot import that package, so this table is what
 * proves the fleet and this agent still agree on the same rule -- a change
 * to one file's behavior that isn't mirrored in the other shows up as this
 * table failing on whichever side didn't change, not as a silent divergence
 * in production between a fleet-run and an agent-run http check.
 */
const VECTORS: {
  name: string;
  config: HttpAssertionConfig;
  status: number;
  nativeOk: boolean;
  headers?: Record<string, string>;
  bodyText?: string | null;
  expected: { ok: boolean; error?: string };
}[] = [
  {
    name: "no assertions, native ok, passes with no error",
    config: NO_ASSERTIONS,
    status: 200,
    nativeOk: true,
    expected: { ok: true },
  },
  {
    name: "no assertions, native not ok, fails with no error text",
    config: NO_ASSERTIONS,
    status: 500,
    nativeOk: false,
    expected: { ok: false },
  },
  {
    name: "body contains, found, passes",
    config: { ...NO_ASSERTIONS, assertionBodyOp: "contains", assertionBodyValue: "Add to cart", assertionBodyCaseSensitive: true },
    status: 200,
    nativeOk: true,
    bodyText: "<button>Add to cart</button>",
    expected: { ok: true },
  },
  {
    name: "body contains, missing, fails with the exact missing text",
    config: { ...NO_ASSERTIONS, assertionBodyOp: "contains", assertionBodyValue: "Add to cart", assertionBodyCaseSensitive: true },
    status: 200,
    nativeOk: true,
    bodyText: "<h1>Sold out</h1>",
    expected: { ok: false, error: 'Assertion failed: body is missing "Add to cart"' },
  },
  {
    name: "body not_contains, absent, passes",
    config: { ...NO_ASSERTIONS, assertionBodyOp: "not_contains", assertionBodyValue: "Internal Server Error", assertionBodyCaseSensitive: true },
    status: 200,
    nativeOk: true,
    bodyText: "<h1>OK</h1>",
    expected: { ok: true },
  },
  {
    name: "body not_contains, present, fails",
    config: { ...NO_ASSERTIONS, assertionBodyOp: "not_contains", assertionBodyValue: "Internal Server Error", assertionBodyCaseSensitive: true },
    status: 200,
    nativeOk: true,
    bodyText: "<h1>500 Internal Server Error</h1>",
    expected: { ok: false, error: 'Assertion failed: body still contains "Internal Server Error"' },
  },
  {
    name: "body contains, case-sensitive, differing case fails",
    config: { ...NO_ASSERTIONS, assertionBodyOp: "contains", assertionBodyValue: "OK", assertionBodyCaseSensitive: true },
    status: 200,
    nativeOk: true,
    bodyText: "ok",
    expected: { ok: false, error: 'Assertion failed: body is missing "OK"' },
  },
  {
    name: "body contains, case-insensitive, differing case passes",
    config: { ...NO_ASSERTIONS, assertionBodyOp: "contains", assertionBodyValue: "OK", assertionBodyCaseSensitive: false },
    status: 200,
    nativeOk: true,
    bodyText: "ok",
    expected: { ok: true },
  },
  {
    name: "header equals, match, passes",
    config: { ...NO_ASSERTIONS, assertionHeaderName: "content-type", assertionHeaderOp: "equals", assertionHeaderValue: "application/json" },
    status: 200,
    nativeOk: true,
    headers: { "content-type": "application/json" },
    expected: { ok: true },
  },
  {
    name: "header equals, mismatch, fails with both values",
    config: { ...NO_ASSERTIONS, assertionHeaderName: "content-type", assertionHeaderOp: "equals", assertionHeaderValue: "application/json" },
    status: 200,
    nativeOk: true,
    headers: { "content-type": "text/html" },
    expected: { ok: false, error: 'Assertion failed: header "content-type" was "text/html", expected "application/json"' },
  },
  {
    name: "header equals, missing header, fails",
    config: { ...NO_ASSERTIONS, assertionHeaderName: "x-api-version", assertionHeaderOp: "equals", assertionHeaderValue: "2" },
    status: 200,
    nativeOk: true,
    headers: {},
    expected: { ok: false, error: 'Assertion failed: header "x-api-version" was not present' },
  },
  {
    name: "header contains, substring present, passes",
    config: { ...NO_ASSERTIONS, assertionHeaderName: "cache-control", assertionHeaderOp: "contains", assertionHeaderValue: "no-store" },
    status: 200,
    nativeOk: true,
    headers: { "cache-control": "private, no-store, max-age=0" },
    expected: { ok: true },
  },
  {
    name: "header contains, substring absent, fails",
    config: { ...NO_ASSERTIONS, assertionHeaderName: "cache-control", assertionHeaderOp: "contains", assertionHeaderValue: "no-store" },
    status: 200,
    nativeOk: true,
    headers: { "cache-control": "public, max-age=3600" },
    expected: { ok: false, error: 'Assertion failed: header "cache-control" did not contain "no-store"' },
  },
  {
    name: "status override, exact match, passes",
    config: { ...NO_ASSERTIONS, assertionStatusMin: 401, assertionStatusMax: 401 },
    status: 401,
    nativeOk: false,
    expected: { ok: true },
  },
  {
    name: "status override, exact mismatch, fails with the exact range",
    config: { ...NO_ASSERTIONS, assertionStatusMin: 401, assertionStatusMax: 401 },
    status: 200,
    nativeOk: true,
    expected: { ok: false, error: "Assertion failed: expected status 401, got 200" },
  },
  {
    name: "status override, range match, passes",
    config: { ...NO_ASSERTIONS, assertionStatusMin: 200, assertionStatusMax: 204 },
    status: 204,
    nativeOk: true,
    expected: { ok: true },
  },
  {
    name: "status override, range mismatch, fails with the range",
    config: { ...NO_ASSERTIONS, assertionStatusMin: 200, assertionStatusMax: 204 },
    status: 500,
    nativeOk: false,
    expected: { ok: false, error: "Assertion failed: expected status 200-204, got 500" },
  },
  {
    name: "status override fails, body assertion is never evaluated (would have failed too, but status wins)",
    config: {
      ...NO_ASSERTIONS,
      assertionStatusMin: 200,
      assertionStatusMax: 200,
      assertionBodyOp: "contains",
      assertionBodyValue: "Add to cart",
      assertionBodyCaseSensitive: true,
    },
    status: 500,
    nativeOk: false,
    bodyText: null,
    expected: { ok: false, error: "Assertion failed: expected status 200, got 500" },
  },
  {
    name: "default status fails (no override), body/header configured, no error text (caller's own message applies)",
    config: {
      ...NO_ASSERTIONS,
      assertionBodyOp: "contains",
      assertionBodyValue: "Add to cart",
      assertionBodyCaseSensitive: true,
    },
    status: 500,
    nativeOk: false,
    bodyText: null,
    expected: { ok: false },
  },
  {
    name: "status passes, body passes, header fails: header's message wins (body then header order)",
    config: {
      ...NO_ASSERTIONS,
      assertionBodyOp: "contains",
      assertionBodyValue: "OK",
      assertionBodyCaseSensitive: true,
      assertionHeaderName: "content-type",
      assertionHeaderOp: "equals",
      assertionHeaderValue: "application/json",
    },
    status: 200,
    nativeOk: true,
    bodyText: "OK",
    headers: { "content-type": "text/plain" },
    expected: { ok: false, error: 'Assertion failed: header "content-type" was "text/plain", expected "application/json"' },
  },
  {
    name: "every assertion passes together",
    config: {
      assertionStatusMin: 200,
      assertionStatusMax: 299,
      assertionBodyOp: "contains",
      assertionBodyValue: "welcome",
      assertionBodyCaseSensitive: false,
      assertionHeaderName: "content-type",
      assertionHeaderOp: "contains",
      assertionHeaderValue: "json",
    },
    status: 200,
    nativeOk: true,
    bodyText: "Welcome back",
    headers: { "content-type": "application/json; charset=utf-8" },
    expected: { ok: true },
  },
];

function headerLookup(headers: Record<string, string> | undefined): (name: string) => string | null {
  const lower = new Map(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return (name: string) => lower.get(name.toLowerCase()) ?? null;
}

describe("evaluateHttpAssertions", () => {
  for (const vector of VECTORS) {
    it(vector.name, () => {
      const result = evaluateHttpAssertions(vector.config, {
        status: vector.status,
        nativeOk: vector.nativeOk,
        getHeader: headerLookup(vector.headers),
        bodyText: vector.bodyText ?? null,
        bodyTruncated: false,
      });
      expect(result.ok).toBe(vector.expected.ok);
      expect(result.error).toBe(vector.expected.error);
    });
  }

  it("hasHttpAssertions is false for an all-null config", () => {
    expect(hasHttpAssertions(NO_ASSERTIONS)).toBe(false);
  });

  it("hasHttpAssertions is true when any one group is set", () => {
    expect(hasHttpAssertions({ ...NO_ASSERTIONS, assertionBodyOp: "contains" })).toBe(true);
    expect(hasHttpAssertions({ ...NO_ASSERTIONS, assertionHeaderOp: "equals" })).toBe(true);
    expect(hasHttpAssertions({ ...NO_ASSERTIONS, assertionStatusMin: 200 })).toBe(true);
  });

  it("needsAssertionBody is true only when a body assertion is configured", () => {
    expect(needsAssertionBody(NO_ASSERTIONS)).toBe(false);
    expect(needsAssertionBody({ ...NO_ASSERTIONS, assertionHeaderOp: "equals" })).toBe(false);
    expect(needsAssertionBody({ ...NO_ASSERTIONS, assertionStatusMin: 200 })).toBe(false);
    expect(needsAssertionBody({ ...NO_ASSERTIONS, assertionBodyOp: "contains" })).toBe(true);
  });
});
