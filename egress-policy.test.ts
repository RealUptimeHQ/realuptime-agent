import { describe, expect, it } from "vitest";
import {
  classifyAddress,
  EGRESS_BLOCKED_MESSAGE,
  egressRules,
  evaluateEgress,
  loadEgressPolicy,
  METADATA_ADDRESSES,
  parsePortRanges,
  parseTargetMatchers,
  type EgressPolicy,
} from "./egress-policy.ts";

/**
 * The address arithmetic and the policy that reads it.
 *
 * Two properties matter more than the rest and both have a mutation test at
 * the bottom of this file: an unconditional class stays unconditional under
 * every mode and every allowlist, and the classifier is what produces the
 * refusal rather than some incidental check further down.
 */

const ENFORCING: EgressPolicy = {
  mode: "enforce",
  allowLoopback: false,
  allowTargets: [],
  allowPorts: [],
};

const REPORTING: EgressPolicy = { ...ENFORCING, mode: "report" };

function target(host: string, addresses: string[], port: number | null = null) {
  return { host, addresses, port };
}

describe("classifyAddress", () => {
  it("classifies the private ranges a location exists to reach", () => {
    expect(classifyAddress("10.0.3.14")).toBe("private");
    expect(classifyAddress("172.16.0.1")).toBe("private");
    expect(classifyAddress("172.31.255.255")).toBe("private");
    expect(classifyAddress("192.168.1.20")).toBe("private");
    expect(classifyAddress("100.64.0.1")).toBe("private");
    expect(classifyAddress("fd00::1")).toBe("private");
  });

  it("172.32.0.0 is public: the RFC1918 block ends at 172.31", () => {
    expect(classifyAddress("172.32.0.1")).toBe("public");
    expect(classifyAddress("172.15.255.255")).toBe("public");
  });

  it("classifies public space as public", () => {
    expect(classifyAddress("1.1.1.1")).toBe("public");
    expect(classifyAddress("93.184.216.34")).toBe("public");
    expect(classifyAddress("2606:4700::1111")).toBe("public");
  });

  it("classifies loopback, link-local, multicast and the unspecified forms", () => {
    expect(classifyAddress("127.0.0.1")).toBe("loopback");
    expect(classifyAddress("::1")).toBe("loopback");
    expect(classifyAddress("169.254.1.1")).toBe("link_local");
    expect(classifyAddress("fe80::1")).toBe("link_local");
    expect(classifyAddress("224.0.0.1")).toBe("multicast");
    expect(classifyAddress("ff02::1")).toBe("multicast");
    expect(classifyAddress("255.255.255.255")).toBe("multicast");
    expect(classifyAddress("0.0.0.0")).toBe("unspecified");
    expect(classifyAddress("::")).toBe("unspecified");
    expect(classifyAddress("240.0.0.1")).toBe("unspecified");
  });

  it("names every documented cloud metadata endpoint", () => {
    for (const address of METADATA_ADDRESSES) {
      expect(classifyAddress(address)).toBe("metadata");
    }
  });

  it("metadata beats link-local: 169.254.169.254 is not merely link-local", () => {
    // The ordering matters for the error text an operator reads, and for the
    // fact that link-local is a range while this is a credential theft.
    expect(classifyAddress("169.254.169.254")).toBe("metadata");
  });

  it("sees through IPv4-mapped, IPv4-compatible and NAT64 wrappers", () => {
    // The trap board #166 hit in the fleet's own guard: a dotted quad in the
    // last group expands to seven groups instead of eight, no range matches,
    // and a metadata endpoint reads as an ordinary public address.
    expect(classifyAddress("::ffff:169.254.169.254")).toBe("metadata");
    expect(classifyAddress("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyAddress("::ffff:10.0.0.1")).toBe("private");
    expect(classifyAddress("::ffff:8.8.8.8")).toBe("public");
    expect(classifyAddress("64:ff9b::169.254.169.254")).toBe("metadata");
    expect(classifyAddress("64:ff9b::a00:1")).toBe("private");
  });

  it("normalizes brackets, case and a zone index", () => {
    expect(classifyAddress("[FD00::1]")).toBe("private");
    expect(classifyAddress("fe80::1%eth0")).toBe("link_local");
  });

  it("fails closed on anything that is not an address literal", () => {
    expect(classifyAddress("not-an-address")).toBe("unknown");
    expect(classifyAddress("")).toBe("unknown");
    expect(classifyAddress("10.0.0")).toBe("unknown");
  });
});

describe("evaluateEgress", () => {
  it("allows a private target", () => {
    expect(evaluateEgress(target("db.internal", ["10.0.0.5"]), ENFORCING)).toEqual({ allow: true });
  });

  it("refuses a public target under enforce", () => {
    const verdict = evaluateEgress(target("example.com", ["93.184.216.34"]), ENFORCING);
    expect(verdict).toMatchObject({ allow: false, enforced: true, rule: "public" });
  });

  it("under report, a public target is recorded but not enforced", () => {
    const verdict = evaluateEgress(target("example.com", ["93.184.216.34"]), REPORTING);
    expect(verdict).toMatchObject({ allow: false, enforced: false, rule: "public" });
  });

  it("refuses a name with one private answer and one public one", () => {
    // Half a match is no match: the owner of the name picks which answer a
    // given dial gets.
    const verdict = evaluateEgress(target("mixed.example", ["10.0.0.5", "93.184.216.34"]), ENFORCING);
    expect(verdict).toMatchObject({ allow: false, rule: "public" });
  });

  it("refuses a target that resolves to nothing", () => {
    expect(evaluateEgress(target("gone.internal", []), ENFORCING)).toMatchObject({
      allow: false,
      rule: "unknown_address",
    });
  });

  it("loopback is opt-in, not banned", () => {
    expect(evaluateEgress(target("localhost", ["127.0.0.1"], 5432), ENFORCING)).toMatchObject({
      allow: false,
      rule: "loopback",
    });
    expect(
      evaluateEgress(target("localhost", ["127.0.0.1"], 5432), { ...ENFORCING, allowLoopback: true }),
    ).toEqual({ allow: true });
  });

  it("an allowlist narrows by host suffix", () => {
    const policy: EgressPolicy = { ...ENFORCING, allowTargets: parseTargetMatchers(".corp.example.com") };
    expect(evaluateEgress(target("api.corp.example.com", ["10.0.0.5"]), policy)).toEqual({ allow: true });
    expect(evaluateEgress(target("corp.example.com", ["10.0.0.5"]), policy)).toEqual({ allow: true });
    expect(evaluateEgress(target("api.other.example.com", ["10.0.0.5"]), policy)).toMatchObject({
      allow: false,
      rule: "allowlist_host",
    });
  });

  it("an allowlist narrows by CIDR, and needs EVERY answer inside it", () => {
    const policy: EgressPolicy = { ...ENFORCING, allowTargets: parseTargetMatchers("10.1.0.0/16") };
    expect(evaluateEgress(target("a.internal", ["10.1.2.3"]), policy)).toEqual({ allow: true });
    expect(evaluateEgress(target("b.internal", ["10.2.2.3"]), policy)).toMatchObject({
      allow: false,
      rule: "allowlist_host",
    });
    expect(evaluateEgress(target("c.internal", ["10.1.2.3", "10.2.2.3"]), policy)).toMatchObject({
      allow: false,
      rule: "allowlist_host",
    });
  });

  it("an allowlist narrows by port range", () => {
    const policy: EgressPolicy = { ...ENFORCING, allowPorts: parsePortRanges("5432, 8000-8999") };
    expect(evaluateEgress(target("db.internal", ["10.0.0.5"], 5432), policy)).toEqual({ allow: true });
    expect(evaluateEgress(target("db.internal", ["10.0.0.5"], 8080), policy)).toEqual({ allow: true });
    expect(evaluateEgress(target("db.internal", ["10.0.0.5"], 22), policy)).toMatchObject({
      allow: false,
      rule: "allowlist_port",
    });
  });

  it("an unconfigured allowlist restricts nothing", () => {
    expect(evaluateEgress(target("anything.internal", ["10.0.0.5"], 9999), ENFORCING)).toEqual({
      allow: true,
    });
  });

  /**
   * The property the whole section-3.3b argument rests on. An allowlist is the
   * customer widening what they permit, and there is no wording of it that
   * reaches a metadata endpoint.
   */
  it("no allowlist and no mode can reach a cloud metadata endpoint", () => {
    const permissive: EgressPolicy = {
      mode: "report",
      allowLoopback: true,
      allowTargets: parseTargetMatchers("0.0.0.0/0, ::/0, .example.com, 169.254.169.254"),
      allowPorts: parsePortRanges("1-65535"),
    };
    for (const address of METADATA_ADDRESSES) {
      const verdict = evaluateEgress(target("metadata.example.com", [address], 80), permissive);
      expect(verdict).toMatchObject({ allow: false, enforced: true, rule: "metadata" });
    }
  });

  it("link-local, multicast and reserved are enforced even in report mode", () => {
    for (const [address, rule] of [
      ["169.254.10.1", "link_local"],
      ["224.0.0.251", "multicast"],
      ["0.0.0.0", "unspecified"],
    ] as const) {
      expect(evaluateEgress(target("h.internal", [address]), REPORTING)).toMatchObject({
        allow: false,
        enforced: true,
        rule,
      });
    }
  });

  it("a public address in report mode is the ONLY thing that is not enforced", () => {
    // Stated as its own assertion because the release that follows this one
    // flips the default, and this is the line that has to change with it.
    expect(evaluateEgress(target("h.example", ["8.8.8.8"]), REPORTING)).toMatchObject({ enforced: false });
    expect(evaluateEgress(target("h.example", ["127.0.0.1"]), REPORTING)).toMatchObject({ enforced: false });
  });
});

describe("parseTargetMatchers", () => {
  it("reads CIDRs, bare addresses and hostname suffixes", () => {
    const matchers = parseTargetMatchers("10.0.0.0/8, fd00::/8 , 192.168.1.5, .corp.example.com");
    expect(matchers.map((m) => m.kind)).toEqual(["cidr", "cidr", "cidr", "host"]);
  });

  it("drops a malformed entry rather than throwing or widening", () => {
    // A typo in an optional hardening variable must not stop a customer's
    // monitoring, and it must certainly not read as "allow everything".
    expect(parseTargetMatchers("10.0.0.0/99")).toEqual([]);
    expect(parseTargetMatchers("10.0.0.0/abc")).toEqual([]);
    expect(parseTargetMatchers(" , , ")).toEqual([]);
  });
});

describe("parsePortRanges", () => {
  it("reads single ports and ranges", () => {
    expect(parsePortRanges("5432, 8000-8999")).toEqual([
      { from: 5432, to: 5432 },
      { from: 8000, to: 8999 },
    ]);
  });

  it("drops out-of-range and inverted entries", () => {
    expect(parsePortRanges("0, 70000, 900-100, abc")).toEqual([]);
  });
});

describe("loadEgressPolicy", () => {
  it("defaults to report-only, which is the staged rollout in section 8", () => {
    expect(loadEgressPolicy({}).mode).toBe("report");
  });

  it("an explicit setting always wins", () => {
    expect(loadEgressPolicy({ REALUPTIME_EGRESS_POLICY: "enforce" }).mode).toBe("enforce");
    expect(
      loadEgressPolicy({ REALUPTIME_EGRESS_POLICY: "report", REALUPTIME_ALLOW_TARGETS: "10.0.0.0/8" }).mode,
    ).toBe("report");
  });

  it("declaring an allowlist flips the default to enforce", () => {
    expect(loadEgressPolicy({ REALUPTIME_ALLOW_TARGETS: "10.0.0.0/8" }).mode).toBe("enforce");
    expect(loadEgressPolicy({ REALUPTIME_ALLOW_PORTS: "5432" }).mode).toBe("enforce");
  });

  it("an unrecognized mode falls back to the default rather than erroring", () => {
    expect(loadEgressPolicy({ REALUPTIME_EGRESS_POLICY: "yes please" }).mode).toBe("report");
  });

  it("loopback is off unless it is exactly true", () => {
    expect(loadEgressPolicy({}).allowLoopback).toBe(false);
    expect(loadEgressPolicy({ REALUPTIME_ALLOW_LOOPBACK: "TRUE" }).allowLoopback).toBe(true);
    expect(loadEgressPolicy({ REALUPTIME_ALLOW_LOOPBACK: "1" }).allowLoopback).toBe(false);
  });
});

describe("the refusal message", () => {
  it("is the one phrase the design names, verbatim", () => {
    expect(EGRESS_BLOCKED_MESSAGE).toBe("Blocked by this location's local policy");
  });
});

describe("mutation tests", () => {
  /**
   * MUTATION TEST. Every refusal in this module comes from `classify`. If the
   * classifier stopped distinguishing anything, every assertion above would
   * still pass for the wrong reason, so break it and watch the refusals
   * disappear.
   */
  it("with the classifier broken, the refusals no longer hold", () => {
    const original = egressRules.classify;
    try {
      egressRules.classify = () => "private";
      expect(evaluateEgress(target("h", ["93.184.216.34"]), ENFORCING)).toEqual({ allow: true });
      expect(evaluateEgress(target("h", ["169.254.169.254"]), ENFORCING)).toEqual({ allow: true });
      expect(evaluateEgress(target("h", ["127.0.0.1"]), ENFORCING)).toEqual({ allow: true });
    } finally {
      egressRules.classify = original;
    }
  });

  it("the classifier is restored afterwards", () => {
    expect(classifyAddress("169.254.169.254")).toBe("metadata");
    expect(evaluateEgress(target("h", ["93.184.216.34"]), ENFORCING)).toMatchObject({ allow: false });
  });

  /**
   * MUTATION TEST. The allowlist is the bound with the most room to be
   * accidentally inverted, since "no entries" and "no matching entry" are one
   * character apart. Drop the entries and the refusal has to vanish; keep
   * them and an unrelated host has to be refused.
   */
  it("removing the allowlist entries removes the allowlist refusal", () => {
    const configured: EgressPolicy = { ...ENFORCING, allowTargets: parseTargetMatchers("10.1.0.0/16") };
    expect(evaluateEgress(target("h.internal", ["10.9.0.1"]), configured)).toMatchObject({
      allow: false,
      rule: "allowlist_host",
    });
    expect(evaluateEgress(target("h.internal", ["10.9.0.1"]), { ...configured, allowTargets: [] })).toEqual({
      allow: true,
    });
  });
});
