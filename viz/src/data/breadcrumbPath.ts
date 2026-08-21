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
 *  takes priority; camera-nearest is the persistent fallback. Never empty. */
export function resolveBreadcrumb(
  model: ClientModel,
  selectedId: string | null,
  nearestClusterKey: string | null,
): Crumb[] {
  const crumbs = selectedId
    ? selectionCrumbs(model, selectedId)
    : cameraCrumbs(model, nearestClusterKey);
  return crumbs.length > 0 ? crumbs : [{ key: model.rootKey, label: model.repoId, clickable: false }];
}
