import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  POWERSHELL_ARGS,
  WINDOWS_SCRIPT,
  WMIC_DISK_ARGS,
  WindowsCollector,
  parseWindowsDisks,
  parseWindowsDocument,
  parseWmicDiskCsv,
} from "./collect-windows.ts";
import { ALLOWED_COMMANDS } from "./platform.ts";
import { FakeHostPlatform } from "./testdata/fake-platform.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(HERE, "testdata", name), "utf8");
const PS_KEY = `powershell.exe ${POWERSHELL_ARGS.join(" ")}`;
const WMIC_KEY = `wmic ${WMIC_DISK_ARGS.join(" ")}`;

function winPlatform(): FakeHostPlatform {
  const p = new FakeHostPlatform("windows");
  p.cpu = Array.from({ length: 4 }, () => ({ user: 1000, nice: 0, sys: 500, idle: 8500, irq: 0 }));
  p.memTotal = 64 * 1024 ** 3;
  p.memFree = 40 * 1024 ** 3; // Windows freemem() is AVAILABLE physical memory
  p.commands.set(PS_KEY, fixture("windows-document.json"));
  p.kernel = "10.0.20348";
  return p;
}

describe("Windows parsers", () => {
  it("the PowerShell document: disks as drive letters with sizes, sorted largest first", () => {
    const doc = parseWindowsDocument(fixture("windows-document.json"))!;
    expect(parseWindowsDisks(doc.disks)).toEqual([
      { mountPoint: "D:\\", totalBytes: 1_000_000_000_000, usedBytes: 100_000_000_000 },
      { mountPoint: "C:\\", totalBytes: 255_000_000_000, usedBytes: 175_000_000_000 },
    ]);
    expect(parseWindowsDocument("not json")).toBeNull();
  });

  it("the wmic fallback CSV yields the same disk shape", () => {
    expect(parseWmicDiskCsv(fixture("wmic-logicaldisk.csv"))).toEqual([
      { mountPoint: "D:\\", totalBytes: 1_000_000_000_000, usedBytes: 100_000_000_000 },
      { mountPoint: "C:\\", totalBytes: 255_000_000_000, usedBytes: 175_000_000_000 },
    ]);
  });

  it("the script is a constant with no interpolation point, so no operator value can reach PowerShell", () => {
    expect(WINDOWS_SCRIPT).not.toMatch(/\$\{|\+\s*\$|Invoke-Expression|iex\b/i);
    expect(POWERSHELL_ARGS).toEqual(["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT]);
  });
});

describe("WindowsCollector", () => {
  const warnings: string[] = [];
  const warn = (_k: string, m: string) => {
    warnings.push(m);
  };

  it("produces a v2 sample: os-module CPU and memory, no load average, one PowerShell call for the rest", async () => {
    const p = winPlatform();
    const c = new WindowsCollector(p, warn);
    p.clock = 0;
    expect(await c.collect(["w32time", "Spooler", "Nope"])).toBeNull(); // warm-up

    p.clock = 60_000;
    p.cpu = p.cpu.map((t) => ({ ...t, user: t.user + 200, sys: t.sys + 100, idle: t.idle + 700 }));
    p.commands.set(PS_KEY, fixture("windows-document-later.json"));
    const s = (await c.collect(["w32time", "Spooler", "Nope"]))!;

    expect(s.cpuCores).toBe(4);
    expect(s.cpuUsedRatio).toBeCloseTo(0.3, 5);
    expect(s.memoryTotalBytes).toBe(64 * 1024 ** 3);
    expect(s.memoryUsedBytes).toBe(24 * 1024 ** 3);
    expect(s.load1).toBeUndefined();
    expect(s.load5).toBeUndefined();
    expect(s.load15).toBeUndefined();
    expect(s.filesystems.map((d) => d.mountPoint)).toEqual(["D:\\", "C:\\"]);
    expect(s.network?.[0]).toEqual({
      name: "Ethernet",
      rxBytesPerSec: 1_000_000,
      txBytesPerSec: 500_000,
      rxErrors: 0,
      txErrors: 0,
      rxDropped: 0,
      txDropped: 0,
    });
    // w3wp: +60 cpu-seconds over 60 s on 4 cores = 0.25 of capacity;
    // sqlservr +30 s = 0.125; System has no Cpu and competes on memory only.
    expect(s.processes?.[0]).toEqual({ pid: 3300, name: "w3wp", cpuRatio: 0.25, memoryBytes: 600_000_000 });
    expect(s.processes?.[1]).toEqual({ pid: 1200, name: "sqlservr", cpuRatio: 0.125, memoryBytes: 8_100_000_000 });
    expect(s.containers).toBeUndefined();
    // Service names are matched case-insensitively, as Windows does.
    expect(s.services).toEqual([
      { name: "w32time", status: "active" },
      { name: "Spooler", status: "inactive" },
      { name: "Nope", status: "inactive" },
    ]);
    expect(p.execCalls.filter((x) => x.startsWith("powershell.exe"))).toHaveLength(2);
  });

  it("falls back to wmic for disks when PowerShell fails, with one warning and the other families absent", async () => {
    const p = winPlatform();
    p.commands.set(PS_KEY, new Error("powershell.exe not found"));
    p.commands.set(WMIC_KEY, fixture("wmic-logicaldisk.csv"));
    const c = new WindowsCollector(p, warn);
    await c.collect(["Spooler"]);
    p.cpu = p.cpu.map((t) => ({ ...t, user: t.user + 100, idle: t.idle + 100 }));
    const s = (await c.collect(["Spooler"]))!;
    expect(s.filesystems.map((d) => d.mountPoint)).toEqual(["D:\\", "C:\\"]);
    expect(s.network).toBeUndefined();
    expect(s.processes).toBeUndefined();
    expect(s.services).toEqual([{ name: "Spooler", status: "unknown" }]);
    expect(warnings.some((w) => w.includes("PowerShell collection unavailable"))).toBe(true);
  });

  it("runs only the allow-listed programs and never puts a watched name on a command line", async () => {
    const p = winPlatform();
    const c = new WindowsCollector(p, warn);
    await c.collect(["Spooler"]);
    for (const call of p.execCalls) {
      const [file] = call.split(" ");
      expect(ALLOWED_COMMANDS.windows).toContain(file);
      expect(call).not.toContain("Spooler");
    }
  });

  it("describes the host from the document's OS caption once it has seen one", async () => {
    const p = winPlatform();
    const c = new WindowsCollector(p, warn);
    expect(c.hostInfo().osVersion).toBe("10.0.20348");
    await c.collect([]);
    expect(c.hostInfo()).toEqual({
      os: "windows",
      osVersion: "Microsoft Windows Server 2022 Datacenter 10.0.20348",
      arch: "x64",
      hostname: "fixture-host",
    });
    expect(c.vantage()).toEqual({ vantage: "host", detail: null });
  });
});
