import { safePathSegment, type HostPlatform } from "./platform.ts";
import type { HostNetworkMode } from "./types.ts";
import { detectVantage } from "./vantage.ts";

/**
 * Whether this process shares the machine's network, or has a network of its
 * own (REA-780).
 *
 * ## The failure this exists to name
 *
 * The agent ships as a container. On Docker's default bridge network,
 * `127.0.0.1` inside the container is the CONTAINER, not the machine it runs
 * on. A customer who points a check at `localhost` or `127.0.0.1` therefore
 * gets "the connection was refused" forever while the service is perfectly
 * healthy. Measured on our own production account, one such check produced
 * 2,819 failures against 22 successes in a day, and every one of them was a
 * confident alarm about something that was fine. A monitoring product that
 * cries wolf about a healthy service is worse than one that says nothing.
 *
 * The agent is the only party that can see the difference, so it reports it,
 * once, with its host identity, and the dashboard turns "the connection was
 * refused" into "your agent cannot see your host's network, here is the one
 * flag that fixes it".
 *
 * ## What counts as evidence, and why the order matters
 *
 * Everything below is evidence a container runtime leaves in `/sys` and
 * `/proc`, never an inference from a hostname or an environment variable.
 * `null` is a first-class answer: an agent that cannot tell says nothing, and
 * the dashboard shows nothing, because a wrong diagnosis sends a customer to
 * fix something that is not broken.
 *
 *   1. Not in a container at all. Then it is the host's network by
 *      definition, and no file reading can change that.
 *   2. A container-runtime BRIDGE device is visible (`docker0`, `br-<id>`,
 *      `cni0`, `virbr0`, ...). Only the host's own network namespace has
 *      those: a bridge-networked container sees one veth end and nothing
 *      else. So this is `--network host`, or a Kubernetes pod with
 *      `hostNetwork: true`.
 *   3. EVERY non-loopback interface is one end of a veth pair
 *      (`ifindex != iflink`, the peer index living in another namespace).
 *      That is the bridge-networked container, and the trap.
 *
 *      "Every", not "any", on purpose. A host NIC can legitimately have
 *      `ifindex != iflink`: a VLAN device (`eth0.100`) and a macvlan both
 *      point their `iflink` at the parent device. A host that has one of
 *      those AND no runtime bridge would be misread as isolated by an "any"
 *      rule, and would be told to fix a network that works. A real
 *      bridge-networked container has exactly `lo` and `eth0`, and `eth0`
 *      is always a veth end, so the conjunctive rule still catches it.
 *   4. Loopback and nothing else: a `--network none` container. Isolated,
 *      and for the same practical reason.
 *
 * Anything else is `null`. There is no configuration override, for the same
 * reason `vantage.ts` has none: a truthfulness signal a customer can set by
 * hand is a signal nobody can act on.
 */

/** `"host"`: this process shares the machine's network, so `localhost` means
 * the machine. `"isolated"`: it has its own, so `localhost` means only this
 * container. Re-exported from the wire contract so the two cannot drift. */
export type { HostNetworkMode };

/** One entry under `/sys/class/net`. `ifindex` is this namespace's index for
 * the device; `iflink` is the index of the device it is bridged to, which for
 * an ordinary physical NIC is itself and for a veth end is its peer's index
 * in ANOTHER namespace. */
export interface NetworkInterfaceEvidence {
  name: string;
  ifindex: number | null;
  iflink: number | null;
}

export interface HostNetworkEvidence {
  /** Whether this process is inside a container at all, from the same four
   * files `vantage.ts` reads. Deliberately the RAW container question and
   * not `vantage()`: the Kubernetes host-mount collector reports vantage
   * "host" from inside a pod (it is measuring the node), and that says
   * nothing about whether the pod shares the node's network. */
  containerized: boolean;
  /** Every entry under `/sys/class/net`. Null when the directory could not be
   * read at all, which is an answer of "cannot tell", never "none". */
  interfaces: NetworkInterfaceEvidence[] | null;
  /** This namespace's default gateway, dotted quad, from `/proc/net/route`.
   * On a bridge-networked container this is the address the host answers on,
   * which is the one useful thing to tell a customer besides the flag. */
  defaultGateway: string | null;
}

export interface HostNetworkResult {
  /** Null means "could not tell", and nothing is reported or shown. */
  mode: HostNetworkMode | null;
  /** Which rule above decided it, for the agent's own log line. */
  evidence:
    | "not-containerized"
    | "runtime-bridge-visible"
    | "all-interfaces-are-veth"
    | "loopback-only"
    | "unknown";
  /** Only ever set alongside `mode: "isolated"`: on a host-networked agent
   * the default gateway is the machine's own router and means nothing here. */
  gateway: string | null;
}

/** Bridge devices only a container runtime creates, and only in the HOST's
 * network namespace: Docker's default bridge and its per-network bridges,
 * the common CNI plugins, libvirt, and Podman. Seeing one of these is
 * positive proof this process is in the host's namespace. */
const RUNTIME_BRIDGE =
  /^(docker[0-9]+|br-[0-9a-f]{6,}|cni[0-9]+|cni-podman[0-9]+|virbr[0-9]+|podman[0-9]*|flannel\.[0-9]+|kube-bridge|weave|cbr[0-9]+)$/;

function isLoopback(name: string): boolean {
  return name === "lo";
}

export function detectHostNetwork(evidence: HostNetworkEvidence): HostNetworkResult {
  if (!evidence.containerized) {
    return { mode: "host", evidence: "not-containerized", gateway: null };
  }
  const interfaces = evidence.interfaces;
  if (!interfaces) return { mode: null, evidence: "unknown", gateway: null };

  // Rule 2 before rule 3, always: a host that runs bridge containers has both
  // the bridge AND their host-side veth ends, and only this ordering reads
  // that machine correctly.
  if (interfaces.some((i) => RUNTIME_BRIDGE.test(i.name))) {
    return { mode: "host", evidence: "runtime-bridge-visible", gateway: null };
  }

  const external = interfaces.filter((i) => !isLoopback(i.name));
  if (external.length === 0) {
    return { mode: "isolated", evidence: "loopback-only", gateway: evidence.defaultGateway };
  }
  const allVeth = external.every(
    (i) => i.ifindex !== null && i.iflink !== null && i.ifindex !== i.iflink,
  );
  if (allVeth) {
    return {
      mode: "isolated",
      evidence: "all-interfaces-are-veth",
      gateway: evidence.defaultGateway,
    };
  }
  return { mode: null, evidence: "unknown", gateway: null };
}

/** `/proc/net/route`'s default route: the row whose destination is all
 * zeroes. The gateway column is a LITTLE-endian hex word, so `010011AC` is
 * 172.17.0.1 and not 1.0.17.172. A route table with no default row (or an
 * IPv6-only namespace, whose default lives in a different file this does not
 * read) yields null, which simply drops the address from the advice. */
export function parseDefaultGateway(routeText: string): string | null {
  for (const line of routeText.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    if (cols[1] !== "00000000") continue;
    const hex = cols[2];
    if (!/^[0-9A-Fa-f]{8}$/.test(hex)) continue;
    const word = Number.parseInt(hex, 16);
    if (word === 0) continue;
    return [word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff, (word >> 24) & 0xff].join(".");
  }
  return null;
}

function readIndex(text: string | null): number | null {
  if (text === null) return null;
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

/** Reads the evidence from this machine. Linux only in practice:
 * `/sys/class/net` and `/proc/net/route` do not exist on macOS or Windows,
 * and an agent that cannot read them reports nothing rather than guessing.
 * Every path is a fixed prefix plus a name that has passed `safePathSegment`,
 * the same rule every other reader in this program follows. */
export function readHostNetworkEvidence(platform: HostPlatform): HostNetworkEvidence {
  const read = (path: string): string | null => {
    try {
      return platform.readFileSync(path);
    } catch {
      return null;
    }
  };
  const exists = (path: string): boolean => {
    try {
      return platform.existsSync(path);
    } catch {
      return false;
    }
  };

  const { vantage } = detectVantage({
    dockerenvExists: exists("/.dockerenv"),
    containerenvExists: exists("/run/.containerenv"),
    cgroupText: read("/proc/1/cgroup"),
    environText: read("/proc/1/environ"),
  });
  const containerized = vantage === "container";

  let interfaces: NetworkInterfaceEvidence[] | null = null;
  try {
    interfaces = platform
      .readdirSync("/sys/class/net")
      .filter((name) => safePathSegment(name))
      .map((name) => ({
        name,
        ifindex: readIndex(read(`/sys/class/net/${name}/ifindex`)),
        iflink: readIndex(read(`/sys/class/net/${name}/iflink`)),
      }));
  } catch {
    interfaces = null;
  }

  const routeText = read("/proc/net/route");
  return {
    containerized,
    interfaces,
    defaultGateway: routeText ? parseDefaultGateway(routeText) : null,
  };
}

/** The one line the agent logs at startup when it is in the trap, so an
 * operator reading `docker logs realuptime-agent` finds the answer without
 * opening the dashboard. */
export function isolatedNetworkHint(gateway: string | null): string {
  return `add --network host to the container (or network_mode: host in Compose), or point host-local checks at ${gateway ?? "the host's address on the container network"}`;
}
