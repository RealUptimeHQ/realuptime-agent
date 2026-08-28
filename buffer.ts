import type { CheckResult } from "./types.ts";

/**
 * The bounded in-memory result queue.
 *
 * ## Why memory and not disk
 *
 * Writing a spool file would mean the agent touches the customer's filesystem,
 * which is a claim the README makes explicitly and a security reviewer checks.
 * The trade is honest and stated: a restart during an outage loses whatever
 * was held. A bounded queue that never writes anywhere is the version we can
 * describe in one sentence and a reviewer can verify in one file.
 *
 * ## Why the oldest is dropped, and why the count is logged
 *
 * At 1000 entries the queue is full. Something has to go, and it is the oldest
 * result, because the newest observations are the ones an operator is about to
 * ask about. Silently dropping them would be the worst outcome of all: the
 * history would have a hole in it that nobody could distinguish from "nothing
 * happened". So every drop increments a counter, and the counter is logged at
 * the next flush. A gap in the data is then a gap somebody was TOLD about.
 *
 * At a 15 second minimum interval, 1000 entries is a bit over four hours of a
 * single check, or roughly 25 minutes across ten checks. Beyond that the link
 * has been down long enough that the server's own agent-offline alert is the
 * signal that matters, not the backfill.
 */

/**
 * Policy behind a mutable holder so `buffer.test.ts` can disable the bound and
 * watch the assertions that depend on it flip. A guard nobody has seen fail is
 * decoration, and this one is the difference between an agent that rides out a
 * four hour outage and one that exhausts the machine's memory.
 */
export const bufferPolicy = {
  max: 1000,
  /** Mutation-test seam. Never changed in production. */
  enforceBound: true,
};

export const FLUSH_BATCH_SIZE = 100;

export class ResultBuffer {
  private items: CheckResult[] = [];
  private droppedTotal = 0;
  private droppedSinceReport = 0;
  private readonly max: number;

  constructor(max: number = bufferPolicy.max) {
    this.max = max;
  }

  push(result: CheckResult): void {
    if (bufferPolicy.enforceBound) {
      while (this.items.length >= this.max) {
        this.items.shift();
        this.droppedTotal++;
        this.droppedSinceReport++;
      }
    }
    this.items.push(result);
  }

  /**
   * The oldest `n` results, WITHOUT removing them. Removal is a separate step
   * (`commit`) that only runs after the server has acknowledged the batch: a
   * take-then-send design loses the whole batch if the POST fails, which is
   * precisely the case this class exists to survive.
   */
  peekBatch(n: number = FLUSH_BATCH_SIZE): CheckResult[] {
    return this.items.slice(0, n);
  }

  /** Discard the oldest `n` results, after the server has accepted them. */
  commit(n: number): void {
    this.items.splice(0, n);
  }

  get size(): number {
    return this.items.length;
  }

  get dropped(): number {
    return this.droppedTotal;
  }

  /** Drops since the last call, for the flush log line. Reading resets it, so
   *  a single drop is reported once rather than in every subsequent line. */
  takeDroppedSinceReport(): number {
    const n = this.droppedSinceReport;
    this.droppedSinceReport = 0;
    return n;
  }
}
