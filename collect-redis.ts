import * as net from "node:net";
import type { RedisSample } from "./types.ts";

/**
 * Redis/Valkey enrichment (REA-440 phase 3), config-gated and off by
 * default, exactly like collect-postgres.ts: nothing here runs unless the
 * customer sets `REALUPTIME_REDIS_DSN`.
 *
 * The wire protocol (RESP, the Redis Serialization Protocol) is a great
 * deal simpler than Postgres's frontend/backend protocol -- one command,
 * one reply, no startup handshake beyond an optional `AUTH` -- so this
 * module is a fraction of collect-postgres.ts's size for the same reason:
 * zero runtime dependencies (wire-contract.test.ts), the same rule the
 * Docker Engine API client established.
 *
 * ## What is collected
 *
 * One `INFO` command (a single round trip; Redis has no equivalent of a
 * multi-statement batch, but INFO already returns everything below in one
 * reply): used memory against the configured `maxmemory`, connected
 * clients, the keyspace hit ratio (`keyspace_hits` over hits+misses), and
 * evicted keys. All four are read-only counters any client can request; the
 * agent never issues a command that touches a key.
 */

const DEFAULT_PORT = 6379;
const CONNECT_TIMEOUT_MS = 3000;
const COMMAND_TIMEOUT_MS = 5000;
const CRLF = "\r\n";

export interface RedisConnectOptions {
  /** A hostname/IP for TCP, or a full socket path (starts with "/"). */
  host: string;
  port: number;
  password: string | null;
  /** Absent means db 0, RESP's default. */
  db: number | null;
}

/** Accepts `redis://[:password@]host:port[/db]` (and the `rediss://` alias,
 * treated identically -- TLS is not implemented in this phase, see the
 * module doc), and a unix-socket form via a `path` query parameter:
 * `redis://?path=/var/run/redis/redis.sock&password=...`. Returns null for
 * anything unparseable. */
export function parseRedisDsn(raw: string): RedisConnectOptions | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") return null;
  const path = url.searchParams.get("path");
  const host = path || url.hostname || "localhost";
  const port = url.port ? Number(url.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const passwordParam = url.searchParams.get("password");
  const password = url.password ? decodeURIComponent(url.password) : passwordParam || null;
  const dbSegment = url.pathname.replace(/^\//, "");
  let db: number | null = null;
  if (dbSegment) {
    const parsed = Number(dbSegment);
    if (!Number.isInteger(parsed) || parsed < 0) return null;
    db = parsed;
  }
  if (!host) return null;
  return { host, port, password, db };
}

export function dsnFingerprint(opts: RedisConnectOptions): string {
  return `${opts.host}:${opts.port}${opts.db !== null ? `/${opts.db}` : ""}`;
}

function encodeCommand(args: readonly string[]): Buffer {
  const parts = [`*${args.length}${CRLF}`];
  for (const arg of args) parts.push(`$${Buffer.byteLength(arg, "utf8")}${CRLF}${arg}${CRLF}`);
  return Buffer.from(parts.join(""), "utf8");
}

type RespValue =
  | { kind: "simple" | "error" | "integer"; text: string }
  | { kind: "bulk"; text: string | null };

/** Parses ONE complete RESP reply from the front of `buffer`, or returns
 * null when more bytes are needed. Only the four reply types this module's
 * fixed command sequence (`AUTH`, `SELECT`, `INFO`) can ever receive are
 * handled: simple strings, errors, integers, and bulk strings. Arrays never
 * arise from any command this module sends. */
function tryParseReply(buffer: Buffer): { value: RespValue; consumed: number } | null {
  if (buffer.length < 1) return null;
  const type = String.fromCharCode(buffer[0]!);
  const lineEnd = buffer.indexOf(CRLF, 1);
  if (lineEnd < 0) return null;
  const line = buffer.toString("utf8", 1, lineEnd);
  if (type === "+") return { value: { kind: "simple", text: line }, consumed: lineEnd + 2 };
  if (type === "-") return { value: { kind: "error", text: line }, consumed: lineEnd + 2 };
  if (type === ":") return { value: { kind: "integer", text: line }, consumed: lineEnd + 2 };
  if (type === "$") {
    const len = Number(line);
    if (len < 0) return { value: { kind: "bulk", text: null }, consumed: lineEnd + 2 };
    const start = lineEnd + 2;
    const end = start + len;
    if (buffer.length < end + 2) return null;
    return {
      value: { kind: "bulk", text: buffer.toString("utf8", start, end) },
      consumed: end + 2,
    };
  }
  // An array (or anything else) reaching here means the server sent
  // something this fixed command sequence does not expect; treated as a
  // protocol error by the caller rather than parsed further.
  throw new Error(`unexpected RESP reply type '${type}'`);
}

/** Buffers a socket's bytes and hands out one RESP reply at a time,
 * pull-based, same shape as collect-postgres.ts's PgMessageReader. */
class RespReader {
  private buffer = Buffer.alloc(0);
  private readonly pending: RespValue[] = [];
  private error: Error | null = null;
  private closed = false;
  private wake: (() => void) | null = null;

  constructor(socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on("error", (err) => {
      this.error = err;
      this.signal();
    });
    socket.on("close", () => {
      this.closed = true;
      this.signal();
    });
  }

  private drain(): void {
    for (;;) {
      let parsed: { value: RespValue; consumed: number } | null;
      try {
        parsed = tryParseReply(this.buffer);
      } catch (err) {
        this.error = err instanceof Error ? err : new Error(String(err));
        break;
      }
      if (!parsed) break;
      this.pending.push(parsed.value);
      this.buffer = this.buffer.subarray(parsed.consumed);
    }
    this.signal();
  }

  private signal(): void {
    if (this.wake) {
      const resolve = this.wake;
      this.wake = null;
      resolve();
    }
  }

  async next(): Promise<RespValue> {
    for (;;) {
      const msg = this.pending.shift();
      if (msg) return msg;
      if (this.error) throw this.error;
      if (this.closed) throw new Error("redis connection closed unexpectedly");
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function command(
  socket: net.Socket,
  reader: RespReader,
  args: readonly string[],
): Promise<RespValue> {
  socket.write(encodeCommand(args));
  const reply = await reader.next();
  if (reply.kind === "error") throw new Error(reply.text);
  return reply;
}

function connectSocket(opts: RedisConnectOptions): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = opts.host.startsWith("/")
      ? net.createConnection({ path: opts.host })
      : net.createConnection({ host: opts.host, port: opts.port });
    const onError = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => onError(new Error("redis connection timed out")));
  });
}

/** `key:value` lines from an INFO reply; blank lines and `#` section
 * headers are skipped. Unknown keys are ignored, which is what makes this
 * forward-compatible with a Redis/Valkey version that adds fields. */
function parseInfo(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split("\r\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    out.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return out;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildSample(info: Map<string, string>): RedisSample {
  const usedMemoryBytes = toNumber(info.get("used_memory")) ?? 0;
  // maxmemory of 0 is Redis's own "no limit configured" value; reported as
  // null, the same "not applicable" null every other family uses, rather
  // than a literal zero that would read as "no memory budget at all".
  const maxMemoryRaw = toNumber(info.get("maxmemory"));
  const maxMemoryBytes = maxMemoryRaw && maxMemoryRaw > 0 ? maxMemoryRaw : null;
  const connectedClients = toNumber(info.get("connected_clients")) ?? 0;
  const hits = toNumber(info.get("keyspace_hits")) ?? 0;
  const misses = toNumber(info.get("keyspace_misses")) ?? 0;
  const total = hits + misses;
  const evictedKeys = toNumber(info.get("evicted_keys")) ?? 0;
  return {
    usedMemoryBytes,
    maxMemoryBytes,
    connectedClients,
    hitRatio: total > 0 ? hits / total : null,
    evictedKeys,
  };
}

/** One DSN, one collector instance, a fresh connection per tick -- same
 * reasoning as `PostgresCollector`: a 15-second-cadence read gains nothing
 * from a pool. */
export class RedisCollector {
  private readonly opts: RedisConnectOptions | null;

  constructor(dsn: string) {
    this.opts = parseRedisDsn(dsn);
  }

  configured(): boolean {
    return this.opts !== null;
  }

  async collect(): Promise<RedisSample | null> {
    if (!this.opts) return null;
    const opts = this.opts;
    let socket: net.Socket;
    try {
      socket = await withTimeout(connectSocket(opts), CONNECT_TIMEOUT_MS, "redis connect");
    } catch {
      return null;
    }
    try {
      const reader = new RespReader(socket);
      const run = async () => {
        if (opts.password !== null) await command(socket, reader, ["AUTH", opts.password]);
        if (opts.db !== null) await command(socket, reader, ["SELECT", String(opts.db)]);
        const reply = await command(socket, reader, ["INFO"]);
        return reply.kind === "bulk" && reply.text !== null ? reply.text : "";
      };
      const infoText = await withTimeout(run(), COMMAND_TIMEOUT_MS, "redis INFO");
      return buildSample(parseInfo(infoText));
    } catch {
      return null;
    } finally {
      socket.destroy();
    }
  }
}
