// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import {
  StoreProvider,
  useActions,
  useEdgeStats,
  useHovered,
  useStoreState,
} from "./store";

// The provider spins up the layout worker on mount; jsdom has no Worker and the
// test doesn't need a graph — the render-isolation contract holds in any status.
vi.mock("../data/worker/graph.worker.ts?worker", () => ({
  default: class {
    onmessage: unknown = null;
    onerror: unknown = null;
    postMessage() {}
    terminate() {}
  },
}));

afterEach(cleanup);

/** Counts how many times a component rendered. */
function useRenderCount(): { current: number } {
  const ref = useRef(0);
  ref.current += 1;
  return ref;
}

describe("store context split", () => {
  it("re-renders scene consumers for hover, and chrome for neither hover nor edgeStats", () => {
    // Render counters, read after each act().
    const counts = { chrome: 0, actor: 0, hover: 0, stats: 0 };
    let actions: ReturnType<typeof useActions> | null = null;

    /** Stands in for the HUD: reads reducer state only. */
    function Chrome() {
      const state = useStoreState();
      counts.chrome = useRenderCount().current;
      return <span data-testid="chrome">{state.status.kind}</span>;
    }
    /** Stands in for a button: dispatches, reads nothing. */
    function Actor() {
      actions = useActions();
      counts.actor = useRenderCount().current;
      return null;
    }
    /** Stands in for StarField / EdgeLines / Labels. */
    function HoverConsumer() {
      const hovered = useHovered();
      counts.hover = useRenderCount().current;
      return <span data-testid="hovered">{hovered ?? "-"}</span>;
    }
    /** Stands in for the HeaderBar's "showing N of M" readout. */
    function StatsConsumer() {
      const { drawn, total } = useEdgeStats();
      counts.stats = useRenderCount().current;
      return <span data-testid="stats">{`${drawn}/${total}`}</span>;
    }

    function Tree({ children }: { children?: ReactNode }) {
      return (
        <StoreProvider>
          <Chrome />
          <Actor />
          <HoverConsumer />
          <StatsConsumer />
          {children}
        </StoreProvider>
      );
    }

    const view = render(<Tree />);
    const baseline = { ...counts };
    expect(baseline.chrome).toBeGreaterThan(0);

    // 1. A hover (pointer rate) must reach the scene and NOTHING else.
    act(() => actions!.hover("rs1:r:sym:a.ts#a1"));
    expect(view.getByTestId("hovered").textContent).toBe("rs1:r:sym:a.ts#a1");
    expect(counts.hover).toBe(baseline.hover + 1);
    expect(counts.chrome).toBe(baseline.chrome);
    expect(counts.actor).toBe(baseline.actor);
    expect(counts.stats).toBe(baseline.stats);

    // 2. An edgeStats republish (per render pass) reaches only its readout.
    const afterHover = { ...counts };
    act(() => actions!.setEdgeStats({ drawn: 12, total: 40 }));
    expect(view.getByTestId("stats").textContent).toBe("12/40");
    expect(counts.stats).toBe(afterHover.stats + 1);
    expect(counts.chrome).toBe(afterHover.chrome);
    expect(counts.hover).toBe(afterHover.hover);

    // 3. Equal values are not changes — no re-render for either channel.
    const afterStats = { ...counts };
    act(() => {
      actions!.hover("rs1:r:sym:a.ts#a1");
      actions!.setEdgeStats({ drawn: 12, total: 40 });
    });
    expect(counts.hover).toBe(afterStats.hover);
    expect(counts.stats).toBe(afterStats.stats);

    // 4. A real reducer transition re-renders state consumers — and only those:
    //    the dispatch-only component holds a stable actions object.
    act(() => actions!.setIdleDrift(true));
    expect(counts.chrome).toBe(afterStats.chrome + 1);
    expect(counts.actor).toBe(afterStats.actor);
    expect(counts.hover).toBe(afterStats.hover);
    expect(counts.stats).toBe(afterStats.stats);
  });

  it("gives each provider its own channels (no cross-mount leakage)", () => {
    let first: ReturnType<typeof useActions> | null = null;
    let second: ReturnType<typeof useActions> | null = null;

    function Probe({ slot }: { slot: "a" | "b" }) {
      const actions = useActions();
      if (slot === "a") first = actions;
      else second = actions;
      const hovered = useHovered();
      return <span data-testid={`hovered-${slot}`}>{hovered ?? "-"}</span>;
    }

    const view = render(
      <>
        <StoreProvider>
          <Probe slot="a" />
        </StoreProvider>
        <StoreProvider>
          <Probe slot="b" />
        </StoreProvider>
      </>,
    );

    act(() => first!.hover("only-a"));
    expect(view.getByTestId("hovered-a").textContent).toBe("only-a");
    expect(view.getByTestId("hovered-b").textContent).toBe("-");
    act(() => second!.hover("only-b"));
    expect(view.getByTestId("hovered-a").textContent).toBe("only-a");
    expect(view.getByTestId("hovered-b").textContent).toBe("only-b");
  });
});
