/** Edge-direction flow particles — pure allocation logic (design: motion §P1).
 *
 *  Given the currently-drawn edge bundles (the SAME rolled-up cluster↔cluster
 *  connections EdgeLines renders), allocate a capped budget of small pulses
 *  that travel from each bundle's SOURCE (caller) to its TARGET (callee),
 *  conveying direction + life. The allocation is pure & deterministic so it can
 *  be unit-tested; the actual GPU advance (t = (t + dt*speed) % 1; pos =
 *  lerp(from,to,t)) happens in the scene component's useFrame.
 *
 *  Budgeting: each visible bundle gets at least one particle (when within
 *  budget); higher-traffic bundles get a few more (log-scaled). When the bundle
 *  count exceeds the budget we SAMPLE deterministically (every k-th bundle),
 *  always keeping bundles flagged `priority` (incident to the selected/hovered
 *  node). Designed so the worst case stays a few thousand particles even on the
 *  ~10k-edge design target.
 */

import type { EdgeBundle } from "../data/clientModel";

/** One scheduled particle: which bundle it rides and its phase offset so a
 *  bundle's multiple particles are spread along the edge rather than stacked. */
export interface FlowParticle {
  /** Index into the bundle array passed to `allocateParticles`. */
  bundleIndex: number;
  /** Initial phase in [0,1); the live position is (phase + t) % 1. */
  phase: number;
}

export interface FlowAllocation {
  /** Scheduled particles (length ≤ budget). */
  particles: FlowParticle[];
}

/** Particles per bundle as a function of member count (log-scaled): a single
 *  pulse for a thin connection, a few for a heavily-trafficked bundle. */
export function particlesForBundle(count: number): number {
  return Math.min(4, 1 + Math.floor(Math.log2(1 + count)));
}

/** Deterministic phase for the j-th particle of an n-particle bundle: evenly
 *  spaced in [0,1) so pulses trail one another along the edge. */
function phaseFor(j: number, n: number): number {
  return n <= 1 ? 0 : j / n;
}

/** Allocate a capped, deterministic set of flow particles over `bundles`.
 *
 *  @param bundles  the drawn edge bundles (order is the caller's draw order).
 *  @param budget   hard cap on total particles (default 3000).
 *  @param isPriority optional predicate: bundles it returns true for are ALWAYS
 *                   kept (incident to selection/hover) and may carry extra
 *                   particles. Priority bundles are allocated first.
 *
 *  Pure & deterministic: same inputs → identical output (and identical order),
 *  so the GPU buffer is stable frame-to-frame until the inputs change.
 */
export function allocateParticles(
  bundles: EdgeBundle[],
  budget = 3000,
  isPriority?: (b: EdgeBundle, index: number) => boolean,
): FlowAllocation {
  const particles: FlowParticle[] = [];
  if (bundles.length === 0 || budget <= 0) return { particles };

  // Partition indices into priority vs normal, preserving draw order.
  const priorityIdx: number[] = [];
  const normalIdx: number[] = [];
  for (let i = 0; i < bundles.length; i++) {
    if (isPriority && isPriority(bundles[i]!, i)) priorityIdx.push(i);
    else normalIdx.push(i);
  }

  const push = (bundleIndex: number, n: number) => {
    for (let j = 0; j < n && particles.length < budget; j++) {
      particles.push({ bundleIndex, phase: phaseFor(j, n) });
    }
  };

  // 1) Priority bundles first — always represented (at least one pulse each),
  //    with their full log-scaled count when budget allows.
  for (const i of priorityIdx) {
    if (particles.length >= budget) break;
    push(i, particlesForBundle(bundles[i]!.count));
  }

  // 2) Normal bundles. If they all fit one-per-bundle within the remaining
  //    budget, emit them all (and top up high-traffic ones if room remains);
  //    otherwise SAMPLE every k-th bundle deterministically so coverage is
  //    spread uniformly across the draw order rather than front-loaded.
  const remaining = budget - particles.length;
  if (remaining > 0 && normalIdx.length > 0) {
    if (normalIdx.length <= remaining) {
      // One pulse each (cheap, guarantees direction is visible everywhere)...
      for (const i of normalIdx) push(i, 1);
      // ...then a second pass topping up heavier bundles while budget remains.
      for (const i of normalIdx) {
        if (particles.length >= budget) break;
        const extra = particlesForBundle(bundles[i]!.count) - 1;
        for (let j = 1; j <= extra && particles.length < budget; j++) {
          particles.push({ bundleIndex: i, phase: phaseFor(j, extra + 1) });
        }
      }
    } else {
      // More bundles than budget: keep every k-th so we cover the whole graph.
      const k = Math.ceil(normalIdx.length / remaining);
      for (let n = 0; n < normalIdx.length && particles.length < budget; n += k) {
        push(normalIdx[n]!, 1);
      }
    }
  }

  return { particles };
}
