import { FiltersPopover } from "./FiltersPopover";
import { HelpOverlay } from "./HelpOverlay";
import { LegendSheet } from "./LegendSheet";
import { MinimapLayer } from "./MinimapLayer";
import { useOpenLayer } from "./layerState";

/** Renders the ONE summoned layer, if any (Astrolabe V3 §2).
 *
 *  Exclusivity is not enforced here — it's structural in `layerState.ts`, whose
 *  state is a single nullable id. This host just switches on it, which is why
 *  "opening one closes the others" can't regress: there is no state shape in
 *  which two are open.
 *
 *  Subscribes through `useOpenLayer` (an external store), so summoning a layer
 *  re-renders exactly this component — never the reducer's consumers, and never
 *  anything inside <Canvas>. */
export function LayerHost() {
  const layer = useOpenLayer();
  switch (layer) {
    case "minimap":
      return <MinimapLayer />;
    case "legend":
      return <LegendSheet />;
    case "filters":
      return <FiltersPopover />;
    case "help":
      return <HelpOverlay />;
    case null:
      return null;
  }
}
