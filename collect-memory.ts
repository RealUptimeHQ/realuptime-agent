/**
 * Memory usage from `/proc/meminfo`.
 *
 * `usedBytes` is `MemTotal - MemAvailable`, never `MemTotal - MemFree`. Free
 * memory on Linux is close to zero on a perfectly healthy machine, because
 * the kernel spends everything it is not otherwise using on page cache and
 * buffers, and reclaims them the instant something actually needs the
 * memory. `MemAvailable` is the kernel's own estimate of what a new process
 * could actually get; `MemFree` is not, and reporting `total - free` would
 * flag every healthy Linux box as almost out of memory, permanently. This is
 * the same distinction migration 068's schema comment and docs/api.md make
 * for the server side of this contract.
 */

export interface MemoryReading {
  totalBytes: number;
  usedBytes: number;
}

/**
 * Parse `/proc/meminfo`. Returns null only if `MemTotal` itself is missing,
 * which means this is not a `/proc/meminfo` this module can trust.
 */
export function parseMemInfo(text: string): MemoryReading | null {
  const kb: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^(\w+):\s*(\d+)\s*kB/);
    if (match) kb[match[1]!] = Number(match[2]) * 1024;
  }

  const totalBytes = kb.MemTotal;
  if (totalBytes === undefined) return null;

  let availableBytes = kb.MemAvailable;
  if (availableBytes === undefined) {
    // MemAvailable arrived in Linux 3.14 (2014). On an older kernel this is
    // the kernel's own pre-3.14 approximation of "reclaimable, so not
    // actually in use": free memory plus the two cache buckets that can be
    // dropped under pressure without losing data.
    const free = kb.MemFree ?? 0;
    const buffers = kb.Buffers ?? 0;
    const cached = kb.Cached ?? 0;
    availableBytes = free + buffers + cached;
  }

  const usedBytes = Math.min(totalBytes, Math.max(0, totalBytes - availableBytes));
  return { totalBytes, usedBytes };
}
