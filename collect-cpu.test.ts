import { describe, expect, it } from "vitest";
import { cpuUsedRatioFromDelta, readCpuTotals } from "./collect-cpu.ts";

function procStat(fields: number[], cores = 4): string {
  const lines = [`cpu  ${fields.join(" ")}`];
  for (let i = 0; i < cores; i++) lines.push(`cpu${i} ${fields.map((f) => Math.round(f / cores)).join(" ")}`);
  lines.push("intr 12345 0 0 0");
  lines.push("ctxt 98765");
  lines.push(`btime 1700000000`);
  lines.push("processes 5000");
  return lines.join("\n");
}

describe("readCpuTotals", () => {
  it("parses the aggregate line and counts cores", () => {
    // user nice system idle iowait irq softirq steal
    const reading = readCpuTotals(procStat([1000, 0, 500, 8000, 100, 0, 0, 0]));
    expect(reading?.cores).toBe(4);
    expect(reading?.totals.idle).toBe(8100); // idle + iowait
    expect(reading?.totals.total).toBe(1000 + 0 + 500 + 8000 + 100 + 0 + 0 + 0);
  });

  it("treats a missing steal/guest tail as zero, not an error (older kernels)", () => {
    // Only four fields: user nice system idle.
    const text = ["cpu  1000 0 500 8000", "cpu0 250 0 125 2000"].join("\n");
    const reading = readCpuTotals(text);
    expect(reading?.cores).toBe(1);
    expect(reading?.totals.total).toBe(1000 + 0 + 500 + 8000);
    expect(reading?.totals.idle).toBe(8000);
  });

  it("returns null when there is no aggregate cpu line", () => {
    expect(readCpuTotals("intr 1 2 3\nctxt 4")).toBeNull();
  });

  it("returns null when there are no per-core lines", () => {
    expect(readCpuTotals("cpu  1000 0 500 8000 0 0 0 0")).toBeNull();
  });

  it("excludes guest/guest_nice from the total, since Linux already counts them in user/nice", () => {
    const withoutGuest = readCpuTotals(procStat([1000, 0, 500, 8000, 0, 0, 0, 0]));
    const text = ["cpu  1000 0 500 8000 0 0 0 0 300 50", "cpu0 250 0 125 2000 0 0 0 0 75 12"].join("\n");
    const withGuest = readCpuTotals(text);
    expect(withGuest?.totals.total).toBe(withoutGuest?.totals.total);
  });
});

describe("cpuUsedRatioFromDelta", () => {
  it("computes the fraction of total capacity busy between two readings", () => {
    const prev = { idle: 8000, total: 10_000 };
    const curr = { idle: 8900, total: 11_000 }; // +1000 total, +900 idle -> 100 busy
    expect(cpuUsedRatioFromDelta(prev, curr)).toBeCloseTo(0.1, 10);
  });

  it("returns 0 for an entirely idle interval and 1 for an entirely busy one", () => {
    expect(cpuUsedRatioFromDelta({ idle: 0, total: 0 }, { idle: 1000, total: 1000 })).toBe(0);
    expect(cpuUsedRatioFromDelta({ idle: 0, total: 0 }, { idle: 0, total: 1000 })).toBe(1);
  });

  it("never returns a ratio outside 0..1", () => {
    const ratio = cpuUsedRatioFromDelta({ idle: 100, total: 200 }, { idle: 105, total: 300 });
    expect(ratio).toBeGreaterThanOrEqual(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });

  it("returns null when the total counter wrapped (curr smaller than prev)", () => {
    // A 32-bit counter near its ceiling, then wrapped back near zero.
    const prev = { idle: 4_000_000_000, total: 4_294_967_290 };
    const curr = { idle: 50, total: 100 };
    expect(cpuUsedRatioFromDelta(prev, curr)).toBeNull();
  });

  it("returns null when two readings are identical (zero elapsed time)", () => {
    const totals = { idle: 500, total: 1000 };
    expect(cpuUsedRatioFromDelta(totals, totals)).toBeNull();
  });

  it("returns null when the idle delta does not fit inside the total delta (glitched pair)", () => {
    const prev = { idle: 100, total: 1000 };
    const curr = { idle: 5000, total: 1100 }; // idle grew more than total possibly could
    expect(cpuUsedRatioFromDelta(prev, curr)).toBeNull();
  });

  it("returns null when idle went backwards while total went forwards (also a glitch)", () => {
    const prev = { idle: 800, total: 1000 };
    const curr = { idle: 700, total: 1100 };
    expect(cpuUsedRatioFromDelta(prev, curr)).toBeNull();
  });
});
