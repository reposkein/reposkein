import { describe, it, expect } from "vitest";
import { layoutFingerprint, LAYOUT_VERSION } from "./layout";
import { fingerprint } from "./hash";

describe("layoutFingerprint (position-cache key)", () => {
  it("is stable for the same node set, regardless of order", () => {
    const a = layoutFingerprint(["c", "a", "b"]);
    const b = layoutFingerprint(["a", "b", "c"]);
    const c = layoutFingerprint(["b", "c", "a"]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("is reproducible across calls", () => {
    expect(layoutFingerprint(["x", "y"])).toBe(layoutFingerprint(["x", "y"]));
  });

  it("differs when the node SET changes", () => {
    expect(layoutFingerprint(["a", "b"])).not.toBe(layoutFingerprint(["a", "c"]));
  });

  it("differs when the node COUNT changes (even with overlapping ids)", () => {
    expect(layoutFingerprint(["a", "b"])).not.toBe(layoutFingerprint(["a", "b", "c"]));
  });

  it("differs from the same id-set hash WITHOUT the version/count prefix", () => {
    // Guards that the version + count are actually folded into the key, so a
    // LAYOUT_VERSION bump (or a count change) necessarily changes the key.
    const ids = ["a", "b", "c"];
    const naive = fingerprint([...ids].sort());
    expect(layoutFingerprint(ids)).not.toBe(naive);
    // The current key equals hashing the version + count + sorted ids.
    const expected = fingerprint([`v${LAYOUT_VERSION}`, `n${ids.length}`, "a", "b", "c"]);
    expect(layoutFingerprint(ids)).toBe(expected);
  });

  it("an empty graph still produces a stable key", () => {
    expect(layoutFingerprint([])).toBe(layoutFingerprint([]));
  });
});
