/** Loader progress (Astrolabe V3 §4): turns the graph worker's free-text
 *  `phase` strings into a STEP of a known pipeline, so the loading screen can
 *  show "step 3 of 4" and a segmented bar instead of an opaque spinner.
 *
 *  The worker (data/worker/graph.worker.ts) posts `{type:"progress", phase}` at
 *  each stage; static-export mode (data/staticMode.ts, driven from
 *  state/store.tsx) posts its own single phase. There is no numeric progress on
 *  the wire — deriving the step HERE keeps the worker protocol unchanged and
 *  makes the mapping a pure, unit-tested function rather than UI guesswork.
 *
 *  Adding a phase to the worker without adding it here is not a crash: an
 *  unknown phase reports step 0 (indeterminate) and still shows its own label,
 *  so the loader degrades to "we're working" rather than lying about progress. */

/** How many steps the pipeline has. Fetch → parse → lay out, plus the initial
 *  "starting" beat at 0. */
export const LOAD_TOTAL_STEPS = 4;

/** Worker phase → completed-step index (0…LOAD_TOTAL_STEPS). Several phases
 *  share a step: federated fetches interleave with parsing, and a layout is
 *  either restored from cache or charted fresh — both are step 4's work. */
const PHASE_STEP: Record<string, number> = {
  starting: 0,
  "fetching manifest": 1,
  "fetching graph": 2,
  parsing: 3,
  "parsing baked graph": 3,
  "fetching federated repos": 3,
  "restoring layout": 4,
  "charting the sky": 4,
};

export interface LoadProgress {
  /** 0…LOAD_TOTAL_STEPS. 0 also means "unrecognized phase". */
  step: number;
  total: number;
  /** 0…1 — `step / total`. */
  fraction: number;
  /** The phase text, as reported (never invented). */
  label: string;
  /** False when the phase isn't in the table: show the label, not the count. */
  known: boolean;
}

/** Pure. Trims + lower-cases the phase for lookup so a capitalization change in
 *  the worker doesn't silently drop the loader to indeterminate. */
export function loadProgress(phase: string): LoadProgress {
  const label = phase.trim();
  const step = PHASE_STEP[label.toLowerCase()];
  const known = step !== undefined;
  const resolved = known ? step : 0;
  return {
    step: resolved,
    total: LOAD_TOTAL_STEPS,
    fraction: resolved / LOAD_TOTAL_STEPS,
    label,
    known,
  };
}
