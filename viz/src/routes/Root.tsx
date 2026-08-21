import { useEffect, useRef, useState } from "react";
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
import { getCameraView } from "../scene/Controls";
import { HopTrail } from "../scene/HopTrail";
import { isNodeOnScreen } from "../scene/onScreen";
import { getCameraPose } from "../state/cameraPose";
import { TemporalLinks } from "../scene/TemporalLinks";
import { fetchTemporal } from "../data/temporal";
import { CommandPalette } from "../panels/CommandPalette";
import { ChromeGroup } from "../panels/ChromeGroup";
import { Inspector } from "../panels/Inspector";
import { LayerHost } from "../panels/LayerHost";
import { StatusBar } from "../panels/StatusBar";
import { TourController } from "../panels/TourController";
import { Toasts } from "../panels/Toasts";
import { ModeToasts } from "../panels/ModeToasts";
import { LoadingScreen } from "../panels/LoadingScreen";
import { ErrorScreen } from "../panels/ErrorScreen";
import { toggleLayer } from "../panels/layerState";
import { isCommandPaletteOpen, requestCommandPalette } from "../panels/paletteOpenState";
import { handleGlobalKey } from "../panels/globalKeys";
import { handlePointerMissed } from "../scene/pointerMissed";
import { resolveNodeFallback } from "../data/nodeFallback";
import {
  encodeViewSearch,
  isDefaultView,
  parseViewSearch,
  sameViewSearch,
} from "../data/urlState";
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

  // Global keys. The bindings themselves live in `panels/globalKeys.ts` (a pure
  // function over a plain event shape) so they can be tested without standing
  // up a WebGL harness — and so `data/keymap.ts`, which the help overlay
  // renders, can be diffed against them. This effect is just the listener.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      handleGlobalKey(e, store, store, {
        openPalette: requestCommandPalette,
        toggleLayer,
        paletteOpen: isCommandPaletteOpen,
        isOnScreen: (id) =>
          store.model
            ? isNodeOnScreen(store.model, id, getCameraPose(), getCameraView())
            : false,
      });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  const [nodeNotice, setNodeNotice] = useState<string | null>(null);

  /** THE INITIAL VIEW, captured ONCE (V4 §7).
   *
   *  The URL is both an input (restore this view) and an output (describe the
   *  current one), and the write-back effect below runs on mount — before the
   *  graph has loaded and therefore before anything can be restored. Reading the
   *  incoming params from live `search` would mean the write-back clears them
   *  first and the restore then finds nothing to do. Snapshotting on first
   *  render is what makes a cold deep link survive its own round trip. */
  const initialView = useRef(parseViewSearch(search)).current;
  /** Set once the initial view has been applied (or found to be empty). Until
   *  then the write-back holds off, for the reason above. */
  const restored = useRef(isDefaultView(initialView));

  // RESTORE. One shot, once the model exists: lens first (it resets filters and
  // clears audit, so anything applied before it would be wiped), then the node,
  // then the overlays — impact and focus need a selection to compute against.
  useEffect(() => {
    if (restored.current || !store.model) return;
    const model = store.model;

    if (initialView.lens && initialView.lens !== "all") store.setLens(initialView.lens);

    if (initialView.node) {
      let id = initialView.node;
      if (!model.records.has(id)) {
        const fallback = resolveNodeFallback(id, model.records.keys());
        if (!fallback) {
          setNodeNotice(initialView.node);
          id = "";
        } else {
          id = fallback;
        }
      }
      if (id) {
        setNodeNotice(null);
        store.revealAndSelect(id, { fly: true });
      }
    }

    const { impact, focus, coupling, audit } = initialView.overlays;
    // Depth before the toggle: `toggleFocus` computes against `focusDepth`, so
    // setting it afterwards would need a second recompute.
    if (focus !== null) {
      store.setFocusDepth(focus);
      store.toggleFocus();
    } else if (impact) {
      // `toggleFocus` clears impact and vice versa — they are mutually
      // exclusive in the reducer, so a link can only restore one. Focus wins
      // because it carries a depth, i.e. more of the reader's intent.
      store.toggleImpact();
    }
    if (coupling) store.toggleCoupling();
    if (audit) store.setAudit(audit);

    restored.current = true;
  }, [store.model]); // intentional: a one-shot restore, guarded by `restored`

  // A later ?node change (the reader edits the URL, or a back/forward that
  // lands on a different node) still reveals, exactly as it did in V3.
  const nodeFromUrl = search.node;
  useEffect(() => {
    if (!restored.current || !store.model || !nodeFromUrl) return;
    if (nodeFromUrl === store.selected) return;
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

  // WRITE BACK. The URL always describes the CURRENT view, so the browser's
  // address bar (and therefore Copy link, which reads `window.location.href`)
  // carries the lens and the overlays too, not just the node.
  //
  // `replace` + the `sameViewSearch` guard together keep this out of the
  // browser's own history: this is a mirror of app state, not a navigation, and
  // pushing an entry per reducer transition would make the back button walk
  // through mode toggles.
  const nextSearch = encodeViewSearch(store);
  useEffect(() => {
    if (!restored.current) return;
    if (sameViewSearch(nextSearch, search)) return;
    navigate({ search: nextSearch, replace: true });
    // Intentional deps: `navigate` identity is stable, and `search` is read for
    // the equality guard only — depending on it would re-run this effect with
    // its own output.
  }, [nextSearch.node, nextSearch.lens, nextSearch.overlays]);

  return (
    <div className="relative h-full w-full">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_38%,#16204a_0%,#0a1024_42%,#05060c_78%,#02030a_100%)]" />
      <Canvas
        camera={{ position: [0, 0, 160], fov: 55, near: 0.1, far: 6000 }}
        frameloop="demand"
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        style={{ background: "transparent" }}
        onPointerMissed={(e) => handlePointerMissed(e, store)}
      >
        <fogExp2 attach="fog" args={[0x070a12, 0.0016]} />
        <ambientLight intensity={0.6} />
        <BackgroundStars />
        {store.status.kind === "ready" && store.model && (
          <>
            <NebulaHalos />
            <ConstellationLines />
            <StarField />
            <EdgeLines />
            <FlowParticles />
            <TemporalLinks />
            <HopTrail />
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

      {/* CINEMATIC MODE (V3 §3): everything in here fades while the guided tour
          runs — status bar, inspector, layers, toasts, deep-link notice. The
          tour's caption and transport are rendered OUTSIDE the group, which is
          the whole reason TourController no longer lives inside the status bar
          (it would have faded with it). See panels/ChromeGroup.tsx. */}
      <ChromeGroup hidden={store.tour}>
        <StatusBar />
        {store.status.kind === "ready" && <Inspector />}
        <LayerHost />
        {nodeNotice && (
          <NodeMovedNotice nodeId={nodeNotice} onDismiss={() => setNodeNotice(null)} />
        )}
        <Toasts />
      </ChromeGroup>

      {/* Above the fade group. */}
      <CommandPalette />
      <TourController />
      <ModeToasts />
      <LoadingScreen />
      {store.status.kind === "error" && <ErrorScreen message={store.status.message} />}
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
      role="status"
      className="pointer-events-auto fixed left-3 top-3 z-[115] flex max-w-80 items-start gap-2 rounded-[8px] border border-[color-mix(in_srgb,var(--color-brand-amber)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-brand-navy)_94%,white_4%)] px-3 py-2 text-[13px] text-[var(--color-brand-cream)]"
    >
      <span className="min-w-0 flex-1">
        Node not found — it may have been renamed or removed.
        <span title={nodeId} className="mt-0.5 block truncate font-mono text-[11px] opacity-60">
          {nodeId}
        </span>
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 opacity-60 hover:opacity-100"
      >
        ✕
      </button>
    </div>
  );
}
