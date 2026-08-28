import { describe, expect, it } from "vitest";
import { FLUSH_BATCH_SIZE, ResultBuffer, bufferPolicy } from "./buffer.ts";
import type { CheckResult } from "./types.ts";

function result(n: number): CheckResult {
  return { checkId: `c${n}`, ok: true, latencyMs: n, checkedAt: new Date(n).toISOString() };
}

describe("ResultBuffer", () => {
  it("keeps results in the order they were observed", () => {
    const b = new ResultBuffer();
    for (let i = 0; i < 5; i++) b.push(result(i));
    expect(b.peekBatch(5).map((r) => r.checkId)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
  });

  it("holds at the bound and drops the OLDEST, counting every drop", () => {
    const b = new ResultBuffer(1000);
    for (let i = 0; i < 1500; i++) b.push(result(i));

    expect(b.size).toBe(1000);
    expect(b.dropped).toBe(500);
    // The 500 that went are the oldest, and the newest survived.
    expect(b.peekBatch(1)[0]?.checkId).toBe("c500");
  });

  it("defaults to the documented 1000-entry bound", () => {
    expect(bufferPolicy.max).toBe(1000);
    const b = new ResultBuffer();
    for (let i = 0; i < 1001; i++) b.push(result(i));
    expect(b.size).toBe(1000);
    expect(b.dropped).toBe(1);
  });

  it("reports drops once, then stops repeating them", () => {
    const b = new ResultBuffer(10);
    for (let i = 0; i < 13; i++) b.push(result(i));
    expect(b.takeDroppedSinceReport()).toBe(3);
    expect(b.takeDroppedSinceReport()).toBe(0);
    // The running total survives the report.
    expect(b.dropped).toBe(3);
  });

  it("peek does not remove, so a failed send loses nothing", () => {
    const b = new ResultBuffer();
    for (let i = 0; i < 10; i++) b.push(result(i));
    expect(b.peekBatch(10)).toHaveLength(10);
    expect(b.peekBatch(10)).toHaveLength(10);
    expect(b.size).toBe(10);
  });

  it("commit removes exactly the batch that was acknowledged", () => {
    const b = new ResultBuffer();
    for (let i = 0; i < 250; i++) b.push(result(i));
    const batch = b.peekBatch();
    expect(batch).toHaveLength(FLUSH_BATCH_SIZE);
    b.commit(batch.length);
    expect(b.size).toBe(150);
    expect(b.peekBatch(1)[0]?.checkId).toBe("c100");
  });

  it("batches at 100 even when far more is held", () => {
    const b = new ResultBuffer();
    for (let i = 0; i < 999; i++) b.push(result(i));
    expect(b.peekBatch()).toHaveLength(100);
  });

  /**
   * MUTATION TEST. The bound is the difference between an agent that rides out
   * a four hour outage and one that exhausts the customer's machine, so the
   * assertions above have to be load-bearing rather than incidentally true.
   * Break the guard, watch them flip, restore in `finally`.
   */
  it("mutation: with the bound disabled, the bound assertions no longer hold", () => {
    const original = bufferPolicy.enforceBound;
    try {
      bufferPolicy.enforceBound = false;
      const b = new ResultBuffer(1000);
      for (let i = 0; i < 1500; i++) b.push(result(i));

      // Every assertion in "holds at the bound" is now false.
      expect(b.size).not.toBe(1000);
      expect(b.size).toBe(1500);
      expect(b.dropped).not.toBe(500);
      expect(b.dropped).toBe(0);
      expect(b.peekBatch(1)[0]?.checkId).toBe("c0");
    } finally {
      bufferPolicy.enforceBound = original;
    }
  });

  it("mutation: the guard is restored afterwards", () => {
    expect(bufferPolicy.enforceBound).toBe(true);
    const b = new ResultBuffer(10);
    for (let i = 0; i < 20; i++) b.push(result(i));
    expect(b.size).toBe(10);
  });
});
