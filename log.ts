/**
 * The whole logging layer, deliberately about forty lines.
 *
 * ## Why not `@realuptime/logger`
 *
 * Same reason as types.ts: this binary runs inside a customer's network and
 * its dependency list is a security artifact. The shared logger is a fine
 * package; it is just not worth a workspace edge in the one program whose
 * selling point is that it has nothing in it.
 *
 * ## Why response bodies never appear here
 *
 * The agent's targets are private: internal APIs, admin panels, databases.
 * Their responses contain the customer's own data, and this process's stdout
 * ends up in `docker logs`, in journald, and in whatever log shipper the
 * customer runs. A prober that echoed a body into a log line would move
 * private data somewhere it was never meant to go, entirely by accident.
 *
 * So: nothing in this package ever reads a response body (see check-http.ts,
 * which aborts the stream at the status line), and every string that reaches a
 * log line is truncated at `MAX_FIELD_CHARS`. The truncation is a second
 * defence rather than the first, because a future contributor adding a
 * diagnostic field should not be able to turn a log into an exfiltration path
 * by pasting one variable into it.
 */

export type LogLevel = "info" | "warn" | "error";

export const MAX_FIELD_CHARS = 200;

/** Test seam. Production leaves it alone and gets stdout. */
export const logSink = {
  write: (line: string) => {
    process.stdout.write(line + "\n");
  },
};

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const record: Record<string, unknown> = {
    level,
    ts: new Date().toISOString(),
    msg,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    record[key] = typeof value === "string" ? truncate(value) : value;
  }
  logSink.write(JSON.stringify(record));
}

export function truncate(value: string): string {
  return value.length <= MAX_FIELD_CHARS ? value : value.slice(0, MAX_FIELD_CHARS) + "...";
}
