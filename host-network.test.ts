import { describe, expect, it } from "vitest";
import {
  detectHostNetwork,
  isolatedNetworkHint,
  parseDefaultGateway,
  readHostNetworkEvidence,
  type HostNetworkEvidence,
  type NetworkInterfaceEvidence,
} from "./host-network.ts";
import type { HostPlatform, StatfsResult, CpuTimes } from "./platform.ts";

/**
 * REA-780. Three fixtures, because there are exactly three machines this has
 * to read correctly and one of them is the trap:
 *
 *   host networking     a container that shares the machine's network
 *   bridge              a container with a network of its own, the trap
 *   not containerised   an ordinary host, where the question does not arise
 *
 * Plus the mutation guards. This function's output turns into a sentence a
 * customer is told about their own infrastructure, so the tests that matter
 * most are the ones that prove it stays SILENT: a wrong "your network is
 * broken" sends somebody to change a flag that was already right.
 */

function iface(
  name: string,
  ifindex: number | null,
  iflink: number | null,
): NetworkInterfaceEvidence {
  return { name, ifindex, iflink };
}

/** A bridge-networked Docker container: loopback, and one veth end called
 * eth0 whose iflink points at its peer's index in the host's namespace. */
const BRIDGE: HostNetworkEvidence = {
  containerized: true,
  interfaces: [iface("lo", 1, 1), iface("eth0", 12, 13)],
  defaultGateway: "172.17.0.1",
};

/** The same container started with --network host: it now sees the host's
 * own devices, including the docker bridge itself. */
const HOST_NETWORKING: HostNetworkEvidence = {
  containerized: true,
  interfaces: [
    iface("lo", 1, 1),
    iface("eth0", 2, 2),
    iface("docker0", 3, 3),
    iface("veth9f21ab", 14, 12),
  ],
  defaultGateway: "192.168.1.1",
};

/** The agent installed directly on the machine, via install.sh's systemd
 * path or a package. */
const NOT_CONTAINERIZED: HostNetworkEvidence = {
  containerized: false,
  interfaces: [iface("lo", 1, 1), iface("eth0", 2, 2)],
  defaultGateway: "192.168.1.1",
};

describe("detectHostNetwork", () => {
  it("reads an ordinary host as host networking without looking at anything else", () => {
    expect(detectHostNetwork(NOT_CONTAINERIZED)).toEqual({
      mode: "host",
      evidence: "not-containerized",
      gateway: null,
    });
    // Even with no readable interfaces at all: not being in a container
    // settles the question on its own.
    expect(
      detectHostNetwork({ ...NOT_CONTAINERIZED, interfaces: null }).mode,
    ).toBe("host");
  });

  it("reads a host-networked container as host networking, on the visible runtime bridge", () => {
    const result = detectHostNetwork(HOST_NETWORKING);
    expect(result.mode).toBe("host");
    expect(result.evidence).toBe("runtime-bridge-visible");
    // Never offered as an address to point a check at: on a host-networked
    // agent it is the machine's own router and says nothing about this.
    expect(result.gateway).toBeNull();
  });

  it("reads a bridge-networked container as isolated, and carries the docker gateway", () => {
    expect(detectHostNetwork(BRIDGE)).toEqual({
      mode: "isolated",
      evidence: "all-interfaces-are-veth",
      gateway: "172.17.0.1",
    });
  });

  it("reads a --network none container as isolated", () => {
    expect(
      detectHostNetwork({
        containerized: true,
        interfaces: [iface("lo", 1, 1)],
        defaultGateway: null,
      }),
    ).toEqual({ mode: "isolated", evidence: "loopback-only", gateway: null });
  });

  it("says nothing when it cannot read the interfaces of a container", () => {
    expect(detectHostNetwork({ ...BRIDGE, interfaces: null })).toEqual({
      mode: null,
      evidence: "unknown",
      gateway: null,
    });
  });

  // The false positive that would make this feature harmful, and the reason
  // the veth rule is "every" and not "any": a VLAN sub-interface on a real
  // host points its iflink at its parent device, exactly like a veth end.
  it("does not call a host isolated because one interface is a VLAN or macvlan", () => {
    const vlanHost: HostNetworkEvidence = {
      containerized: true,
      interfaces: [iface("lo", 1, 1), iface("eth0", 2, 2), iface("eth0.100", 7, 2)],
      defaultGateway: "10.0.0.1",
    };
    expect(detectHostNetwork(vlanHost).mode).toBeNull();
  });

  it("says nothing rather than guessing when an interface's indexes are unreadable", () => {
    expect(
      detectHostNetwork({
        containerized: true,
        interfaces: [iface("lo", 1, 1), iface("eth0", null, null)],
        defaultGateway: "172.17.0.1",
      }).mode,
    ).toBeNull();
  });

  // MUTATION GUARDS. Each flips exactly one input of the fixture that
  // produces the diagnosis and asserts the answer changes. A detector that
  // still says "isolated" with any one of these flipped is decoration.
  describe("mutation guards", () => {
    it("stops saying isolated when the process is not in a container", () => {
      expect(detectHostNetwork({ ...BRIDGE, containerized: false }).mode).toBe("host");
    });

    it("stops saying isolated when eth0 is a real device rather than a veth end", () => {
      expect(
        detectHostNetwork({ ...BRIDGE, interfaces: [iface("lo", 1, 1), iface("eth0", 12, 12)] })
          .mode,
      ).toBeNull();
    });

    it("stops saying isolated the moment a runtime bridge is visible", () => {
      expect(
        detectHostNetwork({
          ...BRIDGE,
          interfaces: [...(BRIDGE.interfaces ?? []), iface("docker0", 3, 3)],
        }).mode,
      ).toBe("host");
    });

    it("recognises the per-network and CNI bridges too, not only docker0", () => {
      for (const name of ["br-1a2b3c4d5e6f", "cni0", "virbr0", "cbr0", "kube-bridge"]) {
        expect(
          detectHostNetwork({
            ...BRIDGE,
            interfaces: [iface("lo", 1, 1), iface(name, 3, 3), iface("eth0", 12, 13)],
          }).mode,
        ).toBe("host");
      }
    });
  });
});

describe("parseDefaultGateway", () => {
  const PROC_NET_ROUTE = [
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
    "eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0",
    "eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
  ].join("\n");

  it("decodes the little-endian gateway word of the default route", () => {
    expect(parseDefaultGateway(PROC_NET_ROUTE)).toBe("172.17.0.1");
  });

  it("returns null when there is no default route, rather than an address from another row", () => {
    const noDefault = PROC_NET_ROUTE.split("\n").filter((l) => !l.includes("00000000\t0100")).join("\n");
    expect(parseDefaultGateway(noDefault)).toBeNull();
  });

  it("returns null for an on-link default route and for junk", () => {
    expect(
      parseDefaultGateway("Iface\tDestination\tGateway\neth0\t00000000\t00000000\t0001"),
    ).toBeNull();
    expect(parseDefaultGateway("")).toBeNull();
    expect(parseDefaultGateway("header\nnot a route at all")).toBeNull();
  });
});

describe("readHostNetworkEvidence", () => {
  function platform(files: Record<string, string>, dirs: Record<string, string[]>): HostPlatform {
    return {
      os: "linux",
      existsSync: (p) => p in files,
      readFileSync: (p) => {
        if (!(p in files)) throw new Error(`ENOENT ${p}`);
        return files[p];
      },
      readdirSync: (p) => {
        if (!(p in dirs)) throw new Error(`ENOENT ${p}`);
        return dirs[p];
      },
      statfsSync: (): StatfsResult => ({ bsize: 4096, blocks: 1, bfree: 1 }),
      exec: () => Promise.reject(new Error("no commands in this test")),
      cpuTimes: (): CpuTimes[] => [],
      totalmem: () => 0,
      freemem: () => 0,
      loadavg: () => [],
      hostname: () => "test",
      release: () => "0",
      arch: () => "x64",
      now: () => new Date(0),
    };
  }

  it("reads the bridge-container shape off a fixture filesystem", () => {
    const evidence = readHostNetworkEvidence(
      platform(
        {
          "/.dockerenv": "",
          "/sys/class/net/lo/ifindex": "1\n",
          "/sys/class/net/lo/iflink": "1\n",
          "/sys/class/net/eth0/ifindex": "12\n",
          "/sys/class/net/eth0/iflink": "13\n",
          "/proc/net/route":
            "Iface\tDestination\tGateway\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000",
        },
        { "/sys/class/net": ["lo", "eth0"] },
      ),
    );
    expect(evidence.containerized).toBe(true);
    expect(evidence.defaultGateway).toBe("172.17.0.1");
    expect(detectHostNetwork(evidence).mode).toBe("isolated");
  });

  it("reports an unreadable /sys/class/net as cannot-tell, never as no interfaces", () => {
    const evidence = readHostNetworkEvidence(platform({ "/.dockerenv": "" }, {}));
    expect(evidence.interfaces).toBeNull();
    expect(detectHostNetwork(evidence).mode).toBeNull();
  });

  it("reads a plain host with no container evidence at all", () => {
    const evidence = readHostNetworkEvidence(
      platform(
        {
          "/sys/class/net/eth0/ifindex": "2\n",
          "/sys/class/net/eth0/iflink": "2\n",
        },
        { "/sys/class/net": ["eth0"] },
      ),
    );
    expect(evidence.containerized).toBe(false);
    expect(detectHostNetwork(evidence).mode).toBe("host");
  });
});

describe("isolatedNetworkHint", () => {
  it("names the flag and the gateway when one is known", () => {
    expect(isolatedNetworkHint("172.17.0.1")).toContain("--network host");
    expect(isolatedNetworkHint("172.17.0.1")).toContain("172.17.0.1");
  });

  it("still names the flag when no gateway could be read", () => {
    expect(isolatedNetworkHint(null)).toContain("--network host");
    expect(isolatedNetworkHint(null)).not.toContain("null");
  });
});
