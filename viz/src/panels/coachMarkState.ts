import { useSyncExternalStore } from "react";

/** First-run coach mark persistence (Astrolabe V5 §1). A ~30-line singleton,
 *  same shape as `toastState.ts`/`layerState.ts` for the same reason: this is
 *  ephemeral chrome state, not reducer state, and it must be readable from a
 *  plain function (the dismiss button) without forcing a subscriber on every
 *  reducer consumer.
 *
 *  Persistence is `localStorage`, not the reducer/URL — the point of a
 *  first-run hint is that it survives across sessions on the SAME browser
 *  without needing a signed-in account or a URL param a viewer could strip.
 *  Every read/write is wrapped: a privacy-mode browser or a disabled storage
 *  API must never throw and must never block the hint from at least trying to
 *  show (degrading to "show every time" is safe; throwing is not). */

const STORAGE_KEY = "reposkein.coachmark.dismissed.v1";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let dismissed = typeof window === "undefined" ? true : readDismissed();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Whether the hint has already been dismissed (this browser, ever). */
export function isCoachMarkDismissed(): boolean {
  return dismissed;
}

/** Dismisses the hint for good — persisted, so it never shows again on this
 *  browser. Safe to call more than once. */
export function dismissCoachMark(): void {
  if (dismissed) return;
  dismissed = true;
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* best-effort — an in-memory dismiss for this session is still correct */
  }
  emit();
}

export function subscribeCoachMark(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCoachMarkDismissed(): boolean {
  return useSyncExternalStore(subscribeCoachMark, isCoachMarkDismissed, isCoachMarkDismissed);
}

/** Test hook: forget the dismissal (in memory AND in storage), so a test can
 *  exercise "first run" more than once in a process. */
export function resetCoachMark(): void {
  dismissed = false;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  emit();
}
