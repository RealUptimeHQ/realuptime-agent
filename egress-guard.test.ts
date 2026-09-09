import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEgressGuard,
  createPinnedLookup,
  EgressReport,
  type LookupFn,
} from "./egress-guard.ts";
import { EGRESS_BLOCKED_MESSAGE, type EgressPolicy } from "./egress-policy.ts";
import { logSink } from "./log.ts";

const ENFORCING: EgressPolicy = { mode: "enforce", allowLoopback: false, allowTargets: [], allowPorts: [] };
const REPORTING: EgressPolicy = { ...ENFORCING, mode: "report" };

function lookupReturning(map: Record<string, string[]>): LookupFn {
  return async (hostname) => {
    const answers = map[hostname];
    if (!answers) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}

const lines: string[] = [];
const originalWrite = logSink.write;
beforeEach(() => {
  lines.length = 0;
  logSink.write = (line: string) => {
    lines.push(line);
  };
});
afterEach(() => {
  logSink.write = originalWrite;
});

function parsed(): { msg: string; rule?: string; host?: string }[] {
  return lines.map((line) => JSON.parse(line));
}

describe("createEgressGuard", () => {
  it("allows a private target and hands back the pin", async () => {
    const guard = createEgressGuard(ENFORCING, new EgressReport(), lookupReturning({ "db.internal": ["10.0.0.5"] }));
    const decision = await guard("db.internal", 5432);
    expect(decision.proceed).toBe(true);
    expect(decision.addresses).toEqual([{ address: "10.0.0.5", family: 4 }]);
  });

  it("refuses a public target and names the rule in the customer-facing text", async () => {
    const guard = createEgressGuard(ENFORCING, new EgressReport(), lookupReturning({ "e.example": ["93.184.216.34"] }));
    const decision = await guard("e.example", 443);
    expect(decision.proceed).toBe(false);
    expect(decision.error).toBe(`${EGRESS_BLOCKED_MESSAGE} (public address)`);
  });

  it("never puts the resolved address in the customer-facing text", async () => {
    // The error string is written into check_results and shipped to us. A
    // customer's internal addressing is theirs; the local log line has it.
    const guard = createEgressGuard(ENFORCING, new EgressReport(), lookupReturning({ h: ["169.254.169.254"] }));
    const decision = await guard("h", 80);
    expect(decision.error).not.toContain("169.254.169.254");
    expect(parsed().some((line) => line.msg === "refused a target by this location's egress policy")).toBe(true);
  });

  it("report mode proceeds, and says what enforcement would have cost", async () => {
    const report = new EgressReport();
    const guard = createEgressGuard(REPORTING, report, lookupReturning({ "e.example": ["93.184.216.34"] }));
    const decision = await guard("e.example", 443);
    expect(decision.proceed).toBe(true);
    expect(decision.error).toBeUndefined();
    const line = parsed().find((l) => l.msg === "target would be refused by this location's egress policy");
    expect(line?.rule).toBe("public");
    expect(line?.host).toBe("e.example");
    expect(report.drain()).toMatchObject({ refused: 0, wouldRefuse: 1, byRule: { public: 1 } });
  });

  it("report mode does NOT proceed past a metadata endpoint", async () => {
    const report = new EgressReport();
    const guard = createEgressGuard(REPORTING, report, lookupReturning({ h: ["169.254.169.254"] }));
    expect((await guard("h", 80)).proceed).toBe(false);
    expect(report.drain()).toMatchObject({ refused: 1, wouldRefuse: 0 });
  });

  it("an IP literal is its own pin, with no lookup at all", async () => {
    let called = 0;
    const guard = createEgressGuard(ENFORCING, new EgressReport(), async (...args) => {
      called++;
      return lookupReturning({})(...args);
    });
    const decision = await guard("10.0.0.5", 5432);
    expect(called).toBe(0);
    expect(decision.proceed).toBe(true);
    expect(decision.addresses).toEqual([{ address: "10.0.0.5", family: 4 }]);
  });

  it("a failed lookup is a refusal, not an exception", async () => {
    const guard = createEgressGuard(ENFORCING, new EgressReport(), lookupReturning({}));
    const decision = await guard("gone.internal", 443);
    expect(decision.proceed).toBe(false);
    expect(decision.error).toContain(EGRESS_BLOCKED_MESSAGE);
  });

  it("an empty host is refused before anything is resolved", async () => {
    const guard = createEgressGuard(ENFORCING, new EgressReport(), lookupReturning({}));
    expect((await guard("  ", 443)).proceed).toBe(false);
  });

  it("re-resolves on every call, so a moved DNS record is caught on the next dial", async () => {
    // The rebinding shape section 3.3 names: private on the first lookup,
    // public on the second, and the verdict has to follow the answer rather
    // than a cached decision.
    let answers = ["10.0.0.5"];
    const guard = createEgressGuard(ENFORCING, new EgressReport(), async () =>
      answers.map((address) => ({ address, family: 4 })),
    );
    expect((await guard("moving.example", 443)).proceed).toBe(true);
    answers = ["93.184.216.34"];
    expect((await guard("moving.example", 443)).proceed).toBe(false);
  });
});

describe("EgressReport", () => {
  it("drains and resets", async () => {
    const report = new EgressReport();
    const guard = createEgressGuard(REPORTING, report, lookupReturning({ a: ["8.8.8.8"], b: ["1.1.1.1"] }));
    await guard("a", 443);
    await guard("b", 443);
    expect(report.drain()).toMatchObject({ wouldRefuse: 2, byRule: { public: 2 } });
    expect(report.drain()).toMatchObject({ refused: 0, wouldRefuse: 0, byRule: {} });
  });
});

describe("createPinnedLookup", () => {
  it("replays the approved answers and never resolves", () => {
    const lookup = createPinnedLookup([{ address: "10.0.0.5", family: 4 }]);
    let all: unknown;
    lookup("ignored.example", { all: true }, (_err, addresses) => {
      all = addresses;
    });
    expect(all).toEqual([{ address: "10.0.0.5", family: 4 }]);

    let single: unknown;
    let family: unknown;
    lookup("ignored.example", undefined, (_err, address, fam) => {
      single = address;
      family = fam;
    });
    expect(single).toBe("10.0.0.5");
    expect(family).toBe(4);
  });

  it("fails CLOSED on an empty pin", () => {
    // An empty pin degrading into "resolve it normally" is the one mistake in
    // this shape that looks like it works.
    const lookup = createPinnedLookup([]);
    let err: NodeJS.ErrnoException | null = null;
    lookup("h", { all: true }, (e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(Error);
    expect((err as unknown as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });
});
