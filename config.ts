import { readFileSync } from "node:fs";

/**
 * Configuration: a handful of environment variables, and nothing else.
 *
 * There is no config file, no config directory, no `--flag`, and no
 * server-pushed setting that changes how this process behaves locally (the
 * one exception, the service watch list, can only name units and is
 * documented in collect-services.ts). That is a security property, not
 * minimalism for its own sake. A customer's security reviewer can read this
 * one file and know the complete set of inputs the program accepts, and an
 * attacker who reaches the machine cannot repoint the agent by dropping a
 * file next to it.
 *
 * It also means the install instruction stays one line, which is the thing
 * every competitor's onboarding gets wrong.
 *
 * ## The variables
 *
 *   REALUPTIME_TOKEN        the `rua_...` token (required unless TOKEN_FILE)
 *   REALUPTIME_TOKEN_FILE   a path to read the token from, once, at start.
 *                           For Kubernetes, where a DaemonSet mounts one
 *                           Secret with one key per node and names the key
 *                           with the node name; and for Docker/Podman
 *                           secrets. The file is read exactly once and its
 *                           path is never derived from anything the server
 *                           sends. This is the ONLY file path this program
 *                           accepts from its environment.
 *   REALUPTIME_URL          origin override for self-hosted / staging
 *   REALUPTIME_CLUSTER      optional label: which cluster this host is in
 *   REALUPTIME_NODE         optional label: this host's node name (defaults
 *                           to the hostname). Both labels are purely for
 *                           grouping in the dashboard.
 */

export interface AgentConfig {
  /** The `rua_...` token the dashboard shows once, at agent registration. */
  token: string;
  /** Origin only, no trailing slash. */
  baseUrl: string;
  cluster: string | null;
  node: string | null;
}

export const DEFAULT_BASE_URL = "https://realuptime.io";
export const MAX_LABEL_LENGTH = 128;

export class ConfigError extends Error {}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): AgentConfig {
  let token = (env.REALUPTIME_TOKEN ?? "").trim();
  const tokenFile = (env.REALUPTIME_TOKEN_FILE ?? "").trim();
  if (!token && tokenFile) {
    try {
      token = readFile(tokenFile).trim();
    } catch (err) {
      throw new ConfigError(
        `REALUPTIME_TOKEN_FILE could not be read (${tokenFile}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!token) {
    throw new ConfigError(
      "REALUPTIME_TOKEN is not set. Copy the agent token from the RealUptime dashboard and pass it as REALUPTIME_TOKEN (or a file path as REALUPTIME_TOKEN_FILE).",
    );
  }

  const raw = (env.REALUPTIME_URL ?? "").trim() || DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`REALUPTIME_URL is not a valid URL: ${raw}`);
  }
  // http is accepted so a self-hosted or staging deployment can be pointed at
  // without a certificate, but the default and every documented install use
  // https. Anything else (file:, ftp:) is a misconfiguration that would
  // otherwise fail later, deep inside fetch, with a worse message.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConfigError(`REALUPTIME_URL must be http or https, got ${parsed.protocol}`);
  }

  return {
    token,
    baseUrl: parsed.origin,
    cluster: label(env.REALUPTIME_CLUSTER),
    node: label(env.REALUPTIME_NODE),
  };
}

/** A label is free text the customer typed; bounded and stripped of
 * control characters, otherwise as given. Empty is null. */
function label(raw: string | undefined): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const value = (raw ?? "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, MAX_LABEL_LENGTH);
  return value || null;
}

/** For log lines and error messages: proves the right token was loaded without
 *  putting a working credential in a log file the customer may ship offsite. */
export function tokenFingerprint(token: string): string {
  return token.length <= 10 ? "rua_..." : `${token.slice(0, 8)}...${token.slice(-4)}`;
}
