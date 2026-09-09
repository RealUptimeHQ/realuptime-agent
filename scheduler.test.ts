import { describe, expect, it } from "vitest";
import { MIN_INTERVAL_SECONDS, Scheduler, intervalMsFor } from "./scheduler.ts";
import type { AgentCheck } from "./types.ts";

function check(id: string, intervalSeconds: number): AgentCheck {
  return { id, type: "http", url: `http://10.0.0.1/${id}`, intervalSeconds };
}

describe("Scheduler", () => {
  it("runs a newly assigned check immediately", () => {
    const s = new Scheduler();
    s.sync([check("a", 300)], 1000);
    expect(s.takeDue(1000).map((c) => c.id)).toEqual(["a"]);
  });

  it("does not run a check again until its interval has elapsed", () => {
    const s = new Scheduler();
    s.sync([check("a", 60)], 0);
    expect(s.takeDue(0)).toHaveLength(1);
    expect(s.takeDue(30_000)).toHaveLength(0);
    expect(s.takeDue(59_999)).toHaveLength(0);
    expect(s.takeDue(60_000).map((c) => c.id)).toEqual(["a"]);
  });

  it("dues each check on its own interval", () => {
    const s = new Scheduler();
    s.sync([check("fast", 15), check("slow", 60)], 0);
    s.takeDue(0);

    expect(s.takeDue(15_000).map((c) => c.id)).toEqual(["fast"]);
    expect(s.takeDue(30_000).map((c) => c.id)).toEqual(["fast"]);
    expect(s.takeDue(45_000).map((c) => c.id)).toEqual(["fast"]);
    expect(s.takeDue(60_000).map((c) => c.id).sort()).toEqual(["fast", "slow"]);
  });

  it("does NOT reset the clock when a poll returns the same check unchanged", () => {
    // The classic bug in this shape: re-syncing every 60s while a check runs
    // every 300s means the check never fires at all.
    const s = new Scheduler();
    s.sync([check("a", 300)], 0);
    s.takeDue(0);

    for (let t = 60_000; t <= 240_000; t += 60_000) {
      s.sync([check("a", 300)], t);
      expect(s.takeDue(t)).toHaveLength(0);
    }
    s.sync([check("a", 300)], 300_000);
    expect(s.takeDue(300_000).map((c) => c.id)).toEqual(["a"]);
  });

  it("keeps the due time when only the check's details change", () => {
    const s = new Scheduler();
    s.sync([check("a", 300)], 0);
    s.takeDue(0);
    const dueBefore = s.dueAt("a");

    const renamed: AgentCheck = { ...check("a", 300), url: "http://10.0.0.9/moved" };
    s.sync([renamed], 60_000);
    expect(s.dueAt("a")).toBe(dueBefore);
    // The new URL is what runs, though.
    expect(s.takeDue(300_000)[0]?.url).toBe("http://10.0.0.9/moved");
  });

  it("brings a shortened interval forward instead of waiting out the old one", () => {
    const s = new Scheduler();
    s.sync([check("a", 3600)], 0);
    s.takeDue(0);
    expect(s.dueAt("a")).toBe(3_600_000);

    s.sync([check("a", 60)], 10_000);
    expect(s.dueAt("a")).toBe(70_000);
  });

  it("does not fire early when an interval is lengthened", () => {
    const s = new Scheduler();
    s.sync([check("a", 60)], 0);
    s.takeDue(0);
    expect(s.dueAt("a")).toBe(60_000);

    s.sync([check("a", 3600)], 10_000);
    expect(s.dueAt("a")).toBe(60_000);
  });

  it("forgets a check the server stopped sending", () => {
    const s = new Scheduler();
    s.sync([check("a", 60), check("b", 60)], 0);
    expect(s.size).toBe(2);
    s.sync([check("a", 60)], 1000);
    expect(s.size).toBe(1);
    expect(s.takeDue(120_000).map((c) => c.id)).toEqual(["a"]);
  });

  it("clamps an interval below one tick, and a nonsense one", () => {
    expect(intervalMsFor(check("a", 5))).toBe(MIN_INTERVAL_SECONDS * 1000);
    expect(intervalMsFor(check("a", 0))).toBe(MIN_INTERVAL_SECONDS * 1000);
    expect(intervalMsFor(check("a", -60))).toBe(MIN_INTERVAL_SECONDS * 1000);
    expect(intervalMsFor({ ...check("a", 60), intervalSeconds: Number.NaN })).toBe(
      MIN_INTERVAL_SECONDS * 1000,
    );
  });

  it("reschedules from now, so a check that fell behind does not burst", () => {
    const s = new Scheduler();
    s.sync([check("a", 60)], 0);
    s.takeDue(0);
    // The process was stalled for ten minutes. A catch-up scheduler would fire
    // this ten times in a row at the target that was probably the cause.
    expect(s.takeDue(600_000)).toHaveLength(1);
    expect(s.takeDue(600_001)).toHaveLength(0);
    expect(s.dueAt("a")).toBe(660_000);
  });
});

/**
 * The cadence floor, section 3.4 of `docs/private-probe-locations.md`.
 *
 * The one bound of the four that a customer feels rather than only an attacker
 * does: a Scale account's 30 second agent-bound checks run at 60 seconds until
 * the person who owns the machine says otherwise, on the machine. That is the
 * design's decision, not an accident, and these tests are what make it a
 * decision somebody has to change on purpose.
 */
describe("Scheduler: the cadence floor", () => {
  it("clamps a server-assigned interval below the floor up to it", () => {
    const s = new Scheduler(60);
    s.sync([check("a", 1)], 0);
    s.takeDue(0);
    expect(s.dueAt("a")).toBe(60_000);
  });

  it("leaves an interval at or above the floor alone", () => {
    const s = new Scheduler(60);
    s.sync([check("a", 300)], 0);
    s.takeDue(0);
    expect(s.dueAt("a")).toBe(300_000);
  });

  it("counts what it clamped, so the log line can say so", () => {
    const s = new Scheduler(60);
    expect(s.clampedByFloor([check("a", 30), check("b", 60), check("c", 300)])).toBe(1);
    expect(s.clampedByFloor([check("a", 60)])).toBe(0);
  });

  it("cannot be configured below the grid's own floor", () => {
    const s = new Scheduler(1);
    s.sync([check("a", 1)], 0);
    s.takeDue(0);
    expect(s.dueAt("a")).toBe(MIN_INTERVAL_SECONDS * 1000);
  });

  it("a server that pushes a non-number gets the floor, not NaN", () => {
    expect(intervalMsFor({ ...check("a", 60), intervalSeconds: NaN }, 60)).toBe(60_000);
    expect(intervalMsFor({ ...check("a", 60), intervalSeconds: "30" as unknown as number }, 60)).toBe(60_000);
  });

  /** MUTATION TEST: lower the floor and the clamp has to stop happening. */
  it("mutation: with the floor lowered, the 1 second interval is no longer clamped to 60", () => {
    const s = new Scheduler(MIN_INTERVAL_SECONDS);
    s.sync([check("a", 1)], 0);
    s.takeDue(0);
    expect(s.dueAt("a")).not.toBe(60_000);
    expect(s.dueAt("a")).toBe(MIN_INTERVAL_SECONDS * 1000);
  });
});
