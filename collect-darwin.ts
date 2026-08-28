import { MAX_FILESYSTEMS_PER_SAMPLE } from "./collect-disk.ts";
import { parseNetstatIbn, ratesFromCounters, type InterfaceCounters } from "./collect-network.ts";
import { parsePsOutput, topProcesses } from "./collect-processes.ts";
import { parseLaunchctlList, statusesFor } from "./collect-services.ts";
import type { CpuTimes, HostPlatform } from "./platform.ts";
import type { DiskSample, HostInfo, MetricSample } from "./types.ts";

/**
 * The macOS collector (REA-181).
 *
 * macOS has no `/proc`. Where Node's `os` module exposes the reading
 * (CPU times per core, total memory, load average) it is used directly and
 * nothing is executed. Where it does not, a fixed OS binary is run with
 * fixed arguments (see platform.ts for the allow-list and the no-shell
 * rule):
 *
 *   vm_stat                   memory available = free + inactive + purgeable
 *                             + speculative pages; Node's freemem() is free
 *                             pages only and would report every Mac as nearly
 *                             full, the macOS version of the MemAvailable rule
 *   df -Pk                    mount points and sizes (POSIX output format)
 *   netstat -ibn              per-interface byte/error counters
 *   ps -Aceo pid=,pcpu=,rss=,comm=   pid, %cpu of one core, rss KiB, bare name
 *   launchctl list            every loaded job, filtered in-process
 *   sw_vers -productVersion   once, for the host info line
 *
 * Containers are not reported: Docker Desktop runs them in a VM this host
 * cannot see into, and reporting the VM's own process would be misleading.
 *
 * The `pcpu` column is what `ps` reports: a decaying average rather than a
 * delta over our interval. It is labelled as such in the docs; the
 * alternative (`top -l 2`) takes a second per sample and still samples at
 * its own cadence.
 */

/** Anything `df` lists that is not a real volume an operator manages. */
const DARWIN_PSEUDO_FS = /^(devfs|map |autofs|none$)/;
/** Apple's internal APFS volumes on the system container; Data is the one
 * that holds the user's files and is kept. */
const DARWIN_SYSTEM_VOLUMES = /^\/System\/Volumes\/(?!Data$)/;

export class DarwinCollector {
  readonly os = "darwin" as const;
  private cpuBaseline: CpuTimes[] | null = null;
  private netBaseline: { counters: InterfaceCounters[]; at: number } | null = null;
  private productVersion: string | null | undefined;

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

    const netText = await this.tryExec("netstat", ["-ibn"]);
    const netNow = netText === null ? null : parseNetstatIbn(netText);
    const previousNet = this.netBaseline;
    this.netBaseline = netNow ? { counters: netNow, at: now.getTime() } : null;

    if (!previousCpu) return null; // warm-up
    const cpu = cpuRatioFromTimes(previousCpu, cpuNow);
    if (cpu === null) return null;

    const totalBytes = this.platform.totalmem();
    const vmStat = await this.tryExec("vm_stat", []);
    const available = vmStat === null ? null : parseVmStat(vmStat);
    // Honest fallback: free pages only, which over-reports use. Warned once
    // so a chart reader can tell which rule produced the number.
    if (available === null) this.warn("vm_stat", "vm_stat unavailable; memory available is free pages only");
    const availableBytes = available ?? this.platform.freemem();
    const memoryUsedBytes = Math.min(totalBytes, Math.max(0, totalBytes - availableBytes));

    const [load1, load5, load15] = this.platform.loadavg();
    const dfText = await this.tryExec("df", ["-Pk"]);
    const filesystems = dfText === null ? [] : parseDfPk(dfText);

    const sample: MetricSample = {
      sampledAt: now.toISOString(),
      cpuUsedRatio: cpu.ratio,
      cpuCores: cpu.cores,
      memoryTotalBytes: totalBytes,
      memoryUsedBytes,
      load1: load1 ?? null,
      load5: load5 ?? null,
      load15: load15 ?? null,
      filesystems,
    };
    if (netNow && previousNet) sample.network = ratesFromCounters(previousNet.counters, netNow, now.getTime() - previousNet.at);

    const psText = await this.tryExec("ps", ["-Aceo", "pid=,pcpu=,rss=,comm="]);
    if (psText !== null) sample.processes = topProcesses(parsePsOutput(psText, cpu.cores), new Map(), 0);

    if (serviceWatch.length) {
      const list = await this.tryExec("launchctl", ["list"]);
      sample.services = list === null
        ? serviceWatch.map((name) => ({ name, status: "unknown" as const }))
        : statusesFor(serviceWatch, parseLaunchctlList(list));
    }
    return sample;
  }

  vantage(): { vantage: "host"; detail: null } {
    return { vantage: "host", detail: null };
  }

  async hostInfo(): Promise<Pick<HostInfo, "os" | "osVersion" | "arch" | "hostname">> {
    if (this.productVersion === undefined) {
      const v = await this.tryExec("sw_vers", ["-productVersion"]);
      this.productVersion = v?.trim() || null;
    }
    return {
      os: "darwin",
      osVersion: this.productVersion ? `macOS ${this.productVersion} (${this.platform.release()})` : this.platform.release(),
      arch: this.platform.arch(),
      hostname: this.platform.hostname(),
    };
  }

  private async tryExec(file: string, args: string[]): Promise<string | null> {
    try {
      return await this.platform.exec(file, args);
    } catch (err) {
      this.warn(`exec:${file}`, `${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}

/** Fraction of total capacity between two `os.cpus()` readings, with the
 * same wrap/zero-delta refusals as collect-cpu.ts. */
export function cpuRatioFromTimes(prev: readonly CpuTimes[], curr: readonly CpuTimes[]): { ratio: number; cores: number } | null {
  if (!curr.length || prev.length !== curr.length) return null;
  let total = 0;
  let idle = 0;
  for (let i = 0; i < curr.length; i++) {
    const p = prev[i]!;
    const c = curr[i]!;
    const dTotal = c.user + c.nice + c.sys + c.idle + c.irq - (p.user + p.nice + p.sys + p.idle + p.irq);
    const dIdle = c.idle - p.idle;
    if (dTotal < 0 || dIdle < 0 || dIdle > dTotal) return null;
    total += dTotal;
    idle += dIdle;
  }
  if (total <= 0) return null;
  return { ratio: Math.min(1, Math.max(0, (total - idle) / total)), cores: curr.length };
}

/** `vm_stat`: page size from the header, then `Pages free/inactive/
 * speculative/purgeable: N.`. Returns AVAILABLE bytes, or null when the
 * header or the free count is missing. */
export function parseVmStat(text: string): number | null {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label: string): number | null => {
    const m = text.match(new RegExp(`^${label}:\\s+(\\d+)\\.?$`, "m"));
    return m ? Number(m[1]) : null;
  };
  const free = pages("Pages free");
  if (free === null) return null;
  const inactive = pages("Pages inactive") ?? 0;
  const speculative = pages("Pages speculative") ?? 0;
  const purgeable = pages("Pages purgeable") ?? 0;
  return (free + inactive + speculative + purgeable) * pageSize;
}

/** `df -Pk`: `Filesystem 1024-blocks Used Available Capacity Mounted on`.
 * The mount point is everything after the Capacity column, so a mount point
 * with spaces survives. Same pseudo-filesystem, dedupe-by-device and
 * largest-first cap discipline as collect-disk.ts. */
export function parseDfPk(text: string): DiskSample[] {
  const out: DiskSample[] = [];
  const seenDevice = new Set<string>();
  for (const line of text.split("\n").slice(1)) {
    const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    if (!m) continue;
    const device = m[1]!;
    const mountPoint = m[6]!.trim();
    if (DARWIN_PSEUDO_FS.test(device) || DARWIN_SYSTEM_VOLUMES.test(mountPoint)) continue;
    if (mountPoint === "/private/var/vm" || mountPoint === "/dev") continue;
    if (seenDevice.has(device)) continue;
    seenDevice.add(device);
    const totalBytes = Number(m[2]) * 1024;
    const usedBytes = Number(m[3]) * 1024;
    if (!(totalBytes > 0)) continue;
    out.push({ mountPoint, totalBytes, usedBytes: Math.min(totalBytes, usedBytes) });
  }
  out.sort((a, b) => b.totalBytes - a.totalBytes || a.mountPoint.localeCompare(b.mountPoint));
  return out.slice(0, MAX_FILESYSTEMS_PER_SAMPLE);
}
