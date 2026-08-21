// @vitest-environment jsdom
//
// The Inspector (Astrolabe V3 §1). Covers the four things the retired
// DetailPanel got wrong or couldn't do:
//
//  1. It was permanently mounted and rendered a "Click a star to inspect it"
//     placeholder card over the scene at all times. The drawer must not exist
//     without a selection (V3 §4: the inspector empty state never renders).
//  2. Its edges table was mouse-only — the sort affordance was an onClick on a
//     bare <th>, the rows were onClick <tr>s, neither focusable. A keyboard user
//     could see every neighbour and reach none of them.
//  3. Sorting had no announced state (no aria-sort).
//  4. Impact / Focus had to dispatch the SAME store actions their command-palette
//     twins do, so the two entry points can't drift.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createInitialState, type Actions, type Store } from "../state/store";
import { buildModel } from "../data/model";
import { fromWorker, type ClientModel } from "../data/clientModel";
import type { WorkerResult } from "../data/worker/graph.worker";
import type { RawGraph } from "../data/types";
import { buildCommandRegistry } from "../state/commands";

// The source peek fetches a slice; keep it out of the way (and assert the
// static-mode degrade separately).
vi.mock("../data/api", async () => {
  const actual = await vi.importActual<typeof import("../data/api")>("../data/api");
  return { ...actual, fetchSource: vi.fn(async () => null) };
});

let currentStore: Store;
vi.mock("../state/store", async () => {
  const actual = await vi.importActual<typeof import("../state/store")>("../state/store");
  return { ...actual, useStore: () => currentStore, useStoreState: () => currentStore };
});

const { Inspector } = await import("./Inspector");

afterEach(cleanup);

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

const SEL = "rs1:r:sym:a.ts#run@0";

/** `run` calls `alpha` and `beta`, and is called by `zeta` — three incident
 *  edges with distinct types/resolutions/confidences so sorting is observable.
 *  Neighbour names are deliberately NOT in edge order, so a sort actually
 *  reorders rows. */
function tinyModel(): ClientModel {
  const g: RawGraph = {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:file:a.ts", labels: ["File"], props: { name: "a.ts", path: "a.ts" } },
      {
        id: SEL,
        labels: ["Function"],
        props: {
          name: "run",
          qualified_name: "a::run",
          file_path: "a.ts",
          start_line: 3,
          end_line: 9,
          content_hash: "h1",
          semantic_summary: "Runs the `thing`.\n\nSecond paragraph.",
          summary_of_hash: "h0",
        },
      },
      {
        id: "rs1:r:sym:a.ts#zeta@0",
        labels: ["Function"],
        props: { name: "zeta", file_path: "a.ts", content_hash: "h" },
      },
      {
        id: "rs1:r:sym:a.ts#alpha@0",
        labels: ["Class"],
        props: { name: "alpha", file_path: "a.ts", content_hash: "h" },
      },
      {
        id: "rs1:r:sym:a.ts#beta@0",
        labels: ["Function"],
        props: { name: "beta", file_path: "a.ts", content_hash: "h" },
      },
    ],
    edges: [
      {
        type: "CALLS",
        from: SEL,
        to: "rs1:r:sym:a.ts#beta@0",
        props: { resolution: "exact", confidence: 1 },
      },
      {
        type: "INSTANTIATES",
        from: SEL,
        to: "rs1:r:sym:a.ts#alpha@0",
        props: { resolution: "ambiguous", confidence: 0.3 },
      },
      {
        type: "CALLS",
        from: "rs1:r:sym:a.ts#zeta@0",
        to: SEL,
        props: { resolution: "name_match", confidence: 0.6 },
      },
    ],
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
    repoRoot: "/abs/repo",
  };
  return fromWorker(result);
}

function makeStore(overrides: Partial<Store> = {}): { store: Store; actions: Actions } {
  const actions = mockActions();
  const store = { ...createInitialState(), ...actions, ...overrides } as Store;
  return { store, actions };
}

function neighborOrder(): string[] {
  return screen
    .getAllByTestId("inspector-edge-row")
    .map((row) => row.children[2]!.textContent ?? "");
}

describe("Inspector — mounts only on a selection (no empty state)", () => {
  it("renders nothing with no selection", () => {
    currentStore = makeStore({ model: tinyModel(), selected: null }).store;
    const { container } = render(<Inspector />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("inspector")).toBeNull();
    // In particular: no placeholder prompt (DetailPanel's permanent card).
    expect(screen.queryByText(/click a star/i)).toBeNull();
  });

  it("renders nothing before the model is ready", () => {
    currentStore = makeStore({ model: null, selected: SEL }).store;
    const { container } = render(<Inspector />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the selected id isn't in the graph", () => {
    currentStore = makeStore({ model: tinyModel(), selected: "rs1:r:sym:ghost@0" }).store;
    const { container } = render(<Inspector />);
    expect(container.firstChild).toBeNull();
  });
});

describe("Inspector — identity + overview", () => {
  it("shows name, kind badge, path with line range, and the confidence badge", () => {
    currentStore = makeStore({ model: tinyModel(), selected: SEL }).store;
    render(<Inspector />);

    expect(screen.getByTestId("inspector-name").textContent).toBe("run");
    expect(screen.getByTestId("inspector-kind-badge").textContent).toBe("Function");
    expect(screen.getByTestId("inspector-path").textContent).toBe("a.ts:3-9");
    // The ambiguous 0.3-confidence edge makes this node low-confidence.
    expect(screen.getByTestId("inspector-confidence").textContent).toBe("30% confidence");
  });

  it("paths and counts are JetBrains Mono (V3 §8)", () => {
    currentStore = makeStore({ model: tinyModel(), selected: SEL }).store;
    render(<Inspector />);
    expect(screen.getByTestId("inspector-path").className).toContain("font-mono");
  });

  it("lists the overview facts, including the connection count", () => {
    currentStore = makeStore({ model: tinyModel(), selected: SEL }).store;
    render(<Inspector />);
    expect(screen.getByText("a::run")).toBeTruthy();
    expect(screen.getByText("3–9")).toBeTruthy();
    expect(screen.getByText("Connections")).toBeTruthy();
  });

  it("renders the summary with inline code and flags it stale on a hash mismatch", () => {
    currentStore = makeStore({ model: tinyModel(), selected: SEL }).store;
    render(<Inspector />);
    expect(screen.getByTestId("inspector-stale")).toBeTruthy();
    expect(screen.getByText("thing").tagName).toBe("CODE");
    expect(screen.getByText(/Second paragraph/)).toBeTruthy();
  });

  it("the header ✕ clears the selection (which unmounts the drawer)", () => {
    const { store, actions } = makeStore({ model: tinyModel(), selected: SEL });
    currentStore = store;
    render(<Inspector />);
    fireEvent.click(screen.getByLabelText("Close inspector"));
    expect(actions.select).toHaveBeenCalledWith(null);
  });
});

describe("Inspector — incident edges table: sorting", () => {
  it("lists every incident edge, in or out", () => {
    currentStore = makeStore({ model: tinyModel(), selected: SEL }).store;
    render(<Inspector />);
    expect(screen.getAllByTestId("inspector-edge-row")).toHaveLength(3);
    expect(screen.getByText("Incident edges (3)")).toBeTruthy();
  });

  it("clicking a column header sorts, and re-clicking reverses", () => {
    currentStore = makeStore({ model: tinyModel(), selected: SEL }).store;
    render(<Inspector />);

    fireEvent.click(screen.getByTestId("inspector-sort-neighbor"));
    const asc = neighborOrder();
    expect(asc).toEqual([...asc].sort());

    fireEvent.click(screen.getByTestId("inspector-sort-neighbor"));
    expect(neighborOrder()).toEqual([...asc].reverse());
  });

  it("sorts by confidence, monotonically, and reverses on a second click", () => {
    currentStore = makeStore({ model: tinyModel(), selected: SEL }).store;
    render(<Inspector />);
    const values = () =>
      screen
        .getAllByTestId("inspector-edge-row")
        .map((row) => Number(row.children[4]!.textContent));

    fireEvent.click(screen.getByTestId("inspector-sort-confidence"));
    const first = values();
    // TanStack sorts a numeric column descending-first; assert monotonic rather
    // than a fixed direction, so the assertion is about ORDER not about which
    // way the library happens to start.
    const sortedDesc = [...first].sort((a, b) => b - a);
    expect(first).toEqual(sortedDesc);

    fireEvent.click(screen.getByTestId("inspector-sort-confidence"));
    expect(values()).toEqual([...first].reverse());
  });

  it("announces the sort direction with aria-sort (DetailPanel had none)", () => {
    currentStore = makeStore({ model: tinyModel(), selected: SEL }).store;
    render(<Inspector />);
    const header = () => screen.getByTestId("inspector-sort-type").closest("th")!;

    expect(header().getAttribute("aria-sort")).toBe("none");
    fireEvent.click(screen.getByTestId("inspector-sort-type"));
    expect(header().getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(screen.getByTestId("inspector-sort-type"));
    expect(header().getAttribute("aria-sort")).toBe("descending");
  });

  it("the sort affordance is a real button, so it is keyboard-reachable", () => {
    currentStore = makeStore({ model: tinyModel(), selected: SEL }).store;
    render(<Inspector />);
    const btn = screen.getByTestId("inspector-sort-neighbor");
    expect(btn.tagName).toBe("BUTTON");
    btn.focus();
    expect(document.activeElement).toBe(btn);
  });
});

describe("Inspector — incident edges table: keyboard navigation", () => {
  it("uses a roving tabindex: exactly one row is in the tab order", () => {
    currentStore = makeStore({ model: tinyModel(), selected: SEL }).store;
    render(<Inspector />);
    const rows = screen.getAllByTestId("inspector-edge-row");
    expect(rows.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(rows[0]!.getAttribute("tabindex")).toBe("0");
  });

  it("ArrowDown / ArrowUp move the roving focus", () => {
    currentStore = makeStore({ model: tinyModel(), selected: SEL }).store;
    render(<Inspector />);
    const rows = () => screen.getAllByTestId("inspector-edge-row");

    rows()[0]!.focus();
    fireEvent.keyDown(rows()[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows()[1]!.getAttribute("tabindex")).toBe("0");
    expect(rows()[0]!.getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(rows()[1]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows()[0]);
  });

  it("Home / End jump to the first and last row, and the ends don't wrap", () => {
    currentStore = makeStore({ model: tinyModel(), selected: SEL }).store;
    render(<Inspector />);
    const rows = () => screen.getAllByTestId("inspector-edge-row");
    const last = rows().length - 1;

    rows()[0]!.focus();
    fireEvent.keyDown(rows()[0]!, { key: "End" });
    expect(document.activeElement).toBe(rows()[last]);

    fireEvent.keyDown(rows()[last]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows()[last]); // clamped, not wrapped

    fireEvent.keyDown(rows()[last]!, { key: "Home" });
    expect(document.activeElement).toBe(rows()[0]);
    fireEvent.keyDown(rows()[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows()[0]);
  });

  it("Enter and Space open the neighbour — the same transition a click makes", () => {
    const { store, actions } = makeStore({ model: tinyModel(), selected: SEL });
    currentStore = store;
    render(<Inspector />);
    const rows = screen.getAllByTestId("inspector-edge-row");

    fireEvent.keyDown(rows[0]!, { key: "Enter" });
    expect(actions.revealAndSelect).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(rows[0]!, { key: " " });
    expect(actions.revealAndSelect).toHaveBeenCalledTimes(2);

    fireEvent.click(rows[0]!);
    expect(actions.revealAndSelect).toHaveBeenCalledTimes(3);
    // Every call targets a neighbour id and flies to it.
    for (const call of vi.mocked(actions.revealAndSelect).mock.calls) {
      expect(call[0]).not.toBe(SEL);
      expect(call[1]).toEqual({ fly: true });
    }
  });

  it("each row carries an accessible label naming the neighbour and the edge", () => {
    currentStore = makeStore({ model: tinyModel(), selected: SEL }).store;
    render(<Inspector />);
    const labels = screen
      .getAllByTestId("inspector-edge-row")
      .map((r) => r.getAttribute("aria-label") ?? "");
    expect(labels.some((l) => /to beta, CALLS, exact, confidence 1\.00/.test(l))).toBe(true);
    expect(labels.some((l) => /from zeta, CALLS, name_match/.test(l))).toBe(true);
  });

  it("says so plainly when nothing is incident", () => {
    const model = tinyModel();
    currentStore = makeStore({ model, selected: "rs1:r:file:a.ts" }).store;
    render(<Inspector />);
    expect(screen.getByText("No relationship edges touch this node.")).toBeTruthy();
  });
});

describe("Inspector — action row mirrors the palette commands", () => {
  it("Impact dispatches toggleImpact, exactly as the palette's command does", () => {
    const { store, actions } = makeStore({ model: tinyModel(), selected: SEL });
    currentStore = store;
    render(<Inspector />);

    fireEvent.click(screen.getByTestId("inspector-impact"));
    expect(actions.toggleImpact).toHaveBeenCalledOnce();

    // The palette command reaches the same action — one code path, two doors.
    const paletteActions = mockActions();
    buildCommandRegistry()
      .find((c) => c.id === "impact")!
      .run(paletteActions, store, { screenshot: vi.fn(), copyLink: vi.fn(), toggleLayer: vi.fn() });
    expect(paletteActions.toggleImpact).toHaveBeenCalledOnce();
  });

  it("Focus dispatches toggleFocus, exactly as the palette's command does", () => {
    const { store, actions } = makeStore({ model: tinyModel(), selected: SEL });
    currentStore = store;
    render(<Inspector />);

    fireEvent.click(screen.getByTestId("inspector-focus"));
    expect(actions.toggleFocus).toHaveBeenCalledOnce();

    const paletteActions = mockActions();
    buildCommandRegistry()
      .find((c) => c.id === "focus")!
      .run(paletteActions, store, { screenshot: vi.fn(), copyLink: vi.fn(), toggleLayer: vi.fn() });
    expect(paletteActions.toggleFocus).toHaveBeenCalledOnce();
  });

  it("depth 1-3 dispatch setFocusDepth and mark the active one pressed", () => {
    const { store, actions } = makeStore({ model: tinyModel(), selected: SEL, focusDepth: 2 });
    currentStore = store;
    render(<Inspector />);

    expect(screen.getByTestId("inspector-depth-2").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("inspector-depth-1").getAttribute("aria-pressed")).toBe("false");

    for (const d of [1, 2, 3]) {
      fireEvent.click(screen.getByTestId(`inspector-depth-${d}`));
      expect(actions.setFocusDepth).toHaveBeenCalledWith(d);
    }
  });

  it("reflects live overlay state: pressed buttons plus impact/focus counts", () => {
    const { store } = makeStore({
      model: tinyModel(),
      selected: SEL,
      impact: { impacted: new Set(["a", "b"]), coveringTests: new Set(["t"]) } as never,
      focus: { nodes: new Set(["a", "b", "c"]) } as never,
    });
    currentStore = store;
    render(<Inspector />);

    expect(screen.getByTestId("inspector-impact").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("inspector-focus").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("● 2 impacted")).toBeTruthy();
    expect(screen.getByText("● 1 covering test")).toBeTruthy();
    expect(screen.getByText("3 nodes")).toBeTruthy();
  });
});

describe("Inspector — opaque, not blurred (V3 §6)", () => {
  it("the drawer has no backdrop blur (it can stay open for minutes)", () => {
    currentStore = makeStore({ model: tinyModel(), selected: SEL }).store;
    render(<Inspector />);
    expect(screen.getByTestId("inspector").className).not.toMatch(/backdrop-blur/);
  });
});
