import { describe, expect, it, vi } from "vitest";
import {
  LOG_SNAPSHOT_DEFAULT_LINES,
  LOG_SNAPSHOT_MAX_LINE_BYTES,
  LOG_SNAPSHOT_MAX_LINES,
  LOG_SNAPSHOT_MAX_SOURCES,
  LogSnapshotCollector,
  parseLogOutput,
  truncateLineBytes,
} from "./collect-logs.ts";
import type { HostPlatform } from "./platform.ts";

function fakePlatform(
  os: HostPlatform["os"],
  exec: (file: string, args: readonly string[]) => Promise<string>,
): Pick<HostPlatform, "os" | "exec"> {
  return { os, exec };
}

describe("truncateLineBytes", () => {
  it("passes a short line through unchanged", () => {
    expect(truncateLineBytes("hello", 100)).toEqual({ text: "hello", truncated: false });
  });

  it("cuts a long line to the byte cap and marks it truncated", () => {
    const line = "x".repeat(50);
    const { text, truncated } = truncateLineBytes(line, 20);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(20);
    expect(text.endsWith("…[truncated]")).toBe(true);
  });

  it("never splits a multi-byte character in half", () => {
    // Each emoji is 4 UTF-8 bytes; a byte cap that lands mid-character must
    // back off to the last whole code point rather than emit a mangled one.
    const line = "😀".repeat(10);
    const { text } = truncateLineBytes(line, 10);
    // Re-encoding and decoding must round-trip without the replacement
    // character, which is what a split surrogate pair would produce.
    expect(text).not.toContain("�");
  });
});

describe("parseLogOutput", () => {
  it("keeps only the trailing maxLines lines, oldest first", () => {
    const raw = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const { lines, truncatedLines } = parseLogOutput(raw, 3);
    expect(lines).toEqual(["line 7", "line 8", "line 9"]);
    expect(truncatedLines).toBe(true);
  });

  it("is not marked truncated when fewer lines exist than the cap", () => {
    const { lines, truncatedLines } = parseLogOutput("a\nb\n", 50);
    expect(lines).toEqual(["a", "b"]);
    expect(truncatedLines).toBe(false);
  });

  it("drops empty trailing lines from a command's final newline", () => {
    const { lines } = parseLogOutput("only one line\n");
    expect(lines).toEqual(["only one line"]);
  });

  it("never returns more than the hard cap even when asked for more", () => {
    const raw = Array.from({ length: LOG_SNAPSHOT_MAX_LINES + 50 }, (_, i) => `l${i}`).join("\n");
    const { lines } = parseLogOutput(raw, LOG_SNAPSHOT_MAX_LINES + 50);
    expect(lines.length).toBeLessThanOrEqual(LOG_SNAPSHOT_MAX_LINES);
  });

  it("marks truncatedBytes when any line was cut", () => {
    const raw = `short\n${"x".repeat(LOG_SNAPSHOT_MAX_LINE_BYTES + 10)}\n`;
    const { truncatedBytes, lines } = parseLogOutput(raw);
    expect(truncatedBytes).toBe(true);
    expect(lines[1]!.endsWith("…[truncated]")).toBe(true);
  });
});

describe("LogSnapshotCollector", () => {
  it("is a no-op when no snapshot was requested (the common-path cost)", async () => {
    const exec = vi.fn();
    const collector = new LogSnapshotCollector(fakePlatform("linux", exec), ["nginx"], false, 50, vi.fn());
    const result = await collector.collect(undefined);
    expect(result).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns null when requested but no source is configured (opt-in absence by default)", async () => {
    const exec = vi.fn();
    const collector = new LogSnapshotCollector(fakePlatform("linux", exec), [], false, 50, vi.fn());
    collector.requestSnapshot();
    const result = await collector.collect(undefined);
    expect(result).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it("captures a journald unit via journalctl with a fixed argv", async () => {
    const exec = vi.fn().mockResolvedValue("one\ntwo\nthree\n");
    const collector = new LogSnapshotCollector(
      fakePlatform("linux", exec),
      ["nginx"],
      false,
      50,
      vi.fn(),
    );
    collector.requestSnapshot();
    const result = await collector.collect(undefined);
    expect(result).toEqual([
      {
        source: "nginx",
        sourceType: "journald",
        capturedAt: expect.any(String),
        lines: ["one", "two", "three"],
        truncatedLines: false,
        truncatedBytes: false,
      },
    ]);
    expect(exec).toHaveBeenCalledWith("journalctl", [
      "-u",
      "nginx.service",
      "-n",
      "50",
      "--no-pager",
      "--output=cat",
    ]);
  });

  it("captures docker logs only for containers this agent already monitors, when enabled", async () => {
    const exec = vi.fn().mockResolvedValue("hello\n");
    const collector = new LogSnapshotCollector(fakePlatform("linux", exec), [], true, 50, vi.fn());
    collector.requestSnapshot();
    const result = await collector.collect([{ id: "abc123def456", name: "web" }]);
    expect(result).toEqual([
      {
        source: "web",
        sourceType: "docker",
        capturedAt: expect.any(String),
        lines: ["hello"],
        truncatedLines: false,
        truncatedBytes: false,
      },
    ]);
    expect(exec).toHaveBeenCalledWith("docker", ["logs", "--tail", "50", "abc123def456"]);
  });

  it("does not touch docker when disabled, even with containers present", async () => {
    const exec = vi.fn();
    const collector = new LogSnapshotCollector(fakePlatform("linux", exec), ["nginx"], false, 50, vi.fn());
    exec.mockResolvedValue("x\n");
    collector.requestSnapshot();
    await collector.collect([{ id: "abc", name: "web" }]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("journalctl", expect.anything());
  });

  it("is one-shot: a second collect() without a new request returns null", async () => {
    const exec = vi.fn().mockResolvedValue("x\n");
    const collector = new LogSnapshotCollector(fakePlatform("linux", exec), ["nginx"], false, 50, vi.fn());
    collector.requestSnapshot();
    await collector.collect(undefined);
    exec.mockClear();
    const second = await collector.collect(undefined);
    expect(second).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it("clears the request even when the capture fails, so a broken source cannot wedge future requests", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("no such unit"));
    const warn = vi.fn();
    const collector = new LogSnapshotCollector(fakePlatform("linux", exec), ["nginx"], false, 50, warn);
    collector.requestSnapshot();
    const result = await collector.collect(undefined);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never runs on macOS or Windows (phase 1 is Linux-only)", async () => {
    const exec = vi.fn();
    const collector = new LogSnapshotCollector(fakePlatform("darwin", exec), ["nginx"], true, 50, vi.fn());
    collector.requestSnapshot();
    const result = await collector.collect([{ id: "abc", name: "web" }]);
    expect(result).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it("stops at LOG_SNAPSHOT_MAX_SOURCES combined across units and containers", async () => {
    const exec = vi.fn().mockResolvedValue("x\n");
    const units = Array.from({ length: LOG_SNAPSHOT_MAX_SOURCES + 5 }, (_, i) => `unit${i}`);
    const collector = new LogSnapshotCollector(fakePlatform("linux", exec), units, true, 50, vi.fn());
    collector.requestSnapshot();
    const containers = [{ id: "c1", name: "web" }];
    const result = await collector.collect(containers);
    expect(result).toHaveLength(LOG_SNAPSHOT_MAX_SOURCES);
    expect(exec).toHaveBeenCalledTimes(LOG_SNAPSHOT_MAX_SOURCES);
  });

  it("drops an invalid unit name rather than passing it to exec", async () => {
    const exec = vi.fn().mockResolvedValue("x\n");
    const collector = new LogSnapshotCollector(
      fakePlatform("linux", exec),
      ["../etc/passwd", "nginx"],
      false,
      50,
      vi.fn(),
    );
    collector.requestSnapshot();
    await collector.collect(undefined);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("journalctl", expect.arrayContaining(["nginx.service"]));
  });

  it("clamps out-of-range line counts into 1..LOG_SNAPSHOT_MAX_LINES", async () => {
    const exec = vi.fn().mockResolvedValue("x\n");
    const collector = new LogSnapshotCollector(fakePlatform("linux", exec), ["nginx"], false, 99999, vi.fn());
    collector.requestSnapshot();
    await collector.collect(undefined);
    expect(exec).toHaveBeenCalledWith("journalctl", expect.arrayContaining([String(LOG_SNAPSHOT_MAX_LINES)]));
  });
});

describe("caps", () => {
  it("are the numbers the wire contract and the server pin", () => {
    expect(LOG_SNAPSHOT_DEFAULT_LINES).toBe(50);
    expect(LOG_SNAPSHOT_MAX_LINES).toBe(200);
    expect(LOG_SNAPSHOT_MAX_LINE_BYTES).toBe(4096);
    expect(LOG_SNAPSHOT_MAX_SOURCES).toBe(10);
  });
});
