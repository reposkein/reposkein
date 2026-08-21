// @vitest-environment jsdom
//
// Layer coordination (Astrolabe V3 §2): exclusivity, Esc dismissal, and the
// position of layers in the Esc stack (palette > tour > layer > chip >
// collapse-level).
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
const { setCommandPaletteOpen } = await import("./paletteOpenState");

afterEach(() => {
  cleanup();
  resetLayers();
  setCommandPaletteOpen(false);
});

function mockActions(): Actions {
  return {
    toggleExpand: vi.fn(),
    collapseLevel: vi.fn(),
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

  it("a layer's Esc is consumed, so Root's collapse-level binding does not also fire", () => {
    const collapse = vi.fn();
    // Stand-in for Root's bubble-phase window listener.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") collapse();
    };
    window.addEventListener("keydown", onKey);
    const { store } = makeStore({ model: tinyModel() });
    currentStore = store;
    render(<LayerHost />);
    summon("legend");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(openLayer()).toBeNull();
    expect(collapse).not.toHaveBeenCalled();

    // With nothing open, the same key reaches the collapse binding as before.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(collapse).toHaveBeenCalledOnce();
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
