import { normalizeServiceName, systemdUnitName } from "./collect-services.ts";
import { safePathSegment, type HostPlatform } from "./platform.ts";
import type { LogSnapshot } from "./types.ts";

/**
 * Log snapshots (REA-440, log snapshots phase 1): a small, bounded, ONE-SHOT
 * tail of recent log lines, captured only when the server asks for one and
 * held in memory until the very next metrics flush.
 *
 * This is deliberately NOT log aggregation and NOT continuous shipping. The
 * ticket says "logs last" and means it: this is the narrowest cut that gives
 * an alert some context, not a log pipeline.
 *
 * ## The two sources, each opt-in and off by default
 *
 *   journald   `REALUPTIME_LOG_UNITS`, a comma list of systemd unit names
 *              the operator typed into the environment on THIS machine.
 *              Read with `journalctl -u <unit> -n <N> --no-pager
 *              --output=cat`. Absent means no journald source at all.
 *   docker     `REALUPTIME_LOG_DOCKER_ENABLED=true` opts this host's
 *              ALREADY-MONITORED containers (collect-containers.ts /
 *              collect-docker.ts) into a `docker logs --tail <N> <id>`
 *              read. There is no separate container list: the set eligible
 *              for a log tail is exactly the set already being read for
 *              cgroup metrics, nothing wider.
 *
 * Linux only for phase 1: journald is a Linux concept, and scoping Docker
 * log capture to the one platform that already runs zero commands for its
 * core metrics keeps the surface this change adds to `platform.ts`'s
 * allow-list small and auditable in one pass.
 *
 * ## Never sent with every sample
 *
 * `requestSnapshot()` sets a one-shot flag; `collect()` only runs when that
 * flag is set, and clears it (successful or not) before returning, so a
 * capture command runs at most once per request no matter how many ticks
 * pass before the next one. The caller (collect-metrics.ts) attaches the
 * result to the very next `MetricSample.logs`, then the flag is gone: a
 * poll response with `requestLogSnapshot: false` (every ordinary poll)
 * costs nothing here.
 *
 * ## Caps, enforced here AND again by the server (never trust one side)
 *
 *   LOG_SNAPSHOT_MAX_SOURCES     at most this many units + containers,
 *                                combined, per snapshot.
 *   LOG_SNAPSHOT_DEFAULT_LINES   requested per source when unconfigured.
 *   LOG_SNAPSHOT_MAX_LINES       hard cap on lines per source, both on the
 *                                `-n`/`--tail` argument and defensively on
 *                                the parsed output.
 *   LOG_SNAPSHOT_MAX_LINE_BYTES  a single line longer than this is cut and
 *                                marked truncated; a broken program's
 *                                megabyte-long log line is not a reading.
 *
 * ## What is NOT here
 *
 * Redaction. A log line may contain a secret the operator's own application
 * wrote into it, and this module ships it verbatim once captured. That is
 * why every source is opt-in and off by default, and it is documented as
 * exactly that in apps/agent/README.md, with a redaction pass named as the
 * phase 2 gate before this feature is turned on by default anywhere.
 */

export const LOG_SNAPSHOT_DEFAULT_LINES = 50;
export const LOG_SNAPSHOT_MAX_LINES = 200;
export const LOG_SNAPSHOT_MAX_LINE_BYTES = 4096;
export const LOG_SNAPSHOT_MAX_SOURCES = 10;

const TRUNCATION_MARKER = "…[truncated]";

/** Cuts a line to at most `maxBytes` UTF-8 bytes, on a code point boundary,
 *  with a visible marker appended when it was cut. A truncated marker is
 *  small and fixed, so it never itself pushes the result over the cap by
 *  more than its own length. */
export function truncateLineBytes(
  line: string,
  maxBytes: number = LOG_SNAPSHOT_MAX_LINE_BYTES,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(line, "utf8") <= maxBytes) return { text: line, truncated: false };
  const budget = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8"));
  // Walk code points (not UTF-16 code units) so a truncation never lands
  // inside a multi-byte character and produces replacement-character junk.
  let text = "";
  let bytes = 0;
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (bytes + chBytes > budget) break;
    text += ch;
    bytes += chBytes;
  }
  return { text: text + TRUNCATION_MARKER, truncated: true };
}

/** Splits a captured command's stdout into at most `maxLines` non-empty
 *  trailing lines (oldest first), truncating each line's bytes. A source
 *  that returned exactly `maxLines` lines is marked `truncatedLines: true`
 *  as a best-effort signal -- the capture command was already asked to
 *  cap itself, so hitting the cap exactly usually means more existed. */
export function parseLogOutput(
  raw: string,
  maxLines: number = LOG_SNAPSHOT_MAX_LINES,
  maxLineBytes: number = LOG_SNAPSHOT_MAX_LINE_BYTES,
): { lines: string[]; truncatedLines: boolean; truncatedBytes: boolean } {
  const allLines = raw.split("\n").filter((line) => line.length > 0);
  const capped = Math.min(maxLines, LOG_SNAPSHOT_MAX_LINES);
  const truncatedLines = allLines.length >= capped && capped > 0;
  const kept = allLines.slice(Math.max(0, allLines.length - capped));
  let truncatedBytes = false;
  const lines = kept.map((line) => {
    const { text, truncated } = truncateLineBytes(line, maxLineBytes);
    if (truncated) truncatedBytes = true;
    return text;
  });
  return { lines, truncatedLines, truncatedBytes };
}

/** The subset of a container reading a log source needs: enough to name
 *  and address it, nothing about its resource usage. */
export interface LogEligibleContainer {
  id: string;
  name: string | null;
}

export interface LogSnapshotSource {
  /** One-shot: the next `collect()` call captures, then the flag clears
   *  regardless of outcome. */
  requestSnapshot(): void;
  /** `containers` is whatever this tick's core collector already read
   *  (`MetricSample.containers`); undefined on a platform/tick that read
   *  none. Returns null when nothing was requested, nothing is configured,
   *  or every configured source failed to capture. */
  collect(containers: readonly LogEligibleContainer[] | undefined): Promise<LogSnapshot[] | null>;
}

export type WarnFn = (key: string, message: string) => void;

/** Linux-only for phase 1 (see module doc comment): the caller is expected
 *  to construct this only when `platform.os === "linux"`, but `collect()`
 *  is defensive about it anyway so a future caller cannot skip the check
 *  and silently run journalctl/docker on a platform that never allow-listed
 *  them (platform.ts refuses the exec either way). */
export class LogSnapshotCollector implements LogSnapshotSource {
  private requested = false;

  constructor(
    private readonly platform: Pick<HostPlatform, "os" | "exec">,
    private readonly units: readonly string[],
    private readonly dockerEnabled: boolean,
    private readonly lines: number,
    private readonly warn: WarnFn,
  ) {}

  requestSnapshot(): void {
    this.requested = true;
  }

  async collect(
    containers: readonly LogEligibleContainer[] | undefined,
  ): Promise<LogSnapshot[] | null> {
    if (!this.requested) return null;
    this.requested = false;
    if (this.platform.os !== "linux") return null;

    const validUnits = this.units
      .map((raw) => normalizeServiceName(raw))
      .filter((name): name is string => name !== null);
    if (validUnits.length === 0 && !this.dockerEnabled) return null;

    const lines = Math.min(Math.max(1, this.lines), LOG_SNAPSHOT_MAX_LINES);
    const snapshots: LogSnapshot[] = [];
    let budget = LOG_SNAPSHOT_MAX_SOURCES;

    for (const unit of validUnits) {
      if (budget <= 0) break;
      const snapshot = await this.captureJournald(unit, lines);
      if (snapshot) {
        snapshots.push(snapshot);
        budget -= 1;
      }
    }

    if (this.dockerEnabled && containers) {
      for (const container of containers) {
        if (budget <= 0) break;
        const snapshot = await this.captureDocker(container, lines);
        if (snapshot) {
          snapshots.push(snapshot);
          budget -= 1;
        }
      }
    }

    return snapshots.length > 0 ? snapshots : null;
  }

  private async captureJournald(unit: string, lines: number): Promise<LogSnapshot | null> {
    const fullUnit = systemdUnitName(unit);
    if (!safePathSegment(fullUnit)) return null;
    try {
      const raw = await this.platform.exec("journalctl", [
        "-u",
        fullUnit,
        "-n",
        String(lines),
        "--no-pager",
        "--output=cat",
      ]);
      const parsed = parseLogOutput(raw, lines);
      return {
        source: unit,
        sourceType: "journald",
        capturedAt: new Date().toISOString(),
        ...parsed,
      };
    } catch (err) {
      this.warn(
        `log-snapshot-journald:${unit}`,
        `log snapshot capture failed for journald unit ${unit}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async captureDocker(
    container: LogEligibleContainer,
    lines: number,
  ): Promise<LogSnapshot | null> {
    if (!safePathSegment(container.id)) return null;
    try {
      const raw = await this.platform.exec("docker", [
        "logs",
        "--tail",
        String(lines),
        container.id,
      ]);
      const parsed = parseLogOutput(raw, lines);
      return {
        source: container.name ?? container.id.slice(0, 12),
        sourceType: "docker",
        capturedAt: new Date().toISOString(),
        ...parsed,
      };
    } catch (err) {
      this.warn(
        `log-snapshot-docker:${container.id}`,
        `log snapshot capture failed for container ${container.id.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
