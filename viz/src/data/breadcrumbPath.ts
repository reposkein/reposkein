/** Persistent-breadcrumb path resolution (REP-18 status bar, CENTER region).
 *  Pure — no React — so the "selection chain" vs. "camera-nearest fallback"
 *  logic is unit-testable without mounting anything.
 *
 *  Two sources, chosen by whether a node is currently selected:
 *   - selection:  the ancestor chain of the selected node's cluster, plus the
 *                 node itself when it's a leaf symbol (not a cluster key).
 *   - camera:     the ancestor chain of the nearest visible cluster to the
 *                 camera's orbit target (see scene/cameraNearest.ts), or the
 *                 repo root when nothing has been computed yet.
 *  The breadcrumb must NEVER be empty — the root-chain fallback guarantees a
 *  crumb list is always returned. */

import type { ClientModel } from "./clientModel";

export interface Crumb {
  key: string;
  label: string;
  /** Whether clicking this crumb navigates (collapses/reveals to its scope).
   *  False only for the synthetic leaf crumb appended when the selected node
   *  is a symbol, not a cluster — clicking "where you already are" is inert. */
  clickable: boolean;
}

function labelFor(model: ClientModel, key: string): string {
  return model.byKey.get(key)?.name ?? key;
}

/** Ancestor-chain crumbs for the currently SELECTED node (cluster or symbol).
 *  `selectedId` is a RAW NODE id in some paths (e.g. picking a file from
 *  search) and a CLUSTER key in others (e.g. clicking a dir/file crumb, which
 *  re-selects via that key) — `clusterOfNode` normalizes either to the
 *  cluster key before walking the ancestor chain. The synthetic leaf crumb
 *  only gets appended when that resolved cluster key truly has no cluster
 *  entry of its own (checked on `clusterKey`, not the raw `selectedId` — a
 *  file/dir's cluster key differs from its node id, so checking `selectedId`
 *  directly would append a spurious duplicate leaf for every file/dir
 *  selected via search). */
export function selectionCrumbs(model: ClientModel, selectedId: string): Crumb[] {
  const clusterKey = model.clusterOfNode.get(selectedId) ?? selectedId;
  const chain = model.ancestors.get(clusterKey) ?? [clusterKey];
  const crumbs: Crumb[] = chain.map((key) => ({
    key,
    label: labelFor(model, key),
    clickable: true,
  }));
  const rec = model.records.get(selectedId);
  if (rec && !model.byKey.has(clusterKey)) {
    crumbs.push({ key: selectedId, label: rec.name, clickable: false });
  }
  return crumbs;
}

/** Ancestor-chain crumbs for the cluster nearest the camera, used when
 *  nothing is selected. Falls back to the repo root when `nearestKey` is
 *  null (e.g. before the first throttled camera sample lands). */
export function cameraCrumbs(model: ClientModel, nearestKey: string | null): Crumb[] {
  const key = nearestKey ?? model.rootKey;
  const chain = model.ancestors.get(key) ?? [key];
  return chain.map((k) => ({ key: k, label: labelFor(model, k), clickable: true }));
}

/** The single entry point the status bar's breadcrumb renders: selection
 *  takes priority; camera-nearest is the persistent fallback. Never empty.
 *
 *  Adjacent crumbs with the IDENTICAL label are folded into one (fix round 2 /
 *  REP-22 polish): a repo whose top-level directory shares the repo's own name
 *  (a common layout) renders a root galaxy crumb and a directory crumb that
 *  say the exact same word — "reposkein · reposkein" reads as a rendering bug,
 *  not as two distinct levels. The fold keeps the DEEPER crumb's key (so
 *  clicking it still navigates to the more specific scope) and just the one
 *  label. */
export function resolveBreadcrumb(
  model: ClientModel,
  selectedId: string | null,
  nearestClusterKey: string | null,
): Crumb[] {
  const crumbs = selectedId
    ? selectionCrumbs(model, selectedId)
    : cameraCrumbs(model, nearestClusterKey);
  const deduped = dedupeAdjacentCrumbLabels(crumbs);
  return deduped.length > 0
    ? deduped
    : [{ key: model.rootKey, label: model.repoId, clickable: false }];
}

/** Folds runs of adjacent crumbs sharing the same displayed LABEL into one,
 *  keeping the last (deepest) crumb's `key`/`clickable` — clicking the folded
 *  crumb still navigates to the more specific of the two scopes. Pure, so the
 *  "repo root galaxy and its same-named top directory" case is unit-testable
 *  without a real model. */
export function dedupeAdjacentCrumbLabels(crumbs: Crumb[]): Crumb[] {
  const out: Crumb[] = [];
  for (const c of crumbs) {
    const prev = out[out.length - 1];
    if (prev && prev.label === c.label) out[out.length - 1] = c;
    else out.push(c);
  }
  return out;
}

/** A synthetic, inert "…" crumb — never clickable, never confused with a real
 *  cluster key (the `__` wrapping keeps it out of real key-space). */
const ELLIPSIS_KEY = "__ellipsis__";

/** Middle-ellipsis collapse for narrow bars ("breadcrumb truncates first" —
 *  REP-18 fix round 1, `#2`): once the chain has more segments than
 *  `maxVisible`, keep the FIRST crumb (repo root — orientation) and the last
 *  `maxVisible - 2` crumbs (where you are now), replacing everything between
 *  with one inert "…" crumb. `maxVisible` values below 3 have no room for
 *  head + ellipsis + >=1 tail crumb, so they clamp up to 3 rather than
 *  collapsing to something nonsensical. Pass `Infinity` (or anything >=
 *  `crumbs.length`) for "don't collapse" — the natural `<=` comparison
 *  handles it with no special-casing. */
export function collapseCrumbsForDisplay(crumbs: Crumb[], maxVisible: number): Crumb[] {
  if (crumbs.length <= maxVisible) return crumbs;
  const visible = Math.max(3, maxVisible);
  if (crumbs.length <= visible) return crumbs; // clamping up may have made it a no-op
  const tailCount = visible - 2;
  const head = crumbs[0]!;
  const tail = crumbs.slice(crumbs.length - tailCount);
  return [head, { key: ELLIPSIS_KEY, label: "…", clickable: false }, ...tail];
}

/** The Inspector's own width + the gutters `LayerShell`'s `layerPlacement`
 *  reserves around it (kept in sync with that module's `INSPECTOR_W`/
 *  `GUTTER` — duplicated rather than imported so this stays a leaf, React-free
 *  module; `StatusBar.test.tsx` pins the two numbers agreeing). */
const INSPECTOR_RESERVED_PX = 360 + 12 * 3;

/** How many breadcrumb segments to show at a given bar (== viewport) width,
 *  in px. The bar is `fixed inset-x-0`, so viewport width IS the bar's
 *  width — no ResizeObserver needed. Wide bars show the whole chain; narrow
 *  ones collapse progressively (paired with `collapseCrumbsForDisplay`
 *  above). Deliberately generous at the wide end (breadcrumb truncation is
 *  the FIRST thing to give ground as the bar narrows, before the left
 *  section drops anything — its threshold (1024) is wider than the left
 *  section's widest drop threshold (768) — see StatusBar.tsx's tier
 *  comment).
 *
 *  `inspectorOpen` (fix round 2 / REP-22 polish — "crumbs over-truncate at
 *  1280 with inspector open"): a live selection makes `selectionCrumbs`
 *  append a synthetic leaf crumb the camera-nearest fallback never has, so
 *  the SAME viewport width has to fit one more segment exactly when the
 *  drawer is also on screen. Tiers tuned for the general case therefore
 *  under-collapsed right when both were true at once. Treating an open
 *  Inspector as `INSPECTOR_RESERVED_PX` narrower — the same number
 *  `layerPlacement` reserves for it — fixes that without a second set of
 *  breakpoints to keep in sync by hand. */
export function breadcrumbMaxVisibleForWidth(width: number, inspectorOpen = false): number {
  const effective = inspectorOpen ? width - INSPECTOR_RESERVED_PX : width;
  if (effective >= 1024) return Infinity;
  if (effective >= 640) return 4;
  return 3;
}

