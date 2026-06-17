import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { buildTour, type TourStop } from "../data/tour";
import { tourExpandKeys } from "../data/tourApply";
import { BRAND } from "../scene/encoding";

/** Dwell (ms) parked on each stop before auto-advancing while playing. Tuned a
 *  touch above the camera's idle-drift threshold (Controls.IDLE_AFTER_MS=4000)
 *  so the view gets a beat of gentle auto-rotation while you read the caption. */
const DWELL_MS = 5500;

/** Guided cinematic tour (design P1).
 *
 *  Lives OUTSIDE the Canvas as an HUD overlay. It derives a deterministic stop
 *  list from the model (data/tour.buildTour) and, on each stop, drives the
 *  EXISTING store mechanisms — expand-ancestors, select, focusTarget (fit/fly),
 *  and neighborhood focus — so it inherits the same smooth CameraControls fly
 *  and idle auto-rotate. It owns no camera code of its own.
 *
 *  Renders nothing but a "Tour" launch button until active; while active it
 *  shows a brand-styled caption card (bottom-center), a progress indicator, and
 *  Play/Pause · Prev · Next · Exit controls. Esc also exits (handled here so it
 *  takes precedence over the global collapse-level Esc binding). */
export function TourController() {
  const store = useStore();
  const model = store.model;
  const active = store.tour;

  const stops = useMemo<TourStop[]>(() => (model ? buildTour(model) : []), [model]);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  // Caption fade: re-trigger the fade-in on every stop change.
  const [shown, setShown] = useState(false);

  // Apply a single stop as one fixed, deterministic sequence (replaces the old
  // per-kind switch). Each stop is self-isolated: step 1 wipes ALL prior
  // expansion/overlays, so there is no cross-stop accumulation and the sequence
  // is idempotent. Dispatches are reduced sequentially against the evolving
  // state (not the render snapshot), so `select` strictly before `toggleFocus`
  // (which reads store.selected) behaves predictably.
  const applyStop = useCallback(
    (stop: TourStop) => {
      if (!model) return;
      // 1. CLEAN SLATE — kills cross-stop accumulation (expanded := {root},
      //    clears focus/selection/impact).
      if (stop.collapsePrevious) store.resetExpansion();
      // 2. LENS — per-stop single lens (no fitNonce bump → won't yank the camera).
      store.setLens(stop.lens);
      // 3. EXPAND (bounded). The keys are computed against the INTENDED post-reset
      //    expansion (resetExpansion sets expanded := {root}, but store.expanded
      //    here is still the stale pre-reset render snapshot) — see tourExpandKeys.
      //    Module: open expandKeys one level (files). Node: reveal the focus
      //    node's ancestor chain. Each returned key is a real state change.
      for (const key of tourExpandKeys(model, stop, store.expanded)) {
        store.toggleExpand(key);
      }
      // 4. FOCUS / ISOLATE — select strictly before toggleFocus.
      if (stop.focusNodeId) {
        store.select(stop.focusNodeId);
        store.toggleFocus();
      } else {
        store.select(null);
      }
      // 5. FIT — bumps fitNonce → Controls flies + frames the target (cluster
      //    key OR node id; setFocusTarget resolves both).
      store.setFocusTarget(stop.targetKey);
    },
    // store identity changes each render (useMemo over state); we intentionally
    // read the latest via closure and only re-create when model changes.
    [model, store],
  );

  const goTo = useCallback(
    (next: number) => {
      if (stops.length === 0) return;
      const clamped = Math.max(0, Math.min(stops.length - 1, next));
      setIndex(clamped);
      applyStop(stops[clamped]!);
    },
    [stops, applyStop],
  );

  // On entering the tour: reset to stop 0 and apply it.
  const prevActive = useRef(false);
  useEffect(() => {
    if (active && !prevActive.current) {
      setIndex(0);
      setPlaying(true);
      if (stops.length > 0) applyStop(stops[0]!);
    }
    prevActive.current = active;
  }, [active, stops, applyStop]);

  // Caption fade-in on each stop change.
  useEffect(() => {
    if (!active) return;
    setShown(false);
    const t = setTimeout(() => setShown(true), 60);
    return () => clearTimeout(t);
  }, [index, active]);

  // Auto-advance while playing. Stops at the last stop (no loop) and pauses.
  useEffect(() => {
    if (!active || !playing) return;
    const t = setTimeout(() => {
      if (index < stops.length - 1) goTo(index + 1);
      else setPlaying(false);
    }, DWELL_MS);
    return () => clearTimeout(t);
  }, [active, playing, index, stops.length, goTo]);

  // Esc exits the tour (takes precedence over the global collapse-level Esc).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Stop the global collapse-level Esc handler (also on window) from also
        // firing for this keypress.
        e.stopImmediatePropagation();
        store.exitTour();
      }
    };
    // Capture phase so we run before Root's window keydown listener.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, store]);

  if (!model || stops.length === 0) return null;

  if (!active) {
    return (
      <button
        onClick={() => store.startTour()}
        title="Take a guided cinematic tour of the constellation"
        style={{
          padding: "2px 10px",
          fontSize: 11,
          borderRadius: 5,
          border: `1px solid ${BRAND.teal}66`,
          background: `${BRAND.teal}1f`,
          color: BRAND.cream,
          cursor: "pointer",
          letterSpacing: 0.3,
        }}
      >
        ▶ Tour
      </button>
    );
  }

  const stop = stops[index]!;
  const atStart = index === 0;
  const atEnd = index === stops.length - 1;

  return (
    <>
      {/* Caption card — bottom-center, brand-styled, fades in/out per stop. */}
      <div
        style={{
          position: "fixed",
          bottom: 88,
          left: "50%",
          transform: `translateX(-50%) translateY(${shown ? 0 : 8}px)`,
          width: "min(520px, calc(100vw - 48px))",
          opacity: shown ? 1 : 0,
          transition: "opacity 0.45s ease, transform 0.45s ease",
          pointerEvents: "none",
          zIndex: 40,
          textAlign: "center",
        }}
      >
        <div
          style={{
            display: "inline-block",
            maxWidth: "100%",
            padding: "14px 22px",
            borderRadius: 12,
            background: "rgba(8,11,22,0.86)",
            border: `1px solid ${BRAND.amber}44`,
            boxShadow: `0 8px 32px rgba(0,0,0,0.5), 0 0 28px ${BRAND.amber}1a`,
            backdropFilter: "blur(10px)",
          }}
        >
          <div
            style={{
              fontSize: 10,
              letterSpacing: 2,
              textTransform: "uppercase",
              color: BRAND.teal,
              opacity: 0.85,
              marginBottom: 6,
            }}
          >
            Guided tour · stop {index + 1} / {stops.length}
          </div>
          <div
            style={{
              fontSize: 19,
              fontWeight: 600,
              color: BRAND.cream,
              letterSpacing: 0.3,
              wordBreak: "break-word",
            }}
          >
            {stop.caption.title}
          </div>
          <div style={{ fontSize: 13, color: "rgba(200,210,235,0.82)", marginTop: 4 }}>
            {stop.caption.body}
          </div>
        </div>
      </div>

      {/* Transport controls — bottom-center, below the caption. */}
      <div
        style={{
          position: "fixed",
          bottom: 26,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          borderRadius: 999,
          background: "rgba(8,11,22,0.9)",
          border: "1px solid rgba(90,120,180,0.35)",
          backdropFilter: "blur(10px)",
          zIndex: 41,
        }}
      >
        <TourBtn label="⟨ Prev" disabled={atStart} onClick={() => goTo(index - 1)} />
        <TourBtn
          label={playing ? "❚❚ Pause" : "▶ Play"}
          primary
          onClick={() => setPlaying((p) => !p)}
        />
        <TourBtn
          label="Next ⟩"
          disabled={atEnd}
          onClick={() => {
            setPlaying(false);
            goTo(index + 1);
          }}
        />
        {/* Progress dots */}
        <div style={{ display: "flex", gap: 4, margin: "0 6px" }}>
          {stops.map((s, i) => (
            <span
              key={s.id}
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: i === index ? BRAND.amber : "rgba(255,255,255,0.25)",
                transition: "background 0.3s",
              }}
            />
          ))}
        </div>
        <TourBtn label="✕ Exit" onClick={() => store.exitTour()} />
      </div>
    </>
  );
}

function TourBtn({
  label,
  onClick,
  disabled,
  primary,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "4px 12px",
        fontSize: 12,
        borderRadius: 999,
        border: `1px solid ${primary ? BRAND.amber + "88" : "rgba(255,255,255,0.18)"}`,
        background: primary ? `${BRAND.amber}26` : "rgba(255,255,255,0.05)",
        color: disabled ? "rgba(255,255,255,0.3)" : primary ? BRAND.cream : "rgba(230,235,245,0.85)",
        cursor: disabled ? "default" : "pointer",
        letterSpacing: 0.3,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}
