// @vitest-environment jsdom
//
// First-run coach mark (Astrolabe V5 §1). A single dismissible hint, shown
// once per browser, persisted via localStorage — the smallest possible
// onboarding surface, deliberately NOT a multi-step tour.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CoachMark } from "./CoachMark";
import {
  dismissCoachMark,
  isCoachMarkDismissed,
  resetCoachMark,
  subscribeCoachMark,
} from "./coachMarkState";
import { resetLayers, showLayer } from "./layerState";

// This project's jsdom test environment doesn't expose `window.localStorage`
// out of the box (Node's own experimental `localStorage` global shadows it
// and warns without `--localstorage-file`) — a real browser always has it, so
// a minimal in-memory polyfill here is what makes the PERSISTENCE assertions
// below meaningful rather than vacuous. `coachMarkState.ts` itself degrades
// gracefully with no polyfill at all (that's the point of its try/catch), so
// production code needs none of this.
function installLocalStorageStub(): void {
  const backing = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => backing.set(k, v),
      removeItem: (k: string) => backing.delete(k),
      clear: () => backing.clear(),
    },
  });
}

beforeEach(() => {
  installLocalStorageStub();
  resetCoachMark();
});

afterEach(() => {
  cleanup();
  resetCoachMark();
  resetLayers();
});

describe("coachMarkState — persistence", () => {
  it("is not dismissed on a fresh browser", () => {
    expect(isCoachMarkDismissed()).toBe(false);
  });

  it("dismissing persists across a fresh read (survives a reload)", () => {
    dismissCoachMark();
    expect(isCoachMarkDismissed()).toBe(true);
    expect(window.localStorage.getItem("reposkein.coachmark.dismissed.v1")).toBe("1");
  });

  it("dismissing twice is a no-op (idempotent, no duplicate writes/emits)", () => {
    let calls = 0;
    const unsub = subscribeCoachMark(() => calls++);
    dismissCoachMark();
    dismissCoachMark();
    expect(calls).toBe(1);
    unsub();
  });

  it("resetCoachMark clears both the in-memory flag and localStorage", () => {
    dismissCoachMark();
    resetCoachMark();
    expect(isCoachMarkDismissed()).toBe(false);
    expect(window.localStorage.getItem("reposkein.coachmark.dismissed.v1")).toBeNull();
  });

  it("notifies subscribers on dismiss", () => {
    const seen: boolean[] = [];
    const unsub = subscribeCoachMark(() => seen.push(isCoachMarkDismissed()));
    dismissCoachMark();
    expect(seen).toEqual([true]);
    unsub();
  });
});

describe("CoachMark — lifecycle (show / dismiss / persist)", () => {
  it("shows once after load when never dismissed", () => {
    render(<CoachMark />);
    const mark = screen.getByTestId("coach-mark");
    expect(mark.getAttribute("role")).toBe("status");
    expect(mark.textContent).toContain("⌘K");
    expect(mark.textContent).toContain("?");
  });

  it("does not render at all once already dismissed (a returning viewer)", () => {
    dismissCoachMark();
    render(<CoachMark />);
    expect(screen.queryByTestId("coach-mark")).toBeNull();
  });

  it("clicking the dismiss button hides it immediately and persists the dismissal", () => {
    render(<CoachMark />);
    fireEvent.click(screen.getByLabelText("Dismiss hint"));
    expect(screen.queryByTestId("coach-mark")).toBeNull();
    expect(isCoachMarkDismissed()).toBe(true);
  });

  it("stays dismissed across a remount (persisted, not just local state)", () => {
    const { unmount } = render(<CoachMark />);
    fireEvent.click(screen.getByLabelText("Dismiss hint"));
    unmount();
    render(<CoachMark />);
    expect(screen.queryByTestId("coach-mark")).toBeNull();
  });

  it("hides (without dismissing) while a summoned layer is open, reappears once it closes", () => {
    render(<CoachMark />);
    expect(screen.getByTestId("coach-mark")).toBeTruthy();

    act(() => showLayer("help"));
    expect(screen.queryByTestId("coach-mark")).toBeNull();
    // Not dismissed — just hidden for the moment the layer occupies the same
    // bottom-center real estate the hint would otherwise point at.
    expect(isCoachMarkDismissed()).toBe(false);

    act(() => resetLayers());
    expect(screen.getByTestId("coach-mark")).toBeTruthy();
  });

  it("respects reduced motion (the entrance animation is dropped, not just eased)", () => {
    render(<CoachMark />);
    const mark = screen.getByTestId("coach-mark");
    expect(mark.className).toContain("motion-safe:animate-");
    expect(mark.className).toContain("motion-reduce:animate-none");
  });
});
