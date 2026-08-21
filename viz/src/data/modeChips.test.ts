import { describe, expect, it, vi } from "vitest";
import { deriveModeChips, dismissModeChip, type ModeChipState } from "./modeChips";
import type { Actions } from "../state/store";

const BASE: ModeChipState = {
  lens: "all",
  impact: null,
  focus: null,
  focusDepth: 1,
  coupling: false,
  audit: "off",
};

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

describe("deriveModeChips", () => {
  it("returns no chips for the fully-neutral state", () => {
    expect(deriveModeChips(BASE)).toEqual([]);
  });

  it("shows a lens chip when the lens is not 'all'", () => {
    const chips = deriveModeChips({ ...BASE, lens: "calls" });
    expect(chips).toEqual([{ kind: "lens", label: "Lens: Call graph" }]);
  });

  it("shows an impact chip when an impact result is present", () => {
    const chips = deriveModeChips({
      ...BASE,
      impact: { impacted: new Set(), coveringTests: new Set() } as never,
    });
    expect(chips).toEqual([{ kind: "impact", label: "Impact" }]);
  });

  it("shows a focus chip labeled with the current depth", () => {
    const chips = deriveModeChips({
      ...BASE,
      focus: { nodes: new Set() } as never,
      focusDepth: 2,
    });
    expect(chips).toEqual([{ kind: "focus", label: "Focus:2" }]);
  });

  it("shows a coupling chip when coupling is on", () => {
    expect(deriveModeChips({ ...BASE, coupling: true })).toEqual([
      { kind: "coupling", label: "Coupling" },
    ]);
  });

  it("shows an audit chip with a distinct label per audit mode", () => {
    expect(deriveModeChips({ ...BASE, audit: "ambiguous" })).toEqual([
      { kind: "audit", label: "Audit: ambiguous" },
    ]);
    expect(deriveModeChips({ ...BASE, audit: "ambiguous+name" })).toEqual([
      { kind: "audit", label: "Audit: ambiguous + name" },
    ]);
  });

  it("orders every active chip: lens, impact, focus, coupling, audit", () => {
    const chips = deriveModeChips({
      lens: "types",
      impact: { impacted: new Set(), coveringTests: new Set() } as never,
      focus: { nodes: new Set() } as never,
      focusDepth: 3,
      coupling: true,
      audit: "ambiguous",
    });
    expect(chips.map((c) => c.kind)).toEqual(["lens", "impact", "focus", "coupling", "audit"]);
  });

  it("a silent mode-clear (e.g. selecting a different node clears impact) is a pure chip-list diff", () => {
    const withImpact = deriveModeChips({ ...BASE, impact: { impacted: new Set(), coveringTests: new Set() } as never });
    const afterClear = deriveModeChips(BASE); // reducer's "select" already nulled impact
    expect(withImpact.some((c) => c.kind === "impact")).toBe(true);
    expect(afterClear.some((c) => c.kind === "impact")).toBe(false);
  });
});

describe("dismissModeChip", () => {
  it("drives the same store action a manual toggle would use, per chip kind", () => {
    const actions = mockActions();
    dismissModeChip("lens", actions);
    expect(actions.setLens).toHaveBeenCalledWith("all");

    dismissModeChip("impact", actions);
    expect(actions.toggleImpact).toHaveBeenCalledOnce();

    dismissModeChip("focus", actions);
    expect(actions.toggleFocus).toHaveBeenCalledOnce();

    dismissModeChip("coupling", actions);
    expect(actions.toggleCoupling).toHaveBeenCalledOnce();

    dismissModeChip("audit", actions);
    expect(actions.setAudit).toHaveBeenCalledWith("off");
  });
});
