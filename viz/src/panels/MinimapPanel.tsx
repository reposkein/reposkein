import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { getCameraTarget, recenterCamera } from "../scene/Controls";
import {
  buildProjection,
  minimapToWorld,
  projectBounds,
  worldToMinimap,
} from "../scene/minimap";
import { BRAND } from "../scene/encoding";

const MAP_W = 160;
const MAP_H = 120;

/** Minimap / overview inset (design: share & scale §P2). A small, subtle,
 *  toggleable 2D top-down (X/Y) projection of the WHOLE graph's node footprint
 *  drawn on a plain 2D canvas (no second WebGL scene), plus a marker for the
 *  current camera target. Clicking recenters the camera near that location.
 *
 *  Cheap: the projection + the static point buffer are computed once per model;
 *  a rAF loop only redraws the (single) camera-target marker when it moves. */
export function MinimapPanel() {
  const store = useStore();
  const model = store.model;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [open, setOpen] = useState(true);

  // Projection + projected point pixels — pure function of the model layout.
  const projected = useMemo(() => {
    if (!model) return null;
    const bounds = projectBounds(model.positions);
    const proj = buildProjection(bounds, MAP_W, MAP_H);
    const n = Math.floor(model.positions.length / 3);
    const pts = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const { px, py } = worldToMinimap(
        proj,
        model.positions[i * 3]!,
        model.positions[i * 3 + 1]!,
      );
      pts[i * 2] = px;
      pts[i * 2 + 1] = py;
    }
    return { proj, pts, n };
  }, [model]);

  // rAF redraw loop: paints the static footprint + the moving camera marker.
  useEffect(() => {
    if (!open || !projected) return;
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
      // Static footprint: faint cool dots.
      ctx.fillStyle = "rgba(120,170,220,0.45)";
      for (let i = 0; i < n; i++) {
        ctx.fillRect(pts[i * 2]! - 0.5, pts[i * 2 + 1]! - 0.5, 1.4, 1.4);
      }
      // Camera target marker (amber crosshair ring).
      const t = getCameraTarget();
      if (t) {
        const { px, py } = worldToMinimap(proj, t.x, t.y);
        ctx.strokeStyle = BRAND.amber;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(px - 8, py);
        ctx.lineTo(px + 8, py);
        ctx.moveTo(px, py - 8);
        ctx.lineTo(px, py + 8);
        ctx.strokeStyle = `${BRAND.amber}99`;
        ctx.stroke();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [open, projected]);

  if (!model) return null;

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!projected) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * MAP_W;
    const py = ((e.clientY - rect.top) / rect.height) * MAP_H;
    const { x, y } = minimapToWorld(projected.proj, px, py);
    // Recenter on the projected plane; keep current Z (depth) target.
    const t = getCameraTarget();
    recenterCamera(x, y, t ? t.z : 0);
  };

  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        bottom: 12,
        background: "rgba(8,11,22,0.78)",
        border: "1px solid rgba(90,120,180,0.30)",
        borderRadius: 8,
        padding: 6,
        userSelect: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 10,
          letterSpacing: 0.4,
          opacity: 0.6,
          marginBottom: open ? 4 : 0,
          gap: 8,
        }}
      >
        <span>OVERVIEW</span>
        <button
          onClick={() => setOpen((o) => !o)}
          title={open ? "Hide minimap" : "Show minimap"}
          style={{
            border: "none",
            background: "transparent",
            color: "rgba(180,200,230,0.7)",
            cursor: "pointer",
            fontSize: 11,
            padding: 0,
            lineHeight: 1,
          }}
        >
          {open ? "▾ hide" : "▸ show"}
        </button>
      </div>
      {open && (
        <canvas
          ref={canvasRef}
          onClick={onClick}
          title="Click to recenter the view here"
          style={{
            display: "block",
            width: MAP_W,
            height: MAP_H,
            cursor: "crosshair",
            borderRadius: 4,
          }}
        />
      )}
    </div>
  );
}
