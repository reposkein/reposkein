import { useEffect, useState } from "react";
import { useStoreState } from "../state/store";
import { LOAD_TOTAL_STEPS, loadProgress } from "../data/loadPhase";

/** The loading screen (Astrolabe V3 §4). V2 showed a spinner plus the raw
 *  worker phase; a viewer had no way to tell "fetching graph" (fast) from
 *  "charting the sky" (the force layout, seconds on a large repo) apart, so a
 *  slow load read as a hang.
 *
 *  Now the phase is placed IN the pipeline: "step 3 of 4" plus four segments
 *  that fill as the worker advances (`data/loadPhase.ts` maps phases to steps,
 *  and is unit-tested). An unrecognized phase degrades to the label with no
 *  count — indeterminate, never a lie.
 *
 *  Segments rather than a percentage bar for a concrete reason beyond taste:
 *  a width-driven bar needs an inline `style` computed per render, and V3 §8
 *  puts chrome on Tailwind tokens. Four fixed segments express the same
 *  information with static classes.
 *
 *  Stays mounted for a ~700ms fade after `ready` so the scene doesn't pop in
 *  over a blank canvas. */
export function LoadingScreen() {
  const status = useStoreState().status;
  const loading = status.kind === "loading";
  const phase = status.kind === "loading" ? status.phase : "";
  const progress = loadProgress(phase);

  const [mounted, setMounted] = useState(true);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (loading) {
      setMounted(true);
      setVisible(true);
      return;
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 700);
    return () => clearTimeout(t);
  }, [loading]);

  if (!mounted) return null;

  return (
    <div
      data-testid="loading-screen"
      aria-live="polite"
      aria-busy={loading}
      className={`pointer-events-none fixed inset-0 z-[130] flex flex-col items-center justify-center gap-4 bg-[radial-gradient(ellipse_60%_50%_at_50%_50%,rgba(5,6,12,0.55)_0%,rgba(5,6,12,0)_70%)] transition-opacity duration-700 motion-reduce:transition-none ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="relative h-16 w-16">
        <span className="absolute inset-0 rounded-full border-2 border-[color-mix(in_srgb,var(--color-brand-teal)_35%,transparent)] border-t-[var(--color-brand-amber)] motion-safe:animate-[rs-spin_1.6s_linear_infinite]" />
        <span className="absolute inset-[18px] rounded-full bg-[radial-gradient(circle,var(--color-brand-amber)_0%,transparent_70%)] motion-safe:animate-[rs-pulse_1.8s_ease-in-out_infinite]" />
      </div>

      <div className="text-center">
        <p className="text-[15px] tracking-wide text-[var(--color-brand-cream)]">
          Charting the constellation…
        </p>
        {progress.label && (
          <p data-testid="loading-phase" className="mt-1 text-[11px] opacity-60">
            {progress.label}
            {progress.known && (
              <span data-testid="loading-fraction" className="ml-1.5 font-mono tabular-nums">
                step {progress.step} of {progress.total}
              </span>
            )}
          </p>
        )}
      </div>

      <div
        role="progressbar"
        aria-label="Graph load progress"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.known ? progress.step : undefined}
        aria-valuetext={progress.label || undefined}
        className="flex gap-1"
      >
        {Array.from({ length: LOAD_TOTAL_STEPS }, (_, i) => (
          <span
            key={i}
            data-testid={`loading-segment-${i + 1}`}
            data-filled={i < progress.step}
            className={`h-0.5 w-8 rounded-full transition-colors ${
              i < progress.step ? "bg-[var(--color-brand-amber)]" : "bg-white/12"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
