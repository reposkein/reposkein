// @vitest-environment jsdom
//
// Regression test for REP-13 fix-round #3: TourController's capture-phase Esc
// handler used to always stopImmediatePropagation + exitTour, which meant an
// Esc pressed while the command palette was open (mid-tour) exited the TOUR
// instead of closing the palette — the newest overlay must win Esc, not the
// oldest. Both components read/write the small `paletteOpenState` singleton
// that makes this possible without lifting palette open/close into the
// reducer (see that module's docstring for why).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createInitialState, type Actions, type Store } from "../state/store";
import { buildModel } from "../data/model";
import { fromWorker, type ClientModel } from "../data/clientModel";
import type { WorkerResult } from "../data/worker/graph.worker";
import type { RawGraph } from "../data/types";

vi.mock("../scene/Screenshot", () => ({ captureScreenshot: vi.fn() }));

let currentStore: Store;
vi.mock("../state/store", async () => {
  const actual = await vi.importActual<typeof import("../state/store")>("../state/store");
  return { ...actual, useStore: () => currentStore };
});

const { CommandPalette } = await import("./CommandPalette");
const { TourController } = await import("./TourController");

afterEach(cleanup);

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

function tinyModel(): ClientModel {
  const g: RawGraph = {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:file:a.ts", labels: ["File"], props: { name: "a.ts", path: "a.ts" } },
      {
        id: "rs1:r:sym:a.ts#run@0",
        labels: ["Function"],
        props: { name: "run", qualified_name: "a::run", file_path: "a.ts", content_hash: "h" },
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

describe("Esc stacking: command palette over an active guided tour", () => {
  it("first Esc closes the palette and leaves the tour active; second Esc exits the tour", async () => {
    const model = tinyModel();
    const { store, actions } = makeStore({ model, tour: true });
    currentStore = store;

    render(
      <>
        <TourController />
        <CommandPalette />
      </>,
    );

    // Open the palette (Cmd+K) while the tour is active.
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    });
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Esc while the palette's input is focused: TourController's window
    // capture-phase listener must step aside (isCommandPaletteOpen() true),
    // letting the SAME event reach the palette's own Escape handling.
    const input = screen.getByRole("combobox");
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull(); // palette closed
    expect(actions.exitTour).not.toHaveBeenCalled(); // tour untouched

    // Second Esc: palette is gone, so TourController's listener now acts.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(actions.exitTour).toHaveBeenCalledOnce();
  });

  it("Esc exits the tour immediately when the palette was never opened", () => {
    const model = tinyModel();
    const { store, actions } = makeStore({ model, tour: true });
    currentStore = store;

    render(
      <>
        <TourController />
        <CommandPalette />
      </>,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(actions.exitTour).toHaveBeenCalledOnce();
  });
});
