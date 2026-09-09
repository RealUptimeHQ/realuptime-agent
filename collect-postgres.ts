import { createHash } from "node:crypto";
import * as net from "node:net";
import type { PostgresSample } from "./types.ts";

/**
 * PostgreSQL enrichment (REA-440 phase 3), config-gated and off by default.
 *
 * Nothing here runs unless the customer sets `REALUPTIME_POSTGRES_DSN`
 * (config.ts): the headline v2 integration this program collects on top of
 * the OS-level sample, but only for a customer who has told it where a
 * database is and handed it a connection string. Absence of the variable
 * means absence of any Postgres traffic at all, exactly like the Docker
 * socket enrichment stays silent on a host with no Docker.
 *
 * ## Why a hand-rolled client instead of `pg`
 *
 * This program ships with zero runtime dependencies (wire-contract.test.ts
 * enforces it) and that is a security property for code that runs on a
 * customer's own machine, not a preference. The Postgres frontend/backend
 * protocol for the one thing this module needs -- connect, authenticate,
 * run a short read-only query batch, read the rows back -- is a few hundred
 * lines over a plain TCP or unix-domain socket (`node:net`), so it stays
 * inside the same zero-dependency rule the Docker Engine API client
 * (collect-docker.ts) already established for exactly this reason.
 *
 * ## What is collected, and why these five
 *
 * One batch of five short, read-only statements, sent as a single simple
 * Query message (one network round trip) against `pg_stat_activity`,
 * `pg_settings`, `pg_stat_database`, `pg_database` and `pg_stat_replication`:
 * connection count against the configured max, per-database size (bounded,
 * largest first), the buffer cache hit ratio, the oldest still-running
 * query's age, and replication lag when this instance has replicas. Every
 * one of them is a `pg_catalog` read available to any role with `pg_monitor`
 * (or superuser) and none of them touches customer table data.
 *
 * ## Authentication
 *
 * Trust, cleartext password and MD5 are supported -- the three methods a
 * self-hosted Postgres a customer controls is commonly configured with for
 * a dedicated monitoring role. SCRAM-SHA-256 (the default `pg_hba.conf`
 * method since Postgres 14) is NOT implemented in this phase and is refused
 * with a message naming the gap rather than a cryptic protocol error;
 * REA-440's follow-up ships it. TLS is likewise not implemented: the DSN is
 * expected to point at an instance reachable without one (typically
 * localhost or the same private network the agent already runs on).
 *
 * ## Failure is silent, not a warning storm
 *
 * A DSN that is present but unreachable (wrong password, database down,
 * network partition) fails the CURRENT tick's collection only and is
 * retried next tick: `collect-metrics.ts` warns once per distinct failure
 * reason and keeps going, the same pattern `enrichWithDocker` uses for the
 * Docker socket. Nothing about a Postgres failure ever takes the core OS
 * sample down with it.
 */

export const MAX_POSTGRES_DATABASES_PER_SAMPLE = 20;
const DEFAULT_PORT = 5432;
const CONNECT_TIMEOUT_MS = 3000;
const QUERY_TIMEOUT_MS = 5000;

export interface PostgresConnectOptions {
  /** A hostname/IP for TCP, or a directory (starts with "/") for a unix
   * domain socket at `<dir>/.s.PGSQL.<port>`, libpq's own convention. */
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Accepts `postgresql://user:pass@host:port/db` (and the `postgres://`
 * alias), and libpq's unix-socket convention of a `host` query parameter
 * that starts with "/" for a socket-only DSN such as
 * `postgresql:///mydb?host=/var/run/postgresql&port=5432`. Returns null for
 * anything unparseable rather than throwing: a malformed DSN is "not
 * configured" from this module's point of view, and the caller decides
 * whether that is worth a log line. */
export function parsePostgresDsn(raw: string): PostgresConnectOptions | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") return null;
  const hostParam = url.searchParams.get("host");
  const host = hostParam || url.hostname || "localhost";
  const portParam = url.searchParams.get("port");
  const port = url.port ? Number(url.port) : portParam ? Number(portParam) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const database =
    decodeURIComponent(url.pathname.replace(/^\//, "")) || url.username || "postgres";
  const user = decodeURIComponent(url.username) || "postgres";
  const password = decodeURIComponent(url.password);
  if (!host) return null;
  return { host, port, user, password, database };
}

/** Never logged: the fingerprint is the shape a customer's own log filter
 * would need to notice a secret is NOT present, not a diagnostic. */
export function dsnFingerprint(opts: PostgresConnectOptions): string {
  return `${opts.user}@${opts.host}:${opts.port}/${opts.database}`;
}

function md5Hex(input: Buffer | string): string {
  return createHash("md5").update(input).digest("hex");
}

/** libpq's MD5 challenge response: `"md5" + md5(md5(password + user) + salt)`. */
export function md5PasswordResponse(user: string, password: string, salt: Buffer): string {
  const inner = md5Hex(password + user);
  const outer = md5Hex(Buffer.concat([Buffer.from(inner, "utf8"), salt]));
  return `md5${outer}`;
}

function buildStartupMessage(user: string, database: string): Buffer {
  const pairs: [string, string][] = [
    ["user", user],
    ["database", database],
    ["application_name", "realuptime-agent"],
  ];
  const parts = pairs.map(([k, v]) => Buffer.from(`${k}\0${v}\0`, "utf8"));
  const body = Buffer.concat([...parts, Buffer.from([0])]);
  const header = Buffer.alloc(8);
  header.writeInt32BE(8 + body.length, 0);
  header.writeInt32BE(196608, 4); // protocol version 3.0
  return Buffer.concat([header, body]);
}

function buildPasswordMessage(password: string): Buffer {
  const body = Buffer.from(`${password}\0`, "utf8");
  const header = Buffer.alloc(5);
  header[0] = 0x70; // 'p'
  header.writeInt32BE(4 + body.length, 1);
  return Buffer.concat([header, body]);
}

function buildQueryMessage(query: string): Buffer {
  const body = Buffer.from(`${query}\0`, "utf8");
  const header = Buffer.alloc(5);
  header[0] = 0x51; // 'Q'
  header.writeInt32BE(4 + body.length, 1);
  return Buffer.concat([header, body]);
}

/** One field:value from an ErrorResponse/NoticeResponse's field list, keyed
 * by libpq's single-byte field codes ("M" is the human message). */
function parseFieldedResponse(payload: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < payload.length && payload[i] !== 0) {
    const code = String.fromCharCode(payload[i]!);
    i++;
    const start = i;
    while (i < payload.length && payload[i] !== 0) i++;
    fields[code] = payload.toString("utf8", start, i);
    i++;
  }
  return fields;
}

/** Buffers a socket's bytes into whole Postgres protocol messages
 * (1-byte type + int32 length, backend-message framing throughout), and
 * hands them out one at a time via `next()`. Pull-based so the auth
 * handshake and the query loop can each await exactly the message they
 * need without a separate event-listener callback per state. */
class PgMessageReader {
  private buffer = Buffer.alloc(0);
  private readonly pending: { type: string; payload: Buffer }[] = [];
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
    while (this.buffer.length >= 5) {
      const len = this.buffer.readInt32BE(1);
      if (len < 4 || this.buffer.length < 1 + len) break;
      const type = String.fromCharCode(this.buffer[0]!);
      const payload = this.buffer.subarray(5, 1 + len);
      this.pending.push({ type, payload });
      this.buffer = this.buffer.subarray(1 + len);
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

  async next(): Promise<{ type: string; payload: Buffer }> {
    for (;;) {
      const msg = this.pending.shift();
      if (msg) return msg;
      if (this.error) throw this.error;
      if (this.closed) throw new Error("postgres connection closed unexpectedly");
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

async function authenticate(
  reader: PgMessageReader,
  socket: net.Socket,
  user: string,
  password: string,
): Promise<void> {
  for (;;) {
    const msg = await reader.next();
    if (msg.type === "E") {
      throw new Error(parseFieldedResponse(msg.payload).M ?? "postgres authentication failed");
    }
    if (msg.type === "Z") return; // ReadyForQuery: authenticated (trust, or auth already accepted)
    if (msg.type === "R") {
      const authType = msg.payload.readInt32BE(0);
      if (authType === 0) continue; // AuthenticationOk; keep reading to ReadyForQuery
      if (authType === 3) {
        socket.write(buildPasswordMessage(password));
        continue;
      }
      if (authType === 5) {
        const salt = msg.payload.subarray(4, 8);
        socket.write(buildPasswordMessage(md5PasswordResponse(user, password, salt)));
        continue;
      }
      throw new Error(
        `unsupported postgres authentication method (code ${authType}); only trust, cleartext password and md5 are supported in this agent version`,
      );
    }
    // NoticeResponse, ParameterStatus, BackendKeyData: not needed here.
  }
}

export interface PgStatementResult {
  columns: string[];
  rows: (string | null)[][];
}

function parseRowDescription(payload: Buffer): string[] {
  const count = payload.readInt16BE(0);
  const names: string[] = [];
  let offset = 2;
  for (let i = 0; i < count; i++) {
    const end = payload.indexOf(0, offset);
    names.push(payload.toString("utf8", offset, end));
    offset = end + 1 + 18; // null terminator + the fixed 18-byte tail per field
  }
  return names;
}

function parseDataRow(payload: Buffer): (string | null)[] {
  const count = payload.readInt16BE(0);
  const values: (string | null)[] = [];
  let offset = 2;
  for (let i = 0; i < count; i++) {
    const len = payload.readInt32BE(offset);
    offset += 4;
    if (len < 0) {
      values.push(null);
      continue;
    }
    values.push(payload.toString("utf8", offset, offset + len));
    offset += len;
  }
  return values;
}

/** Runs one semicolon-separated batch of statements as a single simple Query
 * message (one round trip), and returns each statement's rows in order. */
async function runBatch(
  socket: net.Socket,
  reader: PgMessageReader,
  batch: string,
): Promise<PgStatementResult[]> {
  socket.write(buildQueryMessage(batch));
  const results: PgStatementResult[] = [];
  let columns: string[] = [];
  let rows: (string | null)[][] = [];
  for (;;) {
    const msg = await reader.next();
    switch (msg.type) {
      case "T":
        columns = parseRowDescription(msg.payload);
        rows = [];
        break;
      case "D":
        rows.push(parseDataRow(msg.payload));
        break;
      case "C":
        results.push({ columns, rows });
        columns = [];
        rows = [];
        break;
      case "E":
        throw new Error(parseFieldedResponse(msg.payload).M ?? "postgres query failed");
      case "Z":
        return results;
      default:
      // EmptyQueryResponse, NoticeResponse, ParameterStatus, CopyInResponse
      // never arise from this fixed, read-only batch; nothing to do with them.
    }
  }
}

function col(result: PgStatementResult | undefined, name: string, rowIndex = 0): string | null {
  if (!result) return null;
  const idx = result.columns.indexOf(name);
  const row = result.rows[rowIndex];
  if (idx < 0 || !row) return null;
  return row[idx] ?? null;
}

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The five-statement batch. Each aggregate is written so it always returns
 * exactly one row (`sum`/`count`/`coalesce`), so the caller never has to
 * special-case "no rows back" for statements 1-3 and 5; statement 4 is the
 * one genuinely multi-row result, bounded by its own LIMIT. */
const QUERY_BATCH = [
  // 1: connections and the oldest still-running query's age, one pass over
  // pg_stat_activity so the two do not cost two round trips.
  `select
     count(*) filter (where pid <> pg_backend_pid())::int as connections,
     coalesce(extract(epoch from max(now() - query_start)) filter (where state = 'active' and pid <> pg_backend_pid()), 0)::double precision as longest_query_seconds
   from pg_stat_activity`,
  // 2: the configured ceiling connections is measured against.
  `select setting::int as max_connections from pg_settings where name = 'max_connections'`,
  // 3: cluster-wide buffer cache hit ratio, raw counters (ratio computed in
  // JS, not SQL, so a fresh cluster with zero reads of either kind reads as
  // "no data" instead of a division-by-zero NaN silently becoming a string).
  `select coalesce(sum(blks_hit), 0)::bigint as blks_hit, coalesce(sum(blks_read), 0)::bigint as blks_read from pg_stat_database`,
  // 4: per-database size, largest first, bounded so a cluster with an
  // unusual number of databases costs a fixed amount of wire payload.
  `select datname, pg_database_size(datname)::bigint as size_bytes from pg_database where datistemplate = false order by size_bytes desc limit ${MAX_POSTGRES_DATABASES_PER_SAMPLE}`,
  // 5: replication lag as seen from a primary with replicas. A standalone
  // instance or a standby (whose lag is not visible from this same view)
  // both read as "no rows", which becomes null below, not zero.
  `select extract(epoch from max(replay_lag))::double precision as lag_seconds from pg_stat_replication`,
].join(";\n");

function buildSample(results: PgStatementResult[]): PostgresSample {
  const [activity, settings, cache, databases, replication] = results;
  const blksHit = toNumber(col(cache, "blks_hit")) ?? 0;
  const blksRead = toNumber(col(cache, "blks_read")) ?? 0;
  const total = blksHit + blksRead;
  const databaseRows = databases?.rows ?? [];
  const nameIdx = databases?.columns.indexOf("datname") ?? -1;
  const sizeIdx = databases?.columns.indexOf("size_bytes") ?? -1;
  return {
    connections: toNumber(col(activity, "connections")) ?? 0,
    maxConnections: toNumber(col(settings, "max_connections")),
    databases:
      nameIdx >= 0 && sizeIdx >= 0
        ? databaseRows
            .filter((row) => row[nameIdx] !== null)
            .map((row) => ({ name: row[nameIdx]!, sizeBytes: Number(row[sizeIdx] ?? 0) }))
        : [],
    cacheHitRatio: total > 0 ? blksHit / total : null,
    longestQuerySeconds: toNumber(col(activity, "longest_query_seconds")) ?? 0,
    replicationLagSeconds: toNumber(col(replication, "lag_seconds")),
  };
}

function connectSocket(opts: PostgresConnectOptions): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = opts.host.startsWith("/")
      ? net.createConnection({ path: `${opts.host}/.s.PGSQL.${opts.port}` })
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
    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      onError(new Error("postgres connection timed out")),
    );
  });
}

/**
 * One DSN, one collector instance, reused every tick (a fresh TCP/socket
 * connection per tick, same as the docker inspect call is a fresh HTTP
 * request per tick -- these are 15-second-cadence reads, not a long-lived
 * pool, and a pool would be one more thing to keep healthy across a
 * database restart for no benefit at this query rate).
 */
export class PostgresCollector {
  private readonly opts: PostgresConnectOptions | null;

  constructor(dsn: string) {
    this.opts = parsePostgresDsn(dsn);
  }

  /** Whether the DSN at least parsed. A parse failure is a configuration
   * mistake worth one log line at startup, distinct from a connection
   * failure worth retrying silently every tick. */
  configured(): boolean {
    return this.opts !== null;
  }

  async collect(): Promise<PostgresSample | null> {
    if (!this.opts) return null;
    const opts = this.opts;
    let socket: net.Socket;
    try {
      socket = await withTimeout(connectSocket(opts), CONNECT_TIMEOUT_MS, "postgres connect");
    } catch {
      return null;
    }
    try {
      const reader = new PgMessageReader(socket);
      socket.write(buildStartupMessage(opts.user, opts.password));
      await withTimeout(
        authenticate(reader, socket, opts.user, opts.password),
        CONNECT_TIMEOUT_MS,
        "postgres authentication",
      );
      const results = await withTimeout(
        runBatch(socket, reader, QUERY_BATCH),
        QUERY_TIMEOUT_MS,
        "postgres query",
      );
      return buildSample(results);
    } catch {
      return null;
    } finally {
      socket.destroy();
    }
  }
}
