import { useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { StoreProvider, useStore } from "../state/store";
import { StarField } from "../scene/StarField";
import { BackgroundStars } from "../scene/BackgroundStars";
import { NebulaHalos } from "../scene/NebulaHalos";
import { ConstellationLines } from "../scene/ConstellationLines";
import { EdgeLines } from "../scene/EdgeLines";
import { FlowParticles } from "../scene/FlowParticles";
import { Labels } from "../scene/Labels";
import { Controls } from "../scene/Controls";
import { TemporalLinks } from "../scene/TemporalLinks";
import { fetchTemporal } from "../data/temporal";
import { DetailPanel } from "../panels/DetailPanel";
import { FilterHUD } from "../panels/FilterHUD";
import { SearchPanel } from "../panels/SearchPanel";
import { CommandPalette } from "../panels/CommandPalette";
import { LegendPanel } from "../panels/LegendPanel";
import { MinimapPanel } from "../panels/MinimapPanel";
import { StatusBar } from "../panels/StatusBar";
import { BRAND } from "../scene/encoding";
import { pickNeighbor } from "../data/navigate";
import { resolveNodeFallback } from "../data/nodeFallback";
import { CaptureBridge } from "../scene/Screenshot";

export function Root() {
  return (
    <StoreProvider>
      <View />
    </StoreProvider>
  );
}

function View() {
  const store = useStore();
  const search = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
  const nodeFromUrl = search.node;

  // Keyboard navigation (design §P4):
  //   /            → focus the search input
  //   f            → frame-all / reset view
  //   Esc          → collapse one LOD level (back) — also clears the search box
  //   Arrow / Tab  → with a node selected, hop to a connected neighbor
  // Typing inside an input/textarea is left alone (except Esc, handled there).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      // While the guided tour is active it owns the keyboard (TourController
      // handles Esc on the capture phase); don't let normal nav keys interfere.
      if (store.tour) return;

      if (e.key === "Escape") {
        if (!typing) store.collapseLevel();
        return;
      }
      if (typing) return; // don't hijack keys while the user is typing

      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("reposkein-search")?.focus();
        return;
      }
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        store.resetView();
        return;
      }

      // Neighbor hopping requires a selected node with a known model.
      const model = store.model;
      if (!model || !store.selected) return;
      let dir: "next" | "prev" | null = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") dir = "next";
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") dir = "prev";
      else if (e.key === "Tab") dir = e.shiftKey ? "prev" : "next";
      if (!dir) return;
      e.preventDefault();
      const next = pickNeighbor(model.drawEdges, store.selected, dir);
      if (!next) return;
      // Reveal (expand ancestors) → select → fly to it, as ONE transition.
      store.revealAndSelect(next, { fly: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  // On mount (or when model becomes ready), if there's a nodeId in the URL,
  // expand ancestors + select + fly to it. An id that no longer exists (the
  // repo moved on since the link was shared/baked) tries a suffix-based
  // fallback (survives a repo_id change) before giving up and showing a
  // dismissible "not found" notice instead of silently doing nothing.
  const [nodeNotice, setNodeNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!store.model || !nodeFromUrl) return;
    const model = store.model;
    let id = nodeFromUrl;
    if (!model.records.has(id)) {
      const fallback = resolveNodeFallback(id, model.records.keys());
      if (!fallback) {
        setNodeNotice(nodeFromUrl);
        return;
      }
      id = fallback;
    }
    setNodeNotice(null);
    store.revealAndSelect(id, { fly: true });
  }, [store.model, nodeFromUrl]); // intentional: only re-run when model or URL node changes

  // Lazily fetch the temporal co-change map the first time the Coupling overlay
  // is enabled. Best-effort: fetchTemporal never throws (returns {} on failure),
  // so the overlay degrades to "no temporal data" without breaking the render.
  useEffect(() => {
    if (!store.coupling || store.cochange !== null) return;
    let cancelled = false;
    void fetchTemporal().then((map) => {
      if (!cancelled) store.setCochange(map);
    });
    return () => {
      cancelled = true;
    };
  }, [store.coupling, store.cochange]); // re-run when the toggle flips on

  // When selected changes, update the URL.
  useEffect(() => {
    navigate({
      search: store.selected ? { node: store.selected } : {},
      replace: true,
    });
  }, [store.selected]); // intentional: navigate identity is stable

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
        // Render on demand, not on a wall-clock loop: every frame now has a
        // reason. R3F invalidates for React commits + pointer events and drei's
        // CameraControls for every camera transition; each useFrame animator
        // asks for its own frames while it runs (see scene/frameloop.ts for the
        // full audit — that file is the contract, keep it accurate).
        frameloop="demand"
        // preserveDrawingBuffer keeps the back buffer readable so the PNG export
        // (CaptureBridge) can serialize the composited frame. Small perf cost,
        // acceptable for a viewer (design: share & scale §P1).
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        style={{ background: "transparent" }}
        // Click on empty space (no mesh hit) → collapse one level + refit.
        onPointerMissed={(e) => {
          if (e.button === 0) store.collapseLevel();
        }}
      >
        {/* Exponential depth fog tuned to the navy background: distant stars and
            edges fade with distance as a depth cue. Density is deliberately low
            (~the fitted distance of an expanded cluster is tens of units, where
            the fog factor is only a few percent, so the focused region stays
            crisp and bloom still reads) — distant cross-graph links and the
            background starfield (radius 600) sink into the navy. */}
        <fogExp2 attach="fog" args={[0x070a12, 0.0016]} />
        <ambientLight intensity={0.6} />
        {/* Background starfield for depth (decorative, behind the graph). */}
        <BackgroundStars />
        {store.status.kind === "ready" && store.model && (
          <>
            <NebulaHalos />
            <ConstellationLines />
            <StarField />
            <EdgeLines />
            <FlowParticles />
            <TemporalLinks />
            {store.showLabels && <Labels />}
          </>
        )}
        <Controls />
        <CaptureBridge repoId={store.model?.repoId} />
        <EffectComposer>
          <Bloom
            luminanceThreshold={0.2}
            luminanceSmoothing={0.4}
            intensity={0.9}
            mipmapBlur
          />
        </EffectComposer>
      </Canvas>

      {/* SearchPanel keeps its top-left spot and its '/' binding; it retires
          fully in V3 (design: Astrolabe V2 status bar, REP-18). No longer
          wrapped by HeaderBar — rendered standalone, tokens-consistent. */}
      {store.model && (
        <div className="absolute left-3 top-3 z-[25]">
          <SearchPanel />
        </div>
      )}
      <StatusBar />
      <CommandPalette />
      {nodeNotice && (
        <NodeMovedNotice nodeId={nodeNotice} onDismiss={() => setNodeNotice(null)} />
      )}
      {store.status.kind === "ready" && <DetailPanel />}
      {store.status.kind === "ready" && <FilterHUD />}
      {store.status.kind === "ready" && <LegendPanel />}
      {store.status.kind === "ready" && store.model && <MinimapPanel />}
      <LoaderGate />
      {store.status.kind === "error" && <Overlay text={`Error: ${store.status.message}`} error />}
    </div>
  );
}

/** Dismissible notice shown when a `?node=<id>` deep link doesn't resolve to
 *  any node currently in the loaded graph (and the suffix-based fallback in
 *  data/nodeFallback.ts found nothing either) — a shared/baked link can
 *  outlive the node it pointed at. Replaces silently ignoring the param. */
function NodeMovedNotice({ nodeId, onDismiss }: { nodeId: string; onDismiss: () => void }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        maxWidth: 320,
        fontSize: 12,
        padding: "8px 12px",
        borderRadius: 8,
        background: "rgba(8,11,22,0.9)",
        border: `1px solid ${BRAND.amber}66`,
        color: BRAND.cream,
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
      }}
    >
      <span style={{ flex: 1 }}>
        Node not found — it may have been renamed or removed.
        <span
          style={{
            display: "block",
            opacity: 0.6,
            fontSize: 11,
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={nodeId}
        >
          {nodeId}
        </span>
      </span>
      <button
        onClick={onDismiss}
        title="Dismiss"
        style={{
          background: "transparent",
          border: "none",
          color: BRAND.cream,
          opacity: 0.7,
          cursor: "pointer",
          fontSize: 13,
          lineHeight: 1,
          padding: 0,
        }}
      >
        ✕
      </button>
    </div>
  );
}

/** Loading polish (design §P4): a tasteful centered loader shown while the
 *  worker charts the layout (status !== ready). A soft pulsing constellation
 *  glyph + "Charting the constellation…" with the live phase. When the model
 *  becomes ready the overlay fades out over ~700ms (kept mounted for the fade,
 *  then removed) so the scene doesn't pop in over a blank canvas. */
function LoaderGate() {
  const store = useStore();
  const loading = store.status.kind === "loading";
  const phase = store.status.kind === "loading" ? store.status.phase : "";
  // `fading` keeps the overlay mounted briefly after ready for the fade-out.
  const [mounted, setMounted] = useState(true);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (loading) {
      setMounted(true);
      setVisible(true);
      return;
    }
    // Ready (or error): fade out, then unmount.
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 700);
    return () => clearTimeout(t);
  }, [loading]);

  if (!mounted) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        pointerEvents: "none",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.7s ease",
        background:
          "radial-gradient(ellipse 60% 50% at 50% 50%, rgba(5,6,12,0.55) 0%, rgba(5,6,12,0) 70%)",
      }}
    >
      <style>
        {`@keyframes rs-pulse {
            0%,100% { transform: scale(0.9); opacity: 0.55; }
            50%     { transform: scale(1.12); opacity: 1; }
          }
          @keyframes rs-spin { to { transform: rotate(360deg); } }`}
      </style>
      {/* Pulsing core ringed by a slow-spinning halo (the "constellation"). */}
      <div style={{ position: "relative", width: 64, height: 64 }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            border: `2px solid ${BRAND.teal}55`,
            borderTopColor: BRAND.amber,
            animation: "rs-spin 1.6s linear infinite",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 18,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${BRAND.amber} 0%, ${BRAND.amber}00 70%)`,
            animation: "rs-pulse 1.8s ease-in-out infinite",
          }}
        />
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 15, color: BRAND.cream, letterSpacing: 0.4 }}>
          Charting the constellation…
        </div>
        {phase && (
          <div style={{ fontSize: 11, color: "rgba(160,180,220,0.6)", marginTop: 4 }}>
            {phase}
          </div>
        )}
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
