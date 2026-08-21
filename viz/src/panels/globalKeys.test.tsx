// @vitest-environment jsdom
//
// Global bindings (Astrolabe V3), and their agreement with the keymap the help
// overlay publishes.
//
// The concrete regression behind the '/' tests: V2's handler did
// `document.getElementById("reposkein-search")?.focus()`. When SearchPanel
// retired, that id stopped existing and '/' became a silent no-op — a dead
// shortcut still advertised in the status bar's key hints. Binding it to the
// palette through an env function is what makes that assertable.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createInitialState, type Actions, type State, type Store } from "../state/store";
import { buildModel } from "../data/model";
import { fromWorker, type ClientModel } from "../data/clientModel";
import type { WorkerResult } from "../data/worker/graph.worker";
import type { RawGraph } from "../data/types";
import { KEYMAP, documentedBindings } from "../data/keymap";
import { handleGlobalKey, type GlobalKeyEnv, type GlobalKeyEventLike } from "./globalKeys";

vi.mock("../scene/Screenshot", () => ({ captureScreenshot: vi.fn(), CaptureBridge: () => null }));

let currentStore: Store;
vi.mock("../state/store", async () => {
  const actual = await vi.importActual<typeof import("../state/store")>("../state/store");
  return { ...actual, useStore: () => currentStore, useStoreState: () => currentStore };
});

const { CommandPalette } = await import("./CommandPalette");
const { requestCommandPalette, setCommandPaletteOpen } = await import("./paletteOpenState");
const { resetLayers } = await import("./layerState");

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

function mockEnv(): GlobalKeyEnv & Record<keyof GlobalKeyEnv, ReturnType<typeof vi.fn>> {
  return {
    openPalette: vi.fn(),
    toggleLayer: vi.fn(),
    paletteOpen: vi.fn(() => false),
    // Default OFF-screen, so a hop flies unless a test says otherwise — the
    // same "unknown means fly" default the real env uses.
    isOnScreen: vi.fn(() => false),
  };
}

const SEL = "rs1:r:sym:a.ts#run@0";

function tinyModel(): ClientModel {
  const g: RawGraph = {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:file:a.ts", labels: ["File"], props: { name: "a.ts", path: "a.ts" } },
      {
        id: SEL,
        labels: ["Function"],
        props: { name: "run", file_path: "a.ts", content_hash: "h" },
      },
      {
        id: "rs1:r:sym:a.ts#other@0",
        labels: ["Function"],
        props: { name: "other", file_path: "a.ts", content_hash: "h" },
      },
    ],
    edges: [
      {
        type: "CALLS",
        from: SEL,
        to: "rs1:r:sym:a.ts#other@0",
        props: { resolution: "exact", confidence: 1 },
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
    repoRoot: null,
  };
  return fromWorker(result);
}

function stateWith(overrides: Partial<State> = {}): State {
  return { ...createInitialState(), ...overrides };
}

function key(k: string, extra: Partial<GlobalKeyEventLike> = {}): GlobalKeyEventLike {
  return { key: k, preventDefault: vi.fn(), ...extra };
}

describe("handleGlobalKey — '/' summons the palette", () => {
  it("calls openPalette and consumes the key", () => {
    const env = mockEnv();
    const e = key("/");
    expect(handleGlobalKey(e, stateWith(), mockActions(), env)).toBe(true);
    expect(env.openPalette).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it("works with no model loaded (search is reachable before the graph is)", () => {
    const env = mockEnv();
    handleGlobalKey(key("/"), stateWith({ model: null }), mockActions(), env);
    expect(env.openPalette).toHaveBeenCalledOnce();
  });

  it("does NOT fire while typing in a field", () => {
    const env = mockEnv();
    const e = key("/", { target: { tagName: "INPUT" } });
    expect(handleGlobalKey(e, stateWith(), mockActions(), env)).toBe(false);
    expect(env.openPalette).not.toHaveBeenCalled();
  });

  it("does NOT fire while the guided tour is running", () => {
    const env = mockEnv();
    handleGlobalKey(key("/"), stateWith({ tour: true }), mockActions(), env);
    expect(env.openPalette).not.toHaveBeenCalled();
  });
});

/** The palette is modal AND cannot consume the event itself (its Esc is a React
 *  handler on the dialog, so the synthetic event bubbles all the way to the
 *  window listener). Through V3 that meant Esc-to-close-the-palette also ran
 *  the global Esc step — then a collapse — so dismissing the palette silently
 *  rearranged the scene. */
describe("handleGlobalKey — nothing global fires behind an open palette", () => {
  it("declines every binding, Escape included", () => {
    const state = stateWith({ model: tinyModel(), selected: SEL });
    for (const k of ["Escape", "x", "X", "f", "m", "?", "/", "ArrowRight"]) {
      const actions = mockActions();
      const env = { ...mockEnv(), paletteOpen: vi.fn(() => true) };
      expect(handleGlobalKey(key(k), state, actions, env), `leaked: ${k}`).toBe(false);
      for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
      expect(env.openPalette).not.toHaveBeenCalled();
      expect(env.toggleLayer).not.toHaveBeenCalled();
    }
  });
});

describe("handleGlobalKey — layer shortcuts", () => {
  it("'?' toggles the help layer", () => {
    const env = mockEnv();
    expect(handleGlobalKey(key("?"), stateWith(), mockActions(), env)).toBe(true);
    expect(env.toggleLayer).toHaveBeenCalledExactlyOnceWith("help");
  });

  it("'m' and 'M' toggle the map layer", () => {
    for (const k of ["m", "M"]) {
      const env = mockEnv();
      expect(handleGlobalKey(key(k), stateWith(), mockActions(), env)).toBe(true);
      expect(env.toggleLayer).toHaveBeenCalledExactlyOnceWith("minimap");
    }
  });

  it("neither fires while typing", () => {
    const env = mockEnv();
    handleGlobalKey(key("m", { target: { tagName: "TEXTAREA" } }), stateWith(), mockActions(), env);
    handleGlobalKey(
      key("?", { target: { isContentEditable: true } }),
      stateWith(),
      mockActions(),
      env,
    );
    expect(env.toggleLayer).not.toHaveBeenCalled();
  });
});

describe("handleGlobalKey — the bindings V2 already had, preserved", () => {
  it("'f' frames the current view — and nothing else (V4 §6)", () => {
    const actions = mockActions();
    expect(handleGlobalKey(key("f"), stateWith(), actions, mockEnv())).toBe(true);
    expect(actions.requestFit).toHaveBeenCalledOnce();
    // It used to call resetView(), i.e. Clean slate: lens, filters, every
    // overlay and the whole expansion tree, from a key the keymap calls
    // "Frame all".
    expect(actions.resetView).not.toHaveBeenCalled();
    expect(actions.clearFilters).not.toHaveBeenCalled();
    expect(actions.setLens).not.toHaveBeenCalled();
  });

  it("'d' toggles idle drift, reading the current flag", () => {
    const off = mockActions();
    handleGlobalKey(key("d"), stateWith({ idleDrift: false }), off, mockEnv());
    expect(off.setIdleDrift).toHaveBeenCalledExactlyOnceWith(true);

    const on = mockActions();
    expect(handleGlobalKey(key("D"), stateWith({ idleDrift: true }), on, mockEnv())).toBe(true);
    expect(on.setIdleDrift).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("Esc DESELECTS — the last resort in the Esc stack (V4 §1: it never collapses)", () => {
    const actions = mockActions();
    const state = stateWith({ model: tinyModel(), selected: SEL });
    expect(handleGlobalKey(key("Escape"), state, actions, mockEnv())).toBe(true);
    expect(actions.select).toHaveBeenCalledExactlyOnceWith(null);
    // V3 called collapseLevel() here, which silently rearranged the scene at
    // the exact moment the reader was trying to back out of something.
    expect(actions.collapseBranch).not.toHaveBeenCalled();
    expect(actions.collapseToFileLevel).not.toHaveBeenCalled();
    expect(actions.resetView).not.toHaveBeenCalled();
  });

  it("Esc with nothing selected is a genuine no-op, NOT consumed", () => {
    const actions = mockActions();
    const state = stateWith({ model: tinyModel(), selected: null });
    expect(handleGlobalKey(key("Escape"), state, actions, mockEnv())).toBe(false);
    expect(actions.select).not.toHaveBeenCalled();
    expect(actions.collapseBranch).not.toHaveBeenCalled();
  });

  it("Esc is left alone while typing (the field's own handler owns it)", () => {
    const actions = mockActions();
    const e = key("Escape", { target: { tagName: "INPUT" } });
    expect(handleGlobalKey(e, stateWith({ selected: SEL }), actions, mockEnv())).toBe(false);
    expect(actions.select).not.toHaveBeenCalled();
  });

  it("arrows and Tab hop to a neighbor, forwards and backwards", () => {
    const model = tinyModel();
    for (const [k, extra] of [
      ["ArrowRight", {}],
      ["ArrowDown", {}],
      ["ArrowLeft", {}],
      ["ArrowUp", {}],
      ["Tab", {}],
      ["Tab", { shiftKey: true }],
    ] as const) {
      const actions = mockActions();
      handleGlobalKey(
        key(k, extra),
        stateWith({ model, selected: SEL }),
        actions,
        mockEnv(),
      );
      // The target, the hop memory to carry into the next press, and the fly
      // decision — which mockEnv's isOnScreen() answers "off screen" → true.
      expect(actions.hop).toHaveBeenCalledWith(
        "rs1:r:sym:a.ts#other@0",
        expect.objectContaining({ from: SEL, to: "rs1:r:sym:a.ts#other@0" }),
        true,
      );
      // The V3 path is gone: a hop is no longer an ordinary reveal.
      expect(actions.revealAndSelect).not.toHaveBeenCalled();
    }
  });

  /** FLY ONLY IF OFF SCREEN (V4 §5). V3 flew on every hop, which yanked the
   *  view around a cluster the reader could already see whole. */
  it("does NOT fly when the target is already on screen", () => {
    const actions = mockActions();
    const env = { ...mockEnv(), isOnScreen: vi.fn(() => true) };
    handleGlobalKey(
      key("ArrowRight"),
      stateWith({ model: tinyModel(), selected: SEL }),
      actions,
      env,
    );
    expect(env.isOnScreen).toHaveBeenCalledWith("rs1:r:sym:a.ts#other@0");
    expect(actions.hop).toHaveBeenCalledWith(
      "rs1:r:sym:a.ts#other@0",
      expect.anything(),
      false,
    );
  });

  it("threads the anchor memory: ArrowRight then ArrowLeft returns to the anchor", () => {
    const model = tinyModel();
    const OTHER = "rs1:r:sym:a.ts#other@0";

    const out = mockActions();
    handleGlobalKey(key("ArrowRight"), stateWith({ model, selected: SEL }), out, mockEnv());
    const memory = vi.mocked(out.hop).mock.calls[0]![1];
    expect(memory).toEqual({ from: SEL, to: OTHER, dir: "next" });

    // Now at OTHER, carrying that memory: the opposite arrow goes home.
    const back = mockActions();
    handleGlobalKey(
      key("ArrowLeft"),
      stateWith({ model, selected: OTHER, lastHop: memory }),
      back,
      mockEnv(),
    );
    expect(back.hop).toHaveBeenCalledWith(SEL, expect.anything(), true);
  });

  it("hopping needs both a model and a selection", () => {
    const actions = mockActions();
    handleGlobalKey(key("ArrowRight"), stateWith({ model: null }), actions, mockEnv());
    handleGlobalKey(
      key("ArrowRight"),
      stateWith({ model: tinyModel(), selected: null }),
      actions,
      mockEnv(),
    );
    expect(actions.hop).not.toHaveBeenCalled();
  });

  it("an unbound key is not consumed", () => {
    expect(handleGlobalKey(key("q"), stateWith(), mockActions(), mockEnv())).toBe(false);
  });
});

/** SCOPED COLLAPSE (V4 §2). LOD collapse is now a DELIBERATE key, not what Esc
 *  or a misclick happens to do. */
describe("handleGlobalKey — x / ⇧x collapse", () => {
  it("'x' collapses the selected branch", () => {
    const actions = mockActions();
    const e = key("x");
    expect(handleGlobalKey(e, stateWith(), actions, mockEnv())).toBe(true);
    expect(actions.collapseBranch).toHaveBeenCalledOnce();
    expect(actions.collapseToFileLevel).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it("'X' (shifted) collapses to file level globally", () => {
    const actions = mockActions();
    expect(handleGlobalKey(key("X"), stateWith(), actions, mockEnv())).toBe(true);
    expect(actions.collapseToFileLevel).toHaveBeenCalledOnce();
    expect(actions.collapseBranch).not.toHaveBeenCalled();
  });

  it("'x' with shiftKey set also means file level (never both)", () => {
    const actions = mockActions();
    handleGlobalKey(key("x", { shiftKey: true }), stateWith(), actions, mockEnv());
    expect(actions.collapseToFileLevel).toHaveBeenCalledOnce();
    expect(actions.collapseBranch).not.toHaveBeenCalled();
  });

  it("neither fires while typing", () => {
    const actions = mockActions();
    handleGlobalKey(key("x", { target: { tagName: "INPUT" } }), stateWith(), actions, mockEnv());
    handleGlobalKey(key("X", { target: { tagName: "INPUT" } }), stateWith(), actions, mockEnv());
    expect(actions.collapseBranch).not.toHaveBeenCalled();
    expect(actions.collapseToFileLevel).not.toHaveBeenCalled();
  });
});

/** VIEW HISTORY (V4 §4). The keys delegate; the stack itself is covered by
 *  `state/viewHistory.test.ts` and its wiring by `viewHistoryWiring.test.tsx`. */
describe("handleGlobalKey — [ and ] walk view history", () => {
  it("'[' steps back and ']' steps forward", () => {
    const back = mockActions();
    vi.mocked(back.historyBack).mockReturnValue(true);
    expect(handleGlobalKey(key("["), stateWith(), back, mockEnv())).toBe(true);
    expect(back.historyBack).toHaveBeenCalledOnce();
    expect(back.historyForward).not.toHaveBeenCalled();

    const fwd = mockActions();
    vi.mocked(fwd.historyForward).mockReturnValue(true);
    expect(handleGlobalKey(key("]"), stateWith(), fwd, mockEnv())).toBe(true);
    expect(fwd.historyForward).toHaveBeenCalledOnce();
  });

  it("leaves the key UNCONSUMED at either end of the stack", () => {
    // historyBack/-Forward default to returning false in mockActions().
    const actions = mockActions();
    expect(handleGlobalKey(key("["), stateWith(), actions, mockEnv())).toBe(false);
    expect(handleGlobalKey(key("]"), stateWith(), actions, mockEnv())).toBe(false);
  });

  it("neither fires while typing (a '[' in the palette's query is a '[')", () => {
    const actions = mockActions();
    handleGlobalKey(key("[", { target: { tagName: "INPUT" } }), stateWith(), actions, mockEnv());
    handleGlobalKey(key("]", { target: { tagName: "INPUT" } }), stateWith(), actions, mockEnv());
    expect(actions.historyBack).not.toHaveBeenCalled();
    expect(actions.historyForward).not.toHaveBeenCalled();
  });

  it("needs no model and no selection — history predates both", () => {
    const actions = mockActions();
    vi.mocked(actions.historyBack).mockReturnValue(true);
    expect(
      handleGlobalKey(key("["), stateWith({ model: null, selected: null }), actions, mockEnv()),
    ).toBe(true);
  });
});

/** The help overlay is only useful if it describes the app that exists. */
describe("keymap ↔ handler agreement", () => {
  it("every global binding the keymap documents is actually handled", () => {
    for (const binding of documentedBindings()) {
      if (binding === "k") continue; // ⌘K lives in CommandPalette's own listener
      if (binding === "Escape") continue; // asserted above; also owned by the Esc stack
      const actions = mockActions();
      // `[` / `]` report whether they moved; give them a non-empty stack so
      // "documented" is tested, not "history happens to be empty".
      vi.mocked(actions.historyBack).mockReturnValue(true);
      vi.mocked(actions.historyForward).mockReturnValue(true);
      const env = mockEnv();
      const handled = handleGlobalKey(
        key(binding),
        stateWith({ model: tinyModel(), selected: SEL }),
        actions,
        env,
      );
      expect(handled, `documented but unhandled: ${binding}`).toBe(true);
    }
  });

  it("documents every binding V3 and V4 introduced or rewired", () => {
    const documented = documentedBindings();
    for (const b of ["/", "?", "m", "f", "d", "x", "X", "[", "]"])
      expect(documented.has(b)).toBe(true);
  });

  it("the keymap has no empty group and no binding without a description", () => {
    expect(KEYMAP.length).toBeGreaterThan(0);
    for (const group of KEYMAP) {
      expect(group.bindings.length).toBeGreaterThan(0);
      for (const b of group.bindings) {
        expect(b.keys.length).toBeGreaterThan(0);
        expect(b.description.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("requestCommandPalette — the '/' rendezvous with the mounted palette", () => {
  it("opens the palette, and the input takes focus", () => {
    currentStore = { ...createInitialState(), ...mockActions(), model: tinyModel() } as Store;
    render(<CommandPalette />);
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => requestCommandPalette());

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
  });

  it("is a safe no-op before the palette mounts (and after it unmounts)", () => {
    expect(() => requestCommandPalette()).not.toThrow();

    currentStore = { ...createInitialState(), ...mockActions(), model: tinyModel() } as Store;
    const view = render(<CommandPalette />);
    view.unmount();
    expect(() => requestCommandPalette()).not.toThrow();
  });

  it("the palette absorbed search: Esc closes it again", () => {
    currentStore = { ...createInitialState(), ...mockActions(), model: tinyModel() } as Store;
    render(<CommandPalette />);
    act(() => requestCommandPalette());
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
