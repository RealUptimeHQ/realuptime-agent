// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${SECRET:NAME} is the literal wire format of a secret reference, never a template placeholder
import { readFileSync, statSync } from "node:fs";
import { log, registerSecretValues } from "./log.ts";
import type { AgentCheckAuth } from "./types.ts";

/**
 * Secrets for authenticated internal checks, resolved on this machine
 * (`docs/private-probe-locations.md` section 3.6).
 *
 * An internal admin panel or a private API usually needs a credential. The
 * credential never crosses RealUptime's wire: the check the server sends
 * carries a NAME, `Authorization: Bearer ${SECRET:BILLING_API_TOKEN}`, and
 * this module substitutes the value at dial time from this process's own
 * environment (`REALUPTIME_SECRET_BILLING_API_TOKEN`) or from a secrets file
 * the customer controls (`REALUPTIME_SECRETS_FILE`). A stolen poll response,
 * a leaked database dump and a compromised RealUptime server all reveal the
 * same thing: that a check sends a bearer token named BILLING_API_TOKEN.
 *
 * ## The four rules, all enforced here
 *
 * 1. **Closed positions.** A reference is substituted in a request header
 *    VALUE or in the check's URL credentials, and nowhere else. Never the
 *    host, the path, the port or the query: a secret that can be interpolated
 *    into a hostname is an exfiltration channel
 *    (`https://${SECRET:X}.attacker.example`). A reference anywhere in the
 *    URL itself refuses the check.
 * 2. **Header names are this machine's allowlist.** Authorization,
 *    Proxy-Authorization, Cookie and X-Api-Key, plus whatever the customer
 *    names in `REALUPTIME_AUTH_HEADERS`. Never a name the server chose:
 *    arbitrary server-chosen header names are how a probe becomes a generic
 *    HTTP client.
 * 3. **An unresolvable name fails the check.** The result reads
 *    `This location has no secret named NAME`. The request is never sent
 *    with the placeholder text in it, and the header is never silently left
 *    off, because either would produce a reading about a request the
 *    customer did not configure.
 * 4. **Values never leave in anything but the request.** Every resolved value
 *    is registered with `log.ts`'s redactor before the request is built, so
 *    no log line and no error string returned to RealUptime can carry it.
 */

export const SECRET_ENV_PREFIX = "REALUPTIME_SECRET_";

/** A secret NAME: upper case, digits and underscores, starting with a letter,
 * which is exactly what fits after `REALUPTIME_SECRET_` in an environment
 * variable name on every platform. Byte-identical to the server's
 * `SECRET_NAME_PATTERN` (packages/db/check-auth-rules.ts), pinned by
 * wire-contract.test.ts. */
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The header names every agent may send a secret in. Pinned to the server's
 * `BASE_AUTH_HEADER_NAMES` by wire-contract.test.ts. */
export const BASE_AUTH_HEADER_NAMES = ["Authorization", "Proxy-Authorization", "Cookie", "X-Api-Key"] as const;

/** Headers the agent controls itself, which a customer-declared name may never
 * override: framing, routing and this program's own identity. Pinned to the
 * server's list by wire-contract.test.ts. */
export const FORBIDDEN_AUTH_HEADER_NAMES = [
  "connection",
  "content-length",
  "content-type",
  "expect",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
] as const;

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/**
 * The header names this location will send a secret in: the base four plus
 * each customer-declared name that is a valid header name and not one the
 * agent must control. Lowercased for comparison; the request uses the
 * spelling the check carries.
 */
export function allowedAuthHeaderNames(declared: readonly string[]): string[] {
  const allowed = new Set<string>(BASE_AUTH_HEADER_NAMES.map((name) => name.toLowerCase()));
  for (const name of declared) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name)) continue;
    if ((FORBIDDEN_AUTH_HEADER_NAMES as readonly string[]).includes(lower)) continue;
    allowed.add(lower);
  }
  return [...allowed];
}

/** The customer-declared names that survive `allowedAuthHeaderNames`, in the
 * spelling the customer typed, for the poll's self report. */
export function declaredAuthHeaderNames(declared: readonly string[]): string[] {
  const base = new Set(BASE_AUTH_HEADER_NAMES.map((name) => name.toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of declared) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name) || base.has(lower) || seen.has(lower)) continue;
    if ((FORBIDDEN_AUTH_HEADER_NAMES as readonly string[]).includes(lower)) continue;
    seen.add(lower);
    out.push(name);
  }
  return out;
}

/** Where secret values come from. `lookup` returns undefined for a name this
 * location does not have. */
export interface SecretSource {
  lookup(name: string): string | undefined;
}

export interface SecretSourceOptions {
  env?: NodeJS.ProcessEnv;
  /** REALUPTIME_SECRETS_FILE, or null. */
  secretsFile?: string | null;
  readFile?: (path: string) => string;
  /** A change stamp for the file (mtime and size), so it is re-read only when
   * it changed. Throws when the file cannot be read. */
  stamp?: (path: string) => string;
}

/**
 * The environment first, then the secrets file. The file is re-read whenever
 * its modification time or size changes, so a rotated credential takes effect
 * on the next probe without a restart; an environment variable, like every
 * other one this program reads, takes a restart to change.
 */
export function createSecretSource(options: SecretSourceOptions = {}): SecretSource {
  const env = options.env ?? process.env;
  const secretsFile = options.secretsFile ?? null;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const stamp =
    options.stamp ??
    ((path: string) => {
      const stats = statSync(path);
      return `${stats.mtimeMs}:${stats.size}`;
    });
  let cachedStamp: string | null = null;
  let cached = new Map<string, string>();
  let warnedUnreadable = false;

  function fileValues(): Map<string, string> {
    if (!secretsFile) return cached;
    try {
      const current = stamp(secretsFile);
      if (current !== cachedStamp) {
        cached = parseSecretsFile(readFile(secretsFile));
        cachedStamp = current;
        warnedUnreadable = false;
      }
    } catch (err) {
      cached = new Map();
      cachedStamp = null;
      // Once per outage of the file, not once per probe.
      if (!warnedUnreadable) {
        warnedUnreadable = true;
        log("warn", "REALUPTIME_SECRETS_FILE could not be read", {
          error: err instanceof Error ? err.message : String(err),
          hint: "checks that reference a secret from this file will fail until it can be read",
        });
      }
    }
    return cached;
  }

  return {
    lookup(name: string): string | undefined {
      if (!SECRET_NAME_PATTERN.test(name)) return undefined;
      const fromEnv = env[`${SECRET_ENV_PREFIX}${name}`];
      if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
      return fileValues().get(name);
    },
  };
}

/**
 * `NAME=value`, one per line. Blank lines and lines starting with `#` are
 * skipped, an `export ` prefix is tolerated, and a value wrapped in one pair
 * of matching quotes loses them. Everything after the first `=` is the value,
 * verbatim, so a value may itself contain `=`. A line whose name is not a
 * valid secret name is ignored: it cannot be referenced anyway.
 */
export function parseSecretsFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const name = body.slice(0, eq).trim();
    if (!SECRET_NAME_PATTERN.test(name)) continue;
    let value = body.slice(eq + 1);
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    values.set(name, value);
  }
  return values;
}

/** One piece of a template: literal text, or a reference by name. */
type TemplatePart = { literal: string } | { secret: string };

const REFERENCE = /\$\{SECRET:([A-Z][A-Z0-9_]{0,63})\}/g;

/**
 * Splits a template into literal text and references. Null when the template
 * holds anything that looks like a reference and is not a well-formed one
 * (`${SECRET:lower}`, `${OTHER:X}`, an unclosed `${`): sending that text
 * literally would be exactly the placeholder-in-the-request this module
 * exists to prevent.
 */
export function parseTemplate(template: string): TemplatePart[] | null {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const match of template.matchAll(REFERENCE)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ literal: template.slice(last, at) });
    parts.push({ secret: match[1]! });
    last = at + match[0].length;
  }
  if (last < template.length) parts.push({ literal: template.slice(last) });
  for (const part of parts) {
    if ("literal" in part && part.literal.includes("${")) return null;
  }
  return parts;
}

/** Whether a URL carries anything shaped like a secret reference, in any
 * case, with or without stray whitespace. */
function mentionsReference(text: string): boolean {
  return /\$\{\s*secret\s*:/i.test(text);
}

export type PreparedAuth =
  | { ok: true; headers: Record<string, string> | null; secretValues: string[] }
  | { ok: false; error: string };

const NO_AUTH: PreparedAuth = { ok: true, headers: null, secretValues: [] };

/**
 * Everything an http check needs before it dials: the resolved request
 * headers, and the resolved values to scrub from anything it reports. Or a
 * failure message that names what is wrong without naming a value.
 *
 * Called for EVERY http check, authenticated or not, because rule 1 applies
 * to the URL of any check: a server that put `${SECRET:X}` into a hostname is
 * refused whether or not the check also carries an auth block.
 */
export function prepareCheckAuth(
  url: string,
  auth: AgentCheckAuth | null | undefined,
  source: SecretSource,
  allowedHeaderNames: readonly string[] = allowedAuthHeaderNames([]),
): PreparedAuth {
  if (mentionsReference(url) || mentionsReference(safeDecode(url))) {
    return {
      ok: false,
      error:
        "Secret references are only allowed in request headers and URL credentials, never in the address itself",
    };
  }
  if (!auth || (auth.headers.length === 0 && auth.userinfo === null)) return NO_AUTH;

  const allowed = new Set(allowedHeaderNames.map((name) => name.toLowerCase()));
  const headers: Record<string, string> = {};
  const secretValues: string[] = [];

  for (const header of auth.headers) {
    const lower = header.name.toLowerCase();
    if (!allowed.has(lower)) {
      return {
        ok: false,
        error: `This location does not send the ${header.name} header. Add it to REALUPTIME_AUTH_HEADERS on this machine to allow it`,
      };
    }
    if (lower in headers) {
      return { ok: false, error: `The ${header.name} header is configured more than once` };
    }
    const resolved = resolveTemplate(header.value, source);
    if (!resolved.ok) return resolved;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: a header value cannot carry control characters
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(resolved.value)) {
      return {
        ok: false,
        error: `A secret in the ${header.name} header contains a line break or control character, which a header cannot carry`,
      };
    }
    headers[lower] = resolved.value;
    secretValues.push(...resolved.secretValues);
  }

  if (auth.userinfo !== null) {
    if ("authorization" in headers) {
      return {
        ok: false,
        error: "Set URL credentials or an Authorization header on this check, not both",
      };
    }
    const credentials = resolveUserinfo(auth.userinfo, source);
    if (!credentials.ok) return credentials;
    // HTTP Basic (RFC 7617). Node's fetch refuses a URL that carries
    // credentials outright, so URL credentials are sent the way a browser
    // sends them: as an Authorization header, built here from the resolved
    // pair and never written into the URL.
    const basic = Buffer.from(`${credentials.user}:${credentials.password}`, "utf8").toString("base64");
    headers.authorization = `Basic ${basic}`;
    secretValues.push(...credentials.secretValues, basic);
  }

  // Encoded forms too: a value that reaches a message percent-encoded, or
  // inside the Basic header's base64, is still that value.
  for (const value of [...secretValues]) {
    const encoded = encodeURIComponent(value);
    if (encoded !== value) secretValues.push(encoded);
  }
  registerSecretValues(secretValues);
  return { ok: true, headers, secretValues };
}

type Resolved = { ok: true; value: string; secretValues: string[] } | { ok: false; error: string };

function resolveTemplate(template: string, source: SecretSource): Resolved {
  const parts = parseTemplate(template);
  if (!parts) {
    return { ok: false, error: "A secret reference on this check is malformed. Write it as ${SECRET:NAME}" };
  }
  return resolveParts(parts, source);
}

function resolveParts(parts: TemplatePart[], source: SecretSource): Resolved {
  let value = "";
  const secretValues: string[] = [];
  for (const part of parts) {
    if ("literal" in part) {
      value += part.literal;
      continue;
    }
    const secret = source.lookup(part.secret);
    if (secret === undefined) {
      return { ok: false, error: `This location has no secret named ${part.secret}` };
    }
    value += secret;
    secretValues.push(secret);
  }
  return { ok: true, value, secretValues };
}

/** `user:password`, split at the first colon OUTSIDE a reference (every
 * reference contains one of its own). */
function resolveUserinfo(
  template: string,
  source: SecretSource,
): { ok: true; user: string; password: string; secretValues: string[] } | { ok: false; error: string } {
  const parts = parseTemplate(template);
  if (!parts) {
    return { ok: false, error: "A secret reference on this check is malformed. Write it as ${SECRET:NAME}" };
  }
  const user: TemplatePart[] = [];
  const password: TemplatePart[] = [];
  let inPassword = false;
  for (const part of parts) {
    if (inPassword || !("literal" in part)) {
      (inPassword ? password : user).push(part);
      continue;
    }
    const colon = part.literal.indexOf(":");
    if (colon === -1) {
      user.push(part);
      continue;
    }
    if (colon > 0) user.push({ literal: part.literal.slice(0, colon) });
    inPassword = true;
    if (colon < part.literal.length - 1) password.push({ literal: part.literal.slice(colon + 1) });
  }
  if (!inPassword) {
    return { ok: false, error: "URL credentials on this check need a user name and a password, as user:${SECRET:NAME}" };
  }
  const resolvedUser = resolveParts(user, source);
  if (!resolvedUser.ok) return resolvedUser;
  const resolvedPassword = resolveParts(password, source);
  if (!resolvedPassword.ok) return resolvedPassword;
  return {
    ok: true,
    user: resolvedUser.value,
    password: resolvedPassword.value,
    secretValues: [...resolvedUser.secretValues, ...resolvedPassword.secretValues],
  };
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
