/** Pure tour-stop application logic (the testable core of
 *  TourController.applyStop). Separated from the component so the expansion
 *  sequencing — especially the post-reset expansion decisions — can be unit
 *  tested in the node environment without rendering React.
 *
 *  The historical bug: applyStop called store.resetExpansion() (which sets
 *  expanded := {root}) and then made its expand guards against store.expanded —
 *  the STALE pre-reset render snapshot. So a cluster already expanded before the
 *  reset would be (wrongly) treated as still-expanded and skipped, leaving the
 *  stop empty. This module computes the expand decisions against the INTENDED
 *  post-reset state instead.
 */

import type { ClientModel } from "./clientModel";
import { revealChainFor } from "./clientModel";
import type { TourStop } from "./tour";

/** The cluster keys to toggle-expand for a stop, in apply order, computed
 *  against the POST-reset expansion state.
 *
 *  - `baseExpanded` is the expansion the stop starts from: `{rootKey}` when the
 *    stop collapses previous state (every built-in stop does), else the current
 *    `expanded` set.
 *  - module stops open their explicit `expandKeys` (one level, to files) that
 *    are expandable (children) and not already open.
 *  - node stops reveal the focus node's expandable ancestor chain.
 *
 *  Returns the keys NOT already in `baseExpanded`, deduped, in deterministic
 *  order, so the caller dispatches exactly the toggles that change state. */
export function tourExpandKeys(
  model: ClientModel,
  stop: TourStop,
  currentExpanded: Set<string>,
): string[] {
  const base = stop.collapsePrevious
    ? new Set<string>([model.rootKey])
    : new Set(currentExpanded);
  const out: string[] = [];
  const want = (key: string) => {
    if (base.has(key)) return;
    base.add(key); // dedupe across the chain / repeated keys
    out.push(key);
  };

  if (stop.kind === "module") {
    for (const key of stop.expandKeys) {
      const c = model.byKey.get(key);
      if (c && c.children.length > 0) want(key);
    }
  } else if (stop.focusNodeId) {
    for (const ak of revealChainFor(model, stop.focusNodeId)) want(ak);
  }
  return out;
}
