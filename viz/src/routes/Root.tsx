import { useEffect } from "react";
import { Canvas } from "@react-three/fiber";
import { Stars } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { StoreProvider, useStore } from "../state/store";
import { StarField } from "../scene/StarField";
import { NebulaHalos } from "../scene/NebulaHalos";
import { ConstellationLines } from "../scene/ConstellationLines";
import { EdgeLines } from "../scene/EdgeLines";
import { Labels } from "../scene/Labels";
import { Controls } from "../scene/Controls";
import { TemporalLinks } from "../scene/TemporalLinks";
import { fetchTemporal } from "../data/temporal";
import { DetailPanel } from "../panels/DetailPanel";
import { FilterHUD } from "../panels/FilterHUD";
import { SearchPanel } from "../panels/SearchPanel";
import { LegendPanel } from "../panels/LegendPanel";
import { LensSwitcher } from "../panels/LensSwitcher";
import { BRAND } from "../scene/encoding";

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

  // Esc collapses one LOD level and refits to the parent (design §5 navigation).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") store.collapseLevel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  // On mount (or when model becomes ready), if there's a nodeId in the URL,
  // expand ancestors + select + fly to it.
  useEffect(() => {
    if (!store.model || !nodeFromUrl) return;
    const model = store.model;
    const id = nodeFromUrl;
    if (!model.records.has(id)) return; // unknown id, ignore
    const clusterKey = model.clusterOfNode.get(id) ?? id;
    const chain = model.ancestors.get(clusterKey);
    if (chain) {
      for (const ak of chain) {
        const c = model.byKey.get(ak);
        if (c && c.children.length > 0 && !store.expanded.has(ak)) {
          store.toggleExpand(ak);
        }
      }
    }
    store.select(id);
    store.setFocusTarget(id);
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
        gl={{ antialias: true }}
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
        <Stars radius={600} depth={120} count={2600} factor={6} saturation={0} fade speed={0.6} />
        {store.status.kind === "ready" && store.model && (
          <>
            <NebulaHalos />
            <ConstellationLines />
            <StarField />
            <EdgeLines />
            <TemporalLinks />
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
      {store.status.kind === "ready" && store.model && <Breadcrumb />}
      {store.status.kind === "ready" && <DetailPanel />}
      {store.status.kind === "ready" && <LensSwitcher />}
      {store.status.kind === "ready" && <FilterHUD />}
      {store.status.kind === "ready" && <LegendPanel />}
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
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 600, color: BRAND.amber }}>RepoSkein Constellation</span>
        {store.model && (
          <button
            onClick={() => store.resetView()}
            title="Frame all — collapse to top level"
            style={{
              marginLeft: 8,
              padding: "2px 10px",
              fontSize: 11,
              borderRadius: 5,
              border: `1px solid ${BRAND.amber}66`,
              background: `${BRAND.amber}1f`,
              color: BRAND.cream,
              cursor: "pointer",
              letterSpacing: 0.3,
            }}
          >
            Frame all
          </button>
        )}
      </div>
      {store.model && (
        <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
          {store.model.repoId} · {counts?.nodes ?? 0} nodes · {counts?.edges ?? 0} edges
        </div>
      )}
      <div style={{ fontSize: 11, opacity: 0.55, marginTop: 2 }}>
        scroll = zoom · drag = orbit · click cluster = expand · click star = inspect · Esc / click space = back
      </div>
      {store.model && <SearchPanel />}
    </div>
  );
}

/** Breadcrumb strip showing the ancestor path of the selected node.
 *  Clicking a crumb expands up to that level and resets view below it. */
function Breadcrumb() {
  const store = useStore();
  const model = store.model!;

  if (!store.selected) return null;

  // Resolve the cluster key for the selected node.
  const clusterKey = model.clusterOfNode.get(store.selected) ?? store.selected;
  const chain = model.ancestors.get(clusterKey) ?? [clusterKey];

  // Build crumb labels from the ancestor chain.
  const crumbs = chain.map((key) => {
    const c = model.byKey.get(key);
    return { key, label: c?.name ?? key };
  });
  // Add the selected node itself if it's a symbol (leaf, not in ancestor chain as cluster).
  const rec = model.records.get(store.selected);
  if (rec && !model.byKey.has(store.selected)) {
    crumbs.push({ key: store.selected, label: rec.name });
  }

  function navigateToCrumb(key: string) {
    // Find the chain position and expand up to (and including) this crumb,
    // collapse anything deeper by toggling off.
    const chainIdx = chain.indexOf(key);
    if (chainIdx === -1) return;
    // Expand all ancestors up to this key.
    for (let i = 0; i <= chainIdx; i++) {
      const k = chain[i]!;
      const c = model.byKey.get(k);
      if (c && c.children.length > 0 && !store.expanded.has(k)) {
        store.toggleExpand(k);
      }
    }
    // Collapse any expanded clusters deeper than chainIdx.
    for (const expandedKey of store.expanded) {
      if (expandedKey === model.rootKey) continue;
      const ekChain = model.ancestors.get(expandedKey);
      if (!ekChain) continue;
      const ekIdx = ekChain.indexOf(key);
      // If this expanded key is a descendant of the crumb key (and deeper), collapse it.
      if (ekIdx !== -1 && ekChain.length - 1 > chainIdx) {
        store.toggleExpand(expandedKey);
      }
    }
    store.select(key);
    store.setFocusTarget(key);
  }

  return (
    <div
      style={{
        position: "absolute",
        top: 132,
        left: 12,
        display: "flex",
        alignItems: "center",
        gap: 4,
        fontSize: 12,
        background: "rgba(8,11,22,0.78)",
        border: "1px solid rgba(90,120,180,0.25)",
        borderRadius: 6,
        padding: "4px 10px",
        maxWidth: "calc(100vw - 420px)",
        overflow: "hidden",
        flexWrap: "nowrap",
      }}
    >
      {crumbs.map((crumb, i) => (
        <span key={crumb.key} style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          {i > 0 && <span style={{ opacity: 0.4, flexShrink: 0 }}>›</span>}
          <span
            onClick={() => navigateToCrumb(crumb.key)}
            style={{
              cursor: i < crumbs.length - 1 ? "pointer" : "default",
              color: i === crumbs.length - 1 ? "#dfe6f5" : "rgba(160,180,220,0.7)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 200,
            }}
            title={crumb.label}
          >
            {crumb.label}
          </span>
        </span>
      ))}
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
