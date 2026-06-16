import { describe, it, expect } from "vitest";
import { allocateParticles, particlesForBundle } from "./flow";
import type { EdgeBundle } from "../data/clientModel";

function bundle(srcKey: string, dstKey: string, count = 1): EdgeBundle {
  return {
    srcKey,
    dstKey,
    count,
    dominantType: "CALLS",
    bestResolution: "exact",
    srcNodes: new Set([srcKey]),
    dstNodes: new Set([dstKey]),
  };
}

describe("particlesForBundle", () => {
  it("is 1 for a thin connection and grows (capped) with traffic", () => {
    expect(particlesForBundle(1)).toBe(2); // 1 + floor(log2(2)) = 2
    expect(particlesForBundle(0)).toBe(1);
    expect(particlesForBundle(3)).toBe(3);
    // Capped at 4 regardless of how heavy the bundle is.
    expect(particlesForBundle(10_000)).toBe(4);
  });
});

describe("allocateParticles", () => {
  it("returns nothing for empty input or non-positive budget", () => {
    expect(allocateParticles([], 100).particles).toEqual([]);
    expect(allocateParticles([bundle("a", "b")], 0).particles).toEqual([]);
  });

  it("is deterministic: identical inputs → identical output", () => {
    const bundles = [bundle("a", "b", 2), bundle("c", "d", 5), bundle("e", "f", 1)];
    const r1 = allocateParticles(bundles, 50);
    const r2 = allocateParticles(bundles, 50);
    expect(r1).toEqual(r2);
  });

  it("never exceeds the budget", () => {
    const bundles = Array.from({ length: 500 }, (_, i) => bundle(`s${i}`, `d${i}`, 8));
    const { particles } = allocateParticles(bundles, 100);
    expect(particles.length).toBeLessThanOrEqual(100);
  });

  it("gives at least one particle per bundle when everything fits", () => {
    const bundles = [bundle("a", "b", 1), bundle("c", "d", 1), bundle("e", "f", 1)];
    const { particles } = allocateParticles(bundles, 100);
    const covered = new Set(particles.map((p) => p.bundleIndex));
    expect(covered).toEqual(new Set([0, 1, 2]));
  });

  it("spreads multiple particles of one bundle across distinct phases", () => {
    const { particles } = allocateParticles([bundle("a", "b", 8)], 100);
    expect(particles.length).toBeGreaterThan(1);
    const phases = particles.map((p) => p.phase);
    expect(new Set(phases).size).toBe(phases.length); // all distinct
    for (const ph of phases) {
      expect(ph).toBeGreaterThanOrEqual(0);
      expect(ph).toBeLessThan(1);
    }
  });

  it("always keeps priority bundles even when over budget", () => {
    // 100 bundles, budget 5, the LAST one flagged priority — it must survive
    // even though uniform sampling would normally drop it.
    const bundles = Array.from({ length: 100 }, (_, i) => bundle(`s${i}`, `d${i}`, 1));
    const priorityIndex = 99;
    const { particles } = allocateParticles(bundles, 5, (_b, i) => i === priorityIndex);
    expect(particles.length).toBeLessThanOrEqual(5);
    expect(particles.some((p) => p.bundleIndex === priorityIndex)).toBe(true);
  });

  it("samples uniformly across the draw order when over budget", () => {
    const bundles = Array.from({ length: 20 }, (_, i) => bundle(`s${i}`, `d${i}`, 1));
    const { particles } = allocateParticles(bundles, 4);
    const covered = particles.map((p) => p.bundleIndex);
    // ceil(20/4)=5 → indices 0,5,10,15.
    expect(covered).toEqual([0, 5, 10, 15]);
  });
});
