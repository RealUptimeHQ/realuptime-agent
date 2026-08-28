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
 */
export const MIN_INTERVAL_SECONDS = 15;

interface Entry {
  check: AgentCheck;
  dueAt: number;
}

export class Scheduler {
  private entries = new Map<string, Entry>();

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
      const intervalMs = intervalMsFor(check);
      const existing = this.entries.get(check.id);
      if (!existing) {
        this.entries.set(check.id, { check, dueAt: now });
        continue;
      }
      const dueAt =
        intervalMsFor(existing.check) === intervalMs
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
      entry.dueAt = now + intervalMsFor(entry.check);
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

export function intervalMsFor(check: AgentCheck): number {
  const seconds = Number.isFinite(check.intervalSeconds)
    ? Math.max(MIN_INTERVAL_SECONDS, Math.floor(check.intervalSeconds))
    : MIN_INTERVAL_SECONDS;
  return seconds * 1000;
}
