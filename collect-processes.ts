import type { ProcessSample } from "./types.ts";

/**
 * Per-process top-N by CPU and by memory (REA-181).
 *
 *   Linux    /proc/[pid]/stat (comm, utime, stime, rss) -- files only
 *   macOS    `ps -Aceo pid=,pcpu=,rss=,comm=`
 *   Windows  `Get-Process` inside the one PowerShell script
 *
 * What is reported: pid, the executable NAME, a CPU fraction of total
 * machine capacity, and resident memory in bytes. What is never reported:
 * the command line, arguments, environment, owner, or working directory.
 * `ps -c` and `/proc/[pid]/stat`'s `comm` are both the bare executable
 * name on purpose; Windows' `ProcessName` likewise. A process list is the
 * most revealing thing a server-health collector can send, and this is the
 * least revealing shape of it that still answers "what is eating the box".
 *
 * CPU is a delta between two readings (Linux, Windows) or the OS's own
 * running figure (macOS `pcpu`, which is what `ps` reports and is
 * labelled as such in the docs). The first reading on Linux/Windows
 * establishes the baseline, exactly like `cpuUsedRatio`.
 */

export const TOP_N_BY_CPU = 10;
export const TOP_N_BY_MEMORY = 10;
/** Mirrors the server's cap (packages/db/server-metrics.ts). */
export const MAX_PROCESSES_PER_SAMPLE = TOP_N_BY_CPU + TOP_N_BY_MEMORY;
export const MAX_PROCESS_NAME_LENGTH = 64;

export interface ProcessReading {
  pid: number;
  name: string;
  /** Cumulative CPU time, in whatever unit the platform counts (jiffies on
   * Linux, seconds on Windows); only deltas matter. null when the platform
   * gives a ready-made ratio instead (macOS). */
  cpuTime: number | null;
  /** Ready-made fraction of total capacity, only when the platform computes
   * it for us (macOS). */
  cpuRatio: number | null;
  memoryBytes: number;
}

/** `/proc/[pid]/stat`: `pid (comm) state ppid ... utime(14) stime(15) ...
 * rss(24)`. `comm` can contain spaces and parentheses, so it is cut at the
 * LAST `)` rather than split on whitespace. */
export function parseProcPidStat(text: string, pageSizeBytes: number): ProcessReading | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open === -1 || close === -1 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const name = text.slice(open + 1, close);
  const rest = text.slice(close + 1).trim().split(/\s+/);
  // rest[0] is state (field 3); utime is field 14 -> rest[11], stime field
  // 15 -> rest[12], rss field 24 -> rest[21].
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const rssPages = Number(rest[21]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (![utime, stime, rssPages].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return {
    pid,
    name: cleanName(name),
    cpuTime: utime + stime,
    cpuRatio: null,
    memoryBytes: rssPages * pageSizeBytes,
  };
}

/** `ps -Aceo pid=,pcpu=,rss=,comm=`: pid, %cpu of ONE core, rss in KiB,
 * bare command name. `cpuCores` converts the per-core percentage into a
 * fraction of total capacity. */
export function parsePsOutput(text: string, cpuCores: number): ProcessReading[] {
  const out: ProcessReading[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const pcpu = Number(m[2]);
    const rssKb = Number(m[3]);
    if (!Number.isInteger(pid) || !Number.isFinite(pcpu) || !Number.isFinite(rssKb)) continue;
    out.push({
      pid,
      name: cleanName(m[4] ?? ""),
      cpuTime: null,
      cpuRatio: Math.min(1, Math.max(0, pcpu / 100 / Math.max(1, cpuCores))),
      memoryBytes: rssKb * 1024,
    });
  }
  return out;
}

/** The `procs` array of the Windows PowerShell document: Id, ProcessName,
 * Cpu (total processor seconds, may be null for protected processes),
 * WorkingSet64. */
export function parseWindowsProcesses(rows: unknown): ProcessReading[] {
  if (!Array.isArray(rows)) return [];
  const out: ProcessReading[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const pid = typeof r.Id === "number" ? r.Id : Number.NaN;
    if (!Number.isInteger(pid) || pid < 0) continue;
    const cpu = typeof r.Cpu === "number" && Number.isFinite(r.Cpu) ? r.Cpu : null;
    const ws = typeof r.WorkingSet64 === "number" && Number.isFinite(r.WorkingSet64) ? r.WorkingSet64 : 0;
    out.push({
      pid,
      name: cleanName(typeof r.ProcessName === "string" ? r.ProcessName : ""),
      cpuTime: cpu,
      cpuRatio: null,
      memoryBytes: ws,
    });
  }
  return out;
}

/**
 * Merge the top N by CPU with the top N by memory into one list, deduped by
 * pid. `previousCpuTime` maps pid -> the previous reading's cumulative CPU
 * time, and `totalCpuDelta` is the machine's total CPU time elapsed over the
 * same interval in the SAME unit (jiffies across all cores on Linux;
 * seconds x cores on Windows), so `cpuRatio` is a fraction of total
 * capacity. A process with no previous reading (new, or the warm-up round)
 * gets no CPU ratio and competes on memory only. A pid reused by a new
 * process since the previous reading shows as a counter going backwards and
 * is treated the same way.
 */
export function topProcesses(
  readings: readonly ProcessReading[],
  previousCpuTime: ReadonlyMap<number, number>,
  totalCpuDelta: number,
): ProcessSample[] {
  const withRatio: ProcessSample[] = [];
  const noRatio: ProcessSample[] = [];
  for (const r of readings) {
    let ratio: number | null = r.cpuRatio;
    if (ratio === null && r.cpuTime !== null && totalCpuDelta > 0) {
      const prev = previousCpuTime.get(r.pid);
      if (prev !== undefined) {
        const delta = r.cpuTime - prev;
        if (delta >= 0) ratio = Math.min(1, delta / totalCpuDelta);
      }
    }
    const sample: ProcessSample = { pid: r.pid, name: r.name, cpuRatio: ratio ?? 0, memoryBytes: r.memoryBytes };
    (ratio === null ? noRatio : withRatio).push(sample);
  }
  const byCpu = [...withRatio].sort((a, b) => b.cpuRatio - a.cpuRatio || a.pid - b.pid).slice(0, TOP_N_BY_CPU);
  const byMem = [...withRatio, ...noRatio]
    .sort((a, b) => b.memoryBytes - a.memoryBytes || a.pid - b.pid)
    .slice(0, TOP_N_BY_MEMORY);
  const merged = new Map<number, ProcessSample>();
  for (const s of [...byCpu, ...byMem]) merged.set(s.pid, s);
  return [...merged.values()]
    .sort((a, b) => b.cpuRatio - a.cpuRatio || b.memoryBytes - a.memoryBytes || a.pid - b.pid)
    .slice(0, MAX_PROCESSES_PER_SAMPLE);
}

function cleanName(raw: string): string {
  // Control characters out, length bounded: the name lands in a dashboard
  // cell and in a JSON log line, and a process can be named anything.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return (cleaned || "?").slice(0, MAX_PROCESS_NAME_LENGTH);
}
