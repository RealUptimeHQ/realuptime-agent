import { AuthError, VantageConflictError, type AgentApi } from "./api.ts";
import {
  capAssignedChecks,
  DEFAULT_BOUNDS,
  logProbeBudgetExceeded,
  mapWithConcurrency,
  probeBudgetExceededMessage,
  ProbeBudget,
  type AgentBounds,
} from "./bounds.ts";
import { FLUSH_BATCH_SIZE, ResultBuffer } from "./buffer.ts";
import { MetricsCollector, type MetricsCollectorOptions } from "./collect-metrics.ts";
import type { EgressGuard } from "./egress-guard.ts";
import { EgressReport } from "./egress-guard.ts";
import { executeCheck } from "./execute.ts";
import { log } from "./log.ts";
import { METRICS_FLUSH_BATCH_SIZE, MetricsBuffer } from "./metrics-buffer.ts";
import { Scheduler, TICK_MS } from "./scheduler.ts";
import { AGENT_VERSION } from "./version.ts";
import {
  WIRE_PROTOCOL_VERSION,
  type AgentCheck,
  type CheckResult,
  type HostInfo,
  type MetricSample,
  type MetricsVantage,
} from "./types.ts";

/**
 * The loop. One 15 second tick drives everything:
 *
 *   poll the check list (every 60s)  ->  run whatever is due  ->  flush results
 *   ->  collect a metrics sample (every 60s)  ->  flush metrics
 *
 * All of it is written against injected `now()` and an injected api, so the
 * backoff curve, the 401 behaviour and the recovery flush are testable by
 * calling `tick()` with numbers rather than by waiting out real minutes. A
 * retry policy that can only be exercised by a real outage is a retry policy
 * nobody has ever seen work.
 *
 * ## Metrics never starve results
 *
 * Every tick attempts a results flush BEFORE a metrics flush, and the two
 * run against separate buffers with separate backoff clocks
 * (`metrics-buffer.ts` has the full reasoning). That ordering and separation
 * is deliberate: results are the product's core signal, metrics are
 * additive, and nothing about a slow or failing metrics endpoint can delay,
 * displace, or share a bound with a check result.
 */

export const POLL_INTERVAL_MS = 60_000;
export const FLUSH_INTERVAL_MS = 15_000;
/** Same cadence as the check-list poll, but an independent timer: collecting
 *  a metrics sample does not depend on a poll having succeeded. */
export const METRICS_SAMPLE_INTERVAL_MS = 60_000;

/** First backoff step, then doubling, capped. */
export const BACKOFF_START_MS = 15_000;
export const BACKOFF_MAX_MS = 300_000;

/**
 * How long to wait after a 401 before trying again. Fixed, not exponential,
 * and never fatal. See api.ts for the reasoning.
 */
export const AUTH_RETRY_MS = 300_000;

/** The subset of `MetricsCollector` the runtime needs, injectable so tests
 *  never touch a real filesystem. */
export interface MetricsSource {
  /** Async since REA-181: the macOS and Windows collectors run a fixed
   *  command or two, which must not block the tick. */
  collect(): Promise<MetricSample | null> | MetricSample | null;
  vantage(): { vantage: MetricsVantage; detail: string | null };
  /** Optional, v2: the host identity for the batch header. */
  hostInfo?(): Promise<HostInfo | null> | HostInfo | null;
  /** Optional, v2: the opt-in service watch list from the last poll. */
  setServiceWatch?(names: readonly unknown[]): void;
  /** REA-440, log snapshots phase 1: the last poll carried
   *  `requestLogSnapshot: true`, so the very next `collect()` should
   *  capture one. */
  requestLogSnapshot?(): void;
}

export interface RuntimeDeps {
  api: AgentApi;
  now?: () => number;
  execute?: (check: AgentCheck, egress?: EgressGuard) => Promise<CheckResult>;
  buffer?: ResultBuffer;
  scheduler?: Scheduler;
  metricsBuffer?: MetricsBuffer;
  metricsSource?: MetricsSource;
  metricsOptions?: MetricsCollectorOptions;
  /** The four load bounds this location enforces
   * (`docs/private-probe-locations.md` section 3.4). Defaults to
   * `DEFAULT_BOUNDS`; `agent.ts` passes what `loadBounds()` read from this
   * machine's environment. */
  bounds?: AgentBounds;
  /** The egress policy (section 3.3), already bound to a report. Omitted
   * means the pre-guard behaviour, which is what every existing runtime test
   * exercises. */
  egress?: EgressGuard;
  /** Where the guard's counts land, drained onto the poll line once a minute.
   * Supplied together with `egress` in production. */
  egressReport?: EgressReport;
}

export class AgentRuntime {
  readonly buffer: ResultBuffer;
  readonly scheduler: Scheduler;
  readonly metricsBuffer: MetricsBuffer;
  readonly bounds: AgentBounds;
  private readonly api: AgentApi;
  private readonly now: () => number;
  private readonly execute: (check: AgentCheck, egress?: EgressGuard) => Promise<CheckResult>;
  private readonly metricsSource: MetricsSource;
  private readonly egress?: EgressGuard;
  private readonly egressReport: EgressReport;
  private readonly probeBudget: ProbeBudget;

  private nextPollAt = 0;
  private nextFlushAt = 0;
  private pollBackoffMs = 0;
  private flushBackoffMs = 0;
  private stopped = false;

  private nextMetricsSampleAt = 0;
  private nextMetricsFlushAt = 0;
  private metricsFlushBackoffMs = 0;
  /** Set permanently once the server 409s this agent's vantage. The vantage
   *  a machine measures from does not change while the process runs, so
   *  every future batch would be refused the same way; see `flushMetricsOnce`. */
  private metricsVantageRejected = false;

  constructor(deps: RuntimeDeps) {
    this.api = deps.api;
    this.now = deps.now ?? Date.now;
    this.execute = deps.execute ?? executeCheck;
    this.buffer = deps.buffer ?? new ResultBuffer();
    this.bounds = deps.bounds ?? DEFAULT_BOUNDS;
    this.scheduler = deps.scheduler ?? new Scheduler(this.bounds.minIntervalSeconds);
    this.metricsBuffer = deps.metricsBuffer ?? new MetricsBuffer();
    this.metricsSource = deps.metricsSource ?? new MetricsCollector(deps.metricsOptions);
    this.egress = deps.egress;
    this.egressReport = deps.egressReport ?? new EgressReport();
    this.probeBudget = new ProbeBudget(this.bounds.maxProbesPerMinute);
  }

  async tick(): Promise<void> {
    const now = this.now();
    if (now >= this.nextPollAt) await this.pollOnce(now);
    await this.runDue(now);
    await this.maybeCollectMetrics(now);
    // Results before metrics, always: see the class doc comment.
    await this.maybeFlush(this.now());
    await this.maybeFlushMetrics(this.now());
  }

  /** Runs until `stop()`. The only unbounded loop in the program. */
  async run(sleep: (ms: number) => Promise<void> = defaultSleep): Promise<void> {
    log("info", "starting", { tickMs: TICK_MS, pollIntervalMs: POLL_INTERVAL_MS });
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (err) {
        // Belt and braces. Every path inside tick() already handles its own
        // errors; if one ever does not, the agent logs and keeps going rather
        // than dying on a machine nobody is watching.
        log("error", "unexpected tick failure", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (this.stopped) break;
      await sleep(TICK_MS);
    }
    log("info", "stopping", { buffered: this.buffer.size });
  }

  stop(): void {
    this.stopped = true;
  }

  /** A last flush attempt on shutdown. Best effort by definition: if the link
   *  is down there is nowhere to put the results, and the alternative (block
   *  shutdown until it comes back) is worse. Results first, same ordering as
   *  every tick. */
  async drain(): Promise<void> {
    try {
      await this.flushOnce(this.now());
    } catch {
      // Already logged inside flushOnce.
    }
    try {
      await this.flushMetricsOnce(this.now());
    } catch {
      // Already logged inside flushMetricsOnce.
    }
  }

  private async pollOnce(now: number): Promise<void> {
    try {
      const { checks: assigned, services, requestLogSnapshot } = await this.api.poll();
      // The assigned-check ceiling (section 3.4). Truncated rather than
      // refused whole: a location running 250 of 300 assigned checks is
      // monitoring 250 things, and one that refuses the list is monitoring
      // nothing. Loud either way.
      const { checks, dropped } = capAssignedChecks(assigned, this.bounds);
      if (dropped > 0) {
        log("warn", "assigned more checks than this location accepts", {
          assigned: assigned.length,
          running: checks.length,
          dropped,
          maxAssignedChecks: this.bounds.maxAssignedChecks,
          hint: "split the monitors across more locations, or raise REALUPTIME_MAX_ASSIGNED_CHECKS on this host",
        });
      }
      const clampedByFloor = this.scheduler.clampedByFloor(checks);
      this.scheduler.sync(checks, now);
      // The one server-pushed setting that reaches the collector: the
      // opt-in service watch list (protocol v2). Applied on every successful
      // poll so an operator's change in the dashboard lands within a minute
      // and a removed name stops being read.
      this.metricsSource.setServiceWatch?.(services);
      // REA-440, log snapshots phase 1: the second (and last) server-pushed
      // signal, a one-shot "capture on your next tick" flag rather than a
      // persistent setting. Only ever arms the collector; never disarms it
      // early, since a missed capture window is cheaper than one that never
      // fires because a later poll raced it.
      if (requestLogSnapshot) this.metricsSource.requestLogSnapshot?.();
      this.pollBackoffMs = 0;
      this.nextPollAt = now + POLL_INTERVAL_MS;
      // The location's own health line. There is no local API and no local
      // database to put any of this in (section 7 forbids both), so the log
      // stream is the health surface, and everything a bound did in the last
      // minute is on it: the egress verdicts, the clamped cadences, the
      // truncated list.
      const egress = this.egressReport.drain();
      log("info", "polled", {
        checks: checks.length,
        services: services.length || undefined,
        // Only present when non-zero, the same convention "flushed" uses, so a
        // grep for one of these finds a real bound biting and not routine
        // noise.
        clampedToFloor: clampedByFloor > 0 ? clampedByFloor : undefined,
        minIntervalSeconds: clampedByFloor > 0 ? this.bounds.minIntervalSeconds : undefined,
        droppedOverCeiling: dropped > 0 ? dropped : undefined,
        egressRefused: egress.refused > 0 ? egress.refused : undefined,
        egressWouldRefuse: egress.wouldRefuse > 0 ? egress.wouldRefuse : undefined,
        egressByRule: egress.refused + egress.wouldRefuse > 0 ? egress.byRule : undefined,
      });
    } catch (err) {
      if (err instanceof AuthError) {
        this.nextPollAt = now + AUTH_RETRY_MS;
        log("error", "agent token rejected on poll", {
          hint: "the token is wrong or was revoked; issue a new one in the RealUptime dashboard",
          retryInMs: AUTH_RETRY_MS,
        });
        return;
      }
      this.pollBackoffMs = nextBackoff(this.pollBackoffMs);
      this.nextPollAt = now + this.pollBackoffMs;
      log("warn", "poll failed", {
        error: err instanceof Error ? err.message : String(err),
        retryInMs: this.pollBackoffMs,
      });
    }
  }

  /**
   * Run whatever is due, inside this location's two load bounds.
   *
   * Concurrent because a tick's worth of checks must finish inside a tick, and
   * each one can legitimately spend 10 seconds waiting on a dead target.
   * Serialising them would make a handful of slow targets delay everything
   * else on the machine. Bounded because a check list is a work order and an
   * unbounded work order is a load generator pointed at infrastructure the
   * customer may not have sized for it (section 3.4).
   *
   * The probe budget is spent BEFORE the concurrency ceiling queues anything,
   * so "which checks were skipped" is decided by the order the server assigned
   * them rather than by which target happened to answer fastest. A skipped
   * check gets a synthetic FAILED result rather than nothing at all: silence
   * would read as "not due yet" on the dashboard and the customer would have
   * no way to learn the location is over capacity.
   */
  private async runDue(now: number): Promise<void> {
    const due = this.scheduler.takeDue(now);
    if (due.length === 0) return;

    const admitted: AgentCheck[] = [];
    const skipped: AgentCheck[] = [];
    for (const check of due) {
      if (this.probeBudget.tryConsume(now)) admitted.push(check);
      else skipped.push(check);
    }

    if (skipped.length > 0) {
      logProbeBudgetExceeded(skipped.length, this.bounds);
      const checkedAt = new Date(now).toISOString();
      const message = probeBudgetExceededMessage(this.bounds);
      for (const check of skipped) {
        this.buffer.push({ checkId: check.id, ok: false, error: message, checkedAt });
      }
    }

    const results = await mapWithConcurrency(admitted, this.bounds.maxConcurrentProbes, (check) =>
      this.execute(check, this.egress),
    );
    for (const result of results) this.buffer.push(result);
  }

  private async maybeFlush(now: number): Promise<void> {
    const backingOff = this.flushBackoffMs > 0;
    const due = now >= this.nextFlushAt;
    // The batch-size trigger deliberately does NOT override an active backoff.
    // A full buffer during an outage is the expected state, and letting it
    // punch through the backoff would turn a network failure into a request
    // flood against a service that is already unhappy.
    const full = !backingOff && this.buffer.size >= FLUSH_BATCH_SIZE;
    if (!due && !full) return;
    await this.flushOnce(now);
  }

  private async flushOnce(now: number): Promise<void> {
    if (this.buffer.size === 0) {
      this.nextFlushAt = now + FLUSH_INTERVAL_MS;
      return;
    }

    const batch = this.buffer.peekBatch(FLUSH_BATCH_SIZE);
    try {
      await this.api.sendResults(batch);
      // Only after the server has taken them. A take-then-send would lose the
      // batch on any failed POST, which is the exact case this exists for.
      this.buffer.commit(batch.length);
      this.flushBackoffMs = 0;
      this.nextFlushAt = now + FLUSH_INTERVAL_MS;
      const dropped = this.buffer.takeDroppedSinceReport();
      log("info", "flushed", {
        sent: batch.length,
        buffered: this.buffer.size,
        // Only present when it happened, so a grep for "dropped" finds the
        // real data gaps and nothing else.
        dropped: dropped > 0 ? dropped : undefined,
      });
      if (dropped > 0) {
        log("warn", "dropped oldest results: buffer was full", {
          dropped,
          droppedTotal: this.buffer.dropped,
          hint: "the link to RealUptime was down long enough to overflow the queue",
        });
      }
    } catch (err) {
      if (err instanceof AuthError) {
        this.nextFlushAt = now + AUTH_RETRY_MS;
        log("error", "agent token rejected on results", {
          hint: "the token is wrong or was revoked; issue a new one in the RealUptime dashboard",
          buffered: this.buffer.size,
          retryInMs: AUTH_RETRY_MS,
        });
        return;
      }
      this.flushBackoffMs = nextBackoff(this.flushBackoffMs);
      this.nextFlushAt = now + this.flushBackoffMs;
      log("warn", "flush failed, holding results", {
        error: err instanceof Error ? err.message : String(err),
        buffered: this.buffer.size,
        retryInMs: this.flushBackoffMs,
      });
    }
  }

  /** One sample, once per `METRICS_SAMPLE_INTERVAL_MS`, independent of
   *  whether a poll or a flush happened this tick. The collector reads local
   *  files or runs a fixed local command, never the network; it is awaited
   *  so a slow command on macOS/Windows cannot block the loop, and a
   *  collector that throws costs one log line, not the tick. */
  private async maybeCollectMetrics(now: number): Promise<void> {
    if (this.metricsVantageRejected) return;
    if (now < this.nextMetricsSampleAt) return;
    this.nextMetricsSampleAt = now + METRICS_SAMPLE_INTERVAL_MS;
    try {
      const sample = await this.metricsSource.collect();
      if (sample) this.metricsBuffer.push(sample);
    } catch (err) {
      log("warn", "server-health collection failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async maybeFlushMetrics(now: number): Promise<void> {
    if (this.metricsVantageRejected) return;
    const backingOff = this.metricsFlushBackoffMs > 0;
    const due = now >= this.nextMetricsFlushAt;
    const full = !backingOff && this.metricsBuffer.size >= METRICS_FLUSH_BATCH_SIZE;
    if (!due && !full) return;
    await this.flushMetricsOnce(now);
  }

  private async flushMetricsOnce(now: number): Promise<void> {
    if (this.metricsVantageRejected) return;
    if (this.metricsBuffer.size === 0) {
      this.nextMetricsFlushAt = now + FLUSH_INTERVAL_MS;
      return;
    }

    const { vantage, detail } = this.metricsSource.vantage();
    const batch = this.metricsBuffer.peekBatch(METRICS_FLUSH_BATCH_SIZE);
    try {
      const host = (await this.metricsSource.hostInfo?.()) ?? null;
      const response = await this.api.sendMetrics({
        vantage,
        vantageDetail: detail,
        collectorVersion: AGENT_VERSION,
        protocolVersion: WIRE_PROTOCOL_VERSION,
        host,
        samples: batch,
      });
      this.metricsBuffer.commit(batch.length);
      this.metricsFlushBackoffMs = 0;
      this.nextMetricsFlushAt = now + FLUSH_INTERVAL_MS;
      const dropped = this.metricsBuffer.takeDroppedSinceReport();
      log("info", "metrics flushed", {
        sent: batch.length,
        buffered: this.metricsBuffer.size,
        accepted: response.accepted,
        // Only present when non-zero, same convention as "flushed": a grep
        // for one of these finds a real clock problem or duplicate
        // collector, not routine noise.
        rejectedStale: response.rejectedStale > 0 ? response.rejectedStale : undefined,
        rejectedFuture: response.rejectedFuture > 0 ? response.rejectedFuture : undefined,
        rejectedDuplicate: response.rejectedDuplicate > 0 ? response.rejectedDuplicate : undefined,
        dropped: dropped > 0 ? dropped : undefined,
      });
    } catch (err) {
      if (err instanceof VantageConflictError) {
        // Permanent: see the field doc comment. Drop what is held, since it
        // can never be delivered, and stop touching the metrics endpoint for
        // the rest of this process's life. Check results are untouched.
        this.metricsVantageRejected = true;
        this.metricsBuffer.commit(this.metricsBuffer.size);
        log("error", "agent metrics vantage rejected by server", {
          error: err.message,
          hint: "register a new agent token for this vantage; check results are unaffected",
        });
        return;
      }
      if (err instanceof AuthError) {
        this.nextMetricsFlushAt = now + AUTH_RETRY_MS;
        log("error", "agent token rejected on metrics", {
          hint: "the token is wrong or was revoked; issue a new one in the RealUptime dashboard",
          buffered: this.metricsBuffer.size,
          retryInMs: AUTH_RETRY_MS,
        });
        return;
      }
      this.metricsFlushBackoffMs = nextBackoff(this.metricsFlushBackoffMs);
      this.nextMetricsFlushAt = now + this.metricsFlushBackoffMs;
      log("warn", "metrics flush failed, holding samples", {
        error: err instanceof Error ? err.message : String(err),
        buffered: this.metricsBuffer.size,
        retryInMs: this.metricsFlushBackoffMs,
      });
    }
  }
}

export function nextBackoff(previousMs: number): number {
  if (previousMs <= 0) return BACKOFF_START_MS;
  return Math.min(previousMs * 2, BACKOFF_MAX_MS);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
