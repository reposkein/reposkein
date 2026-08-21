import { describe, it, expect } from "vitest";
import { LOAD_TOTAL_STEPS, loadProgress } from "./loadPhase";

/** Every phase string the worker (data/worker/graph.worker.ts) and static-export
 *  mode (state/store.tsx) actually post. Listed here verbatim so adding a phase
 *  to the pipeline without teaching the loader about it shows up as a red test
 *  rather than as a loader that silently drops to indeterminate. */
const WORKER_PHASES = [
  "starting",
  "fetching manifest",
  "fetching graph",
  "parsing",
  "fetching federated repos",
  "restoring layout",
  "charting the sky",
  "parsing baked graph",
] as const;

describe("loadProgress", () => {
  it("recognizes every phase the worker posts", () => {
    for (const phase of WORKER_PHASES) {
      const p = loadProgress(phase);
      expect(p.known, `unmapped phase: ${phase}`).toBe(true);
      expect(p.label).toBe(phase);
      expect(p.step).toBeGreaterThanOrEqual(0);
      expect(p.step).toBeLessThanOrEqual(LOAD_TOTAL_STEPS);
    }
  });

  it("advances monotonically through the pipeline", () => {
    const ordered = [
      "starting",
      "fetching manifest",
      "fetching graph",
      "parsing",
      "charting the sky",
    ];
    const steps = ordered.map((p) => loadProgress(p).step);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!).toBeGreaterThanOrEqual(steps[i - 1]!);
    }
    expect(steps.at(-1)).toBe(LOAD_TOTAL_STEPS);
  });

  it("treats the two layout phases as the same step (cache hit vs fresh chart)", () => {
    expect(loadProgress("restoring layout").step).toBe(loadProgress("charting the sky").step);
  });

  it("reports the fraction as step/total", () => {
    expect(loadProgress("starting").fraction).toBe(0);
    expect(loadProgress("fetching graph").fraction).toBeCloseTo(2 / LOAD_TOTAL_STEPS, 6);
    expect(loadProgress("charting the sky").fraction).toBe(1);
  });

  it("is case- and whitespace-insensitive on lookup, but echoes the label as given", () => {
    const p = loadProgress("  Fetching Graph  ");
    expect(p.known).toBe(true);
    expect(p.step).toBe(loadProgress("fetching graph").step);
    expect(p.label).toBe("Fetching Graph");
  });

  it("degrades to indeterminate (step 0, known:false) for an unrecognized phase", () => {
    const p = loadProgress("reticulating splines");
    expect(p.known).toBe(false);
    expect(p.step).toBe(0);
    expect(p.fraction).toBe(0);
    expect(p.label).toBe("reticulating splines");
  });

  it("handles an empty phase without inventing progress", () => {
    const p = loadProgress("");
    expect(p.known).toBe(false);
    expect(p.label).toBe("");
  });
});
