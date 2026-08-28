import type { DiskSample } from "./types.ts";

/**
 * Per-filesystem disk usage from `/proc/mounts` plus a `statvfs`-style
 * reading per mount point.
 *
 * ## Filtering, and the tmpfs decision
 *
 * `/proc/mounts` lists every mount, most of which are not disks: `proc`,
 * `sysfs`, `cgroup`/`cgroup2`, and a long tail of other virtual and
 * pseudo-filesystems the kernel exposes as files but that hold no bytes on
 * any storage device. `PSEUDO_FS_TYPES` excludes those outright.
 *
 * `tmpfs` is excluded deliberately, not by omission: it is RAM-backed, not
 * disk, so counting it here would double-book memory that `memoryUsedBytes`
 * already reports and would make `/tmp` or `/dev/shm` look like "disk almost
 * full" pressure that is really memory pressure. `squashfs` is excluded for
 * a different reason: on a machine with snapd, every installed snap revision
 * is its own read-only squashfs mount, which is real disk-backed storage but
 * not a filesystem an operator manages or would want an alert threshold on;
 * reporting it would spend most of `MAX_FILESYSTEMS_PER_SAMPLE` on snap
 * internals before a customer's actual volumes are considered. `overlay` is
 * intentionally NOT in this list: it is the writable root filesystem of most
 * containers, and a containerized agent excluding it would report zero
 * filesystems for the one disk it actually has.
 *
 * ## The noisy-mount-prefix filter
 *
 * A host running Docker or Kubernetes has one `/proc/mounts` entry per
 * running container for that container's own overlay merge
 * (`/var/lib/docker/overlay2/<id>/merged`, `/var/lib/kubelet/pods/...`).
 * These are `overlay` type, so the fstype filter above does not catch them,
 * and each one reports the SAME underlying disk's total/used bytes as the
 * real mount point it sits on. Left in, a machine running a few dozen
 * containers would fill the entire 32-filesystem cap with duplicate readings
 * of one disk and crowd out a genuinely distinct volume. They are excluded by
 * mount point prefix instead of fstype, because the disk itself is still
 * reported at its real, non-container mount point.
 *
 * ## Dedup by device, and the cap
 *
 * A bind mount (or a filesystem mounted at two paths) shows up as two
 * `/proc/mounts` lines for one device; only the first is kept. What survives
 * is capped at `MAX_FILESYSTEMS_PER_SAMPLE`, largest disk first, ties broken
 * by mount point so the same input always produces the same output: an
 * operator watching "disk almost full" cares about the big volumes first,
 * and a non-deterministic cap would make two samples of an unchanged machine
 * disagree about which filesystems were reported.
 */

export const PSEUDO_FS_TYPES = new Set([
  "proc",
  "sysfs",
  "cgroup",
  "cgroup2",
  "tmpfs",
  "devtmpfs",
  "devpts",
  "mqueue",
  "hugetlbfs",
  "debugfs",
  "tracefs",
  "securityfs",
  "pstore",
  "bpf",
  "autofs",
  "binfmt_misc",
  "configfs",
  "fusectl",
  "rpc_pipefs",
  "nsfs",
  "squashfs",
  "efivarfs",
]);

const NOISY_MOUNT_PREFIXES = [
  "/var/lib/docker/",
  "/var/lib/containers/storage/",
  "/var/lib/kubelet/pods/",
  "/run/docker/",
];

/** Mirrors the server's per-sample cap (packages/db/server-metrics.ts
 *  `MAX_FILESYSTEMS_PER_SAMPLE`); a batch over this is refused whole. */
export const MAX_FILESYSTEMS_PER_SAMPLE = 32;

export interface MountEntry {
  device: string;
  mountPoint: string;
  fstype: string;
}

export interface StatfsResult {
  bsize: number;
  blocks: number;
  bfree: number;
}

/** Undo the octal `\040`-style escaping `/proc/mounts` uses for spaces,
 *  tabs, newlines and backslashes in a mount point. */
function unescapeMountPoint(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

export function parseProcMounts(text: string): MountEntry[] {
  const byMountPoint = new Map<string, MountEntry>();
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const [device, rawMountPoint, fstype] = fields as [string, string, string];
    const mountPoint = unescapeMountPoint(rawMountPoint);
    // Later entries at the same path are whatever is actually mounted there
    // now (the kernel lists mounts in attach order), so a later line wins.
    byMountPoint.set(mountPoint, { device, mountPoint, fstype });
  }
  return [...byMountPoint.values()];
}

export function selectFilesystems(entries: MountEntry[]): MountEntry[] {
  const seenDevice = new Set<string>();
  const selected: MountEntry[] = [];
  for (const entry of entries) {
    if (PSEUDO_FS_TYPES.has(entry.fstype)) continue;
    if (NOISY_MOUNT_PREFIXES.some((prefix) => entry.mountPoint.startsWith(prefix))) continue;
    if (entry.device !== "none") {
      if (seenDevice.has(entry.device)) continue;
      seenDevice.add(entry.device);
    }
    selected.push(entry);
  }
  return selected;
}

/**
 * Turn filtered mount entries into wire-shaped disk samples. `statfs` and
 * `onWarning` are injected so tests can supply fixtures and a bad mount
 * (unmounted mid-read, a stale NFS handle) skips that one filesystem with a
 * log line instead of losing the whole sample.
 */
export function diskSamplesFromMounts(
  mountsText: string,
  statfs: (mountPoint: string) => StatfsResult,
  onWarning: (message: string) => void,
): DiskSample[] {
  const candidates = selectFilesystems(parseProcMounts(mountsText));
  const samples: DiskSample[] = [];

  for (const entry of candidates) {
    let stats: StatfsResult;
    try {
      stats = statfs(entry.mountPoint);
    } catch (err) {
      onWarning(
        `could not read filesystem stats for ${entry.mountPoint}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const totalBytes = stats.bsize * stats.blocks;
    // Zero-size survivors of the type filter (a handful of virtual mounts
    // report zero blocks) carry no information the server would accept
    // anyway: it refuses a zero totalBytes.
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) continue;
    const usedBytes = Math.min(totalBytes, Math.max(0, totalBytes - stats.bsize * stats.bfree));
    samples.push({ mountPoint: entry.mountPoint, totalBytes, usedBytes });
  }

  samples.sort((a, b) => b.totalBytes - a.totalBytes || a.mountPoint.localeCompare(b.mountPoint));
  return samples.slice(0, MAX_FILESYSTEMS_PER_SAMPLE);
}
