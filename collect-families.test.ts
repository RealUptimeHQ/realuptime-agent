import { describe, expect, it } from "vitest";
import { classifyCgroupDir, containerSamples, parseCpuStatUsageUsec, parseMemoryMax, walkCgroupTree } from "./collect-containers.ts";
import { MAX_NETWORK_INTERFACES_PER_SAMPLE, parseProcNetDev, parseWindowsNetAdapters, ratesFromCounters } from "./collect-network.ts";
import { MAX_PROCESSES_PER_SAMPLE, parseProcPidStat, topProcesses } from "./collect-processes.ts";
import {
  MAX_WATCHED_SERVICES,
  linuxServiceStatus,
  normalizeServiceName,
  normalizeWatchList,
  parseLaunchctlList,
  parseWindowsServices,
  statusesFor,
  systemdUnitName,
} from "./collect-services.ts";
import { ALLOWED_COMMANDS, RealHostPlatform, safePathSegment } from "./platform.ts";

/**
 * The pure pieces of the four v2 families and the platform seam, each with
 * the edge that would otherwise turn into a wrong chart or an unsafe read:
 * counters that go backwards, a pid reused, a cap that must stay
 * deterministic, a name that must never become a path or an argument.
 */

describe("network", () => {
  it("a counter that goes backwards yields nothing for that interface, not a negative rate", () => {
    const a = [{ name: "eth0", rxBytes: 1000, txBytes: 1000, rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0 }];
    const b = [{ name: "eth0", rxBytes: 500, txBytes: 2000, rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0 }];
    expect(ratesFromCounters(a, b, 1000)).toEqual([]);
    expect(ratesFromCounters(a, a, 0)).toEqual([]);
  });

  it("an interface seen for the first time has no rate yet", () => {
    const a = [{ name: "eth0", rxBytes: 0, txBytes: 0, rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0 }];
    const b = [...a, { name: "eth1", rxBytes: 5, txBytes: 5, rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0 }];
    expect(ratesFromCounters(a, b, 1000).map((s) => s.name)).toEqual(["eth0"]);
  });

  it("caps at the server's limit, busiest first, deterministically", () => {
    const mk = (i: number, bytes: number) => ({ name: `if${i}`, rxBytes: bytes, txBytes: 0, rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0 });
    const prev = Array.from({ length: 40 }, (_, i) => mk(i, 0));
    const curr = Array.from({ length: 40 }, (_, i) => mk(i, 1000 * (i + 1)));
    const out = ratesFromCounters(prev, curr, 1000);
    expect(out).toHaveLength(MAX_NETWORK_INTERFACES_PER_SAMPLE);
    expect(out[0]!.name).toBe("if39");
  });

  it("/proc/net/dev tolerates a missing or malformed line", () => {
    expect(parseProcNetDev("garbage\n  eth0: 1 2\n")).toEqual([]);
  });

  it("Windows rows with missing numbers read as zero counters, not NaN", () => {
    expect(parseWindowsNetAdapters([{ Name: "Ethernet" }])[0]).toMatchObject({ rxBytes: 0, txBytes: 0 });
    expect(parseWindowsNetAdapters("nope")).toEqual([]);
  });
});

describe("processes", () => {
  it("parses a comm with spaces and parentheses by cutting at the last paren", () => {
    const fields = new Array(52).fill("0");
    fields[11] = "7";
    fields[12] = "3";
    fields[21] = "10";
    const r = parseProcPidStat(`77 (tmux: server (2)) ${fields.join(" ")}`, 4096)!;
    expect(r).toEqual({ pid: 77, name: "tmux: server (2)", cpuTime: 10, cpuRatio: null, memoryBytes: 40960 });
    expect(parseProcPidStat("garbage", 4096)).toBeNull();
  });

  it("a reused pid (cpu time went backwards) competes on memory only", () => {
    const readings = [{ pid: 1, name: "a", cpuTime: 5, cpuRatio: null, memoryBytes: 1 }];
    const out = topProcesses(readings, new Map([[1, 50]]), 100);
    expect(out).toEqual([{ pid: 1, name: "a", cpuRatio: 0, memoryBytes: 1 }]);
  });

  it("merges top-by-cpu and top-by-memory, deduped, within the cap", () => {
    const readings = Array.from({ length: 50 }, (_, i) => ({
      pid: i + 1,
      name: `p${i + 1}`,
      cpuTime: i, // higher pid, more cpu
      cpuRatio: null,
      memoryBytes: 1000 - i, // lower pid, more memory
    }));
    const prev = new Map(readings.map((r) => [r.pid, 0]));
    const out = topProcesses(readings, prev, 100);
    expect(out.length).toBeLessThanOrEqual(MAX_PROCESSES_PER_SAMPLE);
    expect(out.map((p) => p.pid)).toContain(50); // top cpu
    expect(out.map((p) => p.pid)).toContain(1); // top memory
    expect(new Set(out.map((p) => p.pid)).size).toBe(out.length);
  });
});

describe("containers", () => {
  it("classifies runtime scope names and promotes kubepods children to kubernetes", () => {
    const id = "c".repeat(64);
    expect(classifyCgroupDir("system.slice", `docker-${id}.scope`)).toMatchObject({ runtime: "docker", id, name: null });
    expect(classifyCgroupDir("kubepods.slice/kubepods-besteffort.slice/x.slice", `cri-containerd-${id}.scope`)).toMatchObject({ runtime: "kubernetes" });
    expect(classifyCgroupDir("machine.slice", `libpod-${id}.scope`)).toMatchObject({ runtime: "podman" });
    expect(classifyCgroupDir("docker", id)).toMatchObject({ runtime: "docker", id });
    expect(classifyCgroupDir("lxc.payload.web", "lxc.payload.web")).toMatchObject({ runtime: "lxc", name: "web" });
    expect(classifyCgroupDir("system.slice", "nginx.service")).toBeNull();
  });

  it("parses cpu.stat and memory.max, including the unlimited sentinel", () => {
    expect(parseCpuStatUsageUsec("usage_usec 123\nuser_usec 100\n")).toBe(123);
    expect(parseCpuStatUsageUsec("")).toBeNull();
    expect(parseMemoryMax("max\n")).toBeNull();
    expect(parseMemoryMax("1024\n")).toBe(1024);
  });

  it("a container whose usage counter went backwards reports null cpu, and the list is capped by memory", () => {
    const readings = Array.from({ length: 70 }, (_, i) => ({
      container: { path: `p${i}`, id: `id${i}`, name: null, runtime: "docker" as const },
      usageUsec: 10,
      memoryCurrent: i,
      memoryMax: null,
    }));
    const prev = new Map([["p0", 20]]);
    const out = containerSamples(readings, prev, 1000, 1);
    expect(out).toHaveLength(64);
    expect(out[0]!.memoryUsedBytes).toBe(69);
    expect(out.find((c) => c.id === "id0")).toBeUndefined(); // cut by the cap, lowest memory
    expect(containerSamples(readings.slice(0, 1), prev, 1000, 1)[0]!.cpuRatio).toBeNull();
  });

  it("the tree walk is bounded and skips control files without reading them", () => {
    const dirs = new Map<string, string[]>([["/cg", ["cgroup.controllers", "cpu.stat", "deep0"]]]);
    for (let i = 0; i < 20; i++) dirs.set(`/cg/${Array.from({ length: i + 1 }, (_, j) => `deep${j}`).join("/")}`, [`deep${i + 1}`]);
    const reads: string[] = [];
    const out = walkCgroupTree(
      "/cg",
      (p) => dirs.get(p) ?? [],
      (p) => {
        reads.push(p);
        throw new Error("no file");
      },
    );
    expect(out).toEqual([]);
    expect(reads).toEqual([]);
  });
});

describe("services", () => {
  it("accepts unit and service names and refuses anything that could be a path", () => {
    expect(normalizeServiceName(" nginx ")).toBe("nginx");
    expect(normalizeServiceName("postgresql@16.service")).toBe("postgresql@16.service");
    expect(normalizeServiceName("com.apple.sshd")).toBe("com.apple.sshd");
    expect(normalizeServiceName("SQL Server (MSSQLSERVER)")).toBeNull(); // parentheses are out; use the short name
    expect(normalizeServiceName("../../etc/passwd")).toBeNull();
    expect(normalizeServiceName("a/b")).toBeNull();
    expect(normalizeServiceName("")).toBeNull();
    expect(normalizeServiceName("x".repeat(200))).toBeNull();
  });

  it("dedupes and caps the watch list", () => {
    const out = normalizeWatchList([...Array.from({ length: 100 }, (_, i) => `svc${i}`), "svc0"]);
    expect(out).toHaveLength(MAX_WATCHED_SERVICES);
  });

  it("systemd names get .service unless a unit type is already present", () => {
    expect(systemdUnitName("nginx")).toBe("nginx.service");
    expect(systemdUnitName("docker.socket")).toBe("docker.socket");
  });

  it("linux status reads the invocation link and never builds a path from a bad name", () => {
    const seen: string[] = [];
    const exists = (p: string) => {
      seen.push(p);
      return p === "/run/systemd/units" || p === "/run/systemd/units/invocation:nginx.service";
    };
    expect(linuxServiceStatus(["nginx", "redis"], "/run", exists)).toEqual([
      { name: "nginx", status: "active" },
      { name: "redis", status: "inactive" },
    ]);
    expect(seen).not.toContain("/run/systemd/units/invocation:..");
  });

  it("launchctl and Get-Service listings map to the three-state status", () => {
    const mac = parseLaunchctlList("PID\tStatus\tLabel\n12\t0\ta\n-\t0\tb\n-\t3\tc\n");
    expect(statusesFor(["a", "b", "c", "d"], mac)).toEqual([
      { name: "a", status: "active" },
      { name: "b", status: "inactive" },
      { name: "c", status: "failed" },
      { name: "d", status: "inactive" },
    ]);
    const win = parseWindowsServices([{ Name: "Spooler", Status: "Running" }, { Name: "W32Time", Status: "StartPending" }]);
    expect(statusesFor(["spooler", "w32time"], win, true)).toEqual([
      { name: "spooler", status: "active" },
      { name: "w32time", status: "unknown" },
    ]);
  });
});

describe("platform seam", () => {
  it("safePathSegment admits pids, unit names and cgroup scopes and refuses separators and dot-dot", () => {
    expect(safePathSegment("1234")).toBe(true);
    expect(safePathSegment("docker-abc.scope")).toBe(true);
    expect(safePathSegment("postgresql@16.service")).toBe(true);
    expect(safePathSegment("../x")).toBe(false);
    expect(safePathSegment("a/b")).toBe(false);
    expect(safePathSegment("")).toBe(false);
  });

  it("exec refuses any program outside the per-OS allow-list before touching the system", async () => {
    const linux = new RealHostPlatform("linux");
    await expect(linux.exec("sh", ["-c", "true"])).rejects.toThrow(/not an allow-listed command/);
    const mac = new RealHostPlatform("darwin");
    await expect(mac.exec("curl", ["https://example.com"])).rejects.toThrow(/not an allow-listed command/);
    // Every core metric reading (CPU/memory/disk/network/processes/
    // containers) still runs no command on Linux at all. journalctl and
    // docker are the one opt-in exception (REA-440, log snapshots phase 1,
    // collect-logs.ts) and only fire on an explicit snapshot request; the
    // other two lists are short and stock.
    expect(ALLOWED_COMMANDS.linux).toEqual(["journalctl", "docker"]);
    expect(ALLOWED_COMMANDS.darwin).toEqual(["vm_stat", "df", "netstat", "ps", "launchctl", "sw_vers"]);
    expect(ALLOWED_COMMANDS.windows).toEqual(["powershell.exe", "wmic"]);
  });
});
