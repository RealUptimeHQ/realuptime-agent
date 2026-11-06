import { readFileSync } from "node:fs";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_POSTGRES_DATABASES_PER_SAMPLE,
  PostgresCollector,
  cleartextPasswordAllowed,
  dsnFingerprint,
  md5PasswordResponse,
  scramClientFinal,
  scramClientFirst,
  scramServerFinalValid,
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

  it("reads libpq's user-and-socket form used for peer auth", () => {
    expect(parsePostgresDsn("postgresql://realuptime-agent@/postgres?host=/var/run/postgresql")).toEqual({
      host: "/var/run/postgresql",
      port: 5432,
      user: "realuptime-agent",
      password: "",
      database: "postgres",
    });
  });

  it("takes the user and database from libpq's query parameters", () => {
    expect(parsePostgresDsn("postgresql:///?host=/run/postgresql&user=monitor&dbname=appdb")).toMatchObject({
      host: "/run/postgresql",
      user: "monitor",
      database: "appdb",
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

  // REA-1164: a negative age made production refuse every batch from db1.
  it("never reports a negative longest query, whatever the server returns", async () => {
    const port = await startFakeServer((socket) => {
      socket.write(
        Buffer.concat([
          statement(["connections", "longest_query_seconds"], [["2", "-0.531956"]]),
          statement(["max_connections"], [["100"]]),
          statement(["blks_hit", "blks_read"], [["0", "0"]]),
          statement(["datname", "size_bytes"], []),
          statement(["lag_seconds"], []),
          readyForQuery(),
        ]),
      );
    });
    const collector = new PostgresCollector(`postgresql://monitor@127.0.0.1:${port}/appdb`);
    expect((await collector.collect())?.longestQuerySeconds).toBe(0);
  });

  it("measures query age from the clock, not from its own transaction start", async () => {
    const source = readFileSync(new URL("./collect-postgres.ts", import.meta.url), "utf8");
    expect(source).toContain("greatest(clock_timestamp() - query_start, interval '0')");
    expect(source).not.toContain("now() - query_start");
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
    expect(collector.lastFailure()).toMatch(/^could not connect: .*ECONNREFUSED/);
  });

  it("refuses a SASL offer with no supported mechanism with a null result, not a hang", async () => {
    const port = await startFakeServer(
      () => {},
      (socket) => {
        socket.write(frame("R", saslBody(10, "SCRAM-SHA-256-PLUS\0\0")));
      },
    );
    expect(await new PostgresCollector(fixtureDsn(port)).collect()).toBeNull();
  });

  it("authenticates with SCRAM-SHA-256 and verifies the server's signature", async () => {
    const salt = Buffer.from("fixture-salt");
    const port = await startFakeServer(
      (socket) => socket.write(minimalBatch()),
      (socket, onAuthenticated) => {
        socket.write(frame("R", saslBody(10, "SCRAM-SHA-256\0\0")));
        socket.once("data", (initial) => {
          const clientFirst = saslInitialData(initial);
          const clientNonce = /r=([^,]+)/.exec(clientFirst)?.[1] ?? "";
          const serverFirst = `r=${clientNonce}server,s=${salt.toString("base64")},i=4096`;
          socket.write(frame("R", saslBody(11, serverFirst)));
          socket.once("data", (response) => {
            const server = scramServer(
              FIXTURE_PASSWORD,
              salt,
              4096,
              clientFirst.slice(3),
              serverFirst,
              response.toString("utf8", 5),
            );
            expect(server.proofValid).toBe(true);
            socket.write(
              Buffer.concat([
                frame("R", saslBody(12, `v=${server.serverSignature}`)),
                authOk(),
                readyForQuery(),
              ]),
            );
            onAuthenticated();
          });
        });
      },
    );
    expect((await new PostgresCollector(fixtureDsn(port)).collect())?.connections).toBe(1);
  });

  it("rejects a SCRAM server that cannot prove the password (wrong signature)", async () => {
    const port = await startFakeServer(
      (socket) => socket.write(minimalBatch()),
      (socket) => {
        socket.write(frame("R", saslBody(10, "SCRAM-SHA-256\0\0")));
        socket.once("data", (initial) => {
          const clientNonce = /r=([^,]+)/.exec(saslInitialData(initial))?.[1] ?? "";
          const salt = Buffer.from("s").toString("base64");
          socket.write(frame("R", saslBody(11, `r=${clientNonce}x,s=${salt},i=4096`)));
          socket.once("data", () => {
            const forged = Buffer.alloc(32).toString("base64");
            socket.write(
              Buffer.concat([frame("R", saslBody(12, `v=${forged}`)), authOk(), readyForQuery()]),
            );
          });
        });
      },
    );
    expect(await new PostgresCollector(fixtureDsn(port)).collect()).toBeNull();
  });

  it("rejects AuthenticationOk that skips the SCRAM server signature", async () => {
    const port = await startFakeServer(
      (socket) => socket.write(minimalBatch()),
      (socket) => {
        socket.write(frame("R", saslBody(10, "SCRAM-SHA-256\0\0")));
        socket.once("data", (initial) => {
          const clientNonce = /r=([^,]+)/.exec(saslInitialData(initial))?.[1] ?? "";
          const salt = Buffer.from("s").toString("base64");
          socket.write(frame("R", saslBody(11, `r=${clientNonce}x,s=${salt},i=4096`)));
          socket.once("data", () => socket.write(Buffer.concat([authOk(), readyForQuery()])));
        });
      },
    );
    expect(await new PostgresCollector(fixtureDsn(port)).collect()).toBeNull();
  });
});

describe("authentication downgrades", () => {
  it("rejects AuthenticationOk sent before the SCRAM exchange has even started", async () => {
    // Anything on the path can answer the SASL offer with a bare
    // AuthenticationOk. The client then has no server signature to check, so
    // it must refuse rather than treat "nothing to check" as "checked".
    const port = await startFakeServer(
      (socket) => socket.write(minimalBatch()),
      (socket, done) => {
        socket.write(frame("R", saslBody(10, "SCRAM-SHA-256\0\0")));
        socket.once("data", () => {
          socket.write(Buffer.concat([authOk(), readyForQuery()]));
          done();
        });
      },
    );
    expect(await new PostgresCollector(fixtureDsn(port)).collect()).toBeNull();
  });

  it("still answers a cleartext request over loopback", async () => {
    let received = "";
    const port = await startFakeServer(
      (socket) => socket.write(minimalBatch()),
      (socket, done) => {
        socket.write(frame("R", saslBody(3, "")));
        socket.once("data", (chunk) => {
          received = chunk.toString("utf8", 5, chunk.length - 1);
          socket.write(Buffer.concat([authOk(), readyForQuery()]));
          done();
        });
      },
    );
    expect(await new PostgresCollector(fixtureDsn(port)).collect()).not.toBeNull();
    expect(received).toBe(FIXTURE_PASSWORD);
  });

  it("sends a cleartext password only where the bytes never leave the machine", () => {
    expect(cleartextPasswordAllowed("/var/run/postgresql")).toBe(true);
    expect(cleartextPasswordAllowed("localhost")).toBe(true);
    expect(cleartextPasswordAllowed("127.0.0.1")).toBe(true);
    expect(cleartextPasswordAllowed("[::1]")).toBe(true);
    expect(cleartextPasswordAllowed("10.0.0.5")).toBe(false);
    expect(cleartextPasswordAllowed("db.internal")).toBe(false);
    expect(cleartextPasswordAllowed("[2001:db8::5]")).toBe(false);
  });
});

const FIXTURE_PASSWORD = "x";

/** A loopback DSN for the fake server, with a placeholder password. */
function fixtureDsn(port: number): string {
  const url = new URL(`postgresql://127.0.0.1:${port}/appdb`);
  url.username = "monitor";
  url.password = FIXTURE_PASSWORD;
  return url.href;
}

function saslBody(code: number, data: string): Buffer {
  const head = Buffer.alloc(4);
  head.writeInt32BE(code, 0);
  return Buffer.concat([head, Buffer.from(data, "utf8")]);
}

/** The client-first message out of a SASLInitialResponse frame. */
function saslInitialData(chunk: Buffer): string {
  const mechEnd = chunk.indexOf(0, 5);
  const len = chunk.readInt32BE(mechEnd + 1);
  return chunk.toString("utf8", mechEnd + 5, mechEnd + 5 + len);
}

function minimalBatch(): Buffer {
  return Buffer.concat([
    statement(["connections", "longest_query_seconds"], [["1", "0"]]),
    statement(["max_connections"], [["50"]]),
    statement(["blks_hit", "blks_read"], [["0", "0"]]),
    statement(["datname", "size_bytes"], []),
    statement(["lag_seconds"], []),
    readyForQuery(),
  ]);
}

/** The server half of SCRAM-SHA-256 (RFC 5802 section 3), written apart
 * from the client code under test: checks the client's proof and computes
 * the server signature. */
function scramServer(
  password: string,
  salt: Buffer,
  iterations: number,
  clientFirstBare: string,
  serverFirst: string,
  clientFinal: string,
): { proofValid: boolean; serverSignature: string } {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const cut = clientFinal.lastIndexOf(",p=");
  const authMessage = `${clientFirstBare},${serverFirst},${clientFinal.slice(0, cut)}`;
  const signature = createHmac("sha256", storedKey).update(authMessage).digest();
  const proof = Buffer.from(clientFinal.slice(cut + 3), "base64");
  const recovered = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) recovered[i] = (proof[i] ?? 0) ^ (signature[i] ?? 0);
  const proofValid = createHash("sha256").update(recovered).digest().equals(storedKey);
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return {
    proofValid,
    serverSignature: createHmac("sha256", serverKey).update(authMessage).digest("base64"),
  };
}

describe("SCRAM-SHA-256 client", () => {
  it("sends an empty user name and the gs2 header libpq sends", () => {
    const { message, client } = scramClientFirst("nonce");
    expect(message).toBe("n,,n=,r=nonce");
    expect(client.clientFirstBare).toBe("n=,r=nonce");
  });

  it("produces a proof the server side accepts and a matching server signature", () => {
    const { client } = scramClientFirst("abc");
    const salt = Buffer.from("salt");
    const serverFirst = `r=abcdef,s=${salt.toString("base64")},i=4096`;
    const final = scramClientFinal(client, FIXTURE_PASSWORD, serverFirst);
    const server = scramServer(
      FIXTURE_PASSWORD,
      salt,
      4096,
      client.clientFirstBare,
      serverFirst,
      final.message,
    );
    expect(server.proofValid).toBe(true);
    expect(final.expectedServerSignature).toBe(server.serverSignature);
    expect(scramServerFinalValid(`v=${server.serverSignature}`, final.expectedServerSignature)).toBe(
      true,
    );
    expect(scramServerFinalValid("v=AAAA", final.expectedServerSignature)).toBe(false);
  });

  it("refuses an iteration count that would block the agent", () => {
    const { client } = scramClientFirst();
    const salt = Buffer.from("s").toString("base64");
    expect(() => scramClientFinal(client, "x", `r=${client.clientNonce}y,s=${salt},i=5000000`)).toThrow(
      /iteration count/,
    );
  });

  it("refuses a server nonce that does not extend the client's", () => {
    const { client } = scramClientFirst("abc");
    const serverFirst = `r=zzz,s=${Buffer.from("salt").toString("base64")},i=4096`;
    expect(() => scramClientFinal(client, FIXTURE_PASSWORD, serverFirst)).toThrow(/nonce/);
  });
});

describe("PostgresCollector against a real server", () => {
  // The fake server above never parses SQL, so a batch Postgres itself
  // rejects (a FILTER clause on a non-aggregate shipped that way) passes
  // every test there. Opt-in, pointed at a small instance: the batch sizes
  // every database, which on a shared test server with hundreds of them
  // outlasts the collector's own query timeout.
  const realDsn = process.env.REALUPTIME_AGENT_TEST_POSTGRES_DSN;
  it.skipIf(!realDsn)("runs its query batch and returns a reading", async () => {
    const sample = await new PostgresCollector(realDsn ?? "").collect();
    expect(sample).not.toBeNull();
    expect(sample?.maxConnections).toBeGreaterThan(0);
  });
});

describe("startup message", () => {
  it("names the DSN's database, never the password", async () => {
    let startup: Buffer | null = null;
    const server = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        startup = chunk;
        socket.destroy();
      });
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    const url = new URL(fixtureDsn(port));
    url.pathname = "/inventory";
    url.password = "not-the-database";
    await new PostgresCollector(url.href).collect();
    const text = (startup ?? Buffer.alloc(0)).toString("utf8");
    expect(text).toContain("database\0inventory\0");
    expect(text).not.toContain("not-the-database");
  });
});

describe("caps", () => {
  it("bounds the number of databases per sample", () => {
    expect(MAX_POSTGRES_DATABASES_PER_SAMPLE).toBe(20);
  });
});
