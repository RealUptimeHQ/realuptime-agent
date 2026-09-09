import { describe, expect, it } from "vitest";
import {
  MAX_GPUS_PER_SAMPLE,
  NVIDIA_SMI_BINARY,
  NvidiaSmiCollector,
  parseNvidiaSmiCsv,
} from "./collect-gpu.ts";

const ONE_GPU_ROW = "0, NVIDIA A100-SXM4-40GB, 45, 2048, 40960, 62, 150.00, 400.00";
const TWO_GPU_ROWS = [
  "0, NVIDIA A100-SXM4-40GB, 45, 2048, 40960, 62, 150.00, 400.00",
  "1, NVIDIA A100-SXM4-40GB, 12, 512, 40960, 55, 90.50, 400.00",
].join("\n");

describe("parseNvidiaSmiCsv", () => {
  it("parses one GPU row into bytes, a 0..1 ratio, and pass-through fields", () => {
    const readings = parseNvidiaSmiCsv(ONE_GPU_ROW);
    expect(readings).toEqual([
      {
        index: 0,
        name: "NVIDIA A100-SXM4-40GB",
        utilizationRatio: 0.45,
        memoryUsedBytes: 2048 * 1024 * 1024,
        memoryTotalBytes: 40960 * 1024 * 1024,
        temperatureCelsius: 62,
        powerDrawWatts: 150,
        powerLimitWatts: 400,
      },
    ]);
  });

  it("parses multiple rows into an array, one entry per physical GPU", () => {
    const readings = parseNvidiaSmiCsv(TWO_GPU_ROWS);
    expect(readings).toHaveLength(2);
    expect(readings?.[0]?.index).toBe(0);
    expect(readings?.[1]?.index).toBe(1);
    expect(readings?.[1]?.utilizationRatio).toBeCloseTo(0.12);
  });

  it("reports power fields as null on nvidia-smi's own [N/A], not a fabricated zero", () => {
    const row = "0, Tesla T4, 10, 100, 16384, 40, [N/A], N/A";
    const readings = parseNvidiaSmiCsv(row);
    expect(readings).toEqual([
      expect.objectContaining({ powerDrawWatts: null, powerLimitWatts: null }),
    ]);
  });

  it("returns null on empty output", () => {
    expect(parseNvidiaSmiCsv("")).toBeNull();
    expect(parseNvidiaSmiCsv("\n\n")).toBeNull();
  });

  it("returns null on a malformed row rather than a half-filled reading", () => {
    expect(parseNvidiaSmiCsv("not,enough,columns")).toBeNull();
    expect(parseNvidiaSmiCsv("0, GPU, notanumber, 100, 16384, 40, 10, 70")).toBeNull();
    // usedBytes cannot exceed totalBytes, same rule as ServerDiskInput.
    expect(parseNvidiaSmiCsv("0, GPU, 10, 20000, 16384, 40, 10, 70")).toBeNull();
    // utilization out of the 0..100 range nvidia-smi documents.
    expect(parseNvidiaSmiCsv("0, GPU, 150, 100, 16384, 40, 10, 70")).toBeNull();
  });

  it("returns null past MAX_GPUS_PER_SAMPLE rows", () => {
    const rows = Array.from(
      { length: MAX_GPUS_PER_SAMPLE + 1 },
      (_, i) => `${i}, GPU ${i}, 10, 100, 16384, 40, 10, 70`,
    ).join("\n");
    expect(parseNvidiaSmiCsv(rows)).toBeNull();
  });
});

describe("NvidiaSmiCollector", () => {
  it("reports nothing (null) when nvidia-smi is not on PATH", async () => {
    const collector = new NvidiaSmiCollector({
      exec: async () => {
        const err: NodeJS.ErrnoException = new Error("not found");
        err.code = "ENOENT";
        throw err;
      },
    });
    expect(await collector.collect()).toBeNull();
  });

  it("caches the absent binary rather than re-spawning it every tick", async () => {
    let calls = 0;
    const collector = new NvidiaSmiCollector({
      exec: async () => {
        calls++;
        const err: NodeJS.ErrnoException = new Error("not found");
        err.code = "ENOENT";
        throw err;
      },
    });
    await collector.collect();
    await collector.collect();
    expect(calls).toBe(1);
  });

  it("runs the fixed nvidia-smi CSV query and returns parsed readings", async () => {
    let seenFile = "";
    let seenArgs: readonly string[] = [];
    const collector = new NvidiaSmiCollector({
      exec: async (file, args) => {
        seenFile = file;
        seenArgs = args;
        return ONE_GPU_ROW;
      },
    });
    const result = await collector.collect();
    expect(seenFile).toBe(NVIDIA_SMI_BINARY);
    expect(seenArgs.join(" ")).toContain("--format=csv,noheader,nounits");
    expect(result).toEqual([expect.objectContaining({ index: 0, name: "NVIDIA A100-SXM4-40GB" })]);
  });

  it("reports multiple GPUs as an array", async () => {
    const collector = new NvidiaSmiCollector({ exec: async () => TWO_GPU_ROWS });
    const result = await collector.collect();
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(2);
  });

  it("reports its own error state when nvidia-smi exists but exits non-zero", async () => {
    const collector = new NvidiaSmiCollector({
      exec: async () => {
        throw new Error(
          "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver",
        );
      },
    });
    const result = await collector.collect();
    expect(result).toEqual({ error: expect.stringContaining("nvidia-smi failed") });
  });

  it("reports its own error state when nvidia-smi's output does not parse", async () => {
    const collector = new NvidiaSmiCollector({ exec: async () => "garbage, not, csv, we, expect" });
    const result = await collector.collect();
    expect(result).toEqual({ error: expect.stringContaining("could not parse") });
  });

  it("refuses AMD without ever spawning a process, naming the gap plainly", async () => {
    let called = false;
    const collector = new NvidiaSmiCollector({
      vendor: "amd",
      exec: async () => {
        called = true;
        return ONE_GPU_ROW;
      },
    });
    const result = await collector.collect();
    expect(called).toBe(false);
    expect(result).toEqual({ error: expect.stringContaining("AMD") });
  });

  it("refuses Intel the same way", async () => {
    const collector = new NvidiaSmiCollector({ vendor: "intel", exec: async () => ONE_GPU_ROW });
    const result = await collector.collect();
    expect(result).toEqual({ error: expect.stringContaining("Intel") });
  });
});
