// @vitest-environment jsdom
//
// The V3 chrome states: the help overlay's full keymap, the loader's phase +
// progress fraction, the error screen's Retry, and cinematic mode.
//
// Each replaces something V2 shipped as a stub or a dead end:
//   - help was five lines of JSX inside the status bar;
//   - the loader showed a raw worker phase with no sense of how far along it was,
//     so a slow force layout read as a hang;
//   - the error state was centered text with `pointerEvents: "none"` — literally
//     unactionable, not even selectable to copy;
//   - "cinematic mode" could not exist, because TourController rendered INSIDE
//     the status bar, so fading the bar would have faded the caption.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createInitialState, type Actions, type Store } from "../state/store";
import { KEYMAP } from "../data/keymap";
import { LOAD_TOTAL_STEPS, loadProgress } from "../data/loadPhase";

vi.mock("../scene/Screenshot", () => ({ captureScreenshot: vi.fn(), CaptureBridge: () => null }));
vi.mock("../scene/Controls", () => ({
  getCameraTarget: () => null,
  getCameraView: () => null,
  recenterCamera: vi.fn(),
}));

let currentStore: Store;
vi.mock("../state/store", async () => {
  const actual = await vi.importActual<typeof import("../state/store")>("../state/store");
  return { ...actual, useStore: () => currentStore, useStoreState: () => currentStore };
});

const { HelpOverlay } = await import("./HelpOverlay");
const { LoadingScreen } = await import("./LoadingScreen");
const { ErrorScreen } = await import("./ErrorScreen");
const { ChromeGroup } = await import("./ChromeGroup");
const { LayerShell } = await import("./LayerShell");
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

function makeStore(overrides: Partial<Store> = {}): { store: Store; actions: Actions } {
  const actions = mockActions();
  const store = { ...createInitialState(), ...actions, ...overrides } as Store;
  return { store, actions };
}

describe("HelpOverlay — the full keymap, not a stub", () => {
  it("renders every group and every binding from data/keymap.ts", () => {
    currentStore = makeStore().store;
    render(<HelpOverlay />);
    for (const group of KEYMAP) {
      expect(screen.getByText(group.title)).toBeTruthy();
      for (const b of group.bindings) {
        expect(screen.getAllByText(b.description).length).toBeGreaterThan(0);
        for (const k of b.keys) expect(screen.getAllByText(k).length).toBeGreaterThan(0);
      }
    }
  });

  it("is substantially more than V2's five lines", () => {
    currentStore = makeStore().store;
    render(<HelpOverlay />);
    const total = KEYMAP.reduce((n, g) => n + g.bindings.length, 0);
    expect(total).toBeGreaterThan(10);
    expect(screen.getAllByRole("definition")).toHaveLength(total);
  });

  it("renders keys inside <kbd> and is a labelled dialog", () => {
    currentStore = makeStore().store;
    render(<HelpOverlay />);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Keyboard & pointer");
    expect(screen.getAllByText("⌘K")[0]!.tagName).toBe("KBD");
  });
});

describe("LoadingScreen — phase plus progress fraction", () => {
  it("shows the phase and its step out of the pipeline total", () => {
    currentStore = makeStore({ status: { kind: "loading", phase: "fetching graph" } }).store;
    render(<LoadingScreen />);
    expect(screen.getByTestId("loading-phase").textContent).toContain("fetching graph");
    expect(screen.getByTestId("loading-fraction").textContent).toBe(
      `step ${loadProgress("fetching graph").step} of ${LOAD_TOTAL_STEPS}`,
    );
  });

  it("fills exactly `step` segments", () => {
    for (const phase of ["fetching manifest", "parsing", "charting the sky"]) {
      cleanup();
      currentStore = makeStore({ status: { kind: "loading", phase } }).store;
      render(<LoadingScreen />);
      const filled = Array.from({ length: LOAD_TOTAL_STEPS }, (_, i) =>
        screen.getByTestId(`loading-segment-${i + 1}`).getAttribute("data-filled"),
      ).filter((v) => v === "true").length;
      expect(filled).toBe(loadProgress(phase).step);
    }
  });

  it("exposes progress on a progressbar role", () => {
    currentStore = makeStore({ status: { kind: "loading", phase: "parsing" } }).store;
    render(<LoadingScreen />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuemax")).toBe(String(LOAD_TOTAL_STEPS));
    expect(bar.getAttribute("aria-valuenow")).toBe(String(loadProgress("parsing").step));
    expect(bar.getAttribute("aria-valuetext")).toBe("parsing");
  });

  it("goes indeterminate — label but no count — for an unknown phase", () => {
    currentStore = makeStore({ status: { kind: "loading", phase: "doing something new" } }).store;
    render(<LoadingScreen />);
    expect(screen.getByTestId("loading-phase").textContent).toContain("doing something new");
    expect(screen.queryByTestId("loading-fraction")).toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
  });

  it("stays mounted for the fade after ready, then unmounts", () => {
    vi.useFakeTimers();
    currentStore = makeStore({ status: { kind: "ready" } }).store;
    render(<LoadingScreen />);
    // First render is still mounted (the fade-out has to have something to fade).
    expect(screen.getByTestId("loading-screen")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.queryByTestId("loading-screen")).toBeNull();
    vi.useRealTimers();
  });
});

describe("ErrorScreen — actionable, with Retry", () => {
  it("shows the message and re-triggers the load through retryLoad", () => {
    const { store, actions } = makeStore();
    currentStore = store;
    render(<ErrorScreen message="failed to fetch nodes.jsonl" />);

    expect(screen.getByTestId("error-message").textContent).toBe("failed to fetch nodes.jsonl");
    fireEvent.click(screen.getByTestId("error-retry"));
    expect(actions.retryLoad).toHaveBeenCalledOnce();
  });

  it("is an alert and is INTERACTIVE (V2's overlay had pointer-events: none)", () => {
    currentStore = makeStore().store;
    render(<ErrorScreen message="boom" />);
    const root = screen.getByTestId("error-screen");
    expect(root.getAttribute("role")).toBe("alert");
    expect(root.className).toContain("pointer-events-auto");
    expect(root.className).not.toMatch(/pointer-events-none/);
  });

  /** Fix round 2 / REP-22 polish: this surface used to carry
   *  `backdrop-blur-sm`, violating the "blur only on transient surfaces"
   *  rule (V3 §6) — an error screen persists for as long as the underlying
   *  failure does, which is the opposite of transient. It should now be a
   *  flat, opaque navy instead. */
  it("is opaque, not blurred — it can persist indefinitely, unlike a summoned layer", () => {
    currentStore = makeStore().store;
    render(<ErrorScreen message="boom" />);
    const root = screen.getByTestId("error-screen");
    expect(root.className).not.toMatch(/backdrop-blur/);
  });

  it("Retry can be pressed more than once (a transient failure may recur)", () => {
    const { store, actions } = makeStore();
    currentStore = store;
    render(<ErrorScreen message="boom" />);
    fireEvent.click(screen.getByTestId("error-retry"));
    fireEvent.click(screen.getByTestId("error-retry"));
    expect(actions.retryLoad).toHaveBeenCalledTimes(2);
  });

  it("the reducer's retryLoad returns to loading and bumps the loader nonce", async () => {
    const { reducer } = await vi.importActual<typeof import("../state/store")>("../state/store");
    const before = createInitialState();
    const errored = reducer(before, { t: "error", message: "boom" });
    expect(errored.status).toEqual({ kind: "error", message: "boom" });

    const retried = reducer(errored, { t: "retryLoad" });
    expect(retried.status).toEqual({ kind: "loading", phase: "starting" });
    expect(retried.loadNonce).toBe(errored.loadNonce + 1);
  });
});

/** NOTE ON WHAT IS ASSERTABLE HERE. jsdom 30 does not implement `inert` at all —
 *  no IDL property, no focus blocking (probed, not assumed). So these tests
 *  assert that the correct MECHANISM is applied (the `inert` attribute present
 *  exactly while hidden, and `aria-hidden` deliberately absent), which is a real
 *  improvement over the class-string assertions they replace, but the behavioural
 *  half — a faded button genuinely refusing focus and clicks — is left to the
 *  browser gate. Asserting focus here would only be asserting jsdom's gap. */
describe("Cinematic mode — the tour fades all chrome but its own transport", () => {
  it("makes the group inert while touring, not merely transparent", () => {
    render(
      <ChromeGroup hidden>
        <button type="button">status bar thing</button>
      </ChromeGroup>,
    );
    const group = screen.getByTestId("chrome-group");
    expect(group.getAttribute("data-hidden")).toBe("true");
    expect(group.className).toContain("opacity-0");

    // The real fix (round 1, I2): opacity alone leaves faded chrome clickable
    // and Tab-focusable, and the children's own `pointer-events-auto` overrides
    // anything the wrapper sets — so the wrapper cannot switch interactivity off
    // on their behalf. `inert` removes pointer events, focusability and
    // a11y-tree presence together.
    expect(group.hasAttribute("inert")).toBe(true);
  });

  it("aria-hidden is NOT used to hide focusable chrome (that would be an ARIA violation)", () => {
    render(
      <ChromeGroup hidden>
        <button type="button">status bar thing</button>
      </ChromeGroup>,
    );
    // `inert` already removes the subtree from the a11y tree; pairing it with
    // aria-hidden over focusable controls is the anti-pattern it replaces.
    expect(screen.getByTestId("chrome-group").hasAttribute("aria-hidden")).toBe(false);
  });

  it("drops inert on exit, so the chrome is interactive again", () => {
    const { rerender } = render(
      <ChromeGroup hidden>
        <button type="button">status bar thing</button>
      </ChromeGroup>,
    );
    expect(screen.getByTestId("chrome-group").hasAttribute("inert")).toBe(true);

    rerender(
      <ChromeGroup hidden={false}>
        <button type="button">status bar thing</button>
      </ChromeGroup>,
    );
    const group = screen.getByTestId("chrome-group");
    expect(group.className).toContain("opacity-100");
    // React 19 treats `inert` as a boolean prop: false must omit the attribute
    // entirely, not render `inert="false"` (which would still be inert).
    expect(group.hasAttribute("inert")).toBe(false);
  });

  it("spans the viewport, so fading cannot shift its fixed children", () => {
    render(
      <ChromeGroup hidden={false}>
        <span />
      </ChromeGroup>,
    );
    // `opacity < 1` makes this element a containing block for fixed
    // descendants; a wrapper smaller than the viewport would move them.
    expect(screen.getByTestId("chrome-group").className).toMatch(/fixed/);
    expect(screen.getByTestId("chrome-group").className).toMatch(/inset-0/);
  });

  it("respects prefers-reduced-motion by dropping the transition", () => {
    render(
      <ChromeGroup hidden={false}>
        <span />
      </ChromeGroup>,
    );
    expect(screen.getByTestId("chrome-group").className).toContain("motion-reduce:transition-none");
  });
});

describe("Blur discipline (V3 §6)", () => {
  it("a transient layer MAY blur its backdrop", () => {
    currentStore = makeStore().store;
    render(
      <LayerShell id="legend" title="Legend" dock="right" width="w-56">
        <span />
      </LayerShell>,
    );
    expect(screen.getByTestId("layer-legend").className).toMatch(/backdrop-blur/);
  });

  it("layer motion is gated on motion-safe, so reduced-motion gets no animation", () => {
    currentStore = makeStore().store;
    render(
      <LayerShell id="help" title="Help" dock="right" width="w-56">
        <span />
      </LayerShell>,
    );
    expect(screen.getByTestId("layer-help").className).toContain("motion-safe:animate-");
  });
});
