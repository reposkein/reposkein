// @vitest-environment jsdom
//
// Cinematic mode, end to end (Astrolabe V3 §3).
//
// V2 could not have this: TourController rendered INSIDE the status bar's right
// region, so fading the bar would have faded the tour's own caption with it. V3
// splits the component in two — `TourLaunchButton` stays in the bar (and fades),
// `TourController` is the caption + transport, mounted by Root outside the fade
// group. These tests pin that split and the layer cleanup that goes with it.
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

const { TourController, TourLaunchButton } = await import("./TourController");
const { StatusBar } = await import("./StatusBar");
const { LayerHost } = await import("./LayerHost");
const { ChromeGroup } = await import("./ChromeGroup");
const { openLayer, resetLayers, showLayer } = await import("./layerState");

afterEach(() => {
  cleanup();
  resetLayers();
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

/** Needs enough structure for `buildTour` to produce stops. */
function tourableModel(): ClientModel {
  const nodes: RawGraph["nodes"] = [
    { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
  ];
  const edges: RawGraph["edges"] = [];
  for (const dir of ["core", "util"]) {
    nodes.push({ id: `rs1:r:dir:${dir}`, labels: ["Directory"], props: { path: dir } });
    for (let i = 0; i < 3; i++) {
      const path = `${dir}/f${i}.ts`;
      nodes.push({ id: `rs1:r:file:${path}`, labels: ["File"], props: { name: `f${i}.ts`, path } });
      nodes.push({
        id: `rs1:r:sym:${path}#fn${i}@0`,
        labels: ["Function"],
        props: { name: `fn${dir}${i}`, file_path: path, content_hash: "h" },
      });
    }
  }
  for (let i = 0; i < 3; i++) {
    edges.push({
      type: "CALLS",
      from: `rs1:r:sym:util/f${i}.ts#fn${i}@0`,
      to: "rs1:r:sym:core/f0.ts#fn0@0",
      props: { resolution: "exact", confidence: 1 },
    });
  }
  const g: RawGraph = { nodes, edges };
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

describe("TourLaunchButton lives in the bar; the overlay does not", () => {
  it("the bar shows the launch pill when not touring", () => {
    currentStore = makeStore({ model: tourableModel() }).store;
    render(<StatusBar />);
    expect(screen.getByText("▶ Tour")).toBeTruthy();
    // …and the caption/transport are NOT inside the bar (they'd fade with it).
    expect(screen.queryByTestId("tour-caption")).toBeNull();
    expect(screen.queryByTestId("tour-transport")).toBeNull();
  });

  it("the launch pill starts the tour", () => {
    const { store, actions } = makeStore({ model: tourableModel() });
    currentStore = store;
    render(<TourLaunchButton />);
    fireEvent.click(screen.getByText("▶ Tour"));
    expect(actions.startTour).toHaveBeenCalledOnce();
  });

  it("the launch pill disappears while touring (nothing to launch)", () => {
    currentStore = makeStore({ model: tourableModel(), tour: true }).store;
    const { container } = render(<TourLaunchButton />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing without a model (no stops to tour)", () => {
    currentStore = makeStore({ model: null }).store;
    const { container } = render(<TourLaunchButton />);
    expect(container.firstChild).toBeNull();
  });
});

describe("the tour overlay renders only the caption and the transport", () => {
  it("mounts caption + transport while active, nothing while inactive", () => {
    currentStore = makeStore({ model: tourableModel(), tour: false }).store;
    const idle = render(<TourController />);
    expect(idle.container.firstChild).toBeNull();
    cleanup();

    currentStore = makeStore({ model: tourableModel(), tour: true }).store;
    render(<TourController />);
    expect(screen.getByTestId("tour-caption")).toBeTruthy();
    expect(screen.getByTestId("tour-transport")).toBeTruthy();
    expect(screen.getByText(/Guided tour · stop 1 \//)).toBeTruthy();
  });

  it("the transport stays clickable — it is the one live control in cinematic mode", () => {
    const { store, actions } = makeStore({ model: tourableModel(), tour: true });
    currentStore = store;
    render(<TourController />);
    expect(screen.getByTestId("tour-transport").className).toContain("pointer-events-auto");
    fireEvent.click(screen.getByText("✕ Exit"));
    expect(actions.exitTour).toHaveBeenCalledOnce();
  });

  it("Prev is disabled on the first stop and Next advances", () => {
    currentStore = makeStore({ model: tourableModel(), tour: true }).store;
    render(<TourController />);
    expect((screen.getByText("⟨ Prev") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText("Next ⟩"));
    expect(screen.getByText(/Guided tour · stop 2 \//)).toBeTruthy();
    expect((screen.getByText("⟨ Prev") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("entering the tour clears any summoned layer", () => {
  it("an open legend is put away when the tour starts", () => {
    // Inactive first, so the mount effect sees the false→true transition.
    const inactive = makeStore({ model: tourableModel(), tour: false });
    currentStore = inactive.store;
    const view = render(<TourController />);
    act(() => showLayer("legend"));
    expect(openLayer()).toBe("legend");

    currentStore = makeStore({ model: tourableModel(), tour: true }).store;
    act(() => view.rerender(<TourController />));

    expect(openLayer()).toBeNull();
  });
});

describe("the fade group is what actually hides the chrome", () => {
  it("chrome inside the group goes invisible and unclickable while touring", () => {
    const { store } = makeStore({ model: tourableModel(), tour: true });
    currentStore = store;
    render(
      <>
        <ChromeGroup hidden={store.tour}>
          <StatusBar />
          <LayerHost />
        </ChromeGroup>
        <TourController />
      </>,
    );

    const group = screen.getByTestId("chrome-group");
    expect(group.className).toContain("opacity-0");
    expect(group.className).toContain("pointer-events-none");
    // The status bar is inside the (now invisible) group. `hidden: true` is
    // required to find it at all — which is itself the assertion that
    // `aria-hidden` took the whole group out of the accessibility tree.
    expect(screen.queryByRole("contentinfo")).toBeNull();
    const bar = screen.getByRole("contentinfo", { hidden: true });
    expect(group.contains(bar)).toBe(true);
    // …while the caption and transport are outside it.
    expect(group.contains(screen.getByTestId("tour-caption"))).toBe(false);
    expect(group.contains(screen.getByTestId("tour-transport"))).toBe(false);
  });

  it("exiting the tour brings the chrome straight back", () => {
    const touring = makeStore({ model: tourableModel(), tour: true });
    currentStore = touring.store;
    const view = render(
      <ChromeGroup hidden={touring.store.tour}>
        <StatusBar />
      </ChromeGroup>,
    );
    expect(screen.getByTestId("chrome-group").className).toContain("opacity-0");

    const after = makeStore({ model: tourableModel(), tour: false });
    currentStore = after.store;
    view.rerender(
      <ChromeGroup hidden={after.store.tour}>
        <StatusBar />
      </ChromeGroup>,
    );
    expect(screen.getByTestId("chrome-group").className).toContain("opacity-100");
    expect(screen.getByRole("contentinfo")).toBeTruthy();
  });
});
