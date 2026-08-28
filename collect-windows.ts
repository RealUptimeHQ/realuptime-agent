import { cpuRatioFromTimes } from "./collect-darwin.ts";
import { MAX_FILESYSTEMS_PER_SAMPLE } from "./collect-disk.ts";
import { parseWindowsNetAdapters, ratesFromCounters, type InterfaceCounters } from "./collect-network.ts";
import { parseWindowsProcesses, topProcesses } from "./collect-processes.ts";
import { parseWindowsServices, statusesFor } from "./collect-services.ts";
import type { CpuTimes, HostPlatform } from "./platform.ts";
import type { DiskSample, HostInfo, MetricSample } from "./types.ts";

/**
 * The Windows Server collector (REA-181).
 *
 * CPU times and memory come from Node's `os` module, which on Windows calls
 * `GetSystemTimes` and `GlobalMemoryStatusEx`: `freemem()` there is
 * AVAILABLE physical memory, the right semantics, so no command is needed
 * for either. Windows has no load average; all three are absent, never 0.
 *
 * Everything else comes from ONE `powershell.exe` invocation per sample
 * running `WINDOWS_SCRIPT`, a constant (no interpolation, ever) that emits
 * one compact JSON document with four arrays: logical disks, network
 * adapter statistics, processes, and ALL services. The service watch list
 * is applied in this process afterwards, so an operator-typed name never
 * reaches PowerShell. If PowerShell fails (removed, constrained language
 * mode, a hardened image), `wmic logicaldisk` is the fallback for disks
 * only and the other three families are absent that round, with one
 * warning.
 *
 * Process CPU is a delta of `Get-Process`'s total processor seconds between
 * two samples against `elapsed x cores`, the same capacity unit as
 * `cpuUsedRatio`.
 */

export const WINDOWS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$o=[ordered]@{}",
  "$o.disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace)",
  "$o.net=@(Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes,ReceivedPacketErrors,OutboundPacketErrors,ReceivedDiscardedPackets,OutboundDiscardedPackets)",
  "$o.procs=@(Get-Process | Select-Object Id,ProcessName,@{n='Cpu';e={$_.CPU}},WorkingSet64)",
  "$o.services=@(Get-Service | Select-Object Name,@{n='Status';e={$_.Status.ToString()}})",
  "$o.os=(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version)",
  "$o | ConvertTo-Json -Compress -Depth 3",
].join("; ");

export const POWERSHELL_ARGS: readonly string[] = ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT];
export const WMIC_DISK_ARGS: readonly string[] = ["logicaldisk", "where", "DriveType=3", "get", "DeviceID,FreeSpace,Size", "/format:csv"];

export interface WindowsDocument {
  disks: unknown;
  net: unknown;
  procs: unknown;
  services: unknown;
  os: unknown;
}

export function parseWindowsDocument(text: string): WindowsDocument | null {
  try {
    const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      disks: parsed.disks ?? [],
      net: parsed.net ?? [],
      procs: parsed.procs ?? [],
      services: parsed.services ?? [],
      os: parsed.os ?? null,
    };
  } catch {
    return null;
  }
}

/** `disks`: Win32_LogicalDisk rows with DeviceID ("C:"), Size, FreeSpace
 * (bytes, may arrive as numbers or numeric strings). Mount point is the
 * drive letter with a trailing backslash, the way Windows itself prints it. */
export function parseWindowsDisks(rows: unknown): DiskSample[] {
  if (!Array.isArray(rows)) return [];
  const out: DiskSample[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.DeviceID === "string" ? r.DeviceID.trim() : "";
    const size = Number(r.Size);
    const free = Number(r.FreeSpace);
    if (!id || !Number.isFinite(size) || size <= 0 || !Number.isFinite(free)) continue;
    out.push({ mountPoint: id.endsWith("\\") ? id : `${id}\\`, totalBytes: size, usedBytes: Math.min(size, Math.max(0, size - free)) });
  }
  out.sort((a, b) => b.totalBytes - a.totalBytes || a.mountPoint.localeCompare(b.mountPoint));
  return out.slice(0, MAX_FILESYSTEMS_PER_SAMPLE);
}

/** `wmic logicaldisk ... /format:csv`: a blank line, a header
 * `Node,DeviceID,FreeSpace,Size`, then rows. */
export function parseWmicDiskCsv(text: string): DiskSample[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const headerIndex = lines.findIndex((l) => /^Node,/i.test(l));
  if (headerIndex === -1) return [];
  const header = lines[headerIndex]!.split(",");
  const iId = header.indexOf("DeviceID");
  const iFree = header.indexOf("FreeSpace");
  const iSize = header.indexOf("Size");
  if (iId === -1 || iFree === -1 || iSize === -1) return [];
  const rows = lines.slice(headerIndex + 1).map((l) => {
    const f = l.split(",");
    return { DeviceID: f[iId], FreeSpace: f[iFree], Size: f[iSize] };
  });
  return parseWindowsDisks(rows);
}

export function parseWindowsOs(os: unknown): string | null {
  if (!os || typeof os !== "object") return null;
  const r = os as Record<string, unknown>;
  const caption = typeof r.Caption === "string" ? r.Caption.trim() : "";
  const version = typeof r.Version === "string" ? r.Version.trim() : "";
  if (!caption && !version) return null;
  return [caption, version].filter(Boolean).join(" ");
}

export class WindowsCollector {
  readonly os = "windows" as const;
  private cpuBaseline: CpuTimes[] | null = null;
  private netBaseline: { counters: InterfaceCounters[]; at: number } | null = null;
  private processCpuBaseline = new Map<number, number>();
  private lastSampleAt: number | null = null;
  private osVersionCache: string | null = null;

  constructor(
    private readonly platform: HostPlatform,
    private readonly warn: (key: string, message: string) => void,
  ) {}

  available(): boolean {
    return true;
  }

  async collect(serviceWatch: readonly string[]): Promise<MetricSample | null> {
    const now = this.platform.now();
    const cpuNow = this.platform.cpuTimes();
    const previousCpu = this.cpuBaseline;
    this.cpuBaseline = cpuNow;

    let doc: WindowsDocument | null = null;
    const psText = await this.tryExec("powershell.exe", POWERSHELL_ARGS);
    if (psText !== null) doc = parseWindowsDocument(psText);
    if (doc === null) this.warn("powershell", "PowerShell collection unavailable; disks via wmic only, no network/process/service data");

    const netNow = doc ? parseWindowsNetAdapters(doc.net) : null;
    const previousNet = this.netBaseline;
    this.netBaseline = netNow ? { counters: netNow, at: now.getTime() } : null;
    const processReadings = doc ? parseWindowsProcesses(doc.procs) : [];
    const previousProcessCpu = this.processCpuBaseline;
    this.processCpuBaseline = new Map(processReadings.filter((p) => p.cpuTime !== null).map((p) => [p.pid, p.cpuTime as number]));
    const previousSampleAt = this.lastSampleAt;
    this.lastSampleAt = now.getTime();
    if (doc && !this.osVersionCache) this.osVersionCache = parseWindowsOs(doc.os);

    if (!previousCpu) return null; // warm-up
    const cpu = cpuRatioFromTimes(previousCpu, cpuNow);
    if (cpu === null) return null;

    let filesystems: DiskSample[] = doc ? parseWindowsDisks(doc.disks) : [];
    if (!doc) {
      const wmic = await this.tryExec("wmic", WMIC_DISK_ARGS);
      filesystems = wmic === null ? [] : parseWmicDiskCsv(wmic);
    }

    const totalBytes = this.platform.totalmem();
    const memoryUsedBytes = Math.min(totalBytes, Math.max(0, totalBytes - this.platform.freemem()));

    const sample: MetricSample = {
      sampledAt: now.toISOString(),
      cpuUsedRatio: cpu.ratio,
      cpuCores: cpu.cores,
      memoryTotalBytes: totalBytes,
      memoryUsedBytes,
      // Windows has no load average: absent as a group, never zero.
      filesystems,
    };
    if (netNow && previousNet) sample.network = ratesFromCounters(previousNet.counters, netNow, now.getTime() - previousNet.at);
    if (processReadings.length && previousSampleAt !== null) {
      const elapsedSeconds = (now.getTime() - previousSampleAt) / 1000;
      sample.processes = topProcesses(processReadings, previousProcessCpu, elapsedSeconds * cpu.cores);
    }
    if (serviceWatch.length) {
      sample.services = doc
        ? statusesFor(serviceWatch, parseWindowsServices(doc.services), true)
        : serviceWatch.map((name) => ({ name, status: "unknown" as const }));
    }
    return sample;
  }

  vantage(): { vantage: "host"; detail: null } {
    return { vantage: "host", detail: null };
  }

  hostInfo(): Pick<HostInfo, "os" | "osVersion" | "arch" | "hostname"> {
    return {
      os: "windows",
      osVersion: this.osVersionCache ?? this.platform.release(),
      arch: this.platform.arch(),
      hostname: this.platform.hostname(),
    };
  }

  private async tryExec(file: string, args: readonly string[]): Promise<string | null> {
    try {
      return await this.platform.exec(file, args);
    } catch (err) {
      this.warn(`exec:${file}`, `${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
