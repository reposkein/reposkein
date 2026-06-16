import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { screenshotFilename } from "./screenshotName";

export { screenshotFilename };

/** A capture callback registered by the in-Canvas <CaptureBridge/> and invoked
 *  by the HUD button (which lives OUTSIDE the Canvas, so it can't read the r3f
 *  renderer directly). Module-level so the two sides rendezvous without prop
 *  drilling through the postprocessing tree. null until the scene mounts. */
let captureFn: (() => void) | null = null;

/** Trigger a PNG capture of the current composited frame (incl. bloom) and
 *  download it. No-op until the scene has mounted. Best-effort. */
export function captureScreenshot(): void {
  captureFn?.();
}

/** Lives inside the <Canvas> so it can reach the WebGLRenderer + scene/camera.
 *  Registers a capture function that forces a synchronous render (so the back
 *  buffer is current — preserveDrawingBuffer keeps it readable) and serializes
 *  the canvas to a PNG download. The EffectComposer composites bloom onto the
 *  same canvas, so toBlob captures the post-processed image. */
export function CaptureBridge({ repoId }: { repoId: string | undefined }) {
  const { gl, scene, camera } = useThree();

  useEffect(() => {
    captureFn = () => {
      try {
        // Force a fresh render so the drawing buffer reflects the latest frame
        // even if the frameloop was idle (demand mode / paused).
        gl.render(scene, camera);
      } catch {
        /* fall through — toBlob on the last frame is still acceptable */
      }
      const canvas = gl.domElement;
      const filename = screenshotFilename(repoId);
      const finish = (url: string, revoke: boolean) => {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        if (revoke) setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      try {
        if (typeof canvas.toBlob === "function") {
          canvas.toBlob((blob) => {
            if (blob) finish(URL.createObjectURL(blob), true);
            else finish(canvas.toDataURL("image/png"), false);
          }, "image/png");
        } else {
          finish(canvas.toDataURL("image/png"), false);
        }
      } catch {
        /* capture unavailable (e.g. tainted canvas) — silently no-op */
      }
    };
    return () => {
      captureFn = null;
    };
  }, [gl, scene, camera, repoId]);

  return null;
}
