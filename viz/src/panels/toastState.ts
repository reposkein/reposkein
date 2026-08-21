/** Transient toasts (Astrolabe V3 §5). A ~60-line singleton, no dependency.
 *
 *  Same reasoning as `layerState.ts` for living outside the reducer: a toast is
 *  ephemeral chrome, and pushing one must not re-render the constellation.
 *  It also has to be pushable from places that are NOT React — the edge-cap
 *  watcher reads a channel, `captureScreenshot()` is a scene singleton, the
 *  clipboard write is a browser API — so a plain function is the right surface.
 *
 *  Auto-dismiss is a real timer per toast (not a single sweep) so a burst of
 *  toasts each get their full dwell. `dedupeKey` collapses repeats: flipping
 *  Impact on/off quickly replaces the message in place rather than stacking two
 *  contradictory cards. */

import { useSyncExternalStore } from "react";

export type ToastTone = "info" | "accent" | "warn";

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  /** Optional second line — used for the "Esc to exit" affordance. */
  hint?: string;
}

export interface ToastOptions {
  tone?: ToastTone;
  hint?: string;
  /** ms before auto-dismiss. 0 disables auto-dismiss (nothing uses that yet). */
  duration?: number;
  /** Replaces any live toast pushed with the same key instead of stacking. */
  dedupeKey?: string;
}

/** Default dwell: long enough to read two short lines, short enough that a
 *  mode-change toast is gone before it becomes furniture. */
export const TOAST_DURATION_MS = 3200;

/** Hard cap on simultaneous toasts — the oldest is dropped past this so a
 *  runaway pusher can never wallpaper the viewport. */
const MAX_TOASTS = 3;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const keys = new Map<string, number>();

function emit(): void {
  for (const l of listeners) l();
}

function clearTimer(id: number): void {
  const t = timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(id);
  }
}

/** Pushes a toast, returning its id. Safe to call from anywhere. */
export function pushToast(text: string, opts: ToastOptions = {}): number {
  const dedupeKey = opts.dedupeKey;
  if (dedupeKey) {
    const prior = keys.get(dedupeKey);
    if (prior !== undefined) dismissToast(prior);
  }
  const id = nextId++;
  const toast: Toast = { id, text, tone: opts.tone ?? "info", hint: opts.hint };
  toasts = [...toasts, toast].slice(-MAX_TOASTS);
  if (dedupeKey) keys.set(dedupeKey, id);
  const duration = opts.duration ?? TOAST_DURATION_MS;
  if (duration > 0) {
    timers.set(
      id,
      setTimeout(() => dismissToast(id), duration),
    );
  }
  emit();
  return id;
}

export function dismissToast(id: number): void {
  clearTimer(id);
  for (const [key, value] of keys) if (value === id) keys.delete(key);
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export function getToasts(): Toast[] {
  return toasts;
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribeToasts, getToasts, getToasts);
}

/** Test hook: wipe every live toast and its timer. */
export function resetToasts(): void {
  for (const id of [...timers.keys()]) clearTimer(id);
  keys.clear();
  toasts = [];
  emit();
}
