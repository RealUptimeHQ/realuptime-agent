import { describe, expect, it } from "vitest";
import { parseMemInfo } from "./collect-memory.ts";

const MODERN_MEMINFO = `MemTotal:       16384000 kB
MemFree:          512000 kB
MemAvailable:    9000000 kB
Buffers:          200000 kB
Cached:          6000000 kB
SwapTotal:       2048000 kB
SwapFree:        2048000 kB
`;

describe("parseMemInfo", () => {
  it("computes used as total minus AVAILABLE, not total minus free", () => {
    const mem = parseMemInfo(MODERN_MEMINFO);
    expect(mem?.totalBytes).toBe(16_384_000 * 1024);
    // If this used MemFree instead, usedBytes would be far larger and a
    // healthy machine (lots of free-looking cache) would read as almost
    // full.
    expect(mem?.usedBytes).toBe((16_384_000 - 9_000_000) * 1024);
  });

  it("falls back to free+buffers+cached when MemAvailable is absent (pre-3.14 kernel)", () => {
    const text = `MemTotal:       8000000 kB
MemFree:        1000000 kB
Buffers:         200000 kB
Cached:         3000000 kB
`;
    const mem = parseMemInfo(text);
    expect(mem?.totalBytes).toBe(8_000_000 * 1024);
    const expectedAvailable = 1_000_000 + 200_000 + 3_000_000;
    expect(mem?.usedBytes).toBe((8_000_000 - expectedAvailable) * 1024);
  });

  it("returns null when MemTotal is missing", () => {
    expect(parseMemInfo("MemFree: 100 kB\n")).toBeNull();
  });

  it("never reports usedBytes above totalBytes, even from a bogus reading", () => {
    const text = `MemTotal:       1000 kB
MemAvailable:  50000 kB
`;
    const mem = parseMemInfo(text);
    expect(mem?.usedBytes).toBe(0);
    expect(mem?.usedBytes).toBeLessThanOrEqual(mem!.totalBytes);
  });
});
