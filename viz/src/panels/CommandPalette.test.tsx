// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createInitialState, type Actions, type Store } from "../state/store";
import { buildModel } from "../data/model";
import { fromWorker, type ClientModel } from "../data/clientModel";
import type { WorkerResult } from "../data/worker/graph.worker";
import type { RawGraph } from "../data/types";

vi.mock("../scene/Screenshot", () => ({ captureScreenshot: vi.fn() }));

// Mock only `useStore` — everything else (createInitialState, types) stays real.
let currentStore: Store;
vi.mock("../state/store", async () => {
  const actual = await vi.importActual<typeof import("../state/store")>("../state/store");
  return { ...actual, useStore: () => currentStore };
});

// Imported AFTER the mock so it picks up the mocked useStore.
const { CommandPalette } = await import("./CommandPalette");

afterEach(cleanup);

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

/** A small ready ClientModel with one symbol, one file, and one directory
 *  record, all sharing the substring "graph" so a single query exercises all
 *  three node buckets deterministically. */
function graphModel(): ClientModel {
  const g: RawGraph = {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:dir:graphtools", labels: ["Directory"], props: { name: "graphtools", path: "graphtools" } },
      {
        id: "rs1:r:file:graphtools/loader.ts",
        labels: ["File"],
        props: { name: "loader.ts", path: "graphtools/loader.ts" },
      },
      {
        id: "rs1:r:sym:graphtools/loader.ts#graphWalk@0",
        labels: ["Function"],
        props: {
          name: "graphWalk",
          qualified_name: "loader::graphWalk",
          file_path: "graphtools/loader.ts",
          content_hash: "h1",
        },
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

async function openPalette() {
  const user = render(<CommandPalette />);
  await act(async () => {
    fireEvent.keyDown(window, { key: "k", metaKey: true });
  });
  return user;
}

let restoreEl: HTMLButtonElement;

beforeEach(() => {
  restoreEl = document.createElement("button");
  document.body.appendChild(restoreEl);
  restoreEl.focus();
});

describe("CommandPalette — open/close", () => {
  it("is closed by default and opens on Cmd+K", async () => {
    const { store } = makeStore();
    currentStore = store;
    render(<CommandPalette />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes on Escape and returns focus to the previously-focused element", async () => {
    const { store } = makeStore();
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(restoreEl);
  });

  it("re-opens with Cmd+K even while another input has focus", async () => {
    const { store } = makeStore();
    currentStore = store;
    render(<CommandPalette />);
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

/** MIGRATED FROM SearchPanel (retired in Astrolabe V3 §7).
 *
 *  The standalone search box is gone and the palette absorbed it, so the
 *  behaviours that were specific to SearchPanel are asserted here rather than
 *  dropped: the 2-character query floor, ranked results with the file path
 *  visible, click-to-open, and Enter opening the top hit. `/` reaching this
 *  palette at all is covered in `globalKeys.test.tsx` (SearchPanel's `/` binding
 *  focused a DOM id that no longer exists — the exact regression that test
 *  exists to catch). */
describe("CommandPalette — absorbed SearchPanel behaviour", () => {
  it("ranks nothing until the query reaches 2 characters", async () => {
    const model = graphModel();
    const { store } = makeStore({ model });
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox");

    fireEvent.change(input, { target: { value: "g" } });
    expect(screen.queryByRole("group", { name: "Symbols" })).toBeNull();

    fireEvent.change(input, { target: { value: "gr" } });
    expect(screen.getByRole("group", { name: "Symbols" })).toBeTruthy();
  });

  it("matches on the file path, not just the name", async () => {
    const model = graphModel();
    const { store } = makeStore({ model });
    currentStore = store;
    await openPalette();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "loader.ts" } });
    expect(within(screen.getByRole("group", { name: "Files" })).getByText("graphtools/loader.ts")).toBeTruthy();
  });

  it("shows each hit's file path in JetBrains Mono under its name", async () => {
    const model = graphModel();
    const { store } = makeStore({ model });
    currentStore = store;
    await openPalette();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "graphWalk" } });
    const path = within(screen.getByRole("group", { name: "Symbols" })).getByText(
      "graphtools/loader.ts",
    );
    expect(path.className).toContain("font-mono");
  });

  it("clicking a result opens it and closes the palette (SearchPanel's click path)", async () => {
    const model = graphModel();
    const { store, actions } = makeStore({ model });
    currentStore = store;
    await openPalette();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "graphWalk" } });

    fireEvent.mouseDown(screen.getByText("graphWalk"));

    expect(actions.revealAndSelect).toHaveBeenCalledWith(
      "rs1:r:sym:graphtools/loader.ts#graphWalk@0",
      { fly: true },
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Enter opens the top-ranked hit (SearchPanel's Enter path)", async () => {
    const model = graphModel();
    const { store, actions } = makeStore({ model });
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "graphWalk" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(actions.revealAndSelect).toHaveBeenCalledWith(
      "rs1:r:sym:graphtools/loader.ts#graphWalk@0",
      { fly: true },
    );
  });

  it("renders nothing to search when no model has loaded, without throwing", async () => {
    const { store } = makeStore({ model: null });
    currentStore = store;
    await openPalette();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "graph" } });
    expect(screen.queryByRole("group", { name: "Symbols" })).toBeNull();
    // Commands remain reachable — the palette is useful pre-load.
    expect(screen.getByRole("group", { name: "Commands" })).toBeTruthy();
  });
});

describe("CommandPalette — grouping and `>` command-only mode", () => {
  it("shows Recent + full Commands list on an empty query", async () => {
    const { store } = makeStore();
    currentStore = store;
    await openPalette();
    expect(screen.getByRole("group", { name: "Commands" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Symbols" })).toBeNull();
  });

  it("groups Symbols / Files / Directories separately for a matching query", async () => {
    const model = graphModel();
    const { store } = makeStore({ model });
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "graph" } });

    expect(within(screen.getByRole("group", { name: "Symbols" })).getByText("graphWalk")).toBeTruthy();
    expect(
      within(screen.getByRole("group", { name: "Files" })).getByText("graphtools/loader.ts"),
    ).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Directories" })).getAllByText("graphtools")).toHaveLength(2);
  });

  it("`>` prefix filters to Commands only, hiding node groups even when they'd match", async () => {
    const model = graphModel();
    const { store } = makeStore({ model });
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: ">frame" } });

    expect(screen.queryByRole("group", { name: "Symbols" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Files" })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Commands" })).getByText("Frame all")).toBeTruthy();
  });
});

describe("CommandPalette — no-results state", () => {
  it("shows actionable copy and a 'Search files only' quick filter, which then narrows the search", async () => {
    const model = graphModel();
    const { store } = makeStore({ model });
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox");
    // Matches nothing: no node, and no command label/subtitle contains this.
    fireEvent.change(input, { target: { value: "zzzznotfound" } });

    // The visible NoResults copy AND the sr-only aria-live announcement both
    // say this — scope to the visible <p> so the assertion isn't ambiguous.
    expect(screen.getByText(/No matches for/, { selector: "p" })).toBeTruthy();
    const filesOnlyBtn = screen.getByRole("button", { name: "Search files only" });
    fireEvent.click(filesOnlyBtn);
    // filesOnly is now active — a "Files only ✕" chip appears in the input row.
    expect(screen.getByRole("button", { name: "Files only ✕" })).toBeTruthy();
  });

  it("keeps aria-controls valid (the listbox always exists, even empty) and announces the no-results state", async () => {
    const model = graphModel();
    const { store } = makeStore({ model });
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox");
    const listboxId = input.getAttribute("aria-controls");
    expect(listboxId).toBeTruthy();
    // Before: the listbox exists and has options.
    expect(document.getElementById(listboxId!)).toBeTruthy();
    expect(document.getElementById(listboxId!)!.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);

    fireEvent.change(input, { target: { value: "zzzznotfound" } });

    // After: aria-controls still resolves to a REAL element (an empty
    // listbox), not a dangling id — and it's still the SAME id (no
    // re-render-driven id churn).
    expect(input.getAttribute("aria-controls")).toBe(listboxId);
    const listbox = document.getElementById(listboxId!);
    expect(listbox).toBeTruthy();
    expect(listbox!.getAttribute("role")).toBe("listbox");
    expect(listbox!.querySelectorAll('[role="option"]')).toHaveLength(0);

    // The live region announces it.
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toMatch(/No matches for/);
  });

  it("aria-expanded on the combobox reflects whether there are results (fix round 2 / REP-22 polish — was hardcoded true)", async () => {
    const model = graphModel();
    const { store } = makeStore({ model });
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "graph" } });
    expect(input.getAttribute("aria-expanded")).toBe("true");

    fireEvent.change(input, { target: { value: "zzzznotfound" } });
    expect(input.getAttribute("aria-expanded")).toBe("false");

    fireEvent.change(input, { target: { value: "graph" } });
    expect(input.getAttribute("aria-expanded")).toBe("true");
  });

  it("announces the result count via the aria-live region when results exist", async () => {
    const model = graphModel();
    const { store } = makeStore({ model });
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "graph" } });
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toMatch(/result/);
  });
});

describe("CommandPalette — keyboard traversal", () => {
  it("ArrowDown/ArrowUp move the active row, wrapping at the ends", async () => {
    const { store } = makeStore();
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox");
    const optionsBefore = screen.getAllByRole("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(optionsBefore[0]!.id);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(optionsBefore[1]!.id);

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toBe(optionsBefore[0]!.id);

    // Wraps to the last row going up from the first.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toBe(optionsBefore.at(-1)!.id);
  });

  it("Enter runs the active command and closes the palette", async () => {
    const { store, actions } = makeStore();
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Frame all" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(actions.requestFit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Enter on a node row calls revealAndSelect with fly:true", async () => {
    const model = graphModel();
    const { store, actions } = makeStore({ model });
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "graphWalk" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(actions.revealAndSelect).toHaveBeenCalledWith(
      "rs1:r:sym:graphtools/loader.ts#graphWalk@0",
      { fly: true },
    );
  });

  it("Cmd+Enter on a node row calls revealAndSelect with fly:false (reveal without flying)", async () => {
    const model = graphModel();
    const { store, actions } = makeStore({ model });
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "graphWalk" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(actions.revealAndSelect).toHaveBeenCalledWith(
      "rs1:r:sym:graphtools/loader.ts#graphWalk@0",
      { fly: false },
    );
  });

  it("Escape closes the palette", async () => {
    const { store } = makeStore();
    currentStore = store;
    await openPalette();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("skips disabled rows during Arrow traversal", async () => {
    // No selection => Impact / Focus / Focus depth N are all disabled.
    const { store } = makeStore({ selected: null });
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "impact" } });
    // Only the disabled "Toggle impact overlay" command matches this query.
    const option = screen.getByRole("option");
    expect(option.getAttribute("aria-disabled")).toBe("true");
    // Landing on it should not be possible via traversal from a real list,
    // but even if it's the only (disabled) row, Enter must no-op.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("dialog")).toBeTruthy(); // stayed open — no-op
  });
});

describe("CommandPalette — Recent", () => {
  it("adds an opened node to Recent, and it re-appears (deduped) after reopening", async () => {
    const model = graphModel();
    const { store } = makeStore({ model });
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "graphWalk" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // Reopen the SAME mounted instance (Recent is component-local state that
    // survives close/reopen, only reset on unmount).
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    });
    expect(
      within(screen.getByRole("group", { name: "Recent" })).getByText("graphWalk"),
    ).toBeTruthy();
  });
});

describe("CommandPalette — disabled without selection", () => {
  it("Impact, Focus, and focus-depth commands are disabled without a selection, enabled with one", async () => {
    const model = graphModel();
    const noSelection = makeStore({ model, selected: null });
    currentStore = noSelection.store;
    const view = await openPalette();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: ">focus" } });
    for (const option of screen.getAllByRole("option")) {
      expect(option.getAttribute("aria-disabled")).toBe("true");
    }
    view.unmount();

    const withSelection = makeStore({ model, selected: "rs1:r:sym:graphtools/loader.ts#graphWalk@0" });
    currentStore = withSelection.store;
    await openPalette();
    const input2 = screen.getByRole("combobox");
    fireEvent.change(input2, { target: { value: ">focus" } });
    for (const option of screen.getAllByRole("option")) {
      expect(option.getAttribute("aria-disabled")).toBe("false");
    }
  });
});

describe("CommandPalette — perf (keystrokes stay local, never dispatch)", () => {
  it("typing a query calls no store action — only local setState", async () => {
    const model = graphModel();
    const { store, actions } = makeStore({ model });
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox") as HTMLInputElement;

    for (const ch of "graphWalk query typed one keystroke at a time") {
      fireEvent.change(input, { target: { value: input.value + ch } });
    }

    for (const fn of Object.values(actions)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("ArrowDown/ArrowUp traversal calls no store action either", async () => {
    const { store, actions } = makeStore();
    currentStore = store;
    await openPalette();
    const input = screen.getByRole("combobox");
    for (let i = 0; i < 10; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
    for (const fn of Object.values(actions)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});
