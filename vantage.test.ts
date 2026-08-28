import { describe, expect, it } from "vitest";
import { detectVantage, type VantageEvidence } from "./vantage.ts";

function noEvidence(): VantageEvidence {
  return { dockerenvExists: false, containerenvExists: false, cgroupText: null, environText: null };
}

describe("detectVantage", () => {
  it("reports host when no container evidence is present at all", () => {
    expect(detectVantage(noEvidence())).toEqual({ vantage: "host", detail: null });
  });

  it("reports host for a normal bare-metal /proc/1/cgroup (root cgroup, no runtime markers)", () => {
    const evidence = { ...noEvidence(), cgroupText: "0::/init.scope\n" };
    expect(detectVantage(evidence)).toEqual({ vantage: "host", detail: null });
  });

  it("detects Docker via /.dockerenv", () => {
    const evidence = { ...noEvidence(), dockerenvExists: true };
    expect(detectVantage(evidence)).toEqual({ vantage: "container", detail: "docker" });
  });

  it("detects Podman via /run/.containerenv", () => {
    const evidence = { ...noEvidence(), containerenvExists: true };
    expect(detectVantage(evidence)).toEqual({ vantage: "container", detail: "podman" });
  });

  it("detects Docker via the cgroup path when /.dockerenv is absent", () => {
    const evidence = {
      ...noEvidence(),
      cgroupText: "0::/docker/abcdef0123456789\n",
    };
    expect(detectVantage(evidence)).toEqual({ vantage: "container", detail: "docker" });
  });

  it("detects a Kubernetes pod via the kubepods cgroup path, labelled 'kubernetes'", () => {
    const evidence = {
      ...noEvidence(),
      cgroupText: "0::/kubepods/burstable/pod123/container456\n",
    };
    expect(detectVantage(evidence)).toEqual({ vantage: "container", detail: "kubernetes" });
  });

  it("detects containerd, LXC and ECS from cgroup evidence", () => {
    expect(
      detectVantage({ ...noEvidence(), cgroupText: "0::/system.slice/containerd.service\n" }),
    ).toMatchObject({ vantage: "container", detail: "containerd" });
    expect(detectVantage({ ...noEvidence(), cgroupText: "0::/lxc/mycontainer\n" })).toMatchObject({
      vantage: "container",
      detail: "lxc",
    });
    expect(detectVantage({ ...noEvidence(), cgroupText: "0::/ecs/task-id/container-id\n" })).toMatchObject({
      vantage: "container",
      detail: "ecs",
    });
  });

  it("detects systemd-nspawn via a container= entry in /proc/1/environ", () => {
    const evidence = { ...noEvidence(), environText: "PATH=/usr/bin\0container=systemd-nspawn\0HOME=/root\0" };
    expect(detectVantage(evidence)).toEqual({ vantage: "container", detail: "systemd-nspawn" });
  });

  it("does not treat an unrelated environ variable that merely contains 'container' as evidence", () => {
    const evidence = { ...noEvidence(), environText: "MY_CONTAINER_NAME=foo\0PATH=/usr/bin\0" };
    expect(detectVantage(evidence)).toEqual({ vantage: "host", detail: null });
  });

  it("prefers /.dockerenv over conflicting or absent cgroup evidence", () => {
    const evidence: VantageEvidence = {
      dockerenvExists: true,
      containerenvExists: false,
      cgroupText: "0::/init.scope\n",
      environText: null,
    };
    expect(detectVantage(evidence)).toEqual({ vantage: "container", detail: "docker" });
  });
});
