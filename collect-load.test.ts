import { describe, expect, it } from "vitest";
import { parseLoadAvg } from "./collect-load.ts";

describe("parseLoadAvg", () => {
  it("parses the three raw, unnormalised averages", () => {
    const load = parseLoadAvg("1.23 0.98 0.55 2/456 78901\n");
    expect(load).toEqual({ load1: 1.23, load5: 0.98, load15: 0.55 });
  });

  it("reads all three or none: never fabricates one from a partial line", () => {
    expect(parseLoadAvg("1.23 0.98")).toBeNull();
    expect(parseLoadAvg("")).toBeNull();
  });

  it("returns null rather than reading garbage as zero", () => {
    expect(parseLoadAvg("not a number 0.5 0.2")).toBeNull();
  });

  it("rejects a negative reading as unusable rather than reporting it", () => {
    expect(parseLoadAvg("-1 0.5 0.2 1/10 100")).toBeNull();
  });
});
