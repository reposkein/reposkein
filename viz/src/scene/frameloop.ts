import { useFrame } from "@react-three/fiber";

/** The `frameloop="demand"` contract for this scene.
 *
 *  The Canvas renders ONLY when something calls `invalidate()`. R3F does that
 *  for React commits and pointer events, and drei's <CameraControls> does it for
 *  every camera transition — so navigation, expansion and selection are covered
 *  for free. What is NOT covered is anything that animates by mutating a
 *  material/attribute inside `useFrame`: nothing in the scene graph changed, so
 *  without an explicit invalidate the animation runs for exactly one frame and
 *  freezes.
 *
 *  Every such animator must therefore ask for the next frame WHILE IT IS ACTIVE
 *  and stop asking when it settles. The audit (keep this list current):
 *
 *  | animator                     | active while                  | invalidates |
 *  |------------------------------|-------------------------------|-------------|
 *  | StarField entrance fade      | first ~1.1 s after mount      | yes (self)  |
 *  | StarField expand morph       | ~MORPH_MS after an expand     | yes (self)  |
 *  | StarField collapse depart    | ~MORPH_MS after a collapse    | yes (self)  |
 *  | FlowParticles drift          | any bundle is drawn           | yes (self)  |
 *  | Controls idle drift          | store.idleDrift && idle       | yes (self)  |
 *  | drei <Stars> twinkle         | always mounted                | via useContinuousFrames |
 *  | Bloom / EffectComposer       | composites whatever frame runs | n/a        |
 *  | TemporalLinks, EdgeLines,    | static geometry               | n/a         |
 *  | ConstellationLines, Labels   |                               |             |
 *
 *  Two of those are *unconditionally* animating today (the decorative starfield
 *  twinkle and the flow particles), so in practice the loop stays warm while the
 *  graph is on screen. That is intentional for this task — zero visual change —
 *  and it makes the payoff a single flip: gate those two behind the motion
 *  preference and `demand` starts genuinely idling, with no other code to touch.
 */

/** Requests a frame every frame while `active`. For animators that have no
 *  natural end (decorative loops) — everything with an end state should
 *  invalidate from its own useFrame and stop, so the loop can settle. */
export function useContinuousFrames(active = true): void {
  useFrame(({ invalidate }) => {
    if (active) invalidate();
  });
}
