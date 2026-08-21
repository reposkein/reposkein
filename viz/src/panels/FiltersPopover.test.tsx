// @vitest-environment jsdom
//
// The filters layer's BEHAVIOUR (its colors are covered by
// `colorIdentity.test.tsx`). Everything FilterHUD could do must still be
// reachable — the audit for V3 §7 is "nothing lost", not "nothing left".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createInitialState, type Actions, type Store } from "../state/store";
import { EDGE_TYPE_META, SYMBOL_KIND_META } from "../scene/encoding";

let currentStore: Store;
vi.mock("../state/store", async () => {
  const actual = await vi.importActual<typeof import("../state/store")>("../state/store");
  return { ...actual, useStore: () => currentStore, useStoreState: () => currentStore };
});

const { FiltersPopover } = await import("./FiltersPopover");
const { resetLayers } = await import("./layerState");

afterEach(() => {
  cleanup();
  resetLayers();
});

function mockActions(): Actions {
  return {
    toggleExpand: vi.fn(),
    collapseLevel: vi.fn(),
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

function makeStore(overrides: Partial<Store> = {}): { store: Store; actions: Actions } {
  const actions = mockActions();
  const store = { ...createInitialState(), ...actions, ...overrides } as Store;
  return { store, actions };
}

describe("FiltersPopover — every FilterHUD control still reachable", () => {
  it("kind chips toggle the HIDDEN set (lit = visible)", () => {
    const { store, actions } = makeStore();
    currentStore = store;
    render(<FiltersPopover />);

    const chip = screen.getByTestId("filter-chip-node-Function");
    expect(chip.getAttribute("aria-pressed")).toBe("true"); // nothing hidden yet
    fireEvent.click(chip);
    expect(actions.setKindFilter).toHaveBeenCalledWith("function", true);
  });

  it("un-hides a kind that is currently hidden", () => {
    const { store, actions } = makeStore({
      filters: { kinds: new Set(["class"]), edgeTypes: new Set(), minConfidence: 0 },
    });
    currentStore = store;
    render(<FiltersPopover />);

    const chip = screen.getByTestId("filter-chip-node-Class");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    expect(actions.setKindFilter).toHaveBeenCalledWith("class", false);
  });

  it("uses the LOWER-CASE filter key the scene compares against", () => {
    // scene/StarField.tsx does `filters.kinds.has(symbolKind.toLowerCase())`.
    const { store, actions } = makeStore();
    currentStore = store;
    render(<FiltersPopover />);
    for (const meta of SYMBOL_KIND_META) {
      fireEvent.click(screen.getByTestId(`filter-chip-node-${meta.kind}`));
      expect(actions.setKindFilter).toHaveBeenCalledWith(meta.kind.toLowerCase(), true);
      expect(meta.filterKey).toBe(meta.kind.toLowerCase());
    }
  });

  it("edge chips toggle each of the five relationship types", () => {
    const { store, actions } = makeStore();
    currentStore = store;
    render(<FiltersPopover />);
    for (const meta of EDGE_TYPE_META) {
      fireEvent.click(screen.getByTestId(`filter-chip-edge-${meta.type}`));
      expect(actions.setEdgeTypeFilter).toHaveBeenCalledWith(meta.type, true);
    }
  });

  it("both audit presets toggle on and back off", () => {
    const off = makeStore({ audit: "off" });
    currentStore = off.store;
    render(<FiltersPopover />);
    fireEvent.click(screen.getByText("Guessed only"));
    expect(off.actions.setAudit).toHaveBeenCalledWith("ambiguous");
    fireEvent.click(screen.getByText("+ name matches"));
    expect(off.actions.setAudit).toHaveBeenCalledWith("ambiguous+name");
    cleanup();

    const on = makeStore({ audit: "ambiguous" });
    currentStore = on.store;
    render(<FiltersPopover />);
    fireEvent.click(screen.getByText("Guessed only"));
    expect(on.actions.setAudit).toHaveBeenCalledWith("off");
  });

  it("the confidence slider dispatches setMinConfidence", () => {
    const { store, actions } = makeStore();
    currentStore = store;
    render(<FiltersPopover />);
    fireEvent.change(screen.getByLabelText("Minimum edge confidence"), {
      target: { value: "0.5" },
    });
    expect(actions.setMinConfidence).toHaveBeenCalledWith(0.5);
  });

  it("the bundling slider dispatches setBundleBeta", () => {
    const { store, actions } = makeStore();
    currentStore = store;
    render(<FiltersPopover />);
    fireEvent.change(screen.getByLabelText("Edge bundling strength"), {
      target: { value: "0" },
    });
    expect(actions.setBundleBeta).toHaveBeenCalledWith(0);
  });

  it("the coupling overlay toggles, and reports 'no data' when git history is empty", () => {
    const { store, actions } = makeStore();
    currentStore = store;
    render(<FiltersPopover />);
    fireEvent.click(screen.getByText("Show co-change links"));
    expect(actions.toggleCoupling).toHaveBeenCalledOnce();
    cleanup();

    currentStore = makeStore({ coupling: true, cochange: null }).store;
    render(<FiltersPopover />);
    expect(screen.getByText("Reading git history…")).toBeTruthy();
    cleanup();

    currentStore = makeStore({ coupling: true, cochange: {} }).store;
    render(<FiltersPopover />);
    expect(screen.getByText(/No co-change data/)).toBeTruthy();
  });

  it("Reset appears only when something is filtered, and clears everything", () => {
    currentStore = makeStore().store;
    render(<FiltersPopover />);
    expect(screen.queryByText("Reset every filter")).toBeNull();
    cleanup();

    const filtered = makeStore({
      filters: { kinds: new Set(["enum"]), edgeTypes: new Set(), minConfidence: 0 },
    });
    currentStore = filtered.store;
    render(<FiltersPopover />);
    fireEvent.click(screen.getByText("Reset every filter"));
    expect(filtered.actions.clearFilters).toHaveBeenCalledOnce();
  });
});

describe("FiltersPopover — plain-language labels (V3 §2)", () => {
  it("says what each control does to the picture, not just its variable name", () => {
    currentStore = makeStore({ audit: "ambiguous" }).store;
    render(<FiltersPopover />);

    // FilterHUD's shouty labels are gone…
    expect(screen.queryByText("CONFIDENCE AUDIT")).toBeNull();
    expect(screen.queryByText(/MIN CONFIDENCE/)).toBeNull();
    expect(screen.queryByText(/EDGE BUNDLING:/)).toBeNull();
    expect(screen.queryByText("NODE KIND")).toBeNull();

    // …replaced by sentences.
    expect(screen.getByText("Confidence audit — highlight low-confidence edges")).toBeTruthy();
    expect(screen.getByText("Edge bundling")).toBeTruthy();
    expect(screen.getByText("Minimum confidence")).toBeTruthy();
    expect(screen.getByText(/Shows only the connections the resolver had to guess at/)).toBeTruthy();
    expect(screen.getByText(/threads hug the folder hierarchy/)).toBeTruthy();
  });

  it("shows the live numeric value of each slider in mono (V3 §8)", () => {
    currentStore = makeStore({ bundleBeta: 0.4 }).store;
    render(<FiltersPopover />);
    const value = screen.getByText("0.40");
    expect(value.className).toContain("font-mono");
  });
});
