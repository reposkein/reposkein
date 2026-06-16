import { describe, it, expect } from "vitest";
import { makeLargeGraph } from "./__fixtures__/largeGraph";
import { buildModel } from "./model";
import { fromWorker } from "./clientModel";
import { bundleEdges, visibleClusters, representativeFor } from "./clientModel";
import { computeNeighborhood } from "./neighborhood";
import { constellationMst, type ConstellationPoint } from "../scene/constellation";
import { allocateParticles } from "../scene/flow";
import { layoutIterations } from "./layout";
import type { WorkerResult } from "./worker/graph.worker";
import type { ClientModel } from "./clientModel";

const PARTICLE_BUDGET = 3000;
const MAX_MEMBERS_PER_CLUSTER = 80; // mirrors ConstellationLines.tsx

/** Reproduce the worker → main-thread handoff without a worker. */
function clientModelFromGraph(g: ReturnType<typeof makeLargeGraph>): ClientModel {
  const m = buildModel(g);
  const result: WorkerResult = {
    type: "result",
    repoId: m.tree.repoId,
    rootKey: m.tree.rootKey,
    clusters: [...m.tree.byKey.values()],
    keys: m.layout.keys,
    positions: m.layout.positions,
    drawEdges: m.drawEdges,
    records: [...m.records.entries()],
    fingerprint: m.fingerprint,
    counts: { nodes: g.nodes.length, edges: g.edges.length },
    repoRoot: null,
  };
  return fromWorker(result);
}

describe("large-graph pipeline (scale hardening §P4)", () => {
  it("generates a deterministic ~12k-node / ~45k-edge graph", () => {
    const a = makeLargeGraph({ symbols: 12000, relEdges: 45000 });
    const b = makeLargeGraph({ symbols: 12000, relEdges: 45000 });
    // Same params → identical node/edge counts + identical first/last ids.
    expect(a.nodes.length).toBe(b.nodes.length);
    expect(a.edges.length).toBe(b.edges.length);
    expect(a.nodes[100]!.id).toBe(b.nodes[100]!.id);
    expect(a.edges.at(-1)!.from).toBe(b.edges.at(-1)!.from);
    // Roughly the requested scale.
    expect(a.nodes.length).toBeGreaterThan(12000); // symbols + files + dirs + repo
    const drawn = a.edges.filter((e) =>
      ["CALLS", "IMPORTS", "INSTANTIATES", "IMPLEMENTS", "INHERITS"].includes(e.type),
    );
    expect(drawn.length).toBeGreaterThan(40000);
  });

  it("runs the full pure pipeline well under budget and respects every cap", () => {
    const t0 = performance.now();
    const g = makeLargeGraph({ symbols: 12000, relEdges: 45000 });
    const tGen = performance.now();

    const model = clientModelFromGraph(g); // includes adaptive d3-force layout
    const tModel = performance.now();

    expect(model.counts.nodes).toBeGreaterThan(12000);
    expect(model.drawEdges.length).toBeGreaterThan(40000);
    // Adaptive iterations actually stepped down for this size.
    expect(layoutIterations(model.keys.length)).toBeLessThan(200);

    // --- visibility + edge bundling (near-linear roll-up) ---
    // Fully expand EVERY cluster so the whole graph renders at symbol LOD — the
    // worst case for bundling, constellation MST and particle allocation.
    const expanded = new Set<string>();
    for (const [key, c] of model.byKey) {
      if (c.children.length > 0) expanded.add(key);
    }
    const visible = visibleClusters(model, expanded);
    const tVisible = performance.now();

    const bundles = bundleEdges(model, visible);
    const tBundle = performance.now();
    // Bundles can never exceed the number of visible-pair combinations and are
    // far fewer than the raw edge count once rolled up.
    expect(bundles.length).toBeLessThanOrEqual(model.drawEdges.length);

    // --- neighborhood BFS (bounded by depth + visited set) ---
    const someSymbol = g.nodes.find((n) =>
      ["Function", "Class", "Interface", "Variable"].includes(n.labels[0] ?? ""),
    )!.id;
    const nb = computeNeighborhood(model.drawEdges, someSymbol, 3);
    const tBfs = performance.now();
    expect(nb.nodes.has(someSymbol)).toBe(true);
    // BFS is bounded by the node universe.
    expect(nb.nodes.size).toBeLessThanOrEqual(model.records.size);

    // --- MST constellation lines (capped per cluster) ---
    let mstClusters = 0;
    let maxMembers = 0;
    for (const parentKey of expanded) {
      const parent = model.byKey.get(parentKey);
      if (!parent || parent.children.length < 2) continue;
      const members: ConstellationPoint[] = [];
      for (const childKey of parent.children) {
        if (!visible.has(childKey)) continue;
        const idx = model.indexByKey.get(childKey);
        if (idx === undefined) continue;
        members.push({
          key: childKey,
          x: model.positions[idx * 3]!,
          y: model.positions[idx * 3 + 1]!,
          z: model.positions[idx * 3 + 2]!,
        });
        if (members.length > MAX_MEMBERS_PER_CLUSTER) break;
      }
      if (members.length < 2 || members.length > MAX_MEMBERS_PER_CLUSTER) continue;
      const tree = constellationMst(members);
      maxMembers = Math.max(maxMembers, members.length);
      // MST has exactly members-1 edges.
      expect(tree.length).toBe(members.length - 1);
      mstClusters++;
    }
    const tMst = performance.now();
    // The per-cluster member cap held everywhere we actually drew an MST.
    expect(maxMembers).toBeLessThanOrEqual(MAX_MEMBERS_PER_CLUSTER);

    // --- particle allocation (hard budget) ---
    const selRep = representativeFor(model, someSymbol, visible);
    const isPriority = selRep
      ? (b: { srcKey: string; dstKey: string }) => b.srcKey === selRep || b.dstKey === selRep
      : undefined;
    const { particles } = allocateParticles(bundles, PARTICLE_BUDGET, isPriority);
    const tParticles = performance.now();
    expect(particles.length).toBeLessThanOrEqual(PARTICLE_BUDGET);

    // --- timing budget ---
    const total = tParticles - t0;
    // Generous CI-safe budget; the layout dominates. Should be a few seconds at
    // most on a laptop — assert it stays comfortably under 20s.
    expect(total).toBeLessThan(20000);

    // Surface measured numbers (visible in vitest reporter on failure / -v).
    console.log(
      `[P4 large-graph] nodes=${model.counts.nodes} drawEdges=${model.drawEdges.length} ` +
        `bundles=${bundles.length} particles=${particles.length} ` +
        `mstClusters=${mstClusters} maxMstMembers=${maxMembers} bfsNodes=${nb.nodes.size}\n` +
        `  gen=${(tGen - t0).toFixed(0)}ms model+layout=${(tModel - tGen).toFixed(0)}ms ` +
        `visible=${(tVisible - tModel).toFixed(0)}ms bundle=${(tBundle - tVisible).toFixed(0)}ms ` +
        `bfs=${(tBfs - tBundle).toFixed(0)}ms mst=${(tMst - tBfs).toFixed(0)}ms ` +
        `particles=${(tParticles - tMst).toFixed(0)}ms total=${total.toFixed(0)}ms`,
    );
  }, 30000);

  it("constellation MST guard skips over-cap clusters (mirrors ConstellationLines)", () => {
    // A wide cluster of 200 members: the scene collects at most MAX+1 then
    // bails (members.length > MAX → skip), so no O(n^2) MST runs on it.
    const members: ConstellationPoint[] = [];
    let collected = 0;
    for (let i = 0; i < 200; i++) {
      members.push({ key: `m${i}`, x: i, y: i * 2, z: i * 3 });
      collected = members.length;
      if (members.length > MAX_MEMBERS_PER_CLUSTER) break; // matches the scene
    }
    // Collection stops one past the cap; the cluster is then skipped entirely.
    expect(collected).toBe(MAX_MEMBERS_PER_CLUSTER + 1);
    const skipped = members.length > MAX_MEMBERS_PER_CLUSTER;
    expect(skipped).toBe(true);

    // At exactly the cap the MST runs and stays bounded (cap-1 edges).
    const atCap = members.slice(0, MAX_MEMBERS_PER_CLUSTER);
    const tree = constellationMst(atCap);
    expect(tree.length).toBe(MAX_MEMBERS_PER_CLUSTER - 1);
  });

  it("particle budget clamps hard even when bundles vastly exceed it", () => {
    // 50k synthetic bundles, no priority: allocation must never exceed budget.
    const bundles = Array.from({ length: 50000 }, (_, i) => ({
      srcKey: `s${i}`,
      dstKey: `d${i}`,
      count: 1 + (i % 16),
      dominantType: "CALLS",
      bestResolution: "exact" as const,
      srcNodes: new Set<string>(),
      dstNodes: new Set<string>(),
    }));
    const { particles } = allocateParticles(bundles, PARTICLE_BUDGET);
    expect(particles.length).toBeLessThanOrEqual(PARTICLE_BUDGET);
    // Coverage is spread across the draw order (sampling), not front-loaded.
    expect(particles.length).toBeGreaterThan(0);
  });

  it("layoutIterations is adaptive but fixed-per-size (deterministic)", () => {
    expect(layoutIterations(500)).toBe(200);
    expect(layoutIterations(2000)).toBe(200);
    expect(layoutIterations(3000)).toBe(150);
    expect(layoutIterations(8000)).toBe(100);
    expect(layoutIterations(14000)).toBe(70);
    // Same size → same count (the determinism contract).
    expect(layoutIterations(14000)).toBe(layoutIterations(14000));
  });
});
