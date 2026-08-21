import { useCallback, useRef, useSyncExternalStore } from "react";

/** A one-value external store — the escape hatch for state that changes at
 *  POINTER or FRAME rate.
 *
 *  Why this exists: the app has exactly one reducer (see store.tsx) and that is
 *  deliberate. But a reducer publishes through context, so every update
 *  re-renders every consumer — fine for "the user expanded a cluster", ruinous
 *  for "the pointer moved onto a different star" (60 Hz) or "EdgeLines finished
 *  a pass and recounted bundles" (per commit). Those two channels used to live
 *  in the reducer, so a hover re-rendered the entire HUD.
 *
 *  A channel is not a state library: no actions, no middleware, no derived
 *  selectors — one slot, `useSyncExternalStore`, and only the components that
 *  actually read the value re-render. Everything with real semantics stays in
 *  the reducer. */
export interface Channel<T> {
  get(): T;
  set(next: T): void;
  subscribe(listener: () => void): () => void;
}

/** Creates a channel. `equals` guards redundant notifications — the hover
 *  channel fires on every pointer frame, most of them with the same value. */
export function createChannel<T>(
  initial: T,
  equals: (a: T, b: T) => boolean = Object.is,
): Channel<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (equals(value, next)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Subscribes to a channel's value. Re-renders ONLY this component when it
 *  changes. Server snapshot is the same getter (the viewer is a client-only
 *  SPA), which also keeps the hook usable under `renderToString` in tests. */
export function useChannelValue<T>(channel: Channel<T>): T {
  return useSyncExternalStore(channel.subscribe, channel.get, channel.get);
}

/** A stable setter for a channel — safe in a dependency array. */
export function useChannelSetter<T>(channel: Channel<T>): (next: T) => void {
  return useCallback((next: T) => channel.set(next), [channel]);
}

/** Convenience for provider construction: a channel created once per mount.
 *  `initial`/`equals` are read on the first render only — a channel's identity
 *  must be stable for its whole lifetime or every subscriber would resubscribe. */
export function useNewChannel<T>(
  initial: T,
  equals?: (a: T, b: T) => boolean,
): Channel<T> {
  const ref = useRef<Channel<T> | null>(null);
  if (ref.current === null) ref.current = createChannel(initial, equals);
  return ref.current;
}
