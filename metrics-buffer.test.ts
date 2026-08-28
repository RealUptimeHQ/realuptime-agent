import { describe, expect, it } from "vitest";
import { METRICS_FLUSH_BATCH_SIZE, MetricsBuffer, metricsBufferPolicy } from "./metrics-buffer.ts";
import type { MetricSample } from "./types.ts";

function sample(n: number): MetricSample {
  return {
    sampledAt: new Date(n).toISOString(),
    cpuUsedRatio: 0.1,
    cpuCores: 4,
    memoryTotalBytes: 1000,
    memoryUsedBytes: 500,
    filesystems: [],
  };
}

describe("MetricsBuffer", () => {
  it("keeps samples in the order they were observed", () => {
    const b = new MetricsBuffer();
    for (let i = 0; i < 5; i++) b.push(sample(i));
    expect(b.peekBatch(5).map((s) => s.sampledAt)).toEqual(
      [0, 1, 2, 3, 4].map((n) => new Date(n).toISOString()),
    );
  });

  it("holds at the bound and drops the OLDEST, counting every drop", () => {
    const b = new MetricsBuffer(1000);
    for (let i = 0; i < 1500; i++) b.push(sample(i));
    expect(b.size).toBe(1000);
    expect(b.dropped).toBe(500);
  });

  it("defaults to the documented 1000-entry bound, same as ResultBuffer", () => {
    expect(metricsBufferPolicy.max).toBe(1000);
    const b = new MetricsBuffer();
    for (let i = 0; i < 1001; i++) b.push(sample(i));
    expect(b.size).toBe(1000);
    expect(b.dropped).toBe(1);
  });

  it("peek does not remove, commit removes exactly what was acknowledged", () => {
    const b = new MetricsBuffer();
    for (let i = 0; i < 250; i++) b.push(sample(i));
    const batch = b.peekBatch();
    expect(batch).toHaveLength(METRICS_FLUSH_BATCH_SIZE);
    expect(b.size).toBe(250);
    b.commit(batch.length);
    expect(b.size).toBe(150);
  });

  it("reports drops once, then stops repeating them", () => {
    const b = new MetricsBuffer(10);
    for (let i = 0; i < 13; i++) b.push(sample(i));
    expect(b.takeDroppedSinceReport()).toBe(3);
    expect(b.takeDroppedSinceReport()).toBe(0);
    expect(b.dropped).toBe(3);
  });

  it("batches at 100 (the server's MAX_SAMPLES_PER_CALL) even when far more is held", () => {
    const b = new MetricsBuffer();
    for (let i = 0; i < 999; i++) b.push(sample(i));
    expect(b.peekBatch()).toHaveLength(100);
  });

  it("mutation: with the bound disabled, the bound assertions no longer hold", () => {
    const original = metricsBufferPolicy.enforceBound;
    try {
      metricsBufferPolicy.enforceBound = false;
      const b = new MetricsBuffer(1000);
      for (let i = 0; i < 1500; i++) b.push(sample(i));
      expect(b.size).toBe(1500);
      expect(b.dropped).toBe(0);
    } finally {
      metricsBufferPolicy.enforceBound = original;
    }
  });

  it("mutation: the guard is restored afterwards", () => {
    expect(metricsBufferPolicy.enforceBound).toBe(true);
    const b = new MetricsBuffer(10);
    for (let i = 0; i < 20; i++) b.push(sample(i));
    expect(b.size).toBe(10);
  });
});
