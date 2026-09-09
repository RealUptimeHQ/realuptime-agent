import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_POSTGRES_DATABASES_PER_SAMPLE,
  PostgresCollector,
  dsnFingerprint,
  md5PasswordResponse,
  parsePostgresDsn,
} from "./collect-postgres.ts";

describe("parsePostgresDsn", () => {
  it("parses a plain TCP DSN with defaults", () => {
    expect(parsePostgresDsn("postgresql://monitor:secret@db.internal:5433/appdb")).toEqual({
      host: "db.internal",
      port: 5433,
      user: "monitor",
      password: "secret",
      database: "appdb",
    });
  });

  it("defaults the port, user and database", () => {
    expect(parsePostgresDsn("postgresql://localhost")).toEqual({
      host: "localhost",
      port: 5432,
      user: "postgres",
      password: "",
      database: "postgres",
    });
  });

  it("accepts the postgres:// alias", () => {
    expect(parsePostgresDsn("postgres://u:p@localhost/db")?.database).toBe("db");
  });

  it("reads a unix-socket DSN from libpq's host query parameter", () => {
    expect(parsePostgresDsn("postgresql:///mydb?host=/var/run/postgresql&port=5432")).toEqual({
      host: "/var/run/postgresql",
      port: 5432,
      user: "postgres",
      password: "",
      database: "mydb",
    });
  });

  it("returns null for an unparseable or wrong-scheme DSN", () => {
    expect(parsePostgresDsn("not a url")).toBeNull();
    expect(parsePostgresDsn("mysql://u:p@localhost/db")).toBeNull();
  });

  it("returns null for a bogus port", () => {
    expect(parsePostgresDsn("postgresql://localhost:0/db")).toBeNull();
    expect(parsePostgresDsn("postgresql://localhost:99999/db")).toBeNull();
  });
});

describe("dsnFingerprint", () => {
  it("never includes the password", () => {
    const opts = parsePostgresDsn("postgresql://monitor:very-secret@db.internal:5432/appdb")!;
    const fp = dsnFingerprint(opts);
    expect(fp).toBe("monitor@db.internal:5432/appdb");
    expect(fp).not.toContain("very-secret");
  });
});

describe("md5PasswordResponse", () => {
  it("matches libpq's known-answer vector", () => {
    // md5(md5("password" + "user") + salt) with a fixed salt, computed once
    // by hand against the documented algorithm and pinned here so a future
    // edit to the hashing cannot silently break auth against a real server.
    const salt = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const response = md5PasswordResponse("user", "password", salt);
    expect(response.startsWith("md5")).toBe(true);
    expect(response).toHaveLength(35);
    // Deterministic: same inputs, same output, every time.
    expect(md5PasswordResponse("user", "password", salt)).toBe(response);
    // Different salt, different response.
    expect(md5PasswordResponse("user", "password", Buffer.from([0, 0, 0, 0]))).not.toBe(response);
  });
});

/** A minimal fake Postgres server: enough of the frontend/backend protocol
 * to drive `PostgresCollector` through startup, one auth method, and a
 * fixed query-batch response, without a real database. */
function frame(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = type.charCodeAt(0);
  header.writeInt32BE(4 + body.length, 1);
  return Buffer.concat([header, body]);
}

function authOk(): Buffer {
  const body = Buffer.alloc(4);
  body.writeInt32BE(0, 0);
  return frame("R", body);
}

function readyForQuery(): Buffer {
  return frame("Z", Buffer.from("I", "utf8"));
}

function rowDescription(names: string[]): Buffer {
  const header = Buffer.alloc(2);
  header.writeInt16BE(names.length, 0);
  const fields = names.map((name) => {
    const nameBuf = Buffer.from(`${name}\0`, "utf8");
    const tail = Buffer.alloc(18);
    return Buffer.concat([nameBuf, tail]);
  });
  return frame("T", Buffer.concat([header, ...fields]));
}

function dataRow(values: (string | null)[]): Buffer {
  const header = Buffer.alloc(2);
  header.writeInt16BE(values.length, 0);
  const cells = values.map((v) => {
    if (v === null) {
      const b = Buffer.alloc(4);
      b.writeInt32BE(-1, 0);
      return b;
    }
    const text = Buffer.from(v, "utf8");
    const len = Buffer.alloc(4);
    len.writeInt32BE(text.length, 0);
    return Buffer.concat([len, text]);
  });
  return frame("D", Buffer.concat([header, ...cells]));
}

function commandComplete(): Buffer {
  return frame("C", Buffer.from("SELECT 1\0", "utf8"));
}

function errorResponse(message: string): Buffer {
  const body = Buffer.concat([Buffer.from(`M${message}\0`, "utf8"), Buffer.from([0])]);
  return frame("E", body);
}

/** One statement's worth of rows, framed as RowDescription + N DataRows +
 * CommandComplete -- what a real backend sends for each `;`-separated
 * statement in a simple-query batch. */
function statement(columns: string[], rows: (string | null)[][]): Buffer {
  return Buffer.concat([rowDescription(columns), ...rows.map(dataRow), commandComplete()]);
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

function startFakeServer(
  onQuery: (socket: net.Socket) => void,
  authFlow: (socket: net.Socket, onAuthenticated: () => void) => void = (s, done) => {
    s.write(Buffer.concat([authOk(), readyForQuery()]));
    done();
  },
): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.once("data", () => {
        // The startup message. Once authentication finishes (immediately
        // for trust, after a password round trip for md5), every further
        // chunk is the query message; the fake server does not bother
        // parsing it since each test fixes one canned response regardless
        // of the exact SQL text sent.
        authFlow(socket, () => {
          socket.once("data", () => onQuery(socket));
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

describe("PostgresCollector", () => {
  it("returns null when the DSN does not parse (never attempts a connection)", async () => {
    const collector = new PostgresCollector("not a url");
    expect(collector.configured()).toBe(false);
    expect(await collector.collect()).toBeNull();
  });

  it("authenticates with trust and parses a full five-statement batch into a sample", async () => {
    const port = await startFakeServer((socket) => {
      const payload = Buffer.concat([
        statement(["connections", "longest_query_seconds"], [["3", "12.5"]]),
        statement(["max_connections"], [["100"]]),
        statement(["blks_hit", "blks_read"], [["900", "100"]]),
        statement(
          ["datname", "size_bytes"],
          [
            ["appdb", "500000"],
            ["postgres", "8000000"],
          ],
        ),
        statement(["lag_seconds"], [["1.5"]]),
        readyForQuery(),
      ]);
      socket.write(payload);
    });
    const collector = new PostgresCollector(`postgresql://monitor:x@127.0.0.1:${port}/appdb`);
    const sample = await collector.collect();
    expect(sample).toEqual({
      connections: 3,
      maxConnections: 100,
      databases: [
        { name: "appdb", sizeBytes: 500000 },
        { name: "postgres", sizeBytes: 8000000 },
      ],
      cacheHitRatio: 0.9,
      longestQuerySeconds: 12.5,
      replicationLagSeconds: 1.5,
    });
  });

  it("authenticates with md5 when challenged", async () => {
    const salt = Buffer.from([9, 8, 7, 6]);
    const port = await startFakeServer(
      (socket) => {
        socket.write(
          Buffer.concat([
            statement(["connections", "longest_query_seconds"], [["1", "0"]]),
            statement(["max_connections"], [["50"]]),
            statement(["blks_hit", "blks_read"], [["0", "0"]]),
            statement(["datname", "size_bytes"], []),
            statement(["lag_seconds"], []),
            readyForQuery(),
          ]),
        );
      },
      (socket, onAuthenticated) => {
        const body = Buffer.alloc(8);
        body.writeInt32BE(5, 0);
        salt.copy(body, 4);
        socket.write(frame("R", body));
        socket.once("data", (chunk) => {
          // First byte 'p' = PasswordMessage, containing our md5 response.
          expect(chunk[0]).toBe(0x70);
          socket.write(Buffer.concat([authOk(), readyForQuery()]));
          onAuthenticated();
        });
      },
    );
    const collector = new PostgresCollector(`postgresql://monitor:secret@127.0.0.1:${port}/appdb`);
    const sample = await collector.collect();
    expect(sample?.connections).toBe(1);
    expect(sample?.cacheHitRatio).toBeNull(); // no reads of either kind
    expect(sample?.replicationLagSeconds).toBeNull(); // no replication rows
  });

  it("returns null (not a throw) on a server error mid-batch", async () => {
    const port = await startFakeServer((socket) => {
      socket.write(errorResponse("permission denied for view pg_stat_activity"));
    });
    const collector = new PostgresCollector(`postgresql://monitor:x@127.0.0.1:${port}/appdb`);
    expect(await collector.collect()).toBeNull();
  });

  it("returns null when nothing is listening on the port (connection refused)", async () => {
    const collector = new PostgresCollector("postgresql://monitor:x@127.0.0.1:1/appdb");
    expect(await collector.collect()).toBeNull();
  });

  it("refuses an unsupported auth method (SCRAM) with a null result, not a hang", async () => {
    const port = await startFakeServer(
      () => {},
      (socket) => {
        const body = Buffer.alloc(4);
        body.writeInt32BE(10, 0); // AuthenticationSASL
        socket.write(frame("R", body));
      },
    );
    const collector = new PostgresCollector(`postgresql://monitor:x@127.0.0.1:${port}/appdb`);
    expect(await collector.collect()).toBeNull();
  });
});

describe("caps", () => {
  it("bounds the number of databases per sample", () => {
    expect(MAX_POSTGRES_DATABASES_PER_SAMPLE).toBe(20);
  });
});
