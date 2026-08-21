import { useEffect, useState } from "react";

/** Shared responsive-breakpoint plumbing (Astrolabe V5 polish). Previously
 *  `StatusBar.tsx` carried its own private `useViewportWidth` for its
 *  progressive-degradation tiers; the Inspector's <900px bottom-sheet mode and
 *  the summoned layers' <640px full-width sheets need the exact same "current
 *  viewport width, updated on resize" primitive, so it moved here rather than
 *  being copied a third and fourth time. */
export function useViewportWidth(): number {
  const [width, setWidth] = useState<number>(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/** Below this width the Inspector drawer becomes a fixed-height bottom sheet
 *  (brief: "Responsive <900px"). */
export const BP_INSPECTOR_SHEET = 900;

/** Below this width every summoned layer (map/legend/filters/help) becomes a
 *  full-width bottom sheet instead of docking right/center at its normal
 *  width — there is no room left over for a docked panel at this size, and
 *  the Inspector is ALSO a full-bleed sheet down here, so there is no column
 *  to reserve either. */
export const BP_LAYER_FULL_WIDTH = 640;
