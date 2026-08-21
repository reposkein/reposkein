import { Stars } from "@react-three/drei";
import { useContinuousFrames } from "./frameloop";

/** The decorative background starfield (depth cue behind the graph).
 *
 *  drei's <Stars> pulses every star's point size from a `time` uniform it
 *  advances in its own useFrame — a material mutation, invisible to R3F's
 *  scene-graph tracking. Under `frameloop="demand"` that twinkle would freeze on
 *  the first frame, so this wrapper keeps asking for frames. It exists purely to
 *  make that dependency explicit and greppable: when the redesign adds a motion
 *  preference, `useContinuousFrames(!reduceMotion)` here (and in FlowParticles)
 *  is what lets the frameloop actually idle.
 *
 *  Parameters are the values the scene has always used — do not tune them here. */
export function BackgroundStars() {
  useContinuousFrames();
  return (
    <Stars radius={600} depth={120} count={2600} factor={6} saturation={0} fade speed={0.6} />
  );
}
