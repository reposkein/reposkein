import { useEffect } from "react";
import { Canvas } from "@react-three/fiber";
import { Stars } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { StoreProvider, useStore } from "../state/store";
import { StarField } from "../scene/StarField";
import { EdgeLines } from "../scene/EdgeLines";
import { Labels } from "../scene/Labels";
import { Controls } from "../scene/Controls";
import { DetailPanel } from "../panels/DetailPanel";

export function Root() {
  return (
    <StoreProvider>
      <View />
    </StoreProvider>
  );
}

function View() {
  const store = useStore();

  // Esc collapses one LOD level and refits to the parent (design §5 navigation).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") store.collapseLevel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Nebula depth gradient behind the canvas (dark navy palette). */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse 80% 60% at 50% 38%, #16204a 0%, #0a1024 42%, #05060c 78%, #02030a 100%)",
          pointerEvents: "none",
        }}
      />
      <Canvas
        camera={{ position: [0, 0, 160], fov: 55, near: 0.1, far: 6000 }}
        gl={{ antialias: true }}
        style={{ background: "transparent" }}
        // Click on empty space (no mesh hit) → collapse one level + refit.
        onPointerMissed={(e) => {
          if (e.button === 0) store.collapseLevel();
        }}
      >
        <ambientLight intensity={0.6} />
        {/* Background starfield for depth (decorative, behind the graph). */}
        <Stars radius={600} depth={120} count={2600} factor={6} saturation={0} fade speed={0.6} />
        {store.status.kind === "ready" && store.model && (
          <>
            <StarField />
            <EdgeLines />
            <Labels />
          </>
        )}
        <Controls />
        <EffectComposer>
          <Bloom
            luminanceThreshold={0.2}
            luminanceSmoothing={0.4}
            intensity={0.9}
            mipmapBlur
          />
        </EffectComposer>
      </Canvas>

      <HeaderBar />
      {store.status.kind === "ready" && <DetailPanel />}
      {store.status.kind === "loading" && <Overlay text={`Charting the sky… (${store.status.phase})`} />}
      {store.status.kind === "error" && <Overlay text={`Error: ${store.status.message}`} error />}
    </div>
  );
}

function HeaderBar() {
  const store = useStore();
  const counts = store.model?.counts;
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        left: 12,
        fontSize: 13,
        padding: "8px 12px",
        borderRadius: 8,
        background: "rgba(8,11,22,0.85)",
        border: "1px solid rgba(90,120,180,0.35)",
      }}
    >
      <div style={{ fontWeight: 600 }}>RepoSkein Constellation</div>
      {store.model && (
        <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
          {store.model.repoId} · {counts?.nodes ?? 0} nodes · {counts?.edges ?? 0} edges
        </div>
      )}
      <div style={{ fontSize: 11, opacity: 0.55, marginTop: 2 }}>
        scroll = zoom · drag = orbit · click cluster = expand · click star = inspect · Esc / click space = back
      </div>
    </div>
  );
}

function Overlay({ text, error }: { text: string; error?: boolean }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
        color: error ? "#ff8a8a" : "#cdd6ea",
        fontSize: 15,
      }}
    >
      {text}
    </div>
  );
}
