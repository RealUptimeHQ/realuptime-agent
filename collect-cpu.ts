/**
 * CPU utilization from `/proc/stat`, as a fraction of TOTAL capacity across
 * all cores (the wire contract's `cpuUsedRatio`, the Monitor design notes phase
 * 2).
 *
 * ## Why a delta, and why it needs two readings
 *
 * The counters in `/proc/stat` are cumulative jiffies since boot, not an
 * instantaneous load. A single reading only tells you the average utilization
 * since the machine started, which is useless a week in. The number the
 * contract wants is the average utilization BETWEEN two readings, so this
 * module is deliberately stateless about time and only computes a ratio
 * between two `CpuTotals` snapshots; `collect-metrics.ts` is what remembers
 * the previous one across polls and supplies both sides.
 *
 * ## Why a wrapped or glitched counter returns null instead of a number
 *
 * The counters are unsigned and, on a long-lived machine or after a kernel
 * quirk, a later reading can be numerically smaller than an earlier one. A
 * naive subtraction would produce a negative delta and a wildly wrong ratio
 * (or a ratio outside 0..1, which the server refuses outright). There is no
 * correct ratio to report from an unusable pair of readings, so this returns
 * `null` and the caller skips that sample rather than fabricating one.
 */

export interface CpuTotals {
  /** idle + iowait, the "not doing work" jiffies. */
  idle: number;
  /** idle + iowait + every busy bucket (user, nice, system, irq, softirq,
   *  steal). Guest/guest_nice are deliberately excluded: on Linux they are
   *  already counted inside user/nice, and adding them again would double
   *  count a VM host's guest time. */
  total: number;
}

export interface CpuReading {
  totals: CpuTotals;
  /** Number of `cpuN` lines seen, i.e. how many cores `totals` is summed
   *  across. */
  cores: number;
}

/**
 * Parse the aggregate `cpu ` line and count the per-core `cpuN` lines.
 * Returns null if the aggregate line is missing or unparseable, or if no
 * per-core lines were found: either means this is not a `/proc/stat` this
 * module can trust.
 */
export function readCpuTotals(procStatText: string): CpuReading | null {
  let aggregateFields: number[] | null = null;
  let cores = 0;

  for (const line of procStatText.split("\n")) {
    if (line.startsWith("cpu ")) {
      const fields = line.trim().split(/\s+/).slice(1).map(Number);
      if (fields.length < 4 || fields.some((f) => !Number.isFinite(f))) continue;
      aggregateFields = fields;
    } else if (/^cpu\d+\s/.test(line)) {
      cores++;
    }
  }

  if (!aggregateFields || cores === 0) return null;

  // Older kernels have fewer than ten fields (steal arrived in 2.6.11, guest
  // in 2.6.24, guest_nice in 2.6.33); a missing trailing field is 0, not an
  // error.
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] =
    aggregateFields;

  const idleAll = idle + iowait;
  const nonIdle = user + nice + system + irq + softirq + steal;
  return { totals: { idle: idleAll, total: idleAll + nonIdle }, cores };
}

/**
 * The fraction of total CPU capacity used between `prev` and `curr`, or null
 * if the pair cannot be trusted: a wrapped/reset counter, two identical
 * readings taken with no time between them, or an idle delta that does not
 * fit inside the total delta (a contradiction that only a counter glitch
 * produces).
 */
export function cpuUsedRatioFromDelta(prev: CpuTotals, curr: CpuTotals): number | null {
  const deltaTotal = curr.total - prev.total;
  const deltaIdle = curr.idle - prev.idle;
  if (deltaTotal <= 0 || deltaIdle < 0 || deltaIdle > deltaTotal) return null;
  const ratio = (deltaTotal - deltaIdle) / deltaTotal;
  // Belt and braces against float rounding at the extremes; the server's
  // CHECK constraint is 0..1 inclusive and refuses anything outside it.
  return Math.min(1, Math.max(0, ratio));
}
