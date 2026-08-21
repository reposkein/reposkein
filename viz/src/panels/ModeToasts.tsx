import { useEffect, useRef } from "react";
import { useStoreState } from "../state/store";
import { pushToast } from "./toastState";

/** Mode-change toasts (Astrolabe V3 §5). One place watches the reducer's mode
 *  flags and announces transitions, so a mode entered from the ⌘K palette, the
 *  Inspector's action row, and a status-bar chip all produce the same message —
 *  rather than each entry point remembering to toast (which is how they drift).
 *
 *  Pairs with the mode CHIPS (data/modeChips.ts): the chip is the persistent
 *  "this mode is on" state, the toast is the transient "…and here's how to get
 *  out" — which is the part V2 never told anyone. Hence the `Esc to exit` hint:
 *  Esc dismissing the topmost mode chip has existed since REP-18 and was
 *  entirely undiscoverable.
 *
 *  Renders nothing. Mounted once by Root. */
export function ModeToasts() {
  const state = useStoreState();
  const impactOn = state.impact !== null;
  const focusOn = state.focus !== null;
  const auditOn = state.audit !== "off";
  const couplingOn = state.coupling;

  // Seeded from the FIRST render's values so a mode already active at mount
  // (a deep link restoring one, a test constructing state directly) doesn't
  // fire a toast for something the viewer didn't just do.
  const prev = useRef({ impactOn, focusOn, auditOn, couplingOn, tour: state.tour });

  useEffect(() => {
    const was = prev.current;
    if (impactOn !== was.impactOn) {
      pushToast(impactOn ? "Impact on" : "Impact off", {
        tone: impactOn ? "accent" : "info",
        hint: impactOn ? "Esc to exit" : undefined,
        dedupeKey: "mode-impact",
      });
    }
    if (focusOn !== was.focusOn) {
      pushToast(focusOn ? `Focus on — depth ${state.focusDepth}` : "Focus off", {
        tone: focusOn ? "accent" : "info",
        hint: focusOn ? "Esc to exit" : undefined,
        dedupeKey: "mode-focus",
      });
    }
    if (auditOn !== was.auditOn) {
      pushToast(auditOn ? "Confidence audit on" : "Confidence audit off", {
        tone: auditOn ? "warn" : "info",
        hint: auditOn ? "Esc to exit" : undefined,
        dedupeKey: "mode-audit",
      });
    }
    if (couplingOn !== was.couplingOn) {
      pushToast(couplingOn ? "Co-change links on" : "Co-change links off", {
        tone: couplingOn ? "accent" : "info",
        hint: couplingOn ? "Esc to exit" : undefined,
        dedupeKey: "mode-coupling",
      });
    }
    prev.current = { impactOn, focusOn, auditOn, couplingOn, tour: state.tour };
    // state.focusDepth is read for the message only — a depth change with focus
    // already on is not itself a mode transition worth a toast.
  }, [impactOn, focusOn, auditOn, couplingOn, state.tour, state.focusDepth]);

  return null;
}
