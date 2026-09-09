import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PORT,
  MysqlCollector,
  dsnFingerprint,
  mysqlNativePasswordResponse,
  parseMysqlDsn,
} from "./collect-mysql.ts";

describe("parseMysqlDsn", () => {
  it("parses a plain TCP DSN", () => {
    expect(parseMysqlDsn("mysql://monitor:secret@db.internal:3307/appdb")).toEqual({
      host: "db.internal",
      port: 3307,
      user: "monitor",
      password: "secret",
      database: "appdb",
    });
  });

  it("defaults the port and user, and treats a missing path as no database", () => {
    expect(parseMysqlDsn("mysql://localhost")).toEqual({
      host: "localhost",
      port: DEFAULT_PORT,
      user: "root",
      password: "",
      database: null,
    });
  });

  it("reads a unix-socket DSN from the socket query parameter", () => {
    expect(
      parseMysqlDsn("mysql://monitor:x@localhost/appdb?socket=/var/run/mysqld/mysqld.sock"),
    ).toEqual({
      host: "/var/run/mysqld/mysqld.sock",
      port: DEFAULT_PORT,
      user: "monitor",
      password: "x",
      database: "appdb",
    });
  });

  it("returns null for an unparseable or wrong-scheme DSN", () => {
    expect(parseMysqlDsn("not a url")).toBeNull();
    expect(parseMysqlDsn("postgresql://u:p@localhost/db")).toBeNull();
  });

  it("returns null for a bogus port", () => {
    expect(parseMysqlDsn("mysql://localhost:0/db")).toBeNull();
    expect(parseMysqlDsn("mysql://localhost:99999/db")).toBeNull();
  });
});

describe("dsnFingerprint", () => {
  it("never includes the password", () => {
    const opts = parseMysqlDsn("mysql://monitor:very-secret@db.internal:3306/appdb")!;
    const fp = dsnFingerprint(opts);
    expect(fp).toBe("monitor@db.internal:3306/appdb");
    expect(fp).not.toContain("very-secret");
  });
});

describe("mysqlNativePasswordResponse", () => {
  it("is deterministic, 20 bytes, and depends on the scramble", () => {
    const scramble = Buffer.from("0123456789abcdefghij", "utf8"); // 20 bytes
    const response = mysqlNativePasswordResponse("secret", scramble);
    expect(response).toHaveLength(20);
    expect(mysqlNativePasswordResponse("secret", scramble)).toEqual(response);
    const otherScramble = Buffer.from("jihgfedcba9876543210", "utf8");
    expect(mysqlNativePasswordResponse("secret", otherScramble)).not.toEqual(response);
  });

  it("is empty for an empty password, per protocol", () => {
    const scramble = Buffer.alloc(20, 1);
    expect(mysqlNativePasswordResponse("", scramble)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A minimal fake MySQL server: enough of the classic client/server protocol
// to drive `MysqlCollector` through the handshake, one auth path, and the
// three-query sequence, without a real server.
// ---------------------------------------------------------------------------

const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_PLUGIN_AUTH = 0x00080000;

function packet(seq: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header[3] = seq;
  return Buffer.concat([header, payload]);
}

function lenEncInt(n: number): Buffer {
  if (n < 0xfb) return Buffer.from([n]);
  const b = Buffer.alloc(3);
  b[0] = 0xfc;
  b.writeUIntLE(n, 1, 2);
  return b;
}

function lenEncString(s: string): Buffer {
  const buf = Buffer.from(s, "utf8");
  return Buffer.concat([lenEncInt(buf.length), buf]);
}

/** A protocol-10 initial handshake packet, offering the given 20-byte
 * scramble under the given auth plugin name. */
function handshakePayload(scramble: Buffer, authPluginName: string): Buffer {
  const part1 = scramble.subarray(0, 8);
  const part2 = scramble.subarray(8, 20);
  const capabilities = CLIENT_SECURE_CONNECTION | CLIENT_PLUGIN_AUTH;
  const capLow = Buffer.alloc(2);
  capLow.writeUInt16LE(capabilities & 0xffff, 0);
  const capHigh = Buffer.alloc(2);
  capHigh.writeUInt16LE((capabilities >>> 16) & 0xffff, 0);
  return Buffer.concat([
    Buffer.from([10]), // protocol version
    Buffer.from("8.0.34\0", "utf8"),
    Buffer.from([1, 0, 0, 0]), // connection id
    part1,
    Buffer.from([0]), // filler
    capLow,
    Buffer.from([33]), // character set
    Buffer.from([0, 0]), // status flags
    capHigh,
    Buffer.from([21]), // auth_plugin_data_len
    Buffer.alloc(10), // reserved
    Buffer.concat([part2, Buffer.from([0])]),
    Buffer.from(`${authPluginName}\0`, "utf8"),
  ]);
}

function okPayload(): Buffer {
  return Buffer.concat([
    Buffer.from([0x00]),
    lenEncInt(0),
    lenEncInt(0),
    Buffer.alloc(2),
    Buffer.alloc(2),
  ]);
}

function errPayload(message: string): Buffer {
  return Buffer.concat([
    Buffer.from([0xff]),
    Buffer.from([0x20, 0x00]), // error code, irrelevant to this module
    Buffer.from("#HY000", "utf8"),
    Buffer.from(message, "utf8"),
  ]);
}

function columnDefPayload(name: string): Buffer {
  return Buffer.concat([
    lenEncString("def"),
    lenEncString(""),
    lenEncString(""),
    lenEncString(""),
    lenEncString(name),
    lenEncString(name),
    Buffer.from([0x0c]),
    Buffer.alloc(2),
    Buffer.alloc(4),
    Buffer.from([0xfd]),
    Buffer.alloc(2),
    Buffer.from([0]),
    Buffer.alloc(2),
  ]);
}

function eofPayload(): Buffer {
  return Buffer.from([0xfe, 0, 0, 0, 0]);
}

function rowPayload(values: (string | null)[]): Buffer {
  return Buffer.concat(values.map((v) => (v === null ? Buffer.from([0xfb]) : lenEncString(v))));
}

/** One `SHOW`-style result set, framed as a full sequence of packets: column
 * count, one column-definition packet per name, an EOF, one row packet per
 * row, and a final EOF -- what a real server sends for a single COM_QUERY. */
function resultSet(columns: string[], rows: (string | null)[][]): Buffer {
  let seq = 1;
  const packets = [packet(seq++, lenEncInt(columns.length))];
  for (const name of columns) packets.push(packet(seq++, columnDefPayload(name)));
  packets.push(packet(seq++, eofPayload()));
  for (const row of rows) packets.push(packet(seq++, rowPayload(row)));
  packets.push(packet(seq++, eofPayload()));
  return Buffer.concat(packets);
}

function errorResult(message: string): Buffer {
  return packet(1, errPayload(message));
}

let servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
  servers = [];
});

/** Starts a fake server that completes one auth flow, then answers each
 * subsequent COM_QUERY (one `data` event per command) with the next buffer
 * from `queryReplies`, in order -- the three-statement sequence
 * `collect-mysql.ts` sends every tick. */
function startFakeServer(
  queryReplies: Buffer[],
  authFlow: (socket: net.Socket, onAuthenticated: () => void) => void = (socket, done) => {
    socket.write(packet(0, handshakePayload(Buffer.alloc(20, 7), "mysql_native_password")));
    socket.once("data", () => {
      socket.write(packet(2, okPayload()));
      done();
    });
  },
): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      // Guarantees this socket can always reach 'end'/'close' once the
      // client disconnects, even in a test whose authFlow never attaches
      // its own 'data' listener (a Readable that nobody reads from stays
      // paused, and a paused stream with unread buffered bytes never fires
      // 'end' -- which would leave the server.close() in afterEach hanging
      // forever and poisoning every later test in this file). Real 'data'
      // listeners registered below still see every byte first, since this
      // only takes effect for bytes nothing else consumes.
      socket.resume();
      let index = 0;
      authFlow(socket, () => {
        socket.on("data", () => {
          if (index < queryReplies.length) socket.write(queryReplies[index++]!);
        });
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

const STATUS_ROWS: [string, string][] = [
  ["Threads_connected", "5"],
  ["Threads_running", "1"],
  ["Slow_queries", "2"],
  ["Uptime", "86400"],
  ["Innodb_buffer_pool_read_requests", "900"],
  ["Innodb_buffer_pool_reads", "100"],
];

function statusReply(): Buffer {
  return resultSet(["Variable_name", "Value"], STATUS_ROWS);
}

function variablesReply(maxConnections = "151"): Buffer {
  return resultSet(["Variable_name", "Value"], [["max_connections", maxConnections]]);
}

function slaveStatusReply(secondsBehind: string | null = null, hasRow = false): Buffer {
  if (!hasRow) return resultSet(["Seconds_Behind_Master"], []);
  return resultSet(["Seconds_Behind_Master"], [[secondsBehind]]);
}

describe("MysqlCollector", () => {
  it("returns null when the DSN does not parse (never attempts a connection)", async () => {
    const collector = new MysqlCollector("not a url");
    expect(collector.configured()).toBe(false);
    expect(await collector.collect()).toBeNull();
  });

  it("returns null when nothing is listening on the port", async () => {
    const collector = new MysqlCollector("mysql://root@127.0.0.1:1/db");
    expect(await collector.collect()).toBeNull();
  });

  it("authenticates with no password, runs the three-query sequence, and builds a sample", async () => {
    const port = await startFakeServer([statusReply(), variablesReply(), slaveStatusReply()]);
    const collector = new MysqlCollector(`mysql://root@127.0.0.1:${port}/app`);
    const sample = await collector.collect();
    expect(sample).toEqual({
      connections: 5,
      maxConnections: 151,
      threadsRunning: 1,
      slowQueries: 2,
      bufferPoolHitRatio: 8 / 9, // 1 - 100/900
      uptimeSeconds: 86400,
      replicationLagSeconds: null,
    });
  });

  it("authenticates with mysql_native_password when a password is required", async () => {
    const scramble = Buffer.alloc(20, 3);
    const expectedResponse = mysqlNativePasswordResponse("secret", scramble);
    let observedResponse: Buffer | null = null;
    const port = await startFakeServer(
      [statusReply(), variablesReply(), slaveStatusReply()],
      (socket, done) => {
        socket.write(packet(0, handshakePayload(scramble, "mysql_native_password")));
        socket.once("data", (chunk: Buffer) => {
          // The client's known-good 20-byte challenge response is somewhere
          // in the handshake response packet; where exactly depends on the
          // username length, so this looks for the bytes rather than
          // recomputing the field offsets by hand.
          const idx = chunk.indexOf(expectedResponse);
          if (idx >= 0) observedResponse = chunk.subarray(idx, idx + expectedResponse.length);
          socket.write(packet(2, okPayload()));
          done();
        });
      },
    );
    const collector = new MysqlCollector(`mysql://monitor:secret@127.0.0.1:${port}/app`);
    const sample = await collector.collect();
    expect(observedResponse).toEqual(expectedResponse);
    expect(sample?.connections).toBe(5);
  });

  it("follows an AuthSwitchRequest offering a fresh mysql_native_password scramble", async () => {
    const newScramble = Buffer.alloc(20, 9);
    const port = await startFakeServer(
      [statusReply(), variablesReply(), slaveStatusReply()],
      (socket, done) => {
        socket.write(packet(0, handshakePayload(Buffer.alloc(20, 1), "caching_sha2_password")));
        socket.once("data", () => {
          // AuthSwitchRequest: 0xfe + plugin name (null-terminated) + scramble.
          const payload = Buffer.concat([
            Buffer.from([0xfe]),
            Buffer.from("mysql_native_password\0", "utf8"),
            newScramble,
          ]);
          socket.write(packet(2, payload));
          socket.once("data", () => {
            socket.write(packet(4, okPayload()));
            done();
          });
        });
      },
    );
    const collector = new MysqlCollector(`mysql://monitor:secret@127.0.0.1:${port}/app`);
    const sample = await collector.collect();
    expect(sample?.connections).toBe(5);
  });

  it("refuses an AuthSwitchRequest naming caching_sha2_password with a null result, not a hang", async () => {
    const port = await startFakeServer([], (socket) => {
      // The greeting advertises caching_sha2_password (MySQL 8's default);
      // this client optimistically offers mysql_native_password anyway (see
      // authenticate()'s comment), so the server corrects it with an
      // AuthSwitchRequest naming the account's real plugin -- which this
      // module still does not speak.
      socket.write(packet(0, handshakePayload(Buffer.alloc(20, 1), "caching_sha2_password")));
      socket.once("data", () => {
        const payload = Buffer.concat([
          Buffer.from([0xfe]),
          Buffer.from("caching_sha2_password\0", "utf8"),
          Buffer.alloc(20, 1),
        ]);
        socket.write(packet(2, payload));
      });
    });
    const collector = new MysqlCollector(`mysql://monitor:secret@127.0.0.1:${port}/app`);
    expect(await collector.collect()).toBeNull();
  });

  it("times out (not a hang) when the server never answers the handshake response", async () => {
    const port = await startFakeServer([], (socket) => {
      socket.write(packet(0, handshakePayload(Buffer.alloc(20, 1), "mysql_native_password")));
      // Never responds to the handshake response that follows.
    });
    const collector = new MysqlCollector(`mysql://monitor:secret@127.0.0.1:${port}/app`);
    expect(await collector.collect()).toBeNull();
  }, 10_000);

  it("returns null (not a throw) on an ERR packet from the status query", async () => {
    const port = await startFakeServer([errorResult("Access denied")]);
    const collector = new MysqlCollector(`mysql://root@127.0.0.1:${port}/app`);
    expect(await collector.collect()).toBeNull();
  });

  it("degrades maxConnections and replicationLagSeconds to null on a per-statement failure, without losing the sample", async () => {
    const port = await startFakeServer([
      statusReply(),
      errorResult("Access denied"),
      errorResult("Access denied"),
    ]);
    const collector = new MysqlCollector(`mysql://limited@127.0.0.1:${port}/app`);
    const sample = await collector.collect();
    expect(sample?.connections).toBe(5);
    expect(sample?.maxConnections).toBeNull();
    expect(sample?.replicationLagSeconds).toBeNull();
  });

  it("reports a null buffer pool hit ratio when there have been no reads of either kind", async () => {
    const zeroRows: [string, string][] = STATUS_ROWS.map(([k, v]) =>
      k === "Innodb_buffer_pool_read_requests" || k === "Innodb_buffer_pool_reads"
        ? [k, "0"]
        : [k, v],
    );
    const port = await startFakeServer([
      resultSet(["Variable_name", "Value"], zeroRows),
      variablesReply(),
      slaveStatusReply(),
    ]);
    const collector = new MysqlCollector(`mysql://root@127.0.0.1:${port}/app`);
    const sample = await collector.collect();
    expect(sample?.bufferPoolHitRatio).toBeNull();
  });

  it("reports replication lag from a Seconds_Behind_Master row when this instance is a replica", async () => {
    const port = await startFakeServer([
      statusReply(),
      variablesReply(),
      slaveStatusReply("4", true),
    ]);
    const collector = new MysqlCollector(`mysql://root@127.0.0.1:${port}/app`);
    const sample = await collector.collect();
    expect(sample?.replicationLagSeconds).toBe(4);
  });

  it("reports replication lag from Seconds_Behind_Source, the MySQL 8.0.22+ column name", async () => {
    const port = await startFakeServer([
      statusReply(),
      variablesReply(),
      resultSet(["Seconds_Behind_Source"], [["7"]]),
    ]);
    const collector = new MysqlCollector(`mysql://root@127.0.0.1:${port}/app`);
    const sample = await collector.collect();
    expect(sample?.replicationLagSeconds).toBe(7);
  });
});
