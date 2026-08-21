// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createInitialState, type Actions, type Store } from "../state/store";
import { buildModel } from "../data/model";
import { fromWorker, type ClientModel } from "../data/clientModel";
import type { WorkerResult } from "../data/worker/graph.worker";
import type { RawGraph } from "../data/types";
import type { RepoMeta } from "../data/api";

vi.mock("../scene/Screenshot", () => ({ captureScreenshot: vi.fn(), CaptureBridge: () => null }));
// Controls.tsx pulls in three.js / camera-controls / R3F; the bar only needs
// getCameraTarget's return value (via scene/cameraNearest.ts).
vi.mock("../scene/Controls", () => ({ getCameraTarget: () => null }));

let currentStore: Store;
const currentEdgeStats = { drawn: 0, total: 0 };
vi.mock("../state/store", async () => {
  const actual = await vi.importActual<typeof import("../state/store")>("../state/store");
  return {
    ...actual,
    useStore: () => currentStore,
    // EdgeCapIndicator subscribes to the edgeStats CHANNEL directly (pointer/
    // pass rate, not the reducer) — outside a real StoreProvider there's no
    // channel context, so this stands in for it.
    useEdgeStats: () => currentEdgeStats,
  };
});

const { StatusBar } = await import("./StatusBar");
const { setCommandPaletteOpen } = await import("./paletteOpenState");
const { isLensPopoverOpen, isChipsPopoverOpen, setLensPopoverOpen, setChipsPopoverOpen } =
  await import("./statusBarOverlayState");

const ORIGINAL_INNER_WIDTH = window.innerWidth;

/** Sets `window.innerWidth` and fires a resize event — `useViewportWidth`
 *  (StatusBar.tsx) reads the property on mount and re-reads it on resize, so
 *  this exercises the exact same path a real browser resize would. */
function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
  fireEvent(window, new Event("resize"));
}

afterEach(() => {
  cleanup();
  setCommandPaletteOpen(false);
  setLensPopoverOpen(false);
  setChipsPopoverOpen(false);
  setViewportWidth(ORIGINAL_INNER_WIDTH);
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
    toggleMinimap: vi.fn(),
    toggleLegend: vi.fn(),
    toggleLabels: vi.fn(),
    hover: vi.fn(),
    setEdgeStats: vi.fn(),
  };
}

/** repo "acmerepo" → dir "lib" → file "lib/a.ts" → symbol "run", plus a
 *  second top-level file so counts are non-trivial. A distinct repoId (not a
 *  single letter) avoids colliding with any breadcrumb crumb's own label. */
function tinyModel(repoMeta: RepoMeta | null = null): ClientModel {
  const g: RawGraph = {
    nodes: [
      { id: "rs1:acmerepo:repo:.", labels: ["Repository"], props: { name: "acmerepo" } },
      { id: "rs1:acmerepo:dir:lib", labels: ["Directory"], props: { path: "lib" } },
      {
        id: "rs1:acmerepo:file:lib/a.ts",
        labels: ["File"],
        props: { name: "a.ts", path: "lib/a.ts" },
      },
      { id: "rs1:acmerepo:file:b.ts", labels: ["File"], props: { name: "b.ts", path: "b.ts" } },
      {
        id: "rs1:acmerepo:sym:lib/a.ts#run@0",
        labels: ["Function"],
        props: { name: "run", qualified_name: "a::run", file_path: "lib/a.ts", content_hash: "h" },
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
    repoMeta,
  };
  return fromWorker(result);
}

function makeStore(overrides: Partial<Store> = {}): { store: Store; actions: Actions } {
  const actions = mockActions();
  const state = { ...createInitialState(), ...overrides };
  const store = { ...state, ...actions, ...overrides } as Store;
  return { store, actions };
}

let restoreEl: HTMLButtonElement;
beforeEach(() => {
  restoreEl = document.createElement("button");
  document.body.appendChild(restoreEl);
  restoreEl.focus();
});

describe("StatusBar — retired-panel functionality mapping", () => {
  it("shows repo name and node/edge counts (HeaderBar's stats line)", () => {
    const model = tinyModel();
    const { store } = makeStore({ model });
    currentStore = store;
    render(<StatusBar />);
    expect(screen.getByTestId("statusbar-repo-name").textContent).toBe(model.repoId);
    expect(screen.getByText(`${model.counts.nodes} nodes · ${model.counts.edges} edges`)).toBeTruthy();
  });

  it("switching lens from the bar's popover dispatches setLens (LensSwitcher's replacement)", () => {
    const model = tinyModel();
    const { store, actions } = makeStore({ model });
    currentStore = store;
    render(<StatusBar />);

    fireEvent.click(screen.getByTitle("Switch lens"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Call graph" }));

    expect(actions.setLens).toHaveBeenCalledWith("calls");
  });
});

describe("StatusBar — staleness rendering", () => {
  it("renders 'graph @ <sha> · <age>' linked to the commit when repoMeta is present", () => {
    const now = Date.parse("2026-08-20T00:10:00Z");
    const model = tinyModel({
      commitSha: "abcdef1234567890",
      builtAt: "2026-08-20T00:00:00Z",
      repoUrl: "https://github.com/acme/repo",
      pagesUrl: null,
    });
    const { store } = makeStore({ model });
    currentStore = store;
    vi.setSystemTime(now);
    render(<StatusBar />);
    const link = screen.getByText(/graph @ abcdef1 ·/) as HTMLElement;
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/repo/commit/abcdef1234567890",
    );
    vi.useRealTimers();
  });

  it("renders nothing extra when repoMeta is absent (no commitSha to show)", () => {
    const model = tinyModel(null);
    const { store } = makeStore({ model });
    currentStore = store;
    render(<StatusBar />);
    expect(screen.queryByText(/graph @/)).toBeNull();
  });
});

describe("StatusBar — breadcrumb crumb clicks", () => {
  it("clicking an ancestor crumb reveals+selects it with collapseDeeper", () => {
    const model = tinyModel();
    const { store, actions } = makeStore({ model, selected: "rs1:acmerepo:sym:lib/a.ts#run@0" });
    currentStore = store;
    render(<StatusBar />);

    fireEvent.click(screen.getByTitle("lib"));

    expect(actions.revealAndSelect).toHaveBeenCalledWith("dir:acmerepo:lib", {
      fly: true,
      collapseDeeper: true,
    });
  });
});

describe("StatusBar — Esc stacking (palette > chips)", () => {
  it("does not dismiss a chip while the command palette is open", () => {
    const model = tinyModel();
    const { store, actions } = makeStore({ model, lens: "calls" });
    currentStore = store;
    render(<StatusBar />);
    setCommandPaletteOpen(true);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(actions.setLens).not.toHaveBeenCalled();
  });

  it("dismisses the topmost chip once the palette is closed", () => {
    const model = tinyModel();
    const { store, actions } = makeStore({ model, lens: "calls" });
    currentStore = store;
    render(<StatusBar />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(actions.setLens).toHaveBeenCalledWith("all");
  });

  it("defers to an active guided tour (tour owns Esc) instead of dismissing a chip", () => {
    const model = tinyModel();
    const { store, actions } = makeStore({ model, lens: "calls", tour: true });
    currentStore = store;
    render(<StatusBar />);
    // Mounting <TourController/> with tour:true applies its first stop, which
    // itself calls setLens once (tour stops set their own lens) — that's
    // unrelated to Escape. Baseline AFTER mount, then assert Escape adds no
    // FURTHER call (in particular not the chip-dismiss "all").
    const callsBeforeEscape = vi.mocked(actions.setLens).mock.calls.length;

    fireEvent.keyDown(window, { key: "Escape" });

    expect(vi.mocked(actions.setLens).mock.calls.length).toBe(callsBeforeEscape);
  });

  it("does nothing when no chip is active (lets the default collapse-level Esc run elsewhere)", () => {
    const model = tinyModel();
    const { store, actions } = makeStore({ model });
    currentStore = store;
    render(<StatusBar />);

    expect(() => fireEvent.keyDown(window, { key: "Escape" })).not.toThrow();
    for (const fn of Object.values(actions)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe("StatusBar — mode chips are a pure function of state (silent clears become visible)", () => {
  it("an impact chip present with impact set, absent once impact is cleared", () => {
    const model = tinyModel();
    const withImpact = makeStore({
      model,
      impact: { impacted: new Set(), coveringTests: new Set() } as never,
    });
    currentStore = withImpact.store;
    const view = render(<StatusBar />);
    expect(screen.getByText("Impact")).toBeTruthy();
    cleanup();

    const cleared = makeStore({ model, impact: null });
    currentStore = cleared.store;
    render(<StatusBar />);
    expect(screen.queryByText("Impact")).toBeNull();
    view.unmount();
  });
});

describe("StatusBar — Esc stacking: the lens popover wins over chip dismissal (fix round 1, #1)", () => {
  it("first Esc closes the popover and leaves the chip alive; second Esc dismisses the chip", () => {
    const model = tinyModel();
    const { store, actions } = makeStore({ model, lens: "calls" });
    currentStore = store;
    render(<StatusBar />);

    fireEvent.click(screen.getByTitle("Switch lens"));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(isLensPopoverOpen()).toBe(true);

    // First Esc: the popover is the newest overlay — it closes itself and
    // consumes the event. The chip (still "calls") must NOT be dismissed.
    // Fired on `document` (not `window`) — a real Escape keydown targets
    // whatever has focus, which bubbles through document before reaching
    // window; dispatching directly on `window` would skip the popover's
    // own (document-level) listener entirely and prove nothing.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(isLensPopoverOpen()).toBe(false);
    expect(actions.setLens).not.toHaveBeenCalled();

    // Second Esc: nothing is above the chip anymore — it gets dismissed.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(actions.setLens).toHaveBeenCalledWith("all");
  });

  it("outside-click also closes the popover (not just Escape) without touching the chip", () => {
    const model = tinyModel();
    const { store, actions } = makeStore({ model, lens: "calls" });
    currentStore = store;
    render(<StatusBar />);

    fireEvent.click(screen.getByTitle("Switch lens"));
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menu")).toBeNull();
    expect(actions.setLens).not.toHaveBeenCalled();
  });
});

describe("StatusBar — Esc stacking: the collapsed chips popover wins over dismissal too", () => {
  it("first Esc closes the 'N modes' popover and leaves chips alive; second Esc dismisses the topmost", () => {
    setViewportWidth(400); // below BP_COLLAPSE_CHIPS (480) — chips collapse to one pill
    const model = tinyModel();
    const { store, actions } = makeStore({ model, lens: "calls", coupling: true });
    currentStore = store;
    render(<StatusBar />);

    fireEvent.click(screen.getByTitle("2 active modes"));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(isChipsPopoverOpen()).toBe(true);

    // Fired on `document` for the same reason as the lens-popover test above.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(isChipsPopoverOpen()).toBe(false);
    expect(actions.setLens).not.toHaveBeenCalled();
    expect(actions.toggleCoupling).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    // "lens" is topmost (deriveModeChips orders lens before coupling).
    expect(actions.setLens).toHaveBeenCalledWith("all");
    expect(actions.toggleCoupling).not.toHaveBeenCalled();
  });
});

describe("StatusBar — responsive degradation (fix round 1, #2)", () => {
  it("controls stay reachable and the repo name is never dropped at 360px", () => {
    setViewportWidth(360);
    const model = tinyModel();
    const { store } = makeStore({ model, lens: "calls" });
    currentStore = store;
    render(<StatusBar />);

    expect(screen.getByTestId("statusbar-repo-name").textContent).toBe(model.repoId);
    // Every control is still present in the DOM (reachable — worst case via
    // the footer's own horizontal scroll), none of them removed for width.
    expect(screen.getByTitle("Switch lens")).toBeTruthy();
    expect(screen.getByTitle("Hide minimap")).toBeTruthy(); // default state has it shown
    expect(screen.getByTitle("Capture a PNG screenshot of the current view")).toBeTruthy();
    expect(screen.getByTitle("Frame all — refit the camera to what's currently on screen")).toBeTruthy();
  });

  it("hides the staleness label below 768px, keeping counts and repo name", () => {
    const model = tinyModel({
      commitSha: "abcdef1234567890",
      builtAt: "2020-01-01T00:00:00Z",
      repoUrl: "https://github.com/acme/repo",
      pagesUrl: null,
    });
    const { store } = makeStore({ model });
    currentStore = store;

    setViewportWidth(900);
    const view = render(<StatusBar />);
    expect(screen.getByText(/graph @ abcdef1/)).toBeTruthy();
    view.unmount();

    setViewportWidth(700);
    render(<StatusBar />);
    expect(screen.queryByText(/graph @ abcdef1/)).toBeNull();
    expect(screen.getByText(`${model.counts.nodes} nodes · ${model.counts.edges} edges`)).toBeTruthy();
    expect(screen.getByTestId("statusbar-repo-name")).toBeTruthy();
  });

  it("hides node/edge counts below 640px, keeping only the repo name on the left", () => {
    const model = tinyModel();
    const { store } = makeStore({ model });
    currentStore = store;

    setViewportWidth(600);
    render(<StatusBar />);
    expect(screen.queryByText(`${model.counts.nodes} nodes · ${model.counts.edges} edges`)).toBeNull();
    expect(screen.getByTestId("statusbar-repo-name").textContent).toBe(model.repoId);
  });

  it("collapses mode chips into one 'N modes' popover chip below 480px", () => {
    const model = tinyModel();
    const { store } = makeStore({ model, lens: "calls", coupling: true });
    currentStore = store;

    setViewportWidth(768);
    const wide = render(<StatusBar />);
    expect(screen.getByText("Lens: Call graph")).toBeTruthy();
    expect(screen.getByText("Coupling")).toBeTruthy();
    expect(screen.queryByTitle("2 active modes")).toBeNull();
    wide.unmount();

    setViewportWidth(400);
    render(<StatusBar />);
    expect(screen.getByTitle("2 active modes")).toBeTruthy();
    expect(screen.queryByText("Lens: Call graph")).toBeNull();
  });

  it("collapses the breadcrumb to a middle-ellipsis chain as the bar narrows, before the left section drops anything", () => {
    const model = tinyModel();
    const { store } = makeStore({ model, selected: "rs1:acmerepo:sym:lib/a.ts#run@0" });
    currentStore = store;

    // Wide: the full chain is visible, nothing collapsed.
    setViewportWidth(1280);
    const wide = render(<StatusBar />);
    expect(screen.queryByText("…")).toBeNull();
    expect(screen.getByTitle("lib")).toBeTruthy();
    wide.unmount();

    // Narrow enough to collapse the breadcrumb (>=768, so staleness/counts
    // are untouched — the breadcrumb gives ground FIRST).
    setViewportWidth(800);
    render(<StatusBar />);
    expect(screen.getByText("…")).toBeTruthy();
    expect(screen.getByText(`${model.counts.nodes} nodes · ${model.counts.edges} edges`)).toBeTruthy();
  });
});

