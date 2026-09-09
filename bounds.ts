/**
 * How much work this location will do, whatever it is asked to do.
 *
 * `docs/private-probe-locations.md` section 3.4. A check list is a work order,
 * and an unbounded work order is a load generator pointed at the customer's
 * own infrastructure. The server-side halves of these bounds already exist
 * (`validateIntervalForTier`, the per-agent check cap at creation) and are a
 * courtesy, so the customer gets an error when they configure something rather
 * than a surprise when it runs. These are the ones that actually hold, because
 * they run on the machine the customer owns and no poll response can move
 * them.
 *
 * Four bounds, four numbers, all four overridable downward-or-upward by the
 * person who installed the agent and by nobody else:
 *
 *   REALUPTIME_MIN_INTERVAL_SECONDS   cadence floor, default 60
 *   REALUPTIME_MAX_CONCURRENT_PROBES  in-flight ceiling, default 8
 *   REALUPTIME_MAX_PROBES_PER_MINUTE  aggregate budget, default 600
 *   REALUPTIME_MAX_ASSIGNED_CHECKS    assigned-check ceiling, default 250
 *
 * Every one of them, when it bites, is LOUD: a log line, and for the probe
 * budget a synthetic failed result on the checks that were skipped. A bound
 * that silently degrades monitoring is indistinguishable from monitoring that
 * silently broke, which is the failure this whole product exists to prevent.
 */

import { log } from "./log.ts";
import { MIN_INTERVAL_SECONDS as SCHEDULER_TICK_FLOOR } from "./scheduler.ts";
import type { AgentCheck } from "./types.ts";

export interface AgentBounds {
  /**
   * No check runs faster than this, whatever the server assigned.
   *
   * 60 seconds by default, which is the Free and Growth tier floor
   * (`TIER_MIN_INTERVAL_SECONDS`). A Scale or MSP account paying for 30 second
   * checks has to say so on the machine, by setting
   * `REALUPTIME_MIN_INTERVAL_SECONDS=30`. That is deliberate and it is the
   * whole point: the cadence at which a customer's own network gets hit is a
   * decision that belongs on the customer's own machine, not in a form on our
   * website, and a server that pushes `intervalSeconds: 1` gets 60.
   *
   * Every clamp is logged once per poll, so an operator whose 30 second checks
   * became 60 second checks reads the reason in `docker logs` instead of
   * guessing.
   */
  minIntervalSeconds: number;
  /** Maximum probes in flight at once. Makes "500 checks all due on the same
   * tick" a queue rather than a burst against infrastructure the customer may
   * not have sized for it. */
  maxConcurrentProbes: number;
  /** Maximum probes started per rolling minute. 600 is 100 checks at a 10
   * second cadence: comfortably above any real configuration, and far below
   * anything that stresses a network. */
  maxProbesPerMinute: number;
  /** Maximum checks this location will accept from one poll response. A
   * larger binding is refused at creation with an honest message; this is the
   * backstop for a server that ignores its own rule. */
  maxAssignedChecks: number;
}

export const DEFAULT_MIN_INTERVAL_SECONDS = 60;
export const DEFAULT_MAX_CONCURRENT_PROBES = 8;
export const DEFAULT_MAX_PROBES_PER_MINUTE = 600;
export const DEFAULT_MAX_ASSIGNED_CHECKS = 250;

export const DEFAULT_BOUNDS: AgentBounds = {
  minIntervalSeconds: DEFAULT_MIN_INTERVAL_SECONDS,
  maxConcurrentProbes: DEFAULT_MAX_CONCURRENT_PROBES,
  maxProbesPerMinute: DEFAULT_MAX_PROBES_PER_MINUTE,
  maxAssignedChecks: DEFAULT_MAX_ASSIGNED_CHECKS,
};

/**
 * Read the four bounds from this machine's environment.
 *
 * A value that is not a positive integer is IGNORED and the default stands,
 * rather than throwing: a typo in an optional hardening variable must not stop
 * a customer's monitoring, and "unset" and "nonsense" mean the same thing to
 * every other optional variable this program takes.
 *
 * The cadence floor additionally cannot go below the scheduler's own tick
 * floor, since a value under one tick would mean "every tick" anyway and a
 * bound that is silently rounded is a bound nobody can reason about.
 */
export function loadBounds(env: NodeJS.ProcessEnv = process.env): AgentBounds {
  return {
    minIntervalSeconds: Math.max(
      SCHEDULER_TICK_FLOOR,
      positiveInt(env.REALUPTIME_MIN_INTERVAL_SECONDS, DEFAULT_MIN_INTERVAL_SECONDS),
    ),
    maxConcurrentProbes: positiveInt(env.REALUPTIME_MAX_CONCURRENT_PROBES, DEFAULT_MAX_CONCURRENT_PROBES),
    maxProbesPerMinute: positiveInt(env.REALUPTIME_MAX_PROBES_PER_MINUTE, DEFAULT_MAX_PROBES_PER_MINUTE),
    maxAssignedChecks: positiveInt(env.REALUPTIME_MAX_ASSIGNED_CHECKS, DEFAULT_MAX_ASSIGNED_CHECKS),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Trim a poll response to the assigned-check ceiling.
 *
 * Truncated, never refused wholesale: a location running 250 of its 300
 * assigned checks is monitoring 250 things, and a location running none
 * because the list was too long is monitoring nothing. The order the server
 * sent is preserved (it is `created_at asc`), so which checks survive is
 * stable across polls rather than shuffling every minute.
 */
export function capAssignedChecks(
  checks: readonly AgentCheck[],
  bounds: AgentBounds,
): { checks: AgentCheck[]; dropped: number } {
  if (checks.length <= bounds.maxAssignedChecks) return { checks: [...checks], dropped: 0 };
  return {
    checks: checks.slice(0, bounds.maxAssignedChecks),
    dropped: checks.length - bounds.maxAssignedChecks,
  };
}

/**
 * The aggregate probe budget: a rolling window of one minute, counted in
 * fixed-length buckets so the memory cost is a handful of numbers regardless
 * of throughput.
 *
 * A rolling window rather than a fixed one because a fixed minute boundary
 * lets twice the budget through across it (599 probes at 11:59:59 and 600 more
 * at 12:00:00), which is exactly the burst the bound exists to stop.
 */
export const BUDGET_WINDOW_MS = 60_000;
const BUDGET_BUCKET_MS = 1_000;

export class ProbeBudget {
  private readonly limit: number;
  private readonly buckets = new Map<number, number>();

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Consume one probe's worth of budget, or refuse. */
  tryConsume(now: number): boolean {
    this.evict(now);
    if (this.used >= this.limit) return false;
    const bucket = Math.floor(now / BUDGET_BUCKET_MS);
    this.buckets.set(bucket, (this.buckets.get(bucket) ?? 0) + 1);
    return true;
  }

  /** Probes started inside the trailing window. Diagnostic and test accessor. */
  get used(): number {
    let total = 0;
    for (const count of this.buckets.values()) total += count;
    return total;
  }

  private evict(now: number): void {
    const oldest = Math.floor((now - BUDGET_WINDOW_MS) / BUDGET_BUCKET_MS);
    for (const bucket of [...this.buckets.keys()]) {
      if (bucket <= oldest) this.buckets.delete(bucket);
    }
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * Results come back in input order, so a caller can pair them with their
 * checks without carrying an index around. `fn` is expected to resolve rather
 * than reject (every prober in this package catches its own errors); a
 * rejection propagates, exactly as `Promise.all` would, and `runtime.ts`'s
 * tick-level backstop catches it.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const ceiling = Math.max(1, Math.floor(limit));
  if (items.length <= ceiling) return Promise.all(items.map((item) => fn(item)));

  const results = new Array<R>(items.length);
  let next = 0;
  const workers = new Array(Math.min(ceiling, items.length)).fill(null).map(async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** The error text on a result that was skipped because this location had
 * already started its budgeted number of probes for the minute. Named here so
 * the runtime and its tests cannot disagree about the wording, and phrased so
 * the customer reads a capacity fact rather than a failure of the thing being
 * monitored. */
export function probeBudgetExceededMessage(bounds: AgentBounds): string {
  return `This location reached its limit of ${bounds.maxProbesPerMinute} probes a minute and skipped this check.`;
}

/** One line, once, when the ceiling bites. Kept here beside the message so a
 * reader sees the whole "loud, not silent" contract in one place. */
export function logProbeBudgetExceeded(skipped: number, bounds: AgentBounds): void {
  log("warn", "probe budget reached, skipping the excess this tick", {
    skipped,
    maxProbesPerMinute: bounds.maxProbesPerMinute,
    hint: "raise REALUPTIME_MAX_PROBES_PER_MINUTE on this host, or lengthen the intervals in the dashboard",
  });
}
