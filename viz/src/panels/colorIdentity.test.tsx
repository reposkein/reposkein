// @vitest-environment jsdom
//
// THE COLOR-IDENTITY TEST (Astrolabe V3 acceptance criterion).
//
// The failure mode this exists to make impossible: the retired FilterHUD carried
// its OWN hard-coded kind palette (One-Dark — `#e5c07b` for Function, `#56b6c2`
// for Class …) that had nothing to do with the hues `scene/encoding.ts` tells
// the GPU to draw (`#ffe08a`, `#5fe0e0`). A "Class" chip was cyan-ish, a Class
// star was a different cyan, and nothing in the codebase could tell you they had
// drifted. Same for the legend, which read encoding.ts directly but as literal
// hex strings rather than through the generated tokens.
//
// V3 routes every chrome swatch through `data/encodingVars.ts` → the CSS custom
// property that `styles/tokens.ts` generates from encoding.ts. This test walks
// that whole chain for every entry of every META table:
//
//     filter chip var  ===  legend swatch var
//                      ===  generated @theme token name
//                      ===  a token whose VALUE is the encoding.ts hex
//
// so a hue can only be changed in one place, and any component that invents its
// own is a red test rather than a subtle visual drift.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createInitialState, type Actions, type Store } from "../state/store";
import { buildModel } from "../data/model";
import { fromWorker, type ClientModel } from "../data/clientModel";
import type { WorkerResult } from "../data/worker/graph.worker";
import type { RawGraph } from "../data/types";
import {
  EDGE_TYPE_META,
  LANGUAGE_HEX,
  NODE_KIND_META,
  SYMBOL_KIND_META,
} from "../scene/encoding";
import {
  edgeTypeVarName,
  languageVarName,
  nodeKindVarName,
  varSlug,
} from "../data/encodingVars";
import { renderTokensCss, tokenGroups, tokenSlug } from "../styles/tokens";

let currentStore: Store;
vi.mock("../state/store", async () => {
  const actual = await vi.importActual<typeof import("../state/store")>("../state/store");
  return { ...actual, useStore: () => currentStore, useStoreState: () => currentStore };
});

const { LegendSheet } = await import("./LegendSheet");
const { FiltersPopover } = await import("./FiltersPopover");
const { resetLayers } = await import("./layerState");

afterEach(() => {
  cleanup();
  resetLayers();
});

function mockActions(): Actions {
  return {
    toggleExpand: vi.fn(),
    collapseBranch: vi.fn(),
    collapseToFileLevel: vi.fn(),
    select: vi.fn(),
    requestFit: vi.fn(),
    revealAndSelect: vi.fn(),
    revealWithoutRefit: vi.fn(),
    hop: vi.fn(),
    historyBack: vi.fn(() => false),
    historyForward: vi.fn(() => false),
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

/** A TypeScript file + a Python file, so `presentLanguages` yields two real
 *  language rows in the legend (and no rows for absent languages). */
function tinyModel(): ClientModel {
  const g: RawGraph = {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:file:a.ts", labels: ["File"], props: { name: "a.ts", path: "a.ts" } },
      { id: "rs1:r:file:b.py", labels: ["File"], props: { name: "b.py", path: "b.py" } },
      {
        id: "rs1:r:sym:a.ts#run@0",
        labels: ["Function"],
        props: { name: "run", file_path: "a.ts", content_hash: "h" },
      },
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

function makeStore(overrides: Partial<Store> = {}): Store {
  return { ...createInitialState(), ...mockActions(), ...overrides } as Store;
}

/** Token name → declared value, parsed out of the generated @theme block. */
function generatedTokens(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of renderTokensCss().split("\n")) {
    const m = /^\s*(--color-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6});$/.exec(line);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

describe("encodingVars ↔ styles/tokens: the same slug, always", () => {
  it("varSlug agrees with tokenSlug for every META entry", () => {
    for (const meta of NODE_KIND_META) expect(varSlug(meta.kind)).toBe(tokenSlug(meta.kind));
    for (const meta of EDGE_TYPE_META) expect(varSlug(meta.type)).toBe(tokenSlug(meta.type));
    for (const lang of Object.keys(LANGUAGE_HEX)) expect(varSlug(lang)).toBe(tokenSlug(lang));
  });

  it("every var name encodingVars can produce is actually declared as a token", () => {
    const tokens = generatedTokens();
    for (const meta of NODE_KIND_META) expect(tokens.has(nodeKindVarName(meta.kind))).toBe(true);
    for (const meta of EDGE_TYPE_META) expect(tokens.has(edgeTypeVarName(meta.type))).toBe(true);
    for (const lang of Object.keys(LANGUAGE_HEX)) {
      expect(tokens.has(languageVarName(lang, true))).toBe(true);
    }
    // An unknown language has no token of its own and must fall back.
    expect(languageVarName("brainfuck", false)).toBe("--color-lang-default");
    expect(tokens.has("--color-lang-default")).toBe(true);
  });

  it("each token's VALUE is the encoding.ts hex (no second source of truth)", () => {
    const tokens = generatedTokens();
    for (const meta of NODE_KIND_META) {
      expect(tokens.get(nodeKindVarName(meta.kind))).toBe(meta.color);
    }
    for (const meta of EDGE_TYPE_META) {
      expect(tokens.get(edgeTypeVarName(meta.type))).toBe(meta.color);
    }
    for (const [lang, hexValue] of Object.entries(LANGUAGE_HEX)) {
      expect(tokens.get(languageVarName(lang, true))).toBe(hexValue);
    }
    // Sanity: the generator itself declares nothing beyond the tables.
    const declared = tokenGroups().flatMap((g) => g.tokens.map((t) => t.name));
    expect(new Set(declared).size).toBe(declared.length);
  });
});

describe("legend sheet is generated from encoding.ts META only", () => {
  it("renders one swatch per node kind and edge type, each naming its token", () => {
    currentStore = makeStore({ model: tinyModel() });
    render(<LegendSheet />);
    const tokens = generatedTokens();

    for (const meta of NODE_KIND_META) {
      const el = screen.getByTestId(`legend-swatch-node-${meta.kind}`);
      const varName = nodeKindVarName(meta.kind);
      expect(el.getAttribute("data-color-var")).toBe(`var(${varName})`);
      expect(tokens.get(varName)).toBe(meta.color);
      // …and the reference actually reaches CSS, not just a data attribute.
      expect(el.style.backgroundColor).toBe(`var(${varName})`);
    }
    for (const meta of EDGE_TYPE_META) {
      const el = screen.getByTestId(`legend-swatch-edge-${meta.type}`);
      const varName = edgeTypeVarName(meta.type);
      expect(el.getAttribute("data-color-var")).toBe(`var(${varName})`);
      expect(tokens.get(varName)).toBe(meta.color);
      expect(el.style.backgroundColor).toBe(`var(${varName})`);
    }
  });

  it("language swatches name their token too, and reach CSS the same way", () => {
    currentStore = makeStore({ model: tinyModel() });
    render(<LegendSheet />);
    const tokens = generatedTokens();

    // Only the two languages this fixture actually contains — asserted the same
    // way as kinds and edges rather than by mere presence.
    for (const lang of ["typescript", "python"]) {
      const el = screen.getByTestId(`legend-swatch-lang-${lang}`);
      const varName = languageVarName(lang, true);
      expect(el.getAttribute("data-color-var")).toBe(`var(${varName})`);
      expect(el.style.backgroundColor).toBe(`var(${varName})`);
      expect(tokens.get(varName)).toBe(LANGUAGE_HEX[lang]);
    }
  });

  it("lists only the languages present in this graph", () => {
    currentStore = makeStore({ model: tinyModel() });
    render(<LegendSheet />);
    expect(screen.getByTestId("legend-swatch-lang-typescript")).toBeTruthy();
    expect(screen.getByTestId("legend-swatch-lang-python")).toBeTruthy();
    expect(screen.queryByTestId("legend-swatch-lang-rust")).toBeNull();
  });
});

describe("filter chips take the SAME token as the legend and the scene", () => {
  it("kind chips reference --color-node-* (never the retired One-Dark palette)", () => {
    currentStore = makeStore({ model: tinyModel() });
    const view = render(<FiltersPopover />);
    const tokens = generatedTokens();

    for (const meta of SYMBOL_KIND_META) {
      const chip = screen.getByTestId(`filter-chip-node-${meta.kind}`);
      const varName = nodeKindVarName(meta.kind);
      expect(chip.getAttribute("data-color-var")).toBe(`var(${varName})`);
      expect(tokens.get(varName)).toBe(meta.color);
      // The One-Dark hues FilterHUD used to hard-code must appear nowhere.
      expect(chip.outerHTML).not.toMatch(/#e5c07b|#56b6c2|#c678dd|#98c379|#abb2bf/i);
    }
    view.unmount();
  });

  it("edge chips reference --color-edge-*, matching the legend's dashes exactly", () => {
    currentStore = makeStore({ model: tinyModel() });
    render(
      <>
        <FiltersPopover />
      </>,
    );
    const chipVars = EDGE_TYPE_META.map((m) =>
      screen.getByTestId(`filter-chip-edge-${m.type}`).getAttribute("data-color-var"),
    );
    cleanup();

    currentStore = makeStore({ model: tinyModel() });
    render(<LegendSheet />);
    const legendVars = EDGE_TYPE_META.map((m) =>
      screen.getByTestId(`legend-swatch-edge-${m.type}`).getAttribute("data-color-var"),
    );

    expect(chipVars).toEqual(legendVars);
    expect(chipVars).toEqual(EDGE_TYPE_META.map((m) => `var(${edgeTypeVarName(m.type)})`));
  });

  it("only SYMBOL kinds are filterable — structural rows aren't chips", () => {
    currentStore = makeStore({ model: tinyModel() });
    render(<FiltersPopover />);
    expect(screen.queryByTestId("filter-chip-node-galaxy")).toBeNull();
    expect(screen.queryByTestId("filter-chip-node-dir")).toBeNull();
    expect(screen.queryByTestId("filter-chip-node-file")).toBeNull();
    expect(screen.getByTestId("filter-chip-node-Function")).toBeTruthy();
  });
});
