/** Mode chips (REP-18 status bar, RIGHT region): a SINGLE pure selector over
 *  the reducer's mode flags (lens, impact, focus, coupling, audit) so the bar
 *  never needs its own derived state — a chip is present if and only if the
 *  corresponding mode is active, full stop. That also means a "silent"
 *  mode-clear (selecting a different node clears impact/focus; changing the
 *  lens clears audit) is automatically a visible chip transition: the next
 *  render simply omits the chip, no extra plumbing required.
 *
 *  Order is the display AND the Esc-dismiss-priority order (leftmost /
 *  "topmost" first) — kept as one array so the two never drift apart. */

import type { Actions, AuditMode, State } from "../state/store";
import { LENS_PRESETS } from "./lens";

export type ModeChipKind = "lens" | "impact" | "focus" | "coupling" | "audit";

export interface ModeChip {
  kind: ModeChipKind;
  label: string;
}

/** The slice of `State` this selector reads — kept narrow so it's easy to
 *  call from a test without constructing a full reducer state. */
export type ModeChipState = Pick<
  State,
  "lens" | "impact" | "focus" | "focusDepth" | "coupling" | "audit"
>;

function auditLabel(mode: AuditMode): string {
  return mode === "ambiguous" ? "Audit: ambiguous" : "Audit: ambiguous + name";
}

/** Derives the ordered list of active mode chips. Pure — no React, no store
 *  reads beyond the plain object passed in. Empty array is a fully valid
 *  (and common) result: no chip shows for "all" lens / no overlays. */
export function deriveModeChips(state: ModeChipState): ModeChip[] {
  const chips: ModeChip[] = [];
  if (state.lens !== "all") {
    chips.push({ kind: "lens", label: `Lens: ${LENS_PRESETS[state.lens].label}` });
  }
  if (state.impact) {
    chips.push({ kind: "impact", label: "Impact" });
  }
  if (state.focus) {
    chips.push({ kind: "focus", label: `Focus:${state.focusDepth}` });
  }
  if (state.coupling) {
    chips.push({ kind: "coupling", label: "Coupling" });
  }
  if (state.audit !== "off") {
    chips.push({ kind: "audit", label: auditLabel(state.audit) });
  }
  return chips;
}

/** Dismisses one chip by driving the SAME store action a manual toggle would
 *  use — chips never fork a parallel "clear" path. */
export function dismissModeChip(kind: ModeChipKind, actions: Actions): void {
  switch (kind) {
    case "lens":
      actions.setLens("all");
      return;
    case "impact":
      actions.toggleImpact();
      return;
    case "focus":
      actions.toggleFocus();
      return;
    case "coupling":
      actions.toggleCoupling();
      return;
    case "audit":
      actions.setAudit("off");
      return;
  }
}
