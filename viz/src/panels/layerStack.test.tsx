// @vitest-environment jsdom
//
// Layer coordination (Astrolabe V3 §2): exclusivity, Esc dismissal, and the
// position of layers in the Esc stack (palette > tour > layer > chip >
// deselect).
//
// The bug this replaces was user-visible, not theoretical: V2 kept `showMinimap`
// and `showLegend` as two independent reducer booleans, BOTH defaulting to true,
// and mounted both panels at `bottom: 40, left: 12` — so a fresh load rendered
// the minimap's "OVERVIEW" card and the legend on top of each other. Making the
// state one nullable id is what makes that unrepresentable; these tests pin the
// behaviour that follows from it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createInitialState, type Actions, type Store } from "../state/store";
import { buildModel } from "../data/model";
import { fromWorker, type ClientModel } from "../data/clientModel";
import type { WorkerResult } from "../data/worker/graph.worker";
import type { RawGraph } from "../data/types";

vi.mock("../scene/Screenshot", () => ({ captureScreenshot: vi.fn(), CaptureBridge: () => null }));
vi.mock("../scene/Controls", () => ({
  getCameraTarget: () => null,
  getCameraView: () => null,
  recenterCamera: vi.fn(),
}));

let currentStore: Store;
const currentEdgeStats = { drawn: 0, total: 0 };
vi.mock("../state/store", async () => {
  const actual = await vi.importActual<typeof import("../state/store")>("../state/store");
  return {
    ...actual,
    useStore: () => currentStore,
    useStoreState: () => currentStore,
    useEdgeStats: () => currentEdgeStats,
  };
});

const { LayerHost } = await import("./LayerHost");
const { layerPlacement } = await import("./LayerShell");
const { StatusBar } = await import("./StatusBar");
const {
  hideLayer,
  isLayerOpen,
  openLayer,
  resetLayers,
  showLayer,
  toggleLayer,
  LAYER_IDS,
} = await import("./layerState");
const { setCommandPaletteOpen, isCommandPaletteOpen } = await import("./paletteOpenState");
const { handleGlobalKey } = await import("./globalKeys");

afterEach(() => {
  cleanup();
  resetLayers();
  setCommandPaletteOpen(false);
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

function makeStore(overrides: Partial<Store> = {}): { store: Store; actions: Actions } {
  const actions = mockActions();
  const store = { ...createInitialState(), ...actions, ...overrides } as Store;
  return { store, actions };
}

/** A symbol the Inspector will actually render for — needed by the placement
 *  suite, which has to distinguish "a node is selected" from "the drawer is
 *  really on screen". */
const SYM = "rs1:r:sym:a.ts#run@0";

function symbolModel(): ClientModel {
  const g: RawGraph = {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:file:a.ts", labels: ["File"], props: { name: "a.ts", path: "a.ts" } },
      {
        id: SYM,
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

let restoreEl: HTMLButtonElement;
beforeEach(() => {
  restoreEl = document.createElement("button");
  document.body.appendChild(restoreEl);
  restoreEl.focus();
});

/** `showLayer` writes a module singleton that mounted components read through
 *  `useSyncExternalStore`, so the resulting re-render has to be flushed inside
 *  `act` for the assertions below to see it — exactly as a real click would be.
 *  Tests that only assert on the singleton itself call `showLayer` directly. */
function summon(id: Parameters<typeof showLayer>[0]) {
  act(() => showLayer(id));
}

describe("layerState — exclusivity is structural", () => {
  it("starts with nothing open", () => {
    expect(openLayer()).toBeNull();
  });

  it("opening any layer closes whatever was open", () => {
    for (const first of LAYER_IDS) {
      for (const second of LAYER_IDS) {
        if (first === second) continue;
        resetLayers();
        showLayer(first);
        expect(openLayer()).toBe(first);
        showLayer(second);
        expect(openLayer()).toBe(second);
        expect(isLayerOpen(first)).toBe(false);
      }
    }
  });

  it("toggle summons, then dismisses the same layer", () => {
    toggleLayer("legend");
    expect(openLayer()).toBe("legend");
    toggleLayer("legend");
    expect(openLayer()).toBeNull();
  });

  it("hideLayer reports whether it consumed anything (drives Esc)", () => {
    expect(hideLayer()).toBe(false);
    summon("help");
    expect(hideLayer()).toBe(true);
    expect(openLayer()).toBeNull();
  });
});

describe("LayerHost — never renders two layers at once", () => {
  it("renders only the summoned layer, swapping on the next summon", () => {
    currentStore = makeStore({ model: tinyModel() }).store;
    render(<LayerHost />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(document.body); // no-op with nothing open

    for (const id of LAYER_IDS) {
      summon(id);
      const dialogs = screen.queryAllByRole("dialog");
      expect(dialogs).toHaveLength(1);
      expect(screen.getByTestId(`layer-${id}`)).toBeTruthy();
    }
  });

  it("the minimap and the legend can never be co-mounted (the V2 overlap bug)", () => {
    currentStore = makeStore({ model: tinyModel() }).store;
    render(<LayerHost />);
    summon("minimap");
    expect(screen.getByTestId("layer-minimap")).toBeTruthy();
    expect(screen.queryByTestId("layer-legend")).toBeNull();
    summon("legend");
    expect(screen.getByTestId("layer-legend")).toBeTruthy();
    expect(screen.queryByTestId("layer-minimap")).toBeNull();
  });
});

describe("status bar pills drive the layer singleton", () => {
  it("clicking Legend summons it and un-presses Map", () => {
    const { store } = makeStore({ model: tinyModel() });
    currentStore = store;
    render(
      <>
        <StatusBar />
        <LayerHost />
      </>,
    );

    // Queried by ROLE, not text: once a layer opens, its LayerShell header
    // renders the same word as a heading label, so `getByText` is ambiguous.
    const mapPill = () => screen.getByRole("button", { name: "Map" });
    const legendPill = () => screen.getByRole("button", { name: "Legend" });

    fireEvent.click(mapPill());
    expect(openLayer()).toBe("minimap");
    expect(mapPill().getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(legendPill());
    expect(openLayer()).toBe("legend");
    expect(mapPill().getAttribute("aria-pressed")).toBe("false");
    expect(legendPill().getAttribute("aria-pressed")).toBe("true");
  });

  it("no layer is open on a fresh load (V2 defaulted two of them to shown)", () => {
    const { store } = makeStore({ model: tinyModel() });
    currentStore = store;
    render(
      <>
        <StatusBar />
        <LayerHost />
      </>,
    );
    expect(openLayer()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  /** REGRESSION: LayerShell dismisses on an outside mousedown, and the pill's
   *  own toggle runs on the following click. Treating the pill as "outside"
   *  meant close-then-reopen, so clicking Legend while the legend was open
   *  looked like nothing happened. The pills carry `data-layer-toggle` and
   *  LayerShell skips them. */
  it("clicking the SAME pill again actually closes the layer", () => {
    const { store } = makeStore({ model: tinyModel() });
    currentStore = store;
    render(
      <>
        <StatusBar />
        <LayerHost />
      </>,
    );
    const pill = () => screen.getByRole("button", { name: "Legend" });

    fireEvent.mouseDown(pill());
    fireEvent.click(pill());
    expect(openLayer()).toBe("legend");

    // Full mousedown → click sequence, as a browser delivers it.
    fireEvent.mouseDown(pill());
    fireEvent.click(pill());
    expect(openLayer()).toBeNull();
  });

  it("clicking a DIFFERENT pill swaps rather than closing to nothing", () => {
    const { store } = makeStore({ model: tinyModel() });
    currentStore = store;
    render(
      <>
        <StatusBar />
        <LayerHost />
      </>,
    );
    const map = () => screen.getByRole("button", { name: "Map" });
    const filters = () => screen.getByRole("button", { name: "Filters" });

    fireEvent.mouseDown(map());
    fireEvent.click(map());
    expect(openLayer()).toBe("minimap");

    fireEvent.mouseDown(filters());
    fireEvent.click(filters());
    expect(openLayer()).toBe("filters");
  });

  /** Fix round 1, M6a: the tooltip was built by lower-casing the pill's LABEL,
   *  which reads fine for "Map"/"Legend"/"Filters" and produces the nonsense
   *  "Hide ? — …" for the help pill, whose label is a glyph. */
  it("tooltips read as sentences, including for the glyph-labelled help pill", () => {
    const { store } = makeStore({ model: tinyModel() });
    currentStore = store;
    render(
      <>
        <StatusBar />
        <LayerHost />
      </>,
    );
    const help = () => screen.getByRole("button", { name: "?" });

    expect(help().getAttribute("title")).toBe(
      "Show keyboard shortcuts — Every key and pointer gesture",
    );
    expect(screen.getByRole("button", { name: "Map" }).getAttribute("title")).toBe(
      "Show map — Overview of the clusters currently on screen",
    );

    fireEvent.mouseDown(help());
    fireEvent.click(help());
    expect(help().getAttribute("title")).toBe(
      "Hide keyboard shortcuts — Every key and pointer gesture",
    );
    // The label itself is never case-mangled.
    expect(help().textContent).toBe("?");
  });
});

/** REGRESSION (fix round 1, I1). Every right-docked layer used a flat
 *  `right-3`, and the Inspector is a 360px drawer pinned to the same edge at a
 *  LOWER z-index (110 vs 120) — so selecting a node and opening the legend
 *  painted the sheet over the drawer's pinned Impact / Focus action row and made
 *  it unreachable. The fix reserves the drawer's column; these assert the
 *  geometry, since jsdom computes no layout to measure. */
describe("layer placement never collides with the Inspector", () => {
  it("layerPlacement reserves the Inspector's column at md and up", () => {
    for (const dock of ["right", "center"] as const) {
      const closed = layerPlacement(dock, false);
      const open = layerPlacement(dock, true);

      // Closed: hugs the right gutter, clamped only by the viewport.
      expect(closed).toContain("right-3");
      expect(closed).not.toMatch(/md:right-/);

      // Open: shifted left by the drawer's full width + a gutter…
      expect(open).toContain("md:right-[calc(360px+0.75rem)]");
      // …and clamped so a wide layer can't overflow back across it.
      expect(open).toContain("md:max-w-[calc(100vw-360px-0.75rem*3)]");
      // Below md the drawer is near-full-width; overlaying is correct there.
      expect(open).toContain("right-3");
    }
  });

  it("a centered layer re-centers in the region left of the drawer", () => {
    // Both insets set + mx-auto = centered inside whatever is left over.
    const open = layerPlacement("center", true);
    expect(open).toContain("left-3");
    expect(open).toContain("mx-auto");
    expect(open).toContain("md:right-[calc(360px+0.75rem)]");
  });

  it("every layer offsets while a node is selected, and none does otherwise", () => {
    for (const id of LAYER_IDS) {
      // No selection → no reserved column.
      cleanup();
      resetLayers();
      currentStore = makeStore({ model: symbolModel(), selected: null }).store;
      render(<LayerHost />);
      summon(id);
      const unselected = screen.getByTestId(`layer-${id}`);
      expect(unselected.getAttribute("data-inspector-open")).toBe("false");
      expect(unselected.className).not.toMatch(/md:right-/);

      // Selection on a node that really exists → column reserved.
      cleanup();
      resetLayers();
      currentStore = makeStore({
        model: symbolModel(),
        selected: SYM,
        status: { kind: "ready" },
      }).store;
      render(<LayerHost />);
      summon(id);
      const selected = screen.getByTestId(`layer-${id}`);
      expect(selected.getAttribute("data-inspector-open")).toBe("true");
      expect(selected.className, `layer ${id} does not clear the inspector`).toContain(
        "md:right-[calc(360px+0.75rem)]",
      );
    }
  });

  it("does NOT reserve a column when the drawer isn't actually mounted", () => {
    // A stale deep-link id leaves `selected` set with no drawer on screen…
    currentStore = makeStore({
      model: symbolModel(),
      selected: "rs1:r:sym:ghost@0",
      status: { kind: "ready" },
    }).store;
    render(<LayerHost />);
    summon("legend");
    expect(screen.getByTestId("layer-legend").getAttribute("data-inspector-open")).toBe("false");
    cleanup();
    resetLayers();

    // …and neither does a selection made before the model is ready.
    currentStore = makeStore({
      model: symbolModel(),
      selected: SYM,
      status: { kind: "loading", phase: "parsing" },
    }).store;
    render(<LayerHost />);
    summon("legend");
    expect(screen.getByTestId("layer-legend").getAttribute("data-inspector-open")).toBe("false");
  });

  it("the layer still sits above the drawer in z-order (it just no longer overlaps it)", () => {
    currentStore = makeStore({
      model: symbolModel(),
      selected: SYM,
      status: { kind: "ready" },
    }).store;
    render(<LayerHost />);
    summon("filters");
    // z-120 vs the Inspector's z-110: intentional, so a layer summoned over the
    // drawer's own edge is never clipped by it.
    expect(screen.getByTestId("layer-filters").className).toContain("z-[120]");
  });
});

describe("Esc stack: palette > tour > layer > chip", () => {
  it("Esc dismisses the open layer and does NOT also dismiss a mode chip", () => {
    const { store, actions } = makeStore({ model: tinyModel(), lens: "calls" });
    currentStore = store;
    render(
      <>
        <StatusBar />
        <LayerHost />
      </>,
    );
    summon("filters");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(openLayer()).toBeNull();
    // The lens chip survives — one Esc, one dismissal.
    expect(actions.setLens).not.toHaveBeenCalled();

    // Second Esc: nothing above the chip any more.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(actions.setLens).toHaveBeenCalledWith("all");
  });

  it("the palette outranks a layer: Esc leaves the layer open", () => {
    const { store } = makeStore({ model: tinyModel() });
    currentStore = store;
    render(<LayerHost />);
    summon("legend");
    setCommandPaletteOpen(true);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(openLayer()).toBe("legend");
  });

  it("an active tour outranks a layer: Esc leaves the layer open", () => {
    const { store } = makeStore({ model: tinyModel(), tour: true });
    currentStore = store;
    render(<LayerHost />);
    summon("help");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(openLayer()).toBe("help");
  });

  it("a layer's Esc is consumed, so the global handler's deselect does not also fire", () => {
    const fellThrough = vi.fn();
    // Stand-in for Root's bubble-phase window listener.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") fellThrough();
    };
    window.addEventListener("keydown", onKey);
    const { store } = makeStore({ model: tinyModel() });
    currentStore = store;
    render(<LayerHost />);
    summon("legend");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(openLayer()).toBeNull();
    expect(fellThrough).not.toHaveBeenCalled();

    // With nothing open, the same key reaches the global binding as before.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(fellThrough).toHaveBeenCalledOnce();
    window.removeEventListener("keydown", onKey);
  });

  /** THE LAYERED ESC STACK, END TO END (Astrolabe V4 §1).
   *
   *  Each step above is asserted in isolation elsewhere in this file; this walks
   *  the whole ladder in one mount with the REAL global handler at the bottom,
   *  because the property that matters is the ORDER — every earlier step must
   *  consume the key so exactly ONE thing happens per press.
   *
   *  palette → summoned layer → topmost mode chip → deselect → nothing. */
  it("walks palette → layer → chip → deselect → nothing, one step per press", () => {
    const { store, actions } = makeStore({
      model: tinyModel(),
      selected: "rs1:r:file:a.ts",
      lens: "calls",
    });
    currentStore = store;
    // Root's listener, verbatim in spirit: the real handler is the tail.
    const onKey = (e: KeyboardEvent) =>
      handleGlobalKey(e, currentStore, currentStore, {
        openPalette: vi.fn(),
        toggleLayer: vi.fn(),
        paletteOpen: isCommandPaletteOpen,
      });
    window.addEventListener("keydown", onKey);
    render(
      <>
        <StatusBar />
        <LayerHost />
      </>,
    );
    summon("legend");
    setCommandPaletteOpen(true);

    // 1. The palette is above everything: nothing else moves.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(openLayer()).toBe("legend");
    expect(actions.setLens).not.toHaveBeenCalled();
    expect(actions.select).not.toHaveBeenCalled();
    setCommandPaletteOpen(false); // the palette closed itself

    // 2. The summoned layer.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(openLayer()).toBeNull();
    expect(actions.setLens).not.toHaveBeenCalled();
    expect(actions.select).not.toHaveBeenCalled();

    // 3. The topmost mode chip (the lens chip is leftmost).
    fireEvent.keyDown(document, { key: "Escape" });
    expect(actions.setLens).toHaveBeenCalledExactlyOnceWith("all");
    expect(actions.select).not.toHaveBeenCalled();

    // 4. Deselect. The chip is gone from state's point of view only once the
    //    store is re-rendered with lens "all", which a real store would do —
    //    mirror that here.
    currentStore = { ...currentStore, lens: "all" } as Store;
    cleanup();
    render(
      <>
        <StatusBar />
        <LayerHost />
      </>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(actions.select).toHaveBeenCalledExactlyOnceWith(null);

    // 5. Nothing left. Esc is a no-op — never a collapse.
    currentStore = { ...currentStore, selected: null } as Store;
    fireEvent.keyDown(document, { key: "Escape" });
    expect(actions.select).toHaveBeenCalledOnce(); // still just the one call
    expect(actions.collapseBranch).not.toHaveBeenCalled();
    expect(actions.collapseToFileLevel).not.toHaveBeenCalled();

    window.removeEventListener("keydown", onKey);
  });
});

describe("layers dismiss on an outside click and on their own close button", () => {
  it("clicking outside puts the layer away", () => {
    currentStore = makeStore({ model: tinyModel() }).store;
    render(<LayerHost />);
    summon("legend");

    fireEvent.mouseDown(document.body);

    expect(openLayer()).toBeNull();
  });

  it("clicking inside the layer keeps it open", () => {
    currentStore = makeStore({ model: tinyModel() }).store;
    render(<LayerHost />);
    summon("legend");

    fireEvent.mouseDown(screen.getByTestId("layer-legend"));

    expect(openLayer()).toBe("legend");
  });

  it("the header ✕ closes it", () => {
    currentStore = makeStore({ model: tinyModel() }).store;
    render(<LayerHost />);
    summon("filters");

    fireEvent.click(screen.getByLabelText("Close Filters"));

    expect(openLayer()).toBeNull();
  });
});
