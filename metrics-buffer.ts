import type { MetricSample } from "./types.ts";

/**
 * The bounded in-memory metrics queue: the same shape as `buffer.ts`'s
 * `ResultBuffer`, kept as a SEPARATE class and a SEPARATE instance rather
 * than a shared one.
 *
 * ## Why a separate buffer rather than one shared queue
 *
 * Check results are the product's core: an operator's alert depends on them
 * arriving, and `the Monitor design notes` phase 1 already spent a great deal of
 * care on never losing or delaying one. Metrics are additive -- charts and a
 * threshold alert, not the up/down signal itself. A single shared bounded
 * queue would let a metrics-side problem (the server rejecting this agent's
 * vantage, a burst of samples during a scheduling hiccup) crowd out results
 * competing for the same 1000 slots, or let a metrics backoff delay the next
 * result flush attempt sitting behind it in the same queue. Two buffers with
 * two independent backoff clocks (see `runtime.ts`) make that structurally
 * impossible instead of merely unlikely: the worst a metrics failure can do
 * is lose metrics.
 *
 * `runtime.ts` also always attempts a results flush before a metrics flush
 * on every tick, so metrics never even gets first claim on the tick's
 * network attempt.
 *
 * ## Sizing
 *
 * Metrics are sampled once per poll interval (60s) rather than once per
 * check per tick, so the same 1000-entry bound the results buffer uses holds
 * roughly 16 hours of samples here, comfortably more headroom than the ~4
 * hours a busy results buffer holds. Reusing the number rather than deriving
 * a different one keeps the two buffers' behaviour easy to reason about
 * side by side; there is no cadence-driven reason for the metrics bound to
 * be smaller.
 */

export const metricsBufferPolicy = {
  max: 1000,
  /** Mutation-test seam, mirroring `buffer.ts`. Never changed in production. */
  enforceBound: true,
};

/** Mirrors the server's `MAX_SAMPLES_PER_CALL` (packages/db/server-metrics.ts). */
export const METRICS_FLUSH_BATCH_SIZE = 100;

export class MetricsBuffer {
  private items: MetricSample[] = [];
  private droppedTotal = 0;
  private droppedSinceReport = 0;
  private readonly max: number;

  constructor(max: number = metricsBufferPolicy.max) {
    this.max = max;
  }

  push(sample: MetricSample): void {
    if (metricsBufferPolicy.enforceBound) {
      while (this.items.length >= this.max) {
        this.items.shift();
        this.droppedTotal++;
        this.droppedSinceReport++;
      }
    }
    this.items.push(sample);
  }

  peekBatch(n: number = METRICS_FLUSH_BATCH_SIZE): MetricSample[] {
    return this.items.slice(0, n);
  }

  commit(n: number): void {
    this.items.splice(0, n);
  }

  get size(): number {
    return this.items.length;
  }

  get dropped(): number {
    return this.droppedTotal;
  }

  takeDroppedSinceReport(): number {
    const n = this.droppedSinceReport;
    this.droppedSinceReport = 0;
    return n;
  }
}
