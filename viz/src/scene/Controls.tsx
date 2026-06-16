import { OrbitControls } from "@react-three/drei";

/** Orbit / zoom / pan camera (design §6). Damping on. */
export function Controls() {
  return (
    <OrbitControls
      makeDefault
      enableDamping
      dampingFactor={0.08}
      rotateSpeed={0.6}
      zoomSpeed={0.9}
      panSpeed={0.7}
      minDistance={2}
      maxDistance={600}
    />
  );
}
