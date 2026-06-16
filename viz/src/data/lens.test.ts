import { describe, it, expect } from "vitest";
import { resolveLens, LENS_ORDER, LENS_PRESETS } from "./lens";

describe("lens presets -> filter state", () => {
  it("All shows everything (no hidden filters, no emphasis)", () => {
    const s = resolveLens("all");
    expect(s.kinds.size).toBe(0);
    expect(s.edgeTypes.size).toBe(0);
    expect(s.minConfidence).toBe(0);
    expect(s.emphasis).toBe("none");
  });

  it("Call graph hides every edge type except CALLS", () => {
    const s = resolveLens("calls");
    expect(s.edgeTypes.has("CALLS")).toBe(false);
    expect(s.edgeTypes.has("IMPORTS")).toBe(true);
    expect(s.edgeTypes.has("INHERITS")).toBe(true);
    expect(s.edgeTypes.has("IMPLEMENTS")).toBe(true);
    expect(s.edgeTypes.has("INSTANTIATES")).toBe(true);
    expect(s.emphasis).toBe("none");
  });

  it("Imports hides every edge type except IMPORTS", () => {
    const s = resolveLens("imports");
    expect(s.edgeTypes.has("IMPORTS")).toBe(false);
    expect(s.edgeTypes.has("CALLS")).toBe(true);
    expect([...s.edgeTypes].sort()).toEqual(
      ["CALLS", "IMPLEMENTS", "INHERITS", "INSTANTIATES"]
    );
  });

  it("Type hierarchy keeps INHERITS/IMPLEMENTS/INSTANTIATES and emphasizes types", () => {
    const s = resolveLens("types");
    expect(s.edgeTypes.has("INHERITS")).toBe(false);
    expect(s.edgeTypes.has("IMPLEMENTS")).toBe(false);
    expect(s.edgeTypes.has("INSTANTIATES")).toBe(false);
    expect(s.edgeTypes.has("CALLS")).toBe(true);
    expect(s.edgeTypes.has("IMPORTS")).toBe(true);
    expect(s.emphasis).toBe("types");
  });

  it("Tests lens hides nothing but sets tests emphasis", () => {
    const s = resolveLens("tests");
    expect(s.kinds.size).toBe(0);
    expect(s.edgeTypes.size).toBe(0);
    expect(s.emphasis).toBe("tests");
  });

  it("LENS_ORDER covers exactly the preset table", () => {
    expect([...LENS_ORDER].sort()).toEqual(
      Object.keys(LENS_PRESETS).sort()
    );
  });

  it("resolveLens returns fresh sets (no shared mutable state)", () => {
    const a = resolveLens("calls");
    const b = resolveLens("calls");
    a.edgeTypes.add("MUTATED");
    expect(b.edgeTypes.has("MUTATED")).toBe(false);
  });
});
