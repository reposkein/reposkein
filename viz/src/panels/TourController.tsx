import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { buildTour, type TourStop } from "../data/tour";
import { tourExpandKeys } from "../data/tourApply";
import { isCommandPaletteOpen } from "./paletteOpenState";
import { restoreStashedLayer, stashLayer } from "./layerState";

/** Dwell (ms) parked on each stop before auto-advancing while playing. Tuned a
 *  touch above the camera's idle-drift threshold (Controls.IDLE_AFTER_MS=4000)
 *  so the view gets a beat of gentle auto-rotation while you read the caption. */
const DWELL_MS = 5500;

/** Guided CINEMATIC tour (Astrolabe V3 §3).
 *
 *  Unchanged from V2: it derives a deterministic stop list from the model
 *  (data/tour.buildTour) and drives the EXISTING store mechanisms per stop —
 *  expand-ancestors, select, focusTarget (fit/fly), neighborhood focus — so it
 *  inherits the same smooth CameraControls fly. It owns no camera code.
 *
 *  Changed in V3: this component is now the OVERLAY ONLY (caption + transport),
 *  mounted by Root outside the chrome-fade group. V2 rendered it inside the
 *  status bar's right region, which meant "cinematic mode" could not actually
 *  fade the bar — the caption would have faded with it. The launch pill it used
 *  to render when inactive is now `TourLaunchButton`, which stays in the bar
 *  (and fades with it, correctly: while touring you don't need a Tour button).
 *
 *  Esc: exits the tour, but only once the palette has had its say (the newest
 *  overlay wins Esc — see paletteOpenState's docstring). Summoned layers defer
 *  to the tour, so the order overall is palette > tour > layer > chip. */
export function TourController() {
  const store = useStore();
  const model = store.model;
  const active = store.tour;

  const stops = useMemo<TourStop[]>(() => (model ? buildTour(model) : []), [model]);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [shown, setShown] = useState(false);

  const applyStop = useCallback(
    (stop: TourStop) => {
      if (!model) return;
      if (stop.collapsePrevious) store.resetExpansion();
      store.setLens(stop.lens);
      store.revealWithoutRefit(tourExpandKeys(model, stop, store.expanded));
      if (stop.focusNodeId) {
        store.select(stop.focusNodeId);
        store.toggleFocus();
      } else {
        store.select(null);
      }
      store.setFocusTarget(stop.targetKey);
    },
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

  const prevActive = useRef(false);
  useEffect(() => {
    if (active && !prevActive.current) {
      // Entering cinematic mode: park any summoned layer. It has to actually
      // CLOSE, not merely fade — LayerHost renders inside Root's ChromeGroup, so
      // fading the group does hide it, but a layer left open would also keep
      // consuming Esc (LayerShell's handler outranks the chip stack), and Esc
      // during a tour must exit the tour. `stashLayer` remembers it so the exit
      // below is a genuine round trip.
      stashLayer();
      setIndex(0);
      setPlaying(true);
      if (stops.length > 0) applyStop(stops[0]!);
    } else if (!active && prevActive.current) {
      // Leaving cinematic mode: put back whatever was open before it started.
      restoreStashedLayer();
    }
    prevActive.current = active;
  }, [active, stops, applyStop]);

  useEffect(() => {
    if (!active) return;
    setShown(false);
    const t = setTimeout(() => setShown(true), 60);
    return () => clearTimeout(t);
  }, [index, active]);

  useEffect(() => {
    if (!active || !playing) return;
    const t = setTimeout(() => {
      if (index < stops.length - 1) goTo(index + 1);
      else setPlaying(false);
    }, DWELL_MS);
    return () => clearTimeout(t);
  }, [active, playing, index, stops.length, goTo]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isCommandPaletteOpen()) return;
        e.stopImmediatePropagation();
        store.exitTour();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, store]);

  if (!model || stops.length === 0 || !active) return null;

  const stop = stops[index]!;
  const atStart = index === 0;
  const atEnd = index === stops.length - 1;

  return (
    <>
      {/* Caption card — bottom-center, above the transport. */}
      <div
        data-testid="tour-caption"
        className={`pointer-events-none fixed inset-x-0 bottom-[88px] z-[140] mx-auto w-[min(520px,calc(100vw-3rem))] text-center transition-opacity duration-500 motion-reduce:transition-none ${
          shown ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="inline-block max-w-full rounded-[12px] border border-[color-mix(in_srgb,var(--color-brand-amber)_28%,transparent)] bg-[color-mix(in_srgb,var(--color-brand-navy)_88%,transparent)] px-5 py-3.5 shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-md">
          <p className="mb-1.5 text-[11px] uppercase tracking-[0.16em] text-[var(--color-brand-teal)] opacity-85">
            Guided tour · stop {index + 1} / {stops.length}
          </p>
          <p className="break-words text-[19px] font-semibold leading-snug text-[var(--color-brand-cream)]">
            {stop.caption.title}
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-brand-cream)] opacity-80">
            {stop.caption.body}
          </p>
        </div>
      </div>

      {/* Transport — the only interactive chrome left during cinematic mode. */}
      <div
        data-testid="tour-transport"
        className="pointer-events-auto fixed inset-x-0 bottom-10 z-[141] mx-auto flex w-fit items-center gap-2 rounded-full border border-[rgba(148,163,207,0.3)] bg-[color-mix(in_srgb,var(--color-brand-navy)_92%,transparent)] px-2.5 py-1.5 backdrop-blur-md"
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
        <span className="mx-1.5 flex gap-1" aria-hidden="true">
          {stops.map((s, i) => (
            <span
              key={s.id}
              className={`h-1.5 w-1.5 rounded-full transition-colors ${
                i === index ? "bg-[var(--color-brand-amber)]" : "bg-white/25"
              }`}
            />
          ))}
        </span>
        <TourBtn label="✕ Exit" onClick={() => store.exitTour()} />
      </div>
    </>
  );
}

/** The status bar's "▶ Tour" pill. Separate from the overlay above so the bar
 *  can fade during cinematic mode without taking the caption with it. */
export function TourLaunchButton() {
  const store = useStore();
  const model = store.model;
  const stops = useMemo<TourStop[]>(() => (model ? buildTour(model) : []), [model]);
  if (!model || stops.length === 0 || store.tour) return null;
  return (
    <button
      type="button"
      onClick={() => store.startTour()}
      title="Take a guided cinematic tour of the constellation"
      className="min-h-6 min-w-6 rounded-full border border-[color-mix(in_srgb,var(--color-brand-teal)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-brand-teal)_12%,transparent)] px-2 py-1 text-[11px] text-[var(--color-brand-cream)] hover:opacity-85"
    >
      ▶ Tour
    </button>
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
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`whitespace-nowrap rounded-full border px-3 py-1 text-[13px] transition-colors disabled:cursor-default disabled:opacity-35 ${
        primary
          ? "border-[color-mix(in_srgb,var(--color-brand-amber)_55%,transparent)] bg-[color-mix(in_srgb,var(--color-brand-amber)_16%,transparent)] text-[var(--color-brand-cream)]"
          : "border-[rgba(148,163,207,0.22)] bg-white/5 text-[var(--color-brand-cream)] opacity-85 hover:opacity-100"
      }`}
    >
      {label}
    </button>
  );
}
