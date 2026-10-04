/**
 * The whole logging layer, deliberately small, and the one place secret
 * values are scrubbed from everything this process writes or sends.
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
    msg: redactSecrets(msg),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    // Redacted BEFORE truncation, so a cut can never leave the front half of
    // a secret behind with nothing left to match it against.
    record[key] = typeof value === "string" ? truncate(redactSecrets(value)) : value;
  }
  // And once more over the whole line, which catches a secret inside a nested
  // field (an object or an array) that the per-field pass above never sees.
  logSink.write(redactSecrets(JSON.stringify(record)));
}

/**
 * Secret redaction (`docs/private-probe-locations.md` section 3.6).
 *
 * Every value `secrets.ts` resolves for an authenticated check is registered
 * here the moment it is resolved, and from then on no log line this process
 * writes, and no error string it sends to RealUptime, can carry it. The
 * registry is process memory only: the values already live in this process's
 * environment or in a file the customer controls, so holding them here adds
 * no copy anywhere new.
 *
 * Matching is by PREFIX of the value, not only the whole value: any run of
 * text that equals the first `REDACT_PREFIX_CHARS` characters of a secret is
 * replaced, extended for as long as the text keeps agreeing with the secret.
 * A message cut off mid-secret (by a library, by a length cap) therefore loses
 * the partial secret too, rather than leaking its first half.
 *
 * A value shorter than `MIN_REDACTED_SECRET_CHARS` is not redacted: three
 * characters cannot be told apart from ordinary words, and replacing them
 * everywhere would make every line unreadable. Nothing that short is a
 * credential worth the name.
 */
export const REDACTED = "[redacted]";
export const MIN_REDACTED_SECRET_CHARS = 4;
export const REDACT_PREFIX_CHARS = 8;
/** Bounded so a secrets file rotated every few seconds for a year cannot grow
 * this without limit. The oldest entries go first. */
export const MAX_REGISTERED_SECRETS = 1024;

const registeredSecrets = new Set<string>();

export function registerSecretValues(values: Iterable<string>): void {
  for (const value of values) {
    if (value.length < MIN_REDACTED_SECRET_CHARS || registeredSecrets.has(value)) continue;
    registeredSecrets.add(value);
    if (registeredSecrets.size > MAX_REGISTERED_SECRETS) {
      const oldest = registeredSecrets.values().next().value;
      if (oldest !== undefined) registeredSecrets.delete(oldest);
    }
  }
}

/** Tests only. */
export function __clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

/** `text` with every registered secret, and every `extra` one, replaced. */
export function redactSecrets(text: string, extra: Iterable<string> = []): string {
  let out = text;
  for (const value of extra) out = redactOne(out, value);
  for (const value of registeredSecrets) out = redactOne(out, value);
  return out;
}

function redactOne(text: string, value: string): string {
  if (value.length < MIN_REDACTED_SECRET_CHARS) return text;
  // A short secret is matched whole; a long one by its prefix, extended as far
  // as the text keeps agreeing with it.
  const probe = value.slice(0, Math.min(REDACT_PREFIX_CHARS, value.length));
  let from = 0;
  let out = "";
  for (;;) {
    const at = text.indexOf(probe, from);
    if (at === -1) break;
    let end = at + probe.length;
    while (end < text.length && end - at < value.length && text[end] === value[end - at]) end++;
    out += text.slice(from, at) + REDACTED;
    from = end;
  }
  return from === 0 ? text : out + text.slice(from);
}

export function truncate(value: string): string {
  return value.length <= MAX_FIELD_CHARS ? value : value.slice(0, MAX_FIELD_CHARS) + "...";
}
