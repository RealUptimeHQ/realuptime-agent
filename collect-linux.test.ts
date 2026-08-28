import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOST_MOUNT_ROOT, LinuxCollector } from "./collect-linux.ts";
import { linuxBaseline, statLine } from "./testdata/fake-platform.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(HERE, "testdata", name), "utf8");

/** A process stat line: pid, comm, then the 50-odd fields; only utime(14),
 * stime(15) and rss(24) matter and the rest are stand-ins. */
function procStat(pid: number, comm: string, utime: number, stime: number, rssPages: number): string {
  const fields = new Array(52).fill("0");
  fields[0] = "S"; // state (field 3)
  fields[11] = String(utime); // field 14
  fields[12] = String(stime); // field 15
  fields[21] = String(rssPages); // field 24
  return `${pid} (${comm}) ${fields.join(" ")}\n`;
}

function withNetwork(p = linuxBaseline()) {
  p.files.set("/proc/net/dev", fixture("proc-net-dev.txt"));
  return p;
}

describe("LinuxCollector: the four v2 families, from files only", () => {
  const warnings: string[] = [];
  const warn = (_key: string, message: string) => {
    warnings.push(message);
  };

  it("reports per-interface rates from two /proc/net/dev readings, loopback excluded", async () => {
    const p = withNetwork();
    const c = new LinuxCollector(p, warn);
    p.clock = 0;
    expect(await c.collect([])).toBeNull(); // warm-up
    p.clock = 60_000;
    p.files.set("/proc/stat", statLine(1200, 8900, 2));
    p.files.set("/proc/net/dev", fixture("proc-net-dev-later.txt"));
    const sample = (await c.collect([]))!;
    expect(sample.network).toEqual([
      { name: "eth0", rxBytesPerSec: 100_000, txBytesPerSec: 50_000, rxErrors: 0, txErrors: 1, rxDropped: 0, txDropped: 0 },
      { name: "docker0", rxBytesPerSec: 0, txBytesPerSec: 0, rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0 },
    ]);
    expect(p.execCalls).toEqual([]); // Linux never runs a command
  });

  it("reports top processes by CPU and memory as a fraction of total capacity, names only", async () => {
    const p = linuxBaseline();
    p.dirs.set("/proc", ["1", "42", "self", "stat", "99"]);
    p.files.set("/proc/1/stat", procStat(1, "systemd", 10, 5, 1000));
    p.files.set("/proc/42/stat", procStat(42, "postgres: writer", 100, 50, 50_000));
    p.files.set("/proc/99/stat", procStat(99, "node", 0, 0, 20_000));
    const c = new LinuxCollector(p, warn);
    await c.collect([]);
    // Total CPU delta: user 1000->1200, idle 8000->8900 = 1100 jiffies.
    p.files.set("/proc/stat", statLine(1200, 8900, 2));
    p.files.set("/proc/42/stat", procStat(42, "postgres: writer", 600, 100, 50_000)); // +550
    p.files.set("/proc/99/stat", procStat(99, "node", 110, 0, 20_000)); // +110
    const sample = (await c.collect([]))!;
    expect(sample.processes?.[0]).toEqual({ pid: 42, name: "postgres: writer", cpuRatio: 0.5, memoryBytes: 50_000 * 4096 });
    expect(sample.processes?.[1]).toEqual({ pid: 99, name: "node", cpuRatio: 0.1, memoryBytes: 20_000 * 4096 });
    expect(sample.processes?.map((x) => x.pid)).toEqual([42, 99, 1]);
    // Only /proc/<pid>/stat was read, never cmdline or environ.
    expect(p.readCalls.filter((r) => /\/proc\/\d+\//.test(r)).every((r) => r.endsWith("/stat"))).toBe(true);
  });

  it("reads containers from cgroup v2, with CPU as a delta of usage_usec against elapsed capacity", async () => {
    const p = linuxBaseline();
    const id = "a".repeat(64);
    p.addTree("/sys/fs/cgroup", {
      "cgroup.controllers": "cpu memory",
      "cgroup.procs": "",
      "system.slice/cpu.stat": "usage_usec 1\n",
      [`system.slice/docker-${id}.scope/cpu.stat`]: "usage_usec 1000000\nuser_usec 1\n",
      [`system.slice/docker-${id}.scope/memory.current`]: "104857600\n",
      [`system.slice/docker-${id}.scope/memory.max`]: "max\n",
      "kubepods.slice/kubepods-burstable.slice/kubepods-burstable-podabc.slice/cri-containerd-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.scope/cpu.stat":
        "usage_usec 500000\n",
      "kubepods.slice/kubepods-burstable.slice/kubepods-burstable-podabc.slice/cri-containerd-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.scope/memory.current":
        "2048\n",
      "kubepods.slice/kubepods-burstable.slice/kubepods-burstable-podabc.slice/cri-containerd-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.scope/memory.max":
        "536870912\n",
    });
    const c = new LinuxCollector(p, warn);
    p.clock = 0;
    await c.collect([]);
    p.clock = 10_000; // 10 s on 2 cores = 20 s of capacity
    p.files.set("/proc/stat", statLine(1200, 8900, 2));
    p.files.set(`/sys/fs/cgroup/system.slice/docker-${id}.scope/cpu.stat`, "usage_usec 3000000\n"); // +2 s
    const sample = (await c.collect([]))!;
    expect(sample.containers).toEqual([
      { id, name: null, runtime: "docker", cpuRatio: 0.1, memoryUsedBytes: 104_857_600, memoryLimitBytes: null },
      { id: "b".repeat(64), name: null, runtime: "kubernetes", cpuRatio: 0, memoryUsedBytes: 2048, memoryLimitBytes: 536_870_912 },
    ]);
  });

  it("reports nothing for containers on a cgroup v1 host rather than guessing", async () => {
    const p = linuxBaseline();
    p.dirs.set("/sys/fs/cgroup", ["cpu", "memory"]); // v1: no cgroup.controllers
    const c = new LinuxCollector(p, warn);
    await c.collect([]);
    p.files.set("/proc/stat", statLine(1200, 8900, 2));
    expect((await c.collect([]))!.containers).toBeUndefined();
  });

  it("answers service status from systemd's invocation links, never by running anything", async () => {
    const p = linuxBaseline();
    p.exists.add("/run/systemd/units");
    p.exists.add("/run/systemd/units/invocation:nginx.service");
    p.exists.add("/run/systemd/units/invocation:postgresql@16.service");
    const c = new LinuxCollector(p, warn);
    await c.collect(["nginx", "postgresql@16", "redis.service"]);
    p.files.set("/proc/stat", statLine(1200, 8900, 2));
    const sample = (await c.collect(["nginx", "postgresql@16", "redis.service"]))!;
    expect(sample.services).toEqual([
      { name: "nginx", status: "active" },
      { name: "postgresql@16", status: "active" },
      { name: "redis.service", status: "inactive" },
    ]);
    expect(p.execCalls).toEqual([]);
  });

  it("reports unknown for every watched service on a host without systemd", async () => {
    const p = linuxBaseline();
    const c = new LinuxCollector(p, warn);
    await c.collect(["nginx"]);
    p.files.set("/proc/stat", statLine(1200, 8900, 2));
    expect((await c.collect(["nginx"]))!.services).toEqual([{ name: "nginx", status: "unknown" }]);
  });

  describe("the DaemonSet host mount", () => {
    it("reads the node's /proc, /sys and /run under /host, statfs's under /host, and reports vantage host", async () => {
      const p = linuxBaseline();
      // Move every fixture under /host; the container's own /proc stays
      // present to prove it is NOT what gets read.
      for (const path of ["/proc/stat", "/proc/meminfo", "/proc/loadavg", "/proc/mounts"]) {
        p.files.set(`${HOST_MOUNT_ROOT}${path}`, p.files.get(path)!);
      }
      p.exists.add(`${HOST_MOUNT_ROOT}/proc/stat`);
      p.exists.add("/.dockerenv"); // this process IS in a container
      p.statfsResults.set(`${HOST_MOUNT_ROOT}/`, { bsize: 4096, blocks: 2000, bfree: 1000 });
      p.files.set(`${HOST_MOUNT_ROOT}/proc/stat`, statLine(5000, 5000, 4));
      const c = new LinuxCollector(p, warn);
      expect(c.vantage()).toEqual({ vantage: "host", detail: "host-mount" });
      await c.collect([]);
      p.files.set(`${HOST_MOUNT_ROOT}/proc/stat`, statLine(5100, 5900, 4));
      const sample = (await c.collect([]))!;
      expect(sample.cpuCores).toBe(4); // the host's four cores, not the container's two
      expect(sample.filesystems).toEqual([{ mountPoint: "/", totalBytes: 4096 * 2000, usedBytes: 4096 * 1000 }]);
      expect(p.readCalls.some((r) => r === "/proc/stat")).toBe(false);
    });
  });
});
