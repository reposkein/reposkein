import { useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { useStoreState } from "../state/store";
import { getCameraTarget, getCameraView, recenterCamera } from "../scene/Controls";
import {
  boundsOfXY,
  buildProjection,
  minimapToWorld,
  viewportHalfExtents,
  visibleXY,
  worldToMinimap,
} from "../scene/minimap";
import { visibleClusters } from "../data/clientModel";
import { BRAND } from "../scene/encoding";
import { LayerShell } from "./LayerShell";

const MAP_W = 168;
const MAP_H = 120;

/** The minimap layer (Astrolabe V3 §2). Two V2 defects fixed here:
 *
 *  1. PLACEMENT. It used to be a permanently-mounted panel pinned bottom-LEFT —
 *     the same corner as the legend, which is why the two painted over each
 *     other on first load (both flags defaulted to `true`). It is now a summoned
 *     layer docked bottom-RIGHT, clear of the 28px status bar.
 *  2. FOOTPRINT. It projected `model.positions` wholesale — every node in the
 *     graph — so the dots didn't correspond to the stars on screen and the map's
 *     scale was that of a graph the viewer wasn't looking at. It now projects
 *     ONLY `visibleClusters(model, expanded)`, recomputed when the expansion set
 *     changes, and adds the camera's viewport RECTANGLE (not just the target
 *     crosshair) so you can read how much of the constellation is framed.
 *
 *  Still cheap: the projection + point buffer are memoized per (model,
 *  expansion); a rAF loop redraws only because the camera moves, and it paints a
 *  plain 2D canvas — never a second WebGL context. */
export function MinimapLayer() {
  const state = useStoreState();
  const model = state.model;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Visible-only projection. `expanded` identity changes on every expand/
  // collapse (the reducer replaces the Set), so this recomputes exactly when
  // what's on screen changes — and never per frame.
  const projected = useMemo(() => {
    if (!model) return null;
    const xy = visibleXY(model.positions, model.indexByKey, visibleClusters(model, state.expanded));
    const proj = buildProjection(boundsOfXY(xy), MAP_W, MAP_H);
    const n = Math.floor(xy.length / 2);
    const pts = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const { px, py } = worldToMinimap(proj, xy[i * 2]!, xy[i * 2 + 1]!);
      pts[i * 2] = px;
      pts[i * 2 + 1] = py;
    }
    return { proj, pts, n };
  }, [model, state.expanded]);

  useEffect(() => {
    if (!projected) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = MAP_W * dpr;
    canvas.height = MAP_H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const { proj, pts, n } = projected;

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, MAP_W, MAP_H);

      // Visible clusters: faint cool dots.
      ctx.fillStyle = "rgba(120,170,220,0.5)";
      for (let i = 0; i < n; i++) {
        ctx.fillRect(pts[i * 2]! - 0.5, pts[i * 2 + 1]! - 0.5, 1.6, 1.6);
      }

      const t = getCameraTarget();
      if (t) {
        // Viewport frustum rectangle: the world-space extent the camera sees on
        // the plane through its target, mapped through the SAME projection as
        // the dots (so "am I zoomed into a corner?" is answerable at a glance).
        const view = getCameraView();
        if (view) {
          const { halfW, halfH } = viewportHalfExtents(view.distance, view.fov, view.aspect);
          if (halfW > 0 && halfH > 0) {
            const a = worldToMinimap(proj, t.x - halfW, t.y + halfH); // top-left
            const b = worldToMinimap(proj, t.x + halfW, t.y - halfH); // bottom-right
            ctx.strokeStyle = `${BRAND.teal}aa`;
            ctx.lineWidth = 1;
            ctx.strokeRect(a.px, a.py, b.px - a.px, b.py - a.py);
          }
        }
        // Target crosshair (amber), drawn over the rect.
        const { px, py } = worldToMinimap(proj, t.x, t.y);
        ctx.strokeStyle = BRAND.amber;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(px - 7, py);
        ctx.lineTo(px + 7, py);
        ctx.moveTo(px, py - 7);
        ctx.lineTo(px, py + 7);
        ctx.strokeStyle = `${BRAND.amber}99`;
        ctx.stroke();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [projected]);

  const onClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!projected) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * MAP_W;
    const py = ((e.clientY - rect.top) / rect.height) * MAP_H;
    const { x, y } = minimapToWorld(projected.proj, px, py);
    // Recenter on the projected plane; keep the current Z (depth) target.
    const t = getCameraTarget();
    recenterCamera(x, y, t ? t.z : 0);
  };

  return (
    <LayerShell id="minimap" title="Map" dock="right" width="w-[184px]">
      <div className="p-2">
        <canvas
          ref={canvasRef}
          onClick={onClick}
          data-testid="minimap-canvas"
          data-visible-points={projected?.n ?? 0}
          title="Click to recenter the view here"
          aria-label="Overview map of the visible constellation — click to recenter"
          className="block h-[120px] w-[168px] cursor-crosshair select-none rounded-[4px]"
        />
        <p className="mt-1.5 text-[11px] leading-tight opacity-45">
          Visible clusters · <span className="text-[var(--color-brand-teal)]">frame</span> = viewport
        </p>
      </div>
    </LayerShell>
  );
}
