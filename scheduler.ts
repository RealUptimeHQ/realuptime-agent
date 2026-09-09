import type { AgentCheck } from "./types.ts";

/**
 * Which checks are due right now.
 *
 * A due-time map on a fixed tick grid, the same shape `apps/probe` uses for the
 * cloud fleet, and for the same reason: one timer for the whole process rather
 * than one `setInterval` per check. A per-check timer array is fine at three
 * checks and a liability at three hundred, and it makes "what is the agent
 * doing right now" impossible to answer.
 *
 * Because the tick is 15 seconds, a check's real period is its interval
 * rounded UP to the next tick. That is deliberate and documented rather than
 * corrected: the alternative is a scheduler that fires off-grid and spends the
 * difference on wakeups.
 */

export const TICK_MS = 15_000;

/**
 * No check runs faster than one tick. A server-side value below this would
 * otherwise mean "run every tick" anyway, so it is clamped where it can be
 * seen instead of being silently ignored by the grid.
 *
 * This is the GRID's floor, and it is not the cadence bound. The cadence bound
 * is `AgentBounds.minIntervalSeconds` (60s by default, `bounds.ts`), which is
 * a security control this machine's operator owns; this constant is the
 * arithmetic limit of a 15 second tick and can never be lowered by anything.
 */
export const MIN_INTERVAL_SECONDS = 15;

interface Entry {
  check: AgentCheck;
  dueAt: number;
}

export class Scheduler {
  private entries = new Map<string, Entry>();
  /**
   * The cadence floor this location enforces (`docs/private-probe-locations.md`
   * section 3.4). Held here rather than read from the environment inside
   * `intervalMsFor`, so a test states the floor it is testing and the
   * production path reads it exactly once at startup.
   *
   * Defaults to the grid floor so a `new Scheduler()` behaves precisely as it
   * did before this argument existed.
   */
  private readonly floorSeconds: number;

  constructor(floorSeconds: number = MIN_INTERVAL_SECONDS) {
    this.floorSeconds = Math.max(MIN_INTERVAL_SECONDS, Math.floor(floorSeconds));
  }

  /**
   * How many of the checks the server just assigned are being run slower than
   * it asked, and by how much. Read once per poll for the log line: a customer
   * whose 30 second checks became 60 second checks has to be able to read the
   * reason rather than infer it from a chart.
   */
  clampedByFloor(checks: readonly AgentCheck[]): number {
    return checks.filter(
      (check) => Number.isFinite(check.intervalSeconds) && check.intervalSeconds < this.floorSeconds,
    ).length;
  }

  /**
   * Reconcile against the list the server just handed us.
   *
   * - A NEW check is due immediately. Adding a monitor and waiting five
   *   minutes for the first datapoint reads as a broken install.
   * - An EXISTING check keeps its due time when only its details changed (a
   *   renamed monitor, an edited URL). Resetting the clock on every poll would
   *   mean a check with an interval longer than the poll period never fires at
   *   all, which is the classic bug in this shape.
   * - A CHANGED interval is clamped forward: never later than one full new
   *   interval from now, so shortening an interval takes effect promptly and
   *   lengthening one does not fire early.
   * - A REMOVED check is forgotten, so a deleted monitor stops costing the
   *   customer's machine anything.
   */
  sync(checks: AgentCheck[], now: number): void {
    const seen = new Set<string>();

    for (const check of checks) {
      seen.add(check.id);
      const intervalMs = intervalMsFor(check, this.floorSeconds);
      const existing = this.entries.get(check.id);
      if (!existing) {
        this.entries.set(check.id, { check, dueAt: now });
        continue;
      }
      const dueAt =
        intervalMsFor(existing.check, this.floorSeconds) === intervalMs
          ? existing.dueAt
          : Math.min(existing.dueAt, now + intervalMs);
      this.entries.set(check.id, { check, dueAt });
    }

    for (const id of [...this.entries.keys()]) {
      if (!seen.has(id)) this.entries.delete(id);
    }
  }

  /**
   * Everything due at `now`, with each one rescheduled from `now` rather than
   * from its previous due time. Scheduling from the previous due time would
   * make a check that fell behind (a slow target, a paused container) fire
   * repeatedly in a burst to "catch up", hammering the very target that was
   * already struggling.
   */
  takeDue(now: number): AgentCheck[] {
    const due: AgentCheck[] = [];
    for (const entry of this.entries.values()) {
      if (entry.dueAt > now) continue;
      due.push(entry.check);
      entry.dueAt = now + intervalMsFor(entry.check, this.floorSeconds);
    }
    return due;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Test and diagnostic accessor. */
  dueAt(checkId: string): number | undefined {
    return this.entries.get(checkId)?.dueAt;
  }
}

/**
 * One check's real period, in milliseconds, after the cadence floor.
 *
 * `floorSeconds` is the location's own bound (`AgentBounds.minIntervalSeconds`)
 * and is clamped up to the grid floor first, so no caller can accidentally ask
 * for a cadence the tick cannot deliver. A server that pushes
 * `intervalSeconds: 1` gets the floor, and so does a server that pushes
 * `NaN`, a string, or nothing.
 */
export function intervalMsFor(check: AgentCheck, floorSeconds: number = MIN_INTERVAL_SECONDS): number {
  const floor = Math.max(MIN_INTERVAL_SECONDS, Math.floor(floorSeconds));
  const seconds = Number.isFinite(check.intervalSeconds)
    ? Math.max(floor, Math.floor(check.intervalSeconds))
    : floor;
  return seconds * 1000;
}
