import { createHash } from "node:crypto";
import * as net from "node:net";
import type { MysqlSample } from "./types.ts";

/**
 * MySQL/MariaDB enrichment (REA-440 phase 4), config-gated and off by
 * default, following the exact pattern collect-postgres.ts and
 * collect-redis.ts established in phase 3: nothing here runs unless the
 * customer sets `REALUPTIME_MYSQL_DSN`. Phase 3's PR named this one "not
 * trivial to add safely in this session -- a third from-scratch wire
 * protocol" and deferred it; this is that follow-up.
 *
 * ## Why a hand-rolled client instead of `mysql`/`mysql2`
 *
 * Same reasoning as the other two: zero runtime dependencies
 * (wire-contract.test.ts enforces it), a security property for code that
 * runs on a customer's own machine. The MySQL client/server protocol for the
 * one thing this module needs -- connect, authenticate, run a handful of
 * read-only `SHOW` statements, read the rows back -- is implemented here
 * over a plain TCP or unix-domain socket (`node:net`), inside the same
 * zero-dependency rule collect-docker.ts established.
 *
 * ## What is collected, and why these six
 *
 * `SHOW GLOBAL STATUS` (one round trip, filtered client-side to the handful
 * of counters below, never stored or forwarded whole -- an operator paging
 * on this host wants six numbers, not the several hundred rows MySQL
 * returns) plus two small follow-up statements: `SHOW GLOBAL VARIABLES LIKE
 * 'max_connections'` and `SHOW SLAVE STATUS` (or its `SHOW REPLICA STATUS`
 * alias-successor on newer builds). Chosen the same way the Postgres batch
 * was: connections against the configured ceiling, threads actively
 * running (not merely connected), the slow-query counter, the InnoDB
 * buffer pool hit ratio, server uptime, and replication lag when this
 * instance is a replica. Not a `SHOW GLOBAL STATUS` dump: it returns
 * several hundred counters and this module reads six of them.
 *
 * Unlike Postgres's single five-statement batch (one simple Query message
 * can carry several semicolon-separated statements over that wire
 * protocol), MySQL's classic protocol runs one statement per `COM_QUERY`
 * command and one result set per response; enabling multi-statement
 * execution is its own capability flag some operators disable for security
 * reasons, so this module never asks for it. Three round trips at a
 * 15-second cadence costs nothing worth avoiding that flag for.
 *
 * ## Authentication
 *
 * `mysql_native_password` only -- a SHA1-based challenge/response any
 * MySQL 5.x/8.x or MariaDB server still accepts for a dedicated monitoring
 * user, and the plugin every hand-rolled MySQL client before this one
 * implements first. `caching_sha2_password` (the MySQL 8.0+ default) is NOT
 * implemented in this phase: its "full" authentication path needs either
 * TLS or an RSA public-key exchange neither of which this module speaks,
 * and refusing it with a message naming the gap is the same choice
 * collect-postgres.ts made for SCRAM-SHA-256. A monitoring role created
 * with `IDENTIFIED WITH mysql_native_password` works today; REA-440's
 * follow-up ships caching_sha2_password. TLS itself is likewise not
 * implemented, matching both siblings: point the DSN at an instance
 * reachable without one.
 *
 * ## Failure is silent, not a warning storm
 *
 * A DSN that is present but unreachable (wrong password, database down,
 * network partition) fails the CURRENT tick's collection only and is
 * retried next tick, exactly like Postgres and Redis. A privilege gap on
 * just the replication statement (a monitoring user without `REPLICATION
 * CLIENT`) degrades only `replicationLagSeconds` to null for that tick
 * rather than losing the whole sample: the connection and the two other
 * statements already succeeded and are real.
 */

export const DEFAULT_PORT = 3306;
const CONNECT_TIMEOUT_MS = 3000;
const QUERY_TIMEOUT_MS = 5000;
const MAX_PACKET_LENGTH = 0xffffff;

// Capability flags this client requests. Deliberately NOT requesting
// CLIENT_DEPRECATE_EOF: omitting it guarantees every server, old or new,
// keeps sending the classic EOF marker packets this reader parses, rather
// than needing to support both wire shapes.
const CLIENT_LONG_PASSWORD = 0x00000001;
const CLIENT_CONNECT_WITH_DB = 0x00000008;
const CLIENT_PROTOCOL_41 = 0x00000200;
const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_PLUGIN_AUTH = 0x00080000;

export interface MysqlConnectOptions {
  /** A hostname/IP for TCP, or a full socket path (starts with "/") for a
   * unix domain socket, given verbatim (unlike Postgres, MySQL's socket
   * path is not a directory-plus-convention, so no filename is appended). */
  host: string;
  port: number;
  user: string;
  password: string;
  database: string | null;
}

/** Accepts `mysql://user:pass@host:port/db`, and a unix-socket form via a
 * `socket` query parameter: `mysql://user:pass@localhost/db?socket=/var/run/mysqld/mysqld.sock`.
 * Returns null for anything unparseable rather than throwing. */
export function parseMysqlDsn(raw: string): MysqlConnectOptions | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "mysql:") return null;
  const socketParam = url.searchParams.get("socket");
  const host = socketParam || url.hostname || "localhost";
  const port = url.port ? Number(url.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || null;
  const user = decodeURIComponent(url.username) || "root";
  const password = decodeURIComponent(url.password);
  if (!host) return null;
  return { host, port, user, password, database };
}

/** Never logged, same as the two siblings' `dsnFingerprint`. */
export function dsnFingerprint(opts: MysqlConnectOptions): string {
  return `${opts.user}@${opts.host}:${opts.port}${opts.database ? `/${opts.database}` : ""}`;
}

function sha1(input: Buffer): Buffer {
  return createHash("sha1").update(input).digest();
}

function xorBuffers(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

/**
 * `mysql_native_password`'s challenge/response, the same formula every
 * MySQL client implements:
 *
 *   SHA1(password) XOR SHA1(scramble + SHA1(SHA1(password)))
 *
 * An empty password yields an empty (zero-length) response, per protocol.
 */
export function mysqlNativePasswordResponse(password: string, scramble: Buffer): Buffer {
  if (password.length === 0) return Buffer.alloc(0);
  const passwordHash = sha1(Buffer.from(password, "utf8"));
  const doubleHash = sha1(passwordHash);
  const combined = sha1(Buffer.concat([scramble, doubleHash]));
  return xorBuffers(passwordHash, combined);
}

/** Buffers a socket's bytes into whole MySQL protocol packets (3-byte
 * little-endian length + 1-byte sequence id), pull-based like the Postgres
 * and Redis readers. A packet whose payload is exactly `MAX_PACKET_LENGTH`
 * bytes is the first of a split sequence continued by a follow-up packet
 * with the same sequence-id rule; none of this module's fixed, short
 * statements ever produce one, but a well-behaved reader does not assume
 * that of a server it does not control, so split packets are reassembled. */
class MysqlPacketReader {
  private buffer = Buffer.alloc(0);
  private readonly pending: { seq: number; payload: Buffer }[] = [];
  private error: Error | null = null;
  private closed = false;
  private wake: (() => void) | null = null;
  private carry: { seq: number; payload: Buffer } | null = null;

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
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUIntLE(0, 3);
      const seq = this.buffer[3]!;
      if (this.buffer.length < 4 + length) break;
      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      if (length === MAX_PACKET_LENGTH) {
        // A split packet: accumulate and keep reading, do not surface yet.
        this.carry = this.carry
          ? { seq: this.carry.seq, payload: Buffer.concat([this.carry.payload, payload]) }
          : { seq, payload };
        continue;
      }
      if (this.carry) {
        this.pending.push({
          seq: this.carry.seq,
          payload: Buffer.concat([this.carry.payload, payload]),
        });
        this.carry = null;
      } else {
        this.pending.push({ seq, payload });
      }
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

  async next(): Promise<{ seq: number; payload: Buffer }> {
    for (;;) {
      const msg = this.pending.shift();
      if (msg) return msg;
      if (this.error) throw this.error;
      if (this.closed) throw new Error("mysql connection closed unexpectedly");
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

/** One packet out, tracking the sequence id the protocol requires: it
 * resets to 0 at the start of a command and increments by one with every
 * packet exchanged (in either direction) until the command completes. */
class MysqlConnection {
  private seq = 0;

  constructor(
    private readonly socket: net.Socket,
    private readonly reader: MysqlPacketReader,
  ) {}

  async readPacket(): Promise<Buffer> {
    const { seq, payload } = await this.reader.next();
    this.seq = (seq + 1) & 0xff;
    return payload;
  }

  writePacket(payload: Buffer): void {
    const header = Buffer.alloc(4);
    header.writeUIntLE(payload.length, 0, 3);
    header[3] = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    this.socket.write(Buffer.concat([header, payload]));
  }

  /** Resets the sequence counter to 0, as required at the start of every
   * new command (`COM_QUERY`, etc). */
  resetSequence(): void {
    this.seq = 0;
  }
}

// ---------------------------------------------------------------------------
// Length-encoded integers and strings (the MySQL wire's variable-length
// primitives), read from a fixed buffer with an explicit cursor.
// ---------------------------------------------------------------------------

interface Cursor {
  offset: number;
}

function readLenEncInt(buf: Buffer, cursor: Cursor): number | null {
  const first = buf[cursor.offset]!;
  cursor.offset++;
  if (first < 0xfb) return first;
  if (first === 0xfb) return null; // NULL, only meaningful in row data
  if (first === 0xfc) {
    const v = buf.readUIntLE(cursor.offset, 2);
    cursor.offset += 2;
    return v;
  }
  if (first === 0xfd) {
    const v = buf.readUIntLE(cursor.offset, 3);
    cursor.offset += 3;
    return v;
  }
  // 0xfe: 8-byte integer. Every count this module reads fits well within
  // Number's safe integer range.
  const v = Number(buf.readBigUInt64LE(cursor.offset));
  cursor.offset += 8;
  return v;
}

function readLenEncString(buf: Buffer, cursor: Cursor): string | null {
  const len = readLenEncInt(buf, cursor);
  if (len === null) return null;
  const value = buf.toString("utf8", cursor.offset, cursor.offset + len);
  cursor.offset += len;
  return value;
}

function readNullTerminatedString(buf: Buffer, offset: number): { value: string; next: number } {
  const end = buf.indexOf(0, offset);
  const stop = end < 0 ? buf.length : end;
  return { value: buf.toString("utf8", offset, stop), next: stop + 1 };
}

// ---------------------------------------------------------------------------
// Handshake and authentication
// ---------------------------------------------------------------------------

interface ServerHandshake {
  capabilities: number;
  authPluginData: Buffer;
  authPluginName: string;
}

function parseHandshakeV10(payload: Buffer): ServerHandshake {
  const protocolVersion = payload[0]!;
  if (protocolVersion !== 10) {
    throw new Error(
      `unsupported mysql protocol version ${protocolVersion}; only version 10 (4.1+) is supported`,
    );
  }
  let offset = 1;
  const serverVersion = readNullTerminatedString(payload, offset);
  offset = serverVersion.next;
  offset += 4; // connection id
  const authPart1 = payload.subarray(offset, offset + 8);
  offset += 8;
  offset += 1; // filler
  const capabilitiesLow = payload.readUInt16LE(offset);
  offset += 2;
  offset += 1; // character set
  offset += 2; // status flags
  const capabilitiesHigh = payload.readUInt16LE(offset);
  offset += 2;
  const capabilities = capabilitiesLow | (capabilitiesHigh << 16);
  const authPluginDataLen = payload[offset]!;
  offset += 1;
  offset += 10; // reserved
  let authPart2: Buffer = Buffer.alloc(0);
  if (capabilities & CLIENT_SECURE_CONNECTION) {
    const part2Len = Math.max(13, authPluginDataLen - 8);
    // Trailing null terminator included in part2Len; drop it from the salt.
    authPart2 = Buffer.from(payload.subarray(offset, offset + part2Len - 1));
    offset += part2Len;
  }
  let authPluginName = "mysql_native_password";
  if (capabilities & CLIENT_PLUGIN_AUTH) {
    authPluginName = readNullTerminatedString(payload, offset).value;
  }
  return {
    capabilities,
    authPluginData: Buffer.concat([authPart1, authPart2]),
    authPluginName,
  };
}

function buildHandshakeResponse(
  opts: MysqlConnectOptions,
  authResponse: Buffer,
  useDatabase: boolean,
): Buffer {
  let clientFlags =
    CLIENT_LONG_PASSWORD | CLIENT_PROTOCOL_41 | CLIENT_SECURE_CONNECTION | CLIENT_PLUGIN_AUTH;
  if (useDatabase) clientFlags |= CLIENT_CONNECT_WITH_DB;

  const parts: Buffer[] = [];
  const fixed = Buffer.alloc(4 + 4 + 1 + 23);
  fixed.writeUInt32LE(clientFlags, 0);
  fixed.writeUInt32LE(16 * 1024 * 1024, 4); // max_packet_size
  fixed[8] = 33; // utf8_general_ci
  parts.push(fixed);
  parts.push(Buffer.from(`${opts.user}\0`, "utf8"));
  parts.push(Buffer.from([authResponse.length]));
  parts.push(authResponse);
  if (useDatabase && opts.database) {
    parts.push(Buffer.from(`${opts.database}\0`, "utf8"));
  }
  parts.push(Buffer.from("mysql_native_password\0", "utf8"));
  return Buffer.concat(parts);
}

/** Parses an ERR packet's SQL message (skips the error code and, when
 * present, the "#SQLSTATE" marker). Good enough for a log line; this module
 * never branches on the error CODE, only whether one occurred. */
function parseErrorPacket(payload: Buffer): string {
  let offset = 1; // 0xff
  offset += 2; // error code
  if (payload[offset] === 0x23 /* '#' */) offset += 6; // sql state marker + 5 chars
  return payload.toString("utf8", offset);
}

/** The message named when the account this DSN authenticates as turns out
 * to need a plugin this module does not speak -- shared between the
 * AuthSwitchRequest path and (defensively) the initial handshake path. */
function unsupportedPluginError(pluginName: string): Error {
  return new Error(
    `unsupported mysql authentication plugin '${pluginName}'; only mysql_native_password is supported in this agent version (caching_sha2_password, MySQL 8's default, needs TLS or an RSA exchange this agent does not implement -- create the monitoring user with IDENTIFIED WITH mysql_native_password)`,
  );
}

async function authenticate(conn: MysqlConnection, opts: MysqlConnectOptions): Promise<void> {
  const first = await conn.readPacket();
  if (first[0] === 0xff) throw new Error(parseErrorPacket(first));
  const handshake = parseHandshakeV10(first);
  // The initial handshake's plugin name is the SERVER's default (MySQL 8
  // defaults to caching_sha2_password even for an account that is itself
  // configured with mysql_native_password), not necessarily what this
  // particular account needs. This client always offers
  // mysql_native_password -- naming it as `client_plugin_name` below -- and
  // lets the server correct it with an AuthSwitchRequest if the account
  // actually needs something else, exactly as libmysqlclient does. Refusing
  // here on the greeting's plugin name alone would reject accounts that
  // would have worked.
  const authResponse = mysqlNativePasswordResponse(opts.password, handshake.authPluginData);
  conn.writePacket(buildHandshakeResponse(opts, authResponse, opts.database !== null));

  const reply = await conn.readPacket();
  if (reply[0] === 0x00) return; // OK packet
  if (reply[0] === 0xff) throw new Error(parseErrorPacket(reply));
  if (reply[0] === 0xfe) {
    // AuthSwitchRequest: the server wants a different plugin than the one
    // this client offered. Only worth following if it is asking for the
    // same plugin this module already speaks with a fresh scramble;
    // anything else is the same unsupported-plugin gap as above.
    const cursor: Cursor = { offset: 1 };
    const pluginName = readNullTerminatedString(reply, cursor.offset);
    if (pluginName.value !== "mysql_native_password") {
      throw unsupportedPluginError(pluginName.value);
    }
    // The auth plugin data runs to the end of the packet; some servers
    // include a trailing 0x00 the way the initial handshake's part-2 does,
    // which is stripped here if present so the scramble is exactly the 20
    // bytes mysql_native_password expects either way.
    const rawScramble = reply.subarray(pluginName.next, reply.length);
    const newScramble =
      rawScramble.length > 0 && rawScramble[rawScramble.length - 1] === 0
        ? rawScramble.subarray(0, rawScramble.length - 1)
        : rawScramble;
    conn.writePacket(mysqlNativePasswordResponse(opts.password, newScramble));
    const final = await conn.readPacket();
    if (final[0] === 0xff) throw new Error(parseErrorPacket(final));
    return;
  }
  throw new Error("unexpected mysql handshake response");
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

export interface MysqlResultSet {
  columns: string[];
  rows: (string | null)[][];
}

const COM_QUERY = 0x03;

/** Parses one column-definition-41 packet just far enough to recover the
 * column name (the 5th length-encoded string in the packet), which is all
 * this module ever needs -- `SHOW SLAVE STATUS`'s column SET is what varies
 * across MySQL/MariaDB versions, and reading by name rather than position
 * is what makes that portable. */
function parseColumnName(payload: Buffer): string {
  const cursor: Cursor = { offset: 0 };
  readLenEncString(payload, cursor); // catalog
  readLenEncString(payload, cursor); // schema
  readLenEncString(payload, cursor); // table
  readLenEncString(payload, cursor); // org_table
  return readLenEncString(payload, cursor) ?? "";
}

function parseRow(payload: Buffer, columnCount: number): (string | null)[] {
  const cursor: Cursor = { offset: 0 };
  const values: (string | null)[] = [];
  for (let i = 0; i < columnCount; i++) values.push(readLenEncString(payload, cursor));
  return values;
}

/** Runs one statement as its own `COM_QUERY` command (one round trip) and
 * returns its result set. Throws on an ERR packet or a non-result-set OK
 * packet (none of this module's `SHOW` statements ever produce the latter,
 * but a caller that got one asked the wrong thing). */
async function runQuery(conn: MysqlConnection, statement: string): Promise<MysqlResultSet> {
  conn.resetSequence();
  conn.writePacket(Buffer.concat([Buffer.from([COM_QUERY]), Buffer.from(statement, "utf8")]));

  const first = await conn.readPacket();
  if (first[0] === 0xff) throw new Error(parseErrorPacket(first));
  if (first[0] === 0x00) throw new Error(`${statement} returned no result set`);

  const cursor: Cursor = { offset: 0 };
  const columnCount = readLenEncInt(first, cursor) ?? 0;

  const columns: string[] = [];
  for (let i = 0; i < columnCount; i++) columns.push(parseColumnName(await conn.readPacket()));
  await conn.readPacket(); // EOF marking the end of column definitions

  const rows: (string | null)[][] = [];
  for (;;) {
    const packet = await conn.readPacket();
    if (packet[0] === 0xfe && packet.length < 9) break; // EOF: end of rows
    if (packet[0] === 0xff) throw new Error(parseErrorPacket(packet));
    rows.push(parseRow(packet, columnCount));
  }
  return { columns, rows };
}

function col(result: MysqlResultSet, name: string, rowIndex = 0): string | null {
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

function connectSocket(opts: MysqlConnectOptions): Promise<net.Socket> {
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
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => onError(new Error("mysql connection timed out")));
  });
}

/** Reads `SHOW GLOBAL STATUS` (a two-column Variable_name/Value result,
 * hundreds of rows) into a lookup map, so the handful of counters this
 * module wants are picked out client-side without storing or forwarding
 * the rest. */
function statusMap(result: MysqlResultSet): Map<string, string> {
  const nameIdx = result.columns.indexOf("Variable_name");
  const valueIdx = result.columns.indexOf("Value");
  const map = new Map<string, string>();
  if (nameIdx < 0 || valueIdx < 0) return map;
  for (const row of result.rows) {
    const name = row[nameIdx];
    const value = row[valueIdx];
    if (name !== null && name !== undefined) map.set(name, value ?? "");
  }
  return map;
}

function buildSample(
  status: Map<string, string>,
  maxConnections: number | null,
  replicationLagSeconds: number | null,
): MysqlSample {
  const reads = toNumber(status.get("Innodb_buffer_pool_reads") ?? null) ?? 0;
  const readRequests = toNumber(status.get("Innodb_buffer_pool_read_requests") ?? null) ?? 0;
  return {
    connections: toNumber(status.get("Threads_connected") ?? null) ?? 0,
    maxConnections,
    threadsRunning: toNumber(status.get("Threads_running") ?? null) ?? 0,
    slowQueries: toNumber(status.get("Slow_queries") ?? null) ?? 0,
    bufferPoolHitRatio: readRequests > 0 ? 1 - reads / readRequests : null,
    uptimeSeconds: toNumber(status.get("Uptime") ?? null) ?? 0,
    replicationLagSeconds,
  };
}

/** Reads the replica-lag column under either name MySQL/MariaDB has used
 * for it (`Seconds_Behind_Master`, and `Seconds_Behind_Source` since MySQL
 * 8.0.22's replication terminology rename), null on an instance with no
 * replication configured (an empty result, not an error) and null when the
 * column itself is NULL (a replica whose IO thread is not currently
 * connected to its source, whose lag is genuinely unknown, not zero). */
function replicationLagFrom(result: MysqlResultSet): number | null {
  if (result.rows.length === 0) return null;
  const value =
    col(result, "Seconds_Behind_Master") ?? col(result, "Seconds_Behind_Source") ?? null;
  return toNumber(value);
}

/**
 * One DSN, one collector instance, a fresh connection per tick -- same
 * reasoning as `PostgresCollector` and `RedisCollector`.
 */
export class MysqlCollector {
  private readonly opts: MysqlConnectOptions | null;

  constructor(dsn: string) {
    this.opts = parseMysqlDsn(dsn);
  }

  configured(): boolean {
    return this.opts !== null;
  }

  async collect(): Promise<MysqlSample | null> {
    if (!this.opts) return null;
    const opts = this.opts;
    let socket: net.Socket;
    try {
      socket = await withTimeout(connectSocket(opts), CONNECT_TIMEOUT_MS, "mysql connect");
    } catch {
      return null;
    }
    try {
      const reader = new MysqlPacketReader(socket);
      const conn = new MysqlConnection(socket, reader);
      await withTimeout(authenticate(conn, opts), CONNECT_TIMEOUT_MS, "mysql authentication");

      const status = statusMap(
        await withTimeout(
          runQuery(conn, "SHOW GLOBAL STATUS"),
          QUERY_TIMEOUT_MS,
          "mysql status query",
        ),
      );

      // Best-effort: a missing max_connections read (should not happen for
      // a role with any read access) degrades that one field to null
      // rather than the whole sample.
      let maxConnections: number | null = null;
      try {
        const variables = await withTimeout(
          runQuery(conn, "SHOW GLOBAL VARIABLES LIKE 'max_connections'"),
          QUERY_TIMEOUT_MS,
          "mysql variables query",
        );
        maxConnections = toNumber(col(variables, "Value"));
      } catch {
        // left null
      }

      // Best-effort: SHOW SLAVE STATUS needs REPLICATION CLIENT (or SLAVE
      // MONITOR on MariaDB), a privilege a minimal monitoring role may not
      // have been granted, and some builds have renamed or removed the
      // statement. Either way this degrades only replicationLagSeconds.
      let replicationLagSeconds: number | null = null;
      try {
        const slaveStatus = await withTimeout(
          runQuery(conn, "SHOW SLAVE STATUS"),
          QUERY_TIMEOUT_MS,
          "mysql replication status query",
        );
        replicationLagSeconds = replicationLagFrom(slaveStatus);
      } catch {
        // left null
      }

      return buildSample(status, maxConnections, replicationLagSeconds);
    } catch {
      return null;
    } finally {
      socket.destroy();
    }
  }
}
