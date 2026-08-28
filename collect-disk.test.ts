import { describe, expect, it } from "vitest";
import {
  MAX_FILESYSTEMS_PER_SAMPLE,
  diskSamplesFromMounts,
  parseProcMounts,
  selectFilesystems,
} from "./collect-disk.ts";

const SAMPLE_MOUNTS = `sysfs /sys sysfs rw,nosuid,nodev,noexec 0 0
proc /proc proc rw,nosuid,nodev,noexec 0 0
tmpfs /run tmpfs rw,nosuid,nodev 0 0
cgroup2 /sys/fs/cgroup cgroup2 rw,nosuid,nodev,noexec 0 0
/dev/sda1 / ext4 rw,relatime 0 0
/dev/sda2 /boot ext4 rw,relatime 0 0
/dev/sdb1 /data xfs rw,relatime 0 0
overlay / overlay rw,relatime,lowerdir=x,upperdir=y 0 0
`;

describe("parseProcMounts", () => {
  it("parses device, mount point, and fstype", () => {
    const entries = parseProcMounts(SAMPLE_MOUNTS);
    const data = entries.find((e) => e.mountPoint === "/data");
    expect(data).toMatchObject({ device: "/dev/sdb1", mountPoint: "/data", fstype: "xfs" });
  });

  it("unescapes octal-encoded spaces in mount points", () => {
    const text = "/dev/sdb1 /mnt/My\\040Drive ext4 rw 0 0\n";
    const [entry] = parseProcMounts(text);
    expect(entry?.mountPoint).toBe("/mnt/My Drive");
  });

  it("keeps the LAST entry when two lines share a mount point", () => {
    const text = ["/dev/sda1 / ext4 rw 0 0", "overlay / overlay rw 0 0"].join("\n");
    const entries = parseProcMounts(text);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.fstype).toBe("overlay");
  });

  it("ignores blank and malformed lines", () => {
    const text = "\n   \nnotenough fields\n/dev/sda1 / ext4 rw 0 0\n";
    expect(parseProcMounts(text)).toHaveLength(1);
  });
});

describe("selectFilesystems", () => {
  it("excludes pseudo-filesystems: proc, sysfs, cgroup2, and tmpfs (deliberately, RAM-backed)", () => {
    const entries = parseProcMounts(SAMPLE_MOUNTS);
    const selected = selectFilesystems(entries);
    expect(selected.some((e) => e.fstype === "proc")).toBe(false);
    expect(selected.some((e) => e.fstype === "sysfs")).toBe(false);
    expect(selected.some((e) => e.fstype === "cgroup2")).toBe(false);
    expect(selected.some((e) => e.fstype === "tmpfs")).toBe(false);
  });

  it("keeps overlay: it is a container's real writable root, not a pseudo-fs", () => {
    const entries = parseProcMounts("overlay / overlay rw,lowerdir=a,upperdir=b 0 0\n");
    expect(selectFilesystems(entries)).toHaveLength(1);
  });

  it("excludes per-container docker/kubelet internal mount paths by prefix", () => {
    const text = [
      "overlay /var/lib/docker/overlay2/abc123/merged overlay rw 0 0",
      "overlay /var/lib/kubelet/pods/xyz/volumes/x overlay rw 0 0",
      "/dev/sda1 / ext4 rw 0 0",
    ].join("\n");
    const selected = selectFilesystems(parseProcMounts(text));
    expect(selected).toHaveLength(1);
    expect(selected[0]?.mountPoint).toBe("/");
  });

  it("dedupes a device bind-mounted at two paths, keeping the first", () => {
    const text = ["/dev/sda1 / ext4 rw 0 0", "/dev/sda1 /mnt/bind ext4 rw 0 0"].join("\n");
    const selected = selectFilesystems(parseProcMounts(text));
    expect(selected.map((e) => e.mountPoint)).toEqual(["/"]);
  });

  it("does not dedupe multiple 'none' devices (e.g. distinct pseudo-ish real mounts)", () => {
    const text = ["none /a ext4 rw 0 0", "none /b ext4 rw 0 0"].join("\n");
    const selected = selectFilesystems(parseProcMounts(text));
    expect(selected).toHaveLength(2);
  });
});

const GB = 1024 * 1024 * 1024;

describe("diskSamplesFromMounts", () => {
  function statfsFor(sizesGb: Record<string, number>, usedFractionOf = 0.5) {
    return (mountPoint: string) => {
      const totalBytes = (sizesGb[mountPoint] ?? 0) * GB;
      const bsize = 4096;
      const blocks = totalBytes / bsize;
      const bfree = blocks * (1 - usedFractionOf);
      return { bsize, blocks, bfree };
    };
  }

  it("turns a filtered mount list into bytes-based disk samples", () => {
    const text = ["/dev/sda1 / ext4 rw 0 0", "/dev/sdb1 /data xfs rw 0 0"].join("\n");
    const statfs = statfsFor({ "/": 100, "/data": 500 }, 0.4);
    const samples = diskSamplesFromMounts(text, statfs, () => {});
    const root = samples.find((s) => s.mountPoint === "/");
    expect(root?.totalBytes).toBe(100 * GB);
    expect(root?.usedBytes).toBeCloseTo(40 * GB, -6);
  });

  it("sorts largest-disk-first and caps at MAX_FILESYSTEMS_PER_SAMPLE, deterministically", () => {
    const mounts = Array.from({ length: 40 }, (_, i) => `/dev/loop${i} /mnt/${i} ext4 rw 0 0`).join("\n");
    const sizes: Record<string, number> = {};
    for (let i = 0; i < 40; i++) sizes[`/mnt/${i}`] = i + 1; // distinct sizes
    const statfs = statfsFor(sizes);
    const samples = diskSamplesFromMounts(mounts, statfs, () => {});
    expect(samples).toHaveLength(MAX_FILESYSTEMS_PER_SAMPLE);
    // Largest first.
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i - 1]!.totalBytes).toBeGreaterThanOrEqual(samples[i]!.totalBytes);
    }
    expect(samples[0]?.mountPoint).toBe("/mnt/39");

    // Same input, same output.
    const again = diskSamplesFromMounts(mounts, statfs, () => {});
    expect(again.map((s) => s.mountPoint)).toEqual(samples.map((s) => s.mountPoint));
  });

  it("skips a mount whose statfs call throws, and reports the rest", () => {
    const text = ["/dev/sda1 / ext4 rw 0 0", "/dev/sdb1 /broken xfs rw 0 0"].join("\n");
    const statfs = (mountPoint: string) => {
      if (mountPoint === "/broken") throw new Error("ENOENT: stale handle");
      return { bsize: 4096, blocks: 1000, bfree: 500 };
    };
    const warnings: string[] = [];
    const samples = diskSamplesFromMounts(text, statfs, (m) => warnings.push(m));
    expect(samples.map((s) => s.mountPoint)).toEqual(["/"]);
    expect(warnings[0]).toContain("/broken");
  });

  it("drops a zero-size filesystem rather than reporting a useless entry", () => {
    const text = "/dev/sda1 / ext4 rw 0 0\n";
    const statfs = () => ({ bsize: 4096, blocks: 0, bfree: 0 });
    expect(diskSamplesFromMounts(text, statfs, () => {})).toHaveLength(0);
  });

  it("never reports usedBytes above totalBytes even from a rounding edge", () => {
    const text = "/dev/sda1 / ext4 rw 0 0\n";
    const statfs = () => ({ bsize: 4096, blocks: 1000, bfree: -5 }); // bogus negative free
    const [sample] = diskSamplesFromMounts(text, statfs, () => {});
    expect(sample!.usedBytes).toBeLessThanOrEqual(sample!.totalBytes);
  });
});
