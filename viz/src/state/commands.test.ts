import { describe, it, expect, vi } from "vitest";
import { buildCommandRegistry, pushRecent, type PaletteEnv } from "./commands";
import { createInitialState, type Actions, type State } from "./store";
import { buildModel } from "../data/model";
import { fromWorker, type ClientModel } from "../data/clientModel";
import type { WorkerResult } from "../data/worker/graph.worker";
import type { RawGraph } from "../data/types";

/** A fully-typed Actions double: every method is a spy, so a command's `run`
 *  can be invoked exactly as the palette would invoke it without mounting a
 *  StoreProvider. */
function mockActions(): Actions & Record<keyof Actions, ReturnType<typeof vi.fn>> {
  return {
    toggleExpand: vi.fn(),
    collapseBranch: vi.fn(),
    collapseToFileLevel: vi.fn(),
    select: vi.fn(),
    requestFit: vi.fn(),
    revealAndSelect: vi.fn(),
    revealWithoutRefit: vi.fn(),
    setKindFilter: vi.fn(),
    setEdgeTypeFilter: vi.fn(),
    setMinConfidence: vi.fn(),
    clearFilters: vi.fn(),
    setFocusTarget: vi.fn(),
    setLens: vi.fn(),
    setAudit: vi.fn(),
    toggleImpact: vi.fn(),
    toggleFocus: vi.fn(),
    setFocusDepth: vi.fn(),
    toggleCoupling: vi.fn(),
    setCochange: vi.fn(),
    startTour: vi.fn(),
    exitTour: vi.fn(),
    resetView: vi.fn(),
    resetExpansion: vi.fn(),
    setBundleBeta: vi.fn(),
    setIdleDrift: vi.fn(),
    retryLoad: vi.fn(),
    toggleLabels: vi.fn(),
    hover: vi.fn(),
    setEdgeStats: vi.fn(),
  };
}

function mockEnv(): PaletteEnv & Record<keyof PaletteEnv, ReturnType<typeof vi.fn>> {
  return { screenshot: vi.fn(), copyLink: vi.fn(), toggleLayer: vi.fn() };
}

/** A tiny ready ClientModel, for the commands (start-tour) that check `model`. */
function tinyModel(): ClientModel {
  const g: RawGraph = {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:file:a.ts", labels: ["File"], props: { name: "a.ts", path: "a.ts" } },
    ],
    edges: [],
  };
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

function stateWith(overrides: Partial<State>): State {
  return { ...createInitialState(), ...overrides };
}

const registry = buildCommandRegistry();

function find(id: string) {
  const cmd = registry.find((c) => c.id === id);
  if (!cmd) throw new Error(`no command registered with id "${id}"`);
  return cmd;
}

describe("buildCommandRegistry — grouping", () => {
  it("every command belongs to the 'commands' group", () => {
    expect(registry.length).toBeGreaterThan(0);
    for (const cmd of registry) expect(cmd.group).toBe("commands");
  });

  it("every id is unique", () => {
    const ids = registry.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildCommandRegistry — completeness (every REP-13-listed store action is reachable)", () => {
  const selected = stateWith({ selected: "n1" });
  const notSelected = stateWith({ selected: null });

  it("lenses 1-5 call setLens with the matching id and carry a numeric kbd hint", () => {
    const order: [string, string][] = [
      ["lens-all", "all"],
      ["lens-calls", "calls"],
      ["lens-types", "types"],
      ["lens-imports", "imports"],
      ["lens-tests", "tests"],
    ];
    order.forEach(([id, lens], i) => {
      const actions = mockActions();
      const cmd = find(id);
      expect(cmd.kbd).toBe(String(i + 1));
      cmd.run(actions, notSelected, mockEnv());
      expect(actions.setLens).toHaveBeenCalledWith(lens);
    });
  });

  it("Impact calls toggleImpact and is disabled without a selection", () => {
    const cmd = find("impact");
    expect(cmd.disabled(notSelected)).toBe(true);
    expect(cmd.disabled(selected)).toBe(false);
    const actions = mockActions();
    cmd.run(actions, selected, mockEnv());
    expect(actions.toggleImpact).toHaveBeenCalledOnce();
  });

  it("Focus calls toggleFocus and is disabled without a selection", () => {
    const cmd = find("focus");
    expect(cmd.disabled(notSelected)).toBe(true);
    const actions = mockActions();
    cmd.run(actions, selected, mockEnv());
    expect(actions.toggleFocus).toHaveBeenCalledOnce();
  });

  it("Focus depth 1-3 call setFocusDepth(n) and are disabled without a selection", () => {
    for (const depth of [1, 2, 3]) {
      const cmd = find(`focus-depth-${depth}`);
      expect(cmd.disabled(notSelected)).toBe(true);
      expect(cmd.disabled(selected)).toBe(false);
      const actions = mockActions();
      cmd.run(actions, selected, mockEnv());
      expect(actions.setFocusDepth).toHaveBeenCalledWith(depth);
    }
  });

  it("Coupling calls toggleCoupling", () => {
    const actions = mockActions();
    find("coupling").run(actions, notSelected, mockEnv());
    expect(actions.toggleCoupling).toHaveBeenCalledOnce();
  });

  it("Audit commands call setAudit and toggle off when already active", () => {
    const actions1 = mockActions();
    find("audit-ambiguous").run(actions1, stateWith({ audit: "off" }), mockEnv());
    expect(actions1.setAudit).toHaveBeenCalledWith("ambiguous");

    const actions2 = mockActions();
    find("audit-ambiguous").run(actions2, stateWith({ audit: "ambiguous" }), mockEnv());
    expect(actions2.setAudit).toHaveBeenCalledWith("off");

    const actions3 = mockActions();
    find("audit-ambiguous-name").run(actions3, stateWith({ audit: "off" }), mockEnv());
    expect(actions3.setAudit).toHaveBeenCalledWith("ambiguous+name");
  });

  it("Edge bundling toggle calls setBundleBeta, flipping between 0 and 0.85", () => {
    const actions1 = mockActions();
    find("bundling").run(actions1, stateWith({ bundleBeta: 0.85 }), mockEnv());
    expect(actions1.setBundleBeta).toHaveBeenCalledWith(0);

    const actions2 = mockActions();
    find("bundling").run(actions2, stateWith({ bundleBeta: 0 }), mockEnv());
    expect(actions2.setBundleBeta).toHaveBeenCalledWith(0.85);
  });

  it("Frame all calls requestFit (camera-only, non-destructive)", () => {
    const actions = mockActions();
    find("frame-all").run(actions, notSelected, mockEnv());
    expect(actions.requestFit).toHaveBeenCalledOnce();
  });

  it("Clean slate calls resetView (destructive full reset)", () => {
    const actions = mockActions();
    find("clean-slate").run(actions, notSelected, mockEnv());
    expect(actions.resetView).toHaveBeenCalledOnce();
  });

  it("Collapse branch needs a selection; Collapse to file level does not (V4 §2)", () => {
    const branch = find("collapse-branch");
    expect(branch.disabled(notSelected)).toBe(true);
    expect(branch.disabled(selected)).toBe(false);
    const a1 = mockActions();
    branch.run(a1, selected, mockEnv());
    expect(a1.collapseBranch).toHaveBeenCalledOnce();

    const global = find("collapse-to-file-level");
    expect(global.disabled(notSelected)).toBe(false);
    const a2 = mockActions();
    global.run(a2, notSelected, mockEnv());
    expect(a2.collapseToFileLevel).toHaveBeenCalledOnce();
  });

  it("Start tour calls startTour and is disabled while already touring or with no model", () => {
    const cmd = find("start-tour");
    expect(cmd.disabled(stateWith({ model: null }))).toBe(true);
    const model = tinyModel();
    expect(cmd.disabled(stateWith({ model, tour: true }))).toBe(true);
    expect(cmd.disabled(stateWith({ model, tour: false }))).toBe(false);
    const actions = mockActions();
    cmd.run(actions, stateWith({ model, tour: false }), mockEnv());
    expect(actions.startTour).toHaveBeenCalledOnce();
  });

  it("Screenshot calls env.screenshot(), not a store action", () => {
    const env = mockEnv();
    find("screenshot").run(mockActions(), notSelected, env);
    expect(env.screenshot).toHaveBeenCalledOnce();
  });

  it("Copy link calls env.copyLink() and is disabled without a selection", () => {
    const cmd = find("copy-link");
    expect(cmd.disabled(notSelected)).toBe(true);
    expect(cmd.disabled(selected)).toBe(false);
    const env = mockEnv();
    cmd.run(mockActions(), selected, env);
    expect(env.copyLink).toHaveBeenCalledOnce();
  });

  it("the labels/drift toggles call their store actions", () => {
    const actions = mockActions();
    find("toggle-labels").run(actions, notSelected, mockEnv());
    find("toggle-drift").run(actions, stateWith({ idleDrift: false }), mockEnv());
    expect(actions.toggleLabels).toHaveBeenCalledOnce();
    expect(actions.setIdleDrift).toHaveBeenCalledWith(true);
  });

  /** V3 moved layer visibility out of the reducer into `panels/layerState.ts`
   *  (one nullable id, so two layers can never be open). The commands that used
   *  to call `actions.toggleMinimap()` / `actions.toggleLegend()` now go through
   *  `env.toggleLayer` — the same env channel `screenshot` uses for a scene-side
   *  singleton. This keeps the completeness guarantee intact and extends it to
   *  the two layers V2 had no command for at all. */
  it("every summoned layer is reachable through env.toggleLayer", () => {
    const cases: [string, string][] = [
      ["toggle-minimap", "minimap"],
      ["toggle-legend", "legend"],
      ["toggle-filters", "filters"],
      ["toggle-help", "help"],
    ];
    for (const [id, layer] of cases) {
      const env = mockEnv();
      const actions = mockActions();
      find(id).run(actions, notSelected, env);
      expect(env.toggleLayer).toHaveBeenCalledExactlyOnceWith(layer);
      // A layer toggle must NOT be a reducer transition any more.
      for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe("pushRecent", () => {
  const a = { id: "a", name: "Alpha", kind: "Function", filePath: "a.ts" };
  const b = { id: "b", name: "Beta", kind: "Class", filePath: "b.ts" };
  const c = { id: "c", name: "Gamma", kind: "file", filePath: "c.ts" };

  it("prepends the new entry", () => {
    expect(pushRecent([b], a).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("de-duplicates by id, moving a re-opened entry back to the front", () => {
    expect(pushRecent([a, b], b).map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("caps at 8 by default", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`,
      name: `n${i}`,
      kind: "Function",
      filePath: "",
    }));
    const result = pushRecent(many, c);
    expect(result).toHaveLength(8);
    expect(result[0]!.id).toBe("c");
    expect(result.at(-1)!.id).not.toBe("n7"); // the oldest fell off the cap
  });

  it("respects a custom cap", () => {
    expect(pushRecent([a, b], c, 2)).toHaveLength(2);
  });
});
