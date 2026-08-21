import { useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { StoreProvider, useEdgeStats, useStore } from "../state/store";
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
import { LegendPanel } from "../panels/LegendPanel";
import { LensSwitcher } from "../panels/LensSwitcher";
import { MinimapPanel } from "../panels/MinimapPanel";
import { TourController } from "../panels/TourController";
import { BRAND } from "../scene/encoding";
import { pickNeighbor } from "../data/navigate";
import { resolveNodeFallback } from "../data/nodeFallback";
import { badgeInfo, teamConstellationHref } from "../data/badge";
import { CaptureBridge, captureScreenshot } from "../scene/Screenshot";

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
            <Labels />
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

      <HeaderBar />
      {nodeNotice && (
        <NodeMovedNotice nodeId={nodeNotice} onDismiss={() => setNodeNotice(null)} />
      )}
      {store.status.kind === "ready" && store.model && <Breadcrumb />}
      {store.status.kind === "ready" && <DetailPanel />}
      {store.status.kind === "ready" && <LensSwitcher />}
      {store.status.kind === "ready" && <FilterHUD />}
      {store.status.kind === "ready" && <LegendPanel />}
      {store.status.kind === "ready" && store.model && <MinimapPanel />}
      <LoaderGate />
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
        {store.model && (
          <button
            onClick={() => captureScreenshot()}
            title="Capture a PNG screenshot of the current view"
            style={{
              padding: "2px 10px",
              fontSize: 11,
              borderRadius: 5,
              border: `1px solid ${BRAND.teal}66`,
              background: `${BRAND.teal}1f`,
              color: BRAND.cream,
              cursor: "pointer",
              letterSpacing: 0.3,
            }}
          >
            Screenshot
          </button>
        )}
        {store.model && teamConstellationHref(store.model.repoMeta) && (
          <a
            href={teamConstellationHref(store.model.repoMeta)!}
            target="_blank"
            rel="noreferrer"
            title="Open this team's published constellation (configured in .reposkein/config.toml [team] pages_url)"
            style={{
              padding: "2px 10px",
              fontSize: 11,
              borderRadius: 5,
              border: `1px solid ${BRAND.amber}66`,
              background: `${BRAND.amber}1f`,
              color: BRAND.cream,
              cursor: "pointer",
              letterSpacing: 0.3,
              textDecoration: "none",
            }}
          >
            Team constellation ↗
          </a>
        )}
        {store.model && <TourController />}
      </div>
      {store.model && (
        <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
          {store.model.repoId} · {counts?.nodes ?? 0} nodes · {counts?.edges ?? 0} edges
        </div>
      )}
      {store.model && <StalenessBadge />}
      {store.model && <EdgeStatsReadout />}
      <div style={{ fontSize: 11, opacity: 0.55, marginTop: 2 }}>
        scroll = zoom · drag = orbit · click cluster = expand · click star = inspect · Esc / click space = back
      </div>
      <div style={{ fontSize: 11, opacity: 0.45, marginTop: 1 }}>
        keys: / search · f frame all · ←→ / Tab hop neighbor
      </div>
      {store.model && <SearchPanel />}
    </div>
  );
}

/** "showing N of M connections" — its own component precisely so it can
 *  subscribe to the edgeStats CHANNEL. EdgeLines republishes the counters on
 *  every render pass (expand, filter, hover-driven rebuild); when they lived in
 *  the reducer that re-rendered the whole HUD for a number nothing else reads.
 *  The inline style is the HeaderBar row's, moved verbatim to keep this task at
 *  zero visual change; it migrates to Tailwind with the rest of HeaderBar in
 *  REP-18. */
function EdgeStatsReadout() {
  const { drawn, total } = useEdgeStats();
  if (total <= 0) return null;
  return (
    <div
      style={{ fontSize: 11, opacity: 0.6, marginTop: 1 }}
      title="Edge bundles currently drawn / total bundles before the render cap"
    >
      showing {drawn} of {total} connections
      {drawn < total ? " (capped)" : ""}
    </div>
  );
}

/** "graph @ <short-sha> · <relative age>" — shown when the loaded model carries
 *  bake-time/server-start provenance (static export: baked by `runExport`;
 *  server mode: resolved once from git at server start). Age is recomputed
 *  every render (cheap: Date.now() + arithmetic) so it stays fresh across a
 *  long-lived tab without a timer. Links to the commit when a repoUrl was
 *  resolvable; otherwise renders as plain (unlinked) text. Matches the
 *  existing inline-style HeaderBar rows — no new visual system introduced. */
function StalenessBadge() {
  const store = useStore();
  const info = badgeInfo(store.model?.repoMeta ?? null);
  if (!info) return null;
  const text = (
    <span
      style={{ color: "rgba(200,210,235,0.85)" }}
      title={store.model?.repoMeta?.builtAt ? `baked ${store.model.repoMeta.builtAt}` : undefined}
    >
      {info.label}
    </span>
  );
  return (
    <div style={{ fontSize: 11, opacity: 0.75, marginTop: 1 }}>
      {info.href ? (
        <a
          href={info.href}
          target="_blank"
          rel="noreferrer"
          style={{ color: "inherit", textDecoration: "none" }}
        >
          {text}
        </a>
      ) : (
        text
      )}
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
    // Only ancestor crumbs navigate. The trailing crumb for a selected SYMBOL is
    // not on the cluster chain (it's the leaf itself) and has always been inert —
    // keep it that way, or clicking it would re-frame the current selection.
    if (chain.indexOf(key) === -1) return;
    // ONE transition: open the chain up to this crumb, shut everything below it,
    // select it and fly there. `collapseDeeper` reproduces the old two-loop walk
    // (expand root→crumb, collapse strict descendants) inside the reducer, which
    // is also what collapses the N fitNonce bumps into one.
    store.revealAndSelect(key, { fly: true, collapseDeeper: true });
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
