import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DarwinCollector, cpuRatioFromTimes, parseDfPk, parseVmStat } from "./collect-darwin.ts";
import { ALLOWED_COMMANDS } from "./platform.ts";
import { FakeHostPlatform } from "./testdata/fake-platform.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(HERE, "testdata", name), "utf8");

function macPlatform(): FakeHostPlatform {
  const p = new FakeHostPlatform("darwin");
  p.cpu = [
    { user: 1000, nice: 0, sys: 500, idle: 8500, irq: 0 },
    { user: 1000, nice: 0, sys: 500, idle: 8500, irq: 0 },
  ];
  p.memTotal = 32 * 1024 ** 3;
  p.load = [2.5, 2.0, 1.5];
  p.commands.set("vm_stat", fixture("vm_stat.txt"));
  p.commands.set("df -Pk", fixture("df-Pk.txt"));
  p.commands.set("netstat -ibn", fixture("netstat-ibn.txt"));
  p.commands.set("ps -Aceo pid=,pcpu=,rss=,comm=", fixture("ps-Aceo.txt"));
  p.commands.set("launchctl list", fixture("launchctl-list.txt"));
  p.commands.set("sw_vers -productVersion", "15.6\n");
  p.kernel = "24.6.0";
  p.cpuArch = "arm64";
  return p;
}

describe("macOS parsers", () => {
  it("vm_stat: available = free + inactive + speculative + purgeable pages x page size", () => {
    expect(parseVmStat(fixture("vm_stat.txt"))).toBe((12345 + 300000 + 20000 + 30000) * 16384);
    expect(parseVmStat("garbage")).toBeNull();
  });

  it("df -Pk: real volumes only, Apple's system volumes and devfs/autofs excluded, spaces in mount points kept", () => {
    const disks = parseDfPk(fixture("df-Pk.txt"));
    expect(disks.map((d) => d.mountPoint)).toEqual(["/Volumes/Time Machine", "/", "/System/Volumes/Data"]);
    expect(disks[1]).toEqual({ mountPoint: "/", totalBytes: 971350180 * 1024, usedBytes: 10485760 * 1024 });
  });

  it("cpuRatioFromTimes: fraction of total capacity across cores, refusing a wrapped reading", () => {
    const a = [{ user: 100, nice: 0, sys: 0, idle: 900, irq: 0 }];
    const b = [{ user: 400, nice: 0, sys: 200, idle: 1400, irq: 0 }];
    expect(cpuRatioFromTimes(a, b)).toEqual({ ratio: 0.5, cores: 1 });
    expect(cpuRatioFromTimes(b, a)).toBeNull();
    expect(cpuRatioFromTimes(a, a)).toBeNull();
  });
});

describe("DarwinCollector", () => {
  const warnings: string[] = [];
  const warn = (_k: string, m: string) => {
    warnings.push(m);
  };

  it("produces a full v2 sample from the os module plus the allow-listed commands, warm-up first", async () => {
    const p = macPlatform();
    const c = new DarwinCollector(p, warn);
    p.clock = 0;
    expect(await c.collect(["com.apple.sshd", "io.realuptime.agent", "com.example.broken", "com.nope"])).toBeNull();

    p.clock = 60_000;
    p.cpu = [
      { user: 1300, nice: 0, sys: 600, idle: 9100, irq: 0 },
      { user: 1100, nice: 0, sys: 500, idle: 9400, irq: 0 },
    ];
    p.commands.set("netstat -ibn", fixture("netstat-ibn-later.txt"));
    const s = (await c.collect(["com.apple.sshd", "io.realuptime.agent", "com.example.broken", "com.nope"]))!;

    expect(s.cpuCores).toBe(2);
    expect(s.cpuUsedRatio).toBeCloseTo(500 / 2000, 5);
    expect(s.memoryTotalBytes).toBe(32 * 1024 ** 3);
    expect(s.memoryUsedBytes).toBe(32 * 1024 ** 3 - (12345 + 300000 + 20000 + 30000) * 16384);
    expect([s.load1, s.load5, s.load15]).toEqual([2.5, 2.0, 1.5]);
    expect(s.filesystems.map((d) => d.mountPoint)).toContain("/");
    expect(s.network).toEqual([
      { name: "en0", rxBytesPerSec: 1_000_000, txBytesPerSec: 500_000, rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0 },
      { name: "utun0", rxBytesPerSec: 0, txBytesPerSec: 0, rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0 },
    ]);
    // ps: 45% of one core on 2 cores = 0.225 of capacity; the name keeps the
    // bare command even with spaces and parentheses.
    expect(s.processes?.[0]).toEqual({ pid: 1200, name: "Google Chrome Helper (Renderer)", cpuRatio: 0.225, memoryBytes: 409600 * 1024 });
    expect(s.processes?.some((x) => x.name === "java")).toBe(true); // top by memory
    expect(s.containers).toBeUndefined();
    expect(s.services).toEqual([
      { name: "com.apple.sshd", status: "inactive" },
      { name: "io.realuptime.agent", status: "active" },
      { name: "com.example.broken", status: "failed" },
      { name: "com.nope", status: "inactive" },
    ]);
  });

  it("only ever runs the allow-listed programs, with fixed arguments, and no watched name reaches a command line", async () => {
    const p = macPlatform();
    const c = new DarwinCollector(p, warn);
    await c.collect(["com.apple.sshd"]);
    p.cpu = p.cpu.map((t) => ({ ...t, user: t.user + 100, idle: t.idle + 100 }));
    await c.collect(["com.apple.sshd"]);
    await c.hostInfo();
    for (const call of p.execCalls) {
      const [file] = call.split(" ");
      expect(ALLOWED_COMMANDS.darwin).toContain(file);
      expect(call).not.toContain("com.apple.sshd");
    }
    expect(new Set(p.execCalls)).toEqual(
      new Set(["netstat -ibn", "vm_stat", "df -Pk", "ps -Aceo pid=,pcpu=,rss=,comm=", "launchctl list", "sw_vers -productVersion"]),
    );
  });

  it("falls back to free pages with one warning when vm_stat fails, and keeps the sample", async () => {
    const p = macPlatform();
    p.commands.set("vm_stat", new Error("not found"));
    p.memFree = 1024 ** 3;
    const c = new DarwinCollector(p, warn);
    await c.collect([]);
    p.cpu = p.cpu.map((t) => ({ ...t, user: t.user + 100, idle: t.idle + 100 }));
    const s = (await c.collect([]))!;
    expect(s.memoryUsedBytes).toBe(32 * 1024 ** 3 - 1024 ** 3);
  });

  it("describes the host with the product version, resolved once", async () => {
    const p = macPlatform();
    const c = new DarwinCollector(p, warn);
    expect(await c.hostInfo()).toEqual({ os: "darwin", osVersion: "macOS 15.6 (24.6.0)", arch: "arm64", hostname: "fixture-host" });
    await c.hostInfo();
    expect(p.execCalls.filter((x) => x.startsWith("sw_vers"))).toHaveLength(1);
    expect(c.vantage()).toEqual({ vantage: "host", detail: null });
  });
});
