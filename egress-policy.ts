import { isIPv4, isIPv6 } from "node:net";

/**
 * Where this location will and will not dial.
 *
 * `docs/private-probe-locations.md` section 3.3, "the agent decides where it
 * will dial, not the server", is the whole specification and this file is the
 * whole implementation of it.
 *
 * ## The inversion, stated once
 *
 * The cloud fleet's guard (`packages/db/target-guard.ts`) exists to stop a
 * customer pointing OUR machines at a private address. This one exists to stop
 * anyone, including a totally compromised RealUptime, pointing the customer's
 * machine at anything the customer did not intend. Same address arithmetic,
 * opposite verdict: the fleet refuses private space, a private location
 * refuses PUBLIC space, because monitoring a public target is what the fleet
 * is for and it does it from ten places instead of one.
 *
 * The security value of that is immediate and large: a fleet of agents that
 * cannot reach the public internet is worthless as a DDoS relay, a
 * credential-spraying proxy or a scanner against third parties, no matter who
 * controls our database.
 *
 * ## Why the policy is re-implemented here rather than imported
 *
 * Same reason as `types.ts` and `log.ts`: this program runs on a customer's
 * machine and its dependency list is a security artifact. Importing
 * `@realuptime/db` for `validateHost` would drag postgres.js and the migration
 * runner into a binary a reviewer is reading line by line. The cost is that
 * the two copies can drift; `egress-policy.test.ts` pins the address classes
 * both files must agree on.
 *
 * ## Custody, which is the point
 *
 * Every input to this module comes from THIS MACHINE: environment variables
 * the person who installed the agent set. Nothing here is server-pushed and
 * nothing here can be. A total compromise of RealUptime cannot widen the
 * allowlist, because widening it means editing a file on the customer's server
 * and restarting a process. That sentence is the feature.
 */

/**
 * What kind of address this is, in the only vocabulary the policy branches on.
 *
 * Ordered from most dangerous to least: `classifyAddress` returns the FIRST
 * class that matches, which is why `metadata` is tested before `link_local`
 * even though every IPv4 metadata endpoint lives inside 169.254.0.0/16.
 */
export type AddressClass =
  | "metadata"
  | "loopback"
  | "link_local"
  | "multicast"
  | "unspecified"
  | "private"
  | "public"
  | "unknown";

/**
 * Cloud instance metadata endpoints: a private address whose read is a
 * credential theft.
 *
 * These are the reason 3.3b exists. An agent inside a VPC that can be told to
 * GET `http://169.254.169.254/latest/meta-data/iam/security-credentials/` is a
 * one-request path from "somebody compromised RealUptime" to "somebody has the
 * customer's cloud role", and an assertion over the response body turns the
 * status code into an oracle over its contents.
 *
 * Refused unconditionally: no mode, no allowlist and no opt-in lifts this.
 * There is no legitimate uptime check against an IMDS endpoint, so the rule
 * costs a real customer nothing.
 *
 * The list names the addresses that are NOT already covered by a broader
 * always-denied class as well as the ones that are, because a reader auditing
 * this file should be able to see the whole set in one place rather than
 * derive it from four range tests.
 */
export const METADATA_ADDRESSES: readonly string[] = [
  "169.254.169.254", // AWS IMDSv1/v2, GCP, Azure, DigitalOcean, Oracle, OpenStack
  "169.254.169.253", // AWS VPC DNS
  "169.254.169.123", // AWS VPC NTP
  "169.254.170.2", // AWS ECS task metadata
  "168.63.129.16", // Azure wireserver (globally routable on paper, never a monitor target)
  "100.100.100.200", // Alibaba Cloud metadata (inside CGNAT, so not otherwise denied)
  "192.0.0.192", // Oracle Cloud legacy metadata (inside 192.0.0.0/24)
  "fd00:ec2::254", // AWS IMDS over IPv6 (inside fc00::/7, so not otherwise denied)
];

const METADATA_SET = new Set(METADATA_ADDRESSES.map((address) => normalizeIp(address)));

/** IPv4 ranges that are private (RFC1918, CGNAT shared space, and the two
 * documentation/benchmark ranges a lab legitimately uses). A private location
 * may dial these; the fleet may not. */
const PRIVATE_IPV4_RANGES: [string, number][] = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10], // carrier-grade NAT / shared address space, and Tailscale's 100.64/10
  ["198.18.0.0", 15], // benchmarking
  ["192.0.2.0", 24], // TEST-NET-1
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
];

/**
 * Classify one address literal.
 *
 * Behind a mutable holder so `egress-policy.test.ts` can break it and watch
 * the refusal assertions flip, the same shape `check-http.ts`'s `httpRules`
 * uses. A guard no test has ever seen fail is decoration.
 */
export const egressRules = {
  classify: (address: string): AddressClass => {
    const ip = normalizeIp(address);
    if (!ip) return "unknown";
    if (METADATA_SET.has(ip)) return "metadata";
    if (isIPv4(ip)) return classifyIPv4(ip);
    if (isIPv6(ip)) return classifyIPv6(ip);
    return "unknown";
  },
};

/** Classify one address literal. Anything this function does not recognise as
 * a well-formed IPv4 or IPv6 literal is `unknown`, which the policy treats as
 * a refusal: failing closed on an address nobody can classify is the only
 * safe reading. */
export function classifyAddress(address: string): AddressClass {
  return egressRules.classify(address);
}

function classifyIPv4(ip: string): AddressClass {
  if (ip === "0.0.0.0") return "unspecified";
  if (ip === "255.255.255.255") return "multicast"; // limited broadcast, denied with the same reasoning
  if (inRange4(ip, "127.0.0.0", 8)) return "loopback";
  if (inRange4(ip, "169.254.0.0", 16)) return "link_local";
  if (inRange4(ip, "224.0.0.0", 4)) return "multicast";
  if (inRange4(ip, "240.0.0.0", 4)) return "unspecified"; // reserved, never routable
  if (inRange4(ip, "0.0.0.0", 8)) return "unspecified"; // "this network"
  if (PRIVATE_IPV4_RANGES.some(([net, bits]) => inRange4(ip, net, bits))) return "private";
  return "public";
}

function classifyIPv6(ip: string): AddressClass {
  const groups = expandIPv6(ip);
  if (groups.length !== 8) return "unknown";

  if (groups.every((g) => g === "0000")) return "unspecified";
  if (groups.slice(0, 7).every((g) => g === "0000") && groups[7] === "0001") return "loopback";

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) both carry an IPv4
  // address in the last 32 bits. Classify THAT, never the wrapper: without
  // this, `::ffff:169.254.169.254` reads as an ordinary IPv6 address and walks
  // straight past the metadata rule. The fleet's guard carries the same trap
  // and the same fix (board #166).
  const mapped = groups.slice(0, 5).every((g) => g === "0000") && groups[5] === "ffff";
  const compatible = groups.slice(0, 6).every((g) => g === "0000");
  if (mapped || compatible) {
    const embedded = last32BitsAsIPv4(groups);
    return METADATA_SET.has(embedded) ? "metadata" : classifyIPv4(embedded);
  }
  // 64:ff9b::/96, the NAT64 well-known prefix, does the same thing.
  if (groups[0] === "0064" && groups[1] === "ff9b" && groups.slice(2, 6).every((g) => g === "0000")) {
    const embedded = last32BitsAsIPv4(groups);
    return METADATA_SET.has(embedded) ? "metadata" : classifyIPv4(embedded);
  }

  const first = Number.parseInt(groups[0], 16);
  if (first >= 0xfc00 && first <= 0xfdff) return "private"; // fc00::/7, unique local
  if (first >= 0xfe80 && first <= 0xfebf) return "link_local"; // fe80::/10
  if (first >= 0xff00) return "multicast"; // ff00::/8
  if (groups[0] === "2001" && groups[1] === "0db8") return "private"; // 2001:db8::/32, documentation
  return "public";
}

/** One entry of `REALUPTIME_ALLOW_TARGETS`: a CIDR, a bare address, or a
 * hostname suffix. */
export type TargetMatcher =
  | { kind: "cidr"; bits: string; prefix: number; source: string }
  | { kind: "host"; suffix: string; source: string };

/** One entry of `REALUPTIME_ALLOW_PORTS`. A single port is a range of one. */
export interface PortRange {
  from: number;
  to: number;
}

/** `report` probes as normal and says what it would have refused; `enforce`
 * refuses. See `loadEgressPolicy` for which one you get and why. */
export type EgressMode = "report" | "enforce";

export interface EgressPolicy {
  mode: EgressMode;
  /** 3.3b: loopback is a legitimate and common private target
   * (`localhost:5432`), so it is opt-in rather than banned. Off by default,
   * because the default container sharing a host network with the customer's
   * own services should not become a probe of them by accident. */
  allowLoopback: boolean;
  /** 3.3c. Empty means "not configured", which is not the same as "allow
   * nothing": an unconfigured allowlist imposes no host restriction at all. */
  allowTargets: TargetMatcher[];
  /** 3.3c, the port half. Empty means every port. */
  allowPorts: PortRange[];
}

/** Which rule refused. Reported in the log line, never in the customer-facing
 * error text, which stays one sentence. */
/** Every rule a verdict can name. A runtime list, not only a type, because
 * the server stores counts per rule and wire-contract.test.ts pins its list
 * to this one (REA-1013). */
export const EGRESS_RULES = [
  "metadata",
  "link_local",
  "multicast",
  "unspecified",
  "unknown_address",
  "loopback",
  "public",
  "allowlist_host",
  "allowlist_port",
] as const;

export type EgressRule = (typeof EGRESS_RULES)[number];

export type EgressVerdict =
  | { allow: true }
  /** `enforced: false` is report-only mode: the probe runs, and this verdict is
   * counted and logged so the operator sees what enforcement would cost them
   * BEFORE it costs them anything. */
  | { allow: false; enforced: boolean; rule: EgressRule; detail: string };

/**
 * The customer-facing half of a refusal, per 3.3: a refusal is a FAILED RESULT
 * with this text, never a silent drop. The customer sees the monitor is down
 * and why, in their own dashboard, which is how they find out someone tried.
 *
 * Pinned by test: this exact phrase is the contract, and a reworded copy in a
 * second file is how a customer ends up reading two different explanations for
 * one event.
 */
export const EGRESS_BLOCKED_MESSAGE = "Blocked by this location's local policy";

/** The rules that no mode and no allowlist can lift. Everything here has no
 * legitimate uptime-monitoring use, so enforcing it from day one costs a real
 * customer nothing, which is exactly why it is not staged behind
 * report-only mode the way the address-class default is. */
const ALWAYS_ENFORCED: ReadonlySet<EgressRule> = new Set<EgressRule>([
  "metadata",
  "link_local",
  "multicast",
  "unspecified",
  "unknown_address",
]);

export interface EgressTarget {
  /** The hostname or IP literal as the check names it, for the suffix half of
   * the allowlist. */
  host: string;
  /** Absent for a check with no port concept (an http check names its port in
   * the URL, and `evaluateEgress`'s caller resolves it). */
  port?: number | null;
  /** Every address `host` resolved to on THIS lookup. All of them are judged,
   * not just the first: a name with one private answer and one public one is a
   * public target with camouflage. */
  addresses: readonly string[];
}

/**
 * The decision, for one target, right now.
 *
 * Called immediately before each dial and again on every redirect hop, never
 * once at check-creation time. A hostname that resolves to `10.0.0.5` today
 * and to a public address after an attacker moves a DNS record has to be
 * refused at the moment of the second dial, and a verdict cached from an hour
 * ago cannot do that.
 */
export function evaluateEgress(target: EgressTarget, policy: EgressPolicy): EgressVerdict {
  if (target.addresses.length === 0) {
    return refuse(policy, "unknown_address", "the target resolved to no address");
  }

  for (const address of target.addresses) {
    const klass = classifyAddress(address);
    if (klass === "metadata") {
      return refuse(policy, "metadata", `${address} is a cloud instance metadata endpoint`);
    }
    if (klass === "link_local") return refuse(policy, "link_local", `${address} is link-local`);
    if (klass === "multicast") return refuse(policy, "multicast", `${address} is multicast or broadcast`);
    if (klass === "unspecified") {
      return refuse(policy, "unspecified", `${address} is an unspecified or reserved address`);
    }
    if (klass === "unknown") return refuse(policy, "unknown_address", `${address} is not a usable address`);
    if (klass === "loopback" && !policy.allowLoopback) {
      return refuse(
        policy,
        "loopback",
        `${address} is loopback and REALUPTIME_ALLOW_LOOPBACK is not set`,
      );
    }
    if (klass === "public") {
      return refuse(policy, "public", `${address} is a public address`);
    }
  }

  if (policy.allowPorts.length > 0 && target.port != null) {
    const allowed = policy.allowPorts.some((range) => target.port! >= range.from && target.port! <= range.to);
    if (!allowed) {
      return refuse(policy, "allowlist_port", `port ${target.port} is outside REALUPTIME_ALLOW_PORTS`);
    }
  }

  if (policy.allowTargets.length > 0 && !matchesAllowlist(target, policy.allowTargets)) {
    return refuse(policy, "allowlist_host", `${target.host} is outside REALUPTIME_ALLOW_TARGETS`);
  }

  return { allow: true };
}

function refuse(policy: EgressPolicy, rule: EgressRule, detail: string): EgressVerdict {
  return { allow: false, enforced: policy.mode === "enforce" || ALWAYS_ENFORCED.has(rule), rule, detail };
}

/**
 * A target matches the allowlist when its NAME matches a host entry, or when
 * EVERY address it resolved to falls inside a CIDR entry.
 *
 * "Every", not "any", deliberately. A name that answers with one allowlisted
 * address and one that is not is a name whose owner can pick which one a given
 * dial gets, and half a match is no match.
 */
function matchesAllowlist(target: EgressTarget, matchers: readonly TargetMatcher[]): boolean {
  const host = target.host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  for (const matcher of matchers) {
    if (matcher.kind !== "host") continue;
    if (host === matcher.suffix) return true;
    if (host.endsWith(`.${matcher.suffix}`)) return true;
  }

  const cidrs = matchers.filter((matcher): matcher is Extract<TargetMatcher, { kind: "cidr" }> => matcher.kind === "cidr");
  if (cidrs.length === 0) return false;
  return target.addresses.every((address) => {
    const bits = addressToBits(address);
    if (!bits) return false;
    return cidrs.some(
      (cidr) => cidr.bits.length === bits.length && bits.slice(0, cidr.prefix) === cidr.bits.slice(0, cidr.prefix),
    );
  });
}

// ---------------------------------------------------------------------------
// Parsing the three environment variables
// ---------------------------------------------------------------------------

/**
 * Read the policy from this machine's environment. Never from a poll response,
 * and there is no code path by which it could be: nothing in this file takes
 * server-supplied input.
 *
 * ## Why `report` is the default, for exactly one release
 *
 * `docs/private-probe-locations.md` section 8 names the one real risk in the
 * whole phase: rule 3.3a refuses a target some customer legitimately points an
 * agent at on the public internet (a SaaS vendor reachable only from their
 * allowlisted egress IP is the realistic case, and it is a good use of an
 * agent). Enforcing on the release that introduces the rule breaks that
 * customer's monitoring with no warning and no data behind the decision.
 *
 * So this release ships the rule in report-only mode: the agent probes exactly
 * as it did before, logs every target it WOULD have refused, and the counts go
 * on the health line. Enforcement becomes the default one release later, with
 * real numbers behind it. This is the measure-before-you-gate posture
 * `docs/probe-quarantine.md` phase 1 and the cadence-tier work both used.
 *
 * Two things override the default:
 *
 *  - `REALUPTIME_EGRESS_POLICY=enforce` (or `report`), which always wins.
 *  - Setting an allowlist. A customer who declares `REALUPTIME_ALLOW_TARGETS`
 *    or `REALUPTIME_ALLOW_PORTS` cannot plausibly have meant "and ignore it",
 *    so declaring one flips the default to `enforce`.
 *
 * The always-enforced classes (metadata, link-local, multicast, unspecified,
 * unparseable) ignore the mode entirely, in both directions.
 */
export function loadEgressPolicy(env: NodeJS.ProcessEnv = process.env): EgressPolicy {
  const allowTargets = parseTargetMatchers(env.REALUPTIME_ALLOW_TARGETS ?? "");
  const allowPorts = parsePortRanges(env.REALUPTIME_ALLOW_PORTS ?? "");
  const declared = (env.REALUPTIME_EGRESS_POLICY ?? "").trim().toLowerCase();

  let mode: EgressMode;
  if (declared === "enforce" || declared === "report") {
    mode = declared;
  } else {
    mode = allowTargets.length > 0 || allowPorts.length > 0 ? "enforce" : "report";
  }

  return {
    mode,
    allowLoopback: (env.REALUPTIME_ALLOW_LOOPBACK ?? "").trim().toLowerCase() === "true",
    allowTargets,
    allowPorts,
  };
}

/**
 * `10.0.0.0/8, fd00::/8, .corp.example.com` and so on.
 *
 * An entry that does not parse is DROPPED with no exception, and the caller
 * logs the count. Throwing would take the whole agent down over one typo in an
 * optional variable, which turns a hardening feature into an outage; silently
 * treating a typo as "match everything" would be worse still.
 */
export function parseTargetMatchers(raw: string): TargetMatcher[] {
  const matchers: TargetMatcher[] = [];
  for (const entry of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    const lowered = entry.toLowerCase();
    if (lowered.includes("/")) {
      const [network, prefixRaw] = lowered.split("/", 2);
      const prefix = Number.parseInt(prefixRaw, 10);
      const bits = addressToBits(network);
      if (!bits || !Number.isInteger(prefix) || prefix < 0 || prefix > bits.length) continue;
      matchers.push({ kind: "cidr", bits, prefix, source: entry });
      continue;
    }
    const bits = addressToBits(lowered);
    if (bits) {
      matchers.push({ kind: "cidr", bits, prefix: bits.length, source: entry });
      continue;
    }
    // A leading dot is the natural way to write "and its subdomains"; it means
    // the same thing here as the bare name, since the suffix rule already
    // matches subdomains.
    const suffix = lowered.replace(/^\.+/, "").replace(/\.+$/, "");
    if (!suffix) continue;
    matchers.push({ kind: "host", suffix, source: entry });
  }
  return matchers;
}

/** `5432, 8000-8999`. Same drop-on-typo rule as the host matchers. */
export function parsePortRanges(raw: string): PortRange[] {
  const ranges: PortRange[] = [];
  for (const entry of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    const [fromRaw, toRaw] = entry.includes("-") ? entry.split("-", 2) : [entry, entry];
    const from = Number.parseInt(fromRaw, 10);
    const to = Number.parseInt(toRaw, 10);
    if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
    if (from < 1 || to > 65_535 || from > to) continue;
    ranges.push({ from, to });
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Address arithmetic
// ---------------------------------------------------------------------------

function normalizeIp(raw: string): string {
  let value = raw.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  // A zone index (`fe80::1%eth0`) is a local scope hint, not part of the
  // address, and node hands it back on some platforms.
  const zone = value.indexOf("%");
  return zone === -1 ? value : value.slice(0, zone);
}

function inRange4(ip: string, network: string, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(network) & mask);
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((part) => Number(part));
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0) as number;
}

/**
 * Expand an IPv6 literal into 8 zero-padded hex groups, rewriting a trailing
 * dotted quad (`::ffff:127.0.0.1`) into the two groups it actually occupies.
 *
 * The dotted-quad rewrite is not cosmetic. A bare host string (a tcp check's
 * `tcpHost`) is never laundered through a URL parser, so the dotted form
 * arrives verbatim; without the rewrite the expansion produces seven groups,
 * the IPv4-mapped test fails to match, and `::ffff:169.254.169.254` classifies
 * as an ordinary public address. The fleet's guard hit exactly this (board
 * #166) and this copy inherits the fix rather than the bug.
 */
function expandIPv6(ip: string): string[] {
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, undefined];
  const headParts = expandTrailingDottedQuad(head ? head.split(":") : []);
  const tailParts = expandTrailingDottedQuad(tail !== undefined && tail !== "" ? tail.split(":") : []);
  const missing = 8 - headParts.length - tailParts.length;
  if (!ip.includes("::") && missing !== 0) return [];
  if (missing < 0) return [];
  const zeros: string[] = new Array(missing).fill("0");
  return [...headParts, ...zeros, ...tailParts].map((part) => part.padStart(4, "0"));
}

function expandTrailingDottedQuad(parts: string[]): string[] {
  if (parts.length === 0) return parts;
  const last = parts[parts.length - 1];
  if (!last.includes(".")) return parts;
  const octets = last.split(".").map((octet) => Number(octet));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return parts;
  }
  const high = (((octets[0] << 8) | octets[1]) >>> 0).toString(16);
  const low = (((octets[2] << 8) | octets[3]) >>> 0).toString(16);
  return [...parts.slice(0, -1), high, low];
}

function last32BitsAsIPv4(groups: string[]): string {
  const bytes = groups.slice(-2).join("").match(/.{1,2}/g) ?? [];
  return bytes.map((byte) => Number.parseInt(byte, 16)).join(".");
}

/** An address as a bit string, for prefix comparison against a CIDR. Null when
 * the value is not an address literal at all, which is how a hostname entry in
 * the allowlist is told apart from a CIDR one. */
function addressToBits(address: string): string | null {
  const ip = normalizeIp(address);
  if (isIPv4(ip)) {
    return ipv4ToInt(ip).toString(2).padStart(32, "0");
  }
  if (isIPv6(ip)) {
    const groups = expandIPv6(ip);
    if (groups.length !== 8) return null;
    return groups.map((group) => Number.parseInt(group, 16).toString(2).padStart(16, "0")).join("");
  }
  return null;
}
