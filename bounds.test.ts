import { describe, expect, it } from "vitest";
import {
  BUDGET_WINDOW_MS,
  capAssignedChecks,
  DEFAULT_BOUNDS,
  DEFAULT_MAX_ASSIGNED_CHECKS,
  DEFAULT_MAX_CONCURRENT_PROBES,
  DEFAULT_MAX_PROBES_PER_MINUTE,
  DEFAULT_MIN_INTERVAL_SECONDS,
  loadBounds,
  mapWithConcurrency,
  probeBudgetExceededMessage,
  ProbeBudget,
} from "./bounds.ts";
import { MIN_INTERVAL_SECONDS } from "./scheduler.ts";
import type { AgentCheck } from "./types.ts";

function check(id: string): AgentCheck {
  return { id, type: "http", url: `http://10.0.0.1/${id}`, intervalSeconds: 60 };
}

describe("the four defaults", () => {
  it("are the numbers the design's parameter table names", () => {
    // Pinned as literals rather than compared to themselves: these four are a
    // published contract (README, docs/api.md) and a change to any of them is
    // a change a reviewer has to see in a diff.
    expect(DEFAULT_MIN_INTERVAL_SECONDS).toBe(60);
    expect(DEFAULT_MAX_CONCURRENT_PROBES).toBe(8);
    expect(DEFAULT_MAX_PROBES_PER_MINUTE).toBe(600);
    expect(DEFAULT_MAX_ASSIGNED_CHECKS).toBe(250);
  });
});

describe("the cadence floor stays in sync with the product side (REA-659)", () => {
  it("matches packages/db/checks.ts's AGENT_CADENCE_FLOOR_SECONDS", () => {
    // This package deliberately never imports @realuptime/db (see
    // wire-contract.test.ts's note on why), so it cannot import the constant
    // it is checking against here. The product surfaces that tell a customer
    // about this floor -- the add-agent-monitor form's inline hint and the
    // monitor detail page's effective-cadence line -- read
    // packages/db/checks.ts's AGENT_CADENCE_FLOOR_SECONDS, which has the same
    // pinned-literal test on its side. If you change the number here, change
    // it there in the same PR, or this test and that one both go stale
    // together and silently.
    expect(DEFAULT_MIN_INTERVAL_SECONDS).toBe(60);
  });
});

describe("loadBounds", () => {
  it("reads the four variables from the environment", () => {
    expect(
      loadBounds({
        REALUPTIME_MIN_INTERVAL_SECONDS: "30",
        REALUPTIME_MAX_CONCURRENT_PROBES: "4",
        REALUPTIME_MAX_PROBES_PER_MINUTE: "120",
        REALUPTIME_MAX_ASSIGNED_CHECKS: "50",
      }),
    ).toEqual({
      minIntervalSeconds: 30,
      maxConcurrentProbes: 4,
      maxProbesPerMinute: 120,
      maxAssignedChecks: 50,
    });
  });

  it("falls back to the defaults on nonsense rather than throwing", () => {
    // A typo in an optional hardening variable must not stop a customer's
    // monitoring.
    expect(loadBounds({ REALUPTIME_MIN_INTERVAL_SECONDS: "soon" })).toEqual(DEFAULT_BOUNDS);
    expect(loadBounds({ REALUPTIME_MAX_CONCURRENT_PROBES: "-1" })).toEqual(DEFAULT_BOUNDS);
    expect(loadBounds({ REALUPTIME_MAX_PROBES_PER_MINUTE: "0" })).toEqual(DEFAULT_BOUNDS);
    expect(loadBounds({})).toEqual(DEFAULT_BOUNDS);
  });

  it("cannot take the cadence floor below the scheduler's own tick floor", () => {
    expect(loadBounds({ REALUPTIME_MIN_INTERVAL_SECONDS: "1" }).minIntervalSeconds).toBe(MIN_INTERVAL_SECONDS);
  });
});

describe("capAssignedChecks", () => {
  it("passes a list under the ceiling through untouched", () => {
    const checks = [check("a"), check("b")];
    expect(capAssignedChecks(checks, DEFAULT_BOUNDS)).toEqual({ checks, dropped: 0 });
  });

  it("truncates rather than refusing the whole list", () => {
    // 250 of 300 monitored is 250 things monitored. Refusing the list is
    // nothing monitored.
    const checks = Array.from({ length: 300 }, (_, i) => check(String(i)));
    const capped = capAssignedChecks(checks, DEFAULT_BOUNDS);
    expect(capped.checks).toHaveLength(250);
    expect(capped.dropped).toBe(50);
    expect(capped.checks[0].id).toBe("0");
  });

  it("keeps the same checks across polls, so the survivors do not shuffle", () => {
    const checks = Array.from({ length: 260 }, (_, i) => check(String(i)));
    const first = capAssignedChecks(checks, DEFAULT_BOUNDS).checks.map((c) => c.id);
    const second = capAssignedChecks(checks, DEFAULT_BOUNDS).checks.map((c) => c.id);
    expect(first).toEqual(second);
  });

  /** MUTATION TEST: with the ceiling lifted, the truncation stops happening. */
  it("mutation: raising the ceiling removes the truncation", () => {
    const checks = Array.from({ length: 300 }, (_, i) => check(String(i)));
    expect(capAssignedChecks(checks, { ...DEFAULT_BOUNDS, maxAssignedChecks: 1000 }).dropped).toBe(0);
    expect(capAssignedChecks(checks, DEFAULT_BOUNDS).dropped).toBeGreaterThan(0);
  });
});

describe("ProbeBudget", () => {
  it("admits up to the limit inside one window and refuses the rest", () => {
    const budget = new ProbeBudget(3);
    expect(budget.tryConsume(0)).toBe(true);
    expect(budget.tryConsume(0)).toBe(true);
    expect(budget.tryConsume(0)).toBe(true);
    expect(budget.tryConsume(0)).toBe(false);
    expect(budget.used).toBe(3);
  });

  it("is a ROLLING window, so a fixed minute boundary cannot double it", () => {
    // The bug a fixed window has: 3 at 59.999 and 3 more at 60.000 is 6 in one
    // second, which is exactly the burst this bound exists to stop.
    const budget = new ProbeBudget(3);
    for (let i = 0; i < 3; i++) expect(budget.tryConsume(59_000)).toBe(true);
    expect(budget.tryConsume(60_000)).toBe(false);
    // A full window later, the budget is back.
    expect(budget.tryConsume(59_000 + BUDGET_WINDOW_MS + 1_000)).toBe(true);
  });

  it("forgets buckets that have aged out, so memory does not grow with throughput", () => {
    const budget = new ProbeBudget(1_000);
    for (let t = 0; t < 600_000; t += 1_000) budget.tryConsume(t);
    expect(budget.used).toBeLessThanOrEqual(61);
  });
});

describe("mapWithConcurrency", () => {
  it("returns results in input order", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it("never exceeds the ceiling", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 8, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(8);
  });

  /** MUTATION TEST: with the ceiling raised past the work, the queue stops
   * being a queue, which is what proves the ceiling is what bounded it. */
  it("mutation: with the ceiling above the item count, everything runs at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const body = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return null;
    };
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 1_000, body);
    expect(peak).toBe(20);
  });

  it("handles an empty list and a ceiling of zero without hanging", async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 0, async (n) => n)).toEqual([1, 2]);
  });
});

describe("probeBudgetExceededMessage", () => {
  it("reads as a capacity fact about the location, not a failure of the target", () => {
    expect(probeBudgetExceededMessage(DEFAULT_BOUNDS)).toBe(
      "This location reached its limit of 600 probes a minute and skipped this check.",
    );
  });
});
