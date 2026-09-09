import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MetricsCollector } from "./collect-metrics.ts";
import { logSink } from "./log.ts";
import { FakeHostPlatform, linuxBaseline, statLine } from "./testdata/fake-platform.ts";

/**
 * The orchestrator over the per-OS seam (REA-181): collector choice, the
 * warm-up sample, the one-warning-then-silence rule when nothing can be
 * measured, the service watch list plumbing, and host identity. The
 * per-family parsing is covered in each collector's own test file.
 */

/** Every test below constructs a MetricsCollector directly; without this
 * injected no-op, the default GPU source would spawn a real `nvidia-smi`
 * process (harmlessly failing with ENOENT on a GPU-less test runner, but
 * not hermetic, and not what any of these tests are about). GPU collection
 * itself is covered in collect-gpu.test.ts. */
const NO_GPU = { collect: async () => null };

const lines: string[] = [];
const originalWrite = logSink.write;
beforeEach(() => {
  lines.length = 0;
  logSink.write = (line: string) => lines.push(line);
});
afterEach(() => {
  logSink.write = originalWrite;
});

describe("MetricsCollector", () => {
  it("returns null on the first call (baseline only) and a real sample on the second", async () => {
    const platform = linuxBaseline();
    const collector = new MetricsCollector({ platform, gpu: NO_GPU });

    expect(await collector.collect()).toBeNull();

    platform.files.set("/proc/stat", statLine(1200, 8900, 2));
    const sample = await collector.collect();
    expect(sample).not.toBeNull();
    expect(sample!.cpuUsedRatio).toBeGreaterThan(0);
    expect(sample!.cpuUsedRatio).toBeLessThanOrEqual(1);
    expect(sample!.cpuCores).toBe(2);
  });

  it("reports memory, load, and filesystems on a normal Linux sample", async () => {
    const platform = linuxBaseline();
    const collector = new MetricsCollector({ platform, gpu: NO_GPU });
    await collector.collect();
    platform.files.set("/proc/stat", statLine(1200, 8900, 2));

    const sample = (await collector.collect())!;
    expect(sample.memoryTotalBytes).toBe(16_384_000 * 1024);
    expect(sample.memoryUsedBytes).toBe((16_384_000 - 9_000_000) * 1024);
    expect(sample.load1).toBe(1.0);
    expect(sample.load5).toBe(0.5);
    expect(sample.load15).toBe(0.25);
    expect(sample.filesystems).toEqual([
      { mountPoint: "/", totalBytes: 4096 * 1000, usedBytes: 4096 * 500 },
    ]);
    // No v2 family is fabricated when the source files are absent.
    expect(sample.network).toBeUndefined();
    expect(sample.processes).toBeUndefined();
    expect(sample.containers).toBeUndefined();
    expect(sample.services).toBeUndefined();
  });

  it("sends load as null when /proc/loadavg is unreadable, never as fabricated zeroes", async () => {
    const platform = linuxBaseline();
    platform.files.delete("/proc/loadavg");
    const collector = new MetricsCollector({ platform, gpu: NO_GPU });
    await collector.collect();
    platform.files.set("/proc/stat", statLine(1200, 8900, 2));
    const sample = (await collector.collect())!;
    expect(sample.load1).toBeNull();
    expect(sample.load5).toBeNull();
    expect(sample.load15).toBeNull();
  });

  it("returns null and logs exactly once when /proc is entirely absent on a Linux host", async () => {
    const platform = new FakeHostPlatform("linux"); // /proc/stat not present
    const collector = new MetricsCollector({ platform, gpu: NO_GPU });

    expect(await collector.collect()).toBeNull();
    expect(await collector.collect()).toBeNull();
    expect(await collector.collect()).toBeNull();

    expect(lines.filter((l) => l.includes("/proc not found"))).toHaveLength(1);
  });

  it("does not touch the filesystem again after /proc is found absent once", async () => {
    const platform = new FakeHostPlatform("linux");
    const collector = new MetricsCollector({ platform, gpu: NO_GPU });
    await collector.collect();
    const callsAfterFirst = platform.existsCalls.length;
    await collector.collect();
    await collector.collect();
    expect(platform.existsCalls.length).toBe(callsAfterFirst);
  });

  it("returns null and logs once on an operating system with no collector, with checks unaffected", async () => {
    const platform = new FakeHostPlatform("other");
    const collector = new MetricsCollector({ platform, gpu: NO_GPU });
    expect(await collector.collect()).toBeNull();
    expect(await collector.collect()).toBeNull();
    expect(lines.filter((l) => l.includes("no collector for this operating system"))).toHaveLength(
      1,
    );
    expect(await collector.hostInfo()).toBeNull();
    expect(collector.vantage()).toEqual({ vantage: "host", detail: null });
  });

  it("returns null and warns once for an unparseable /proc/stat, without crashing", async () => {
    const platform = linuxBaseline();
    platform.files.set("/proc/stat", "garbage\n");
    const collector = new MetricsCollector({ platform, gpu: NO_GPU });
    expect(await collector.collect()).toBeNull();
    expect(await collector.collect()).toBeNull();
    expect(lines.filter((l) => l.includes("could not parse /proc/stat"))).toHaveLength(1);
  });

  it("skips a bad mount but still reports the sample", async () => {
    const platform = linuxBaseline();
    platform.files.set(
      "/proc/mounts",
      ["/dev/sda1 / ext4 rw 0 0", "/dev/sdb1 /broken xfs rw 0 0"].join("\n"),
    );
    const collector = new MetricsCollector({ platform, gpu: NO_GPU });
    await collector.collect();
    platform.files.set("/proc/stat", statLine(1200, 8900, 2));
    const sample = (await collector.collect())!;
    expect(sample.filesystems.map((f) => f.mountPoint)).toEqual(["/"]);
  });

  it("normalises the service watch list before any collector sees it", async () => {
    const platform = linuxBaseline();
    platform.exists.add("/run/systemd/units");
    platform.exists.add("/run/systemd/units/invocation:nginx.service");
    const collector = new MetricsCollector({ platform, gpu: NO_GPU });
    collector.setServiceWatch(["nginx", "../../etc/passwd", "", 42, "nginx", "sshd.service"]);
    await collector.collect();
    platform.files.set("/proc/stat", statLine(1200, 8900, 2));
    const sample = (await collector.collect())!;
    expect(sample.services).toEqual([
      { name: "nginx", status: "active" },
      { name: "sshd.service", status: "inactive" },
    ]);
    // The traversal attempt never became a path.
    expect(platform.existsCalls.some((p) => p.includes(".."))).toBe(false);
  });

  it("describes the host once, with the two labels layered on top of what the collector knows", async () => {
    const platform = linuxBaseline();
    platform.files.set("/etc/os-release", 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n');
    const collector = new MetricsCollector({
      platform,
      cluster: "prod-eu",
      node: null,
      gpu: NO_GPU,
    });
    const info = await collector.hostInfo();
    expect(info).toEqual({
      hostname: "fixture-host",
      os: "linux",
      osVersion: "Ubuntu 24.04.1 LTS (6.8.0)",
      arch: "x64",
      cluster: "prod-eu",
      node: "fixture-host",
    });
    expect(await collector.hostInfo()).toBe(info); // cached
  });

  describe("vantage()", () => {
    it("detects a container from /.dockerenv and caches the result", async () => {
      const platform = linuxBaseline();
      platform.exists.add("/.dockerenv");
      const collector = new MetricsCollector({ platform, gpu: NO_GPU });

      expect(collector.vantage()).toEqual({ vantage: "container", detail: "docker" });
      const callsAfterFirst = platform.existsCalls.filter((p) => p === "/.dockerenv").length;
      collector.vantage();
      collector.vantage();
      const callsAfterMore = platform.existsCalls.filter((p) => p === "/.dockerenv").length;
      expect(callsAfterMore).toBe(callsAfterFirst); // detection ran once, not three times
    });

    it("detects host when nothing indicates a container", () => {
      const platform = linuxBaseline();
      const collector = new MetricsCollector({ platform, gpu: NO_GPU });
      expect(collector.vantage()).toEqual({ vantage: "host", detail: null });
    });
  });

  describe("GPU wiring", () => {
    it("attaches GPU readings onto the sample when the source reports them", async () => {
      const platform = linuxBaseline();
      const reading = {
        index: 0,
        name: "NVIDIA A100-SXM4-40GB",
        utilizationRatio: 0.5,
        memoryUsedBytes: 1024,
        memoryTotalBytes: 2048,
        temperatureCelsius: 60,
        powerDrawWatts: 100,
        powerLimitWatts: 300,
      };
      const gpu = { collect: async () => [reading] };
      const collector = new MetricsCollector({ platform, gpu });
      await collector.collect();
      platform.files.set("/proc/stat", statLine(1200, 8900, 2));
      const sample = await collector.collect();
      expect(sample?.gpu).toEqual([reading]);
    });

    it("attaches an error state onto the sample without dropping the core reading", async () => {
      const platform = linuxBaseline();
      const gpu = { collect: async () => ({ error: "nvidia-smi failed: timed out" }) };
      const collector = new MetricsCollector({ platform, gpu });
      await collector.collect();
      platform.files.set("/proc/stat", statLine(1200, 8900, 2));
      const sample = await collector.collect();
      expect(sample?.gpu).toEqual({ error: "nvidia-smi failed: timed out" });
      expect(sample?.cpuUsedRatio).toBeGreaterThan(0);
    });

    it("leaves gpu absent, never fabricated, when the source has nothing to report", async () => {
      const platform = linuxBaseline();
      const collector = new MetricsCollector({ platform, gpu: NO_GPU });
      await collector.collect();
      platform.files.set("/proc/stat", statLine(1200, 8900, 2));
      const sample = await collector.collect();
      expect(sample?.gpu).toBeUndefined();
    });

    it("logs once and continues the core sample when the injected GPU source throws", async () => {
      const platform = linuxBaseline();
      const gpu = {
        collect: async () => {
          throw new Error("boom");
        },
      };
      const collector = new MetricsCollector({ platform, gpu });
      await collector.collect();
      platform.files.set("/proc/stat", statLine(1200, 8900, 2));
      const sample = await collector.collect();
      expect(sample).not.toBeNull();
      expect(sample?.gpu).toBeUndefined();
      expect(lines.some((l) => l.includes("GPU metrics collection failed"))).toBe(true);
    });
  });
});
