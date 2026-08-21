// @vitest-environment jsdom
//
// Toast lifecycle (Astrolabe V3 §5). The point of the toast layer is telling the
// viewer about things that used to happen silently: the edge cap engaging, a
// screenshot downloading, a link copied, and — the one that matters most — that
// a mode is now ON and Esc gets you out of it. Esc-dismisses-the-topmost-chip
// has existed since REP-18 and was completely undiscoverable.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  TOAST_DURATION_MS,
  dismissToast,
  getToasts,
  pushToast,
  resetToasts,
  subscribeToasts,
} from "./toastState";
import { Toasts } from "./Toasts";
import { resetLayers, showLayer } from "./layerState";

beforeEach(() => {
  vi.useFakeTimers();
  resetToasts();
});

afterEach(() => {
  cleanup();
  resetToasts();
  resetLayers();
  vi.useRealTimers();
});

describe("toastState — lifecycle", () => {
  it("pushes, then auto-dismisses after the default dwell", () => {
    pushToast("Screenshot saved");
    expect(getToasts()).toHaveLength(1);

    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(getToasts()).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(getToasts()).toHaveLength(0);
  });

  it("honours a custom duration, and duration 0 means 'stay'", () => {
    pushToast("quick", { duration: 100 });
    vi.advanceTimersByTime(100);
    expect(getToasts()).toHaveLength(0);

    pushToast("sticky", { duration: 0 });
    vi.advanceTimersByTime(TOAST_DURATION_MS * 5);
    expect(getToasts()).toHaveLength(1);
  });

  it("can be dismissed early, and dismissing twice is a no-op", () => {
    const id = pushToast("Link copied");
    dismissToast(id);
    expect(getToasts()).toHaveLength(0);
    expect(() => dismissToast(id)).not.toThrow();
    // …and the cancelled timer doesn't resurrect or double-remove anything.
    vi.advanceTimersByTime(TOAST_DURATION_MS);
    expect(getToasts()).toHaveLength(0);
  });

  it("dedupeKey replaces a live toast in place instead of stacking a contradiction", () => {
    pushToast("Impact on", { dedupeKey: "mode-impact" });
    pushToast("Impact off", { dedupeKey: "mode-impact" });
    const live = getToasts();
    expect(live).toHaveLength(1);
    expect(live[0]!.text).toBe("Impact off");
  });

  it("a replaced toast's timer is cancelled (it can't take the new one with it)", () => {
    pushToast("first", { dedupeKey: "k", duration: 100 });
    vi.advanceTimersByTime(90);
    pushToast("second", { dedupeKey: "k", duration: 100 });
    vi.advanceTimersByTime(20); // past the FIRST toast's deadline
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0]!.text).toBe("second");
    vi.advanceTimersByTime(90);
    expect(getToasts()).toHaveLength(0);
  });

  it("caps the stack, dropping the oldest", () => {
    for (const t of ["a", "b", "c", "d", "e"]) pushToast(t, { duration: 0 });
    expect(getToasts().map((t) => t.text)).toEqual(["c", "d", "e"]);
  });

  it("notifies subscribers on push and on dismiss, and stops after unsubscribe", () => {
    const seen = vi.fn();
    const unsub = subscribeToasts(seen);
    const id = pushToast("x");
    expect(seen).toHaveBeenCalledTimes(1);
    dismissToast(id);
    expect(seen).toHaveBeenCalledTimes(2);
    unsub();
    pushToast("y");
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("resetToasts clears live toasts and their pending timers", () => {
    pushToast("a");
    pushToast("b");
    resetToasts();
    expect(getToasts()).toHaveLength(0);
    vi.advanceTimersByTime(TOAST_DURATION_MS * 2);
    expect(getToasts()).toHaveLength(0);
  });
});

describe("Toasts — rendering and a11y", () => {
  it("keeps a polite live region mounted even with nothing to say", () => {
    render(<Toasts />);
    const region = screen.getByTestId("toast-region");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(screen.queryAllByTestId("toast")).toHaveLength(0);
  });

  it("renders the text, the hint, and a role=status per toast", () => {
    render(<Toasts />);
    act(() => {
      pushToast("Impact on", { tone: "accent", hint: "Esc to exit" });
    });
    const toast = screen.getByTestId("toast");
    expect(toast.getAttribute("role")).toBe("status");
    expect(screen.getByText("Impact on")).toBeTruthy();
    expect(screen.getByText("Esc to exit")).toBeTruthy();
  });

  it("the manual ✕ removes it before the timer fires", () => {
    render(<Toasts />);
    act(() => {
      pushToast("Edge cap engaged — drawing 2500 of 4000 bundles", { tone: "warn" });
    });
    fireEvent.click(screen.getByLabelText("Dismiss notification"));
    expect(screen.queryAllByTestId("toast")).toHaveLength(0);
  });

  it("unmounts a toast when its timer expires", () => {
    render(<Toasts />);
    act(() => {
      pushToast("Link copied");
    });
    expect(screen.getAllByTestId("toast")).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS);
    });
    expect(screen.queryAllByTestId("toast")).toHaveLength(0);
  });

  it("shows several at once, newest last", () => {
    render(<Toasts />);
    act(() => {
      pushToast("first", { duration: 0 });
      pushToast("second", { duration: 0 });
    });
    expect(screen.getAllByTestId("toast").map((t) => t.textContent)).toEqual([
      "first✕",
      "second✕",
    ]);
  });
});

/** Fix round 2 / REP-22 polish: "toasts (bottom-10, z-150) can paint over the
 *  centered Help overlay's bottom edge". The toast stack now moves to the top
 *  of the screen whenever ANY summoned layer is open — including the Help
 *  overlay, and (since every layer becomes a full-width bottom sheet below
 *  640px) the right-docked ones too — rather than staying pinned to a bottom
 *  position no single spot could stay clear of. */
describe("Toasts — repositions above an open summoned layer", () => {
  it("sits at the bottom by default (nothing summoned)", () => {
    render(<Toasts />);
    const region = screen.getByTestId("toast-region");
    expect(region.getAttribute("data-position")).toBe("bottom");
    expect(region.className).toContain("bottom-10");
  });

  it("moves to the top while the Help overlay (or any layer) is open", () => {
    render(<Toasts />);
    act(() => showLayer("help"));
    const region = screen.getByTestId("toast-region");
    expect(region.getAttribute("data-position")).toBe("top");
    expect(region.className).toContain("top-3");
    expect(region.className).not.toContain("bottom-10");
  });

  it("returns to the bottom once the layer closes", () => {
    render(<Toasts />);
    act(() => showLayer("legend"));
    act(() => resetLayers());
    const region = screen.getByTestId("toast-region");
    expect(region.getAttribute("data-position")).toBe("bottom");
  });
});
