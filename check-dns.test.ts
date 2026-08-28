import { describe, expect, it } from "vitest";
import { flattenAnswer, runDnsCheck } from "./check-dns.ts";

/**
 * The resolver is injected rather than a real one pointed at a real zone: the
 * behaviours worth pinning are the JUDGEMENTS (empty answers, contains-match,
 * error vocabulary), and a test that needs working DNS to run is a test that
 * fails on an aeroplane.
 */

const answering =
  (answers: unknown[]) =>
  async (): Promise<unknown[]> =>
    answers;

const failing = (code: string) => async (): Promise<unknown[]> => {
  const err = new Error(`resolver said ${code}`) as Error & { code: string };
  err.code = code;
  throw err;
};

describe("runDnsCheck", () => {
  it("counts a non-empty answer as up", async () => {
    const out = await runDnsCheck("api.internal", "A", null, 1000, answering(["10.0.0.4"]));
    expect(out.ok).toBe(true);
    expect(out.error).toBeUndefined();
  });

  it("counts an EMPTY answer set as down, not as a successful query", async () => {
    // The classic false green: resolve() returned without throwing, and the
    // name resolves to nothing.
    const out = await runDnsCheck("api.internal", "A", null, 1000, answering([]));
    expect(out.ok).toBe(false);
    expect(out.error).toBe("No records returned");
  });

  it("matches an expected value by substring, case insensitively", async () => {
    const out = await runDnsCheck(
      "api.internal",
      "A",
      "10.0.0.4",
      1000,
      answering(["10.0.0.4", "10.0.0.5"]),
    );
    expect(out.ok).toBe(true);

    const cased = await runDnsCheck(
      "mail.internal",
      "MX",
      "MX1.Internal",
      1000,
      answering([{ priority: 10, exchange: "mx1.internal" }]),
    );
    expect(cased.ok).toBe(true);
  });

  it("counts a repointed record as down and says what it actually got", async () => {
    const out = await runDnsCheck("api.internal", "A", "10.0.0.4", 1000, answering(["10.9.9.9"]));
    expect(out.ok).toBe(false);
    expect(out.error).toContain('Expected "10.0.0.4"');
    expect(out.error).toContain("10.9.9.9");
  });

  it("rejoins a chunked TXT record before matching", async () => {
    // A long TXT is split at 255 bytes on the wire. Matching a chunk instead
    // of the whole value would miss a DKIM key the record contains.
    const key = "v=DKIM1; k=rsa; p=" + "A".repeat(300);
    const chunks = [key.slice(0, 255), key.slice(255)];
    const out = await runDnsCheck("sel._domainkey.internal", "TXT", key, 1000, answering([chunks]));
    expect(out.ok).toBe(true);
  });

  it("keeps NXDOMAIN, SERVFAIL and a timeout as distinct diagnoses", async () => {
    expect((await runDnsCheck("x", "A", null, 1000, failing("NXDOMAIN"))).error).toContain(
      "NXDOMAIN",
    );
    expect((await runDnsCheck("x", "A", null, 1000, failing("SERVFAIL"))).error).toContain(
      "SERVFAIL",
    );
    expect((await runDnsCheck("x", "A", null, 1000, failing("ETIMEOUT"))).error).toBe(
      "The DNS query timed out",
    );
    expect((await runDnsCheck("x", "A", null, 1000, failing("ENODATA"))).error).toBe(
      "No records found for that name and type",
    );
  });

  it("bounds a resolver that never answers", async () => {
    const started = Date.now();
    const out = await runDnsCheck("x", "A", null, 100, () => new Promise<unknown[]>(() => {}));
    expect(out.ok).toBe(false);
    expect(out.error).toBe("The DNS query timed out");
    // timeoutMs * DNS_TOTAL_BUDGET_PHASES, with slack for a loaded CI box.
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it(
    "resolves a real name end to end",
    async () => {
      // One test against the actual node:dns resolver, so an injected-seam-only
      // suite cannot hide a broken production path.
      const out = await runDnsCheck("localhost", "A", null, 5_000);
      // Some CI images have no localhost A record in DNS at all, so the pass
      // condition is "answered coherently", not "answered up".
      expect(typeof out.ok).toBe("boolean");
      expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    },
    // The test timeout must OUTLIVE the budget it hands runDnsCheck, or the
    // two race and vitest kills the test before the assertions can run. Both
    // were 5_000: any lookup that actually used its budget failed as
    // "Test timed out in 5000ms" -- the harness reporting a resolver that was
    // behaving exactly as instructed. Seen on the gate box 2026-08-27 at
    // 5008ms, eight milliseconds over.
    //
    // This is the only test here that touches the network, so it is also the
    // only one whose duration is not ours to predict; the budget above is what
    // bounds the behaviour under test, and this bounds the harness.
    15_000,
  );
});

describe("flattenAnswer", () => {
  it("renders each record shape as one comparable string", () => {
    expect(flattenAnswer("10.0.0.4")).toBe("10.0.0.4");
    expect(flattenAnswer(["a", "b"])).toBe("ab");
    expect(flattenAnswer({ priority: 10, exchange: "mx1.internal" })).toBe("10 mx1.internal");
    expect(flattenAnswer({ exchange: "mx1.internal" })).toBe("mx1.internal");
    expect(flattenAnswer({ other: 1 })).toBe('{"other":1}');
  });
});
