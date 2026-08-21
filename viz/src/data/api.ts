/** Client for the `reposkein-mcp view` HTTP API (design §2.2). */

import { isStaticMode, staticSourceSlice } from "./staticMode";

/** Bake-time / server-start-time provenance for the staleness badge. Any field
 *  may be null when it couldn't be determined (not a git repo, no origin, a
 *  non-GitHub host) — the badge simply doesn't render in that case. */
export interface RepoMeta {
  commitSha: string | null;
  builtAt: string | null;
  repoUrl: string | null;
  /** `[team] pages_url` from `.reposkein/config.toml`, or null when unset —
   *  the team's canonical/CI-published constellation link, distinct from
   *  whatever local `view`/export a viewer happens to be looking at.
   *  Optional (not just nullable) so a manifest baked by an older server
   *  build — before this field existed — still parses. */
  pagesUrl?: string | null;
}

export interface GraphManifest {
  root: { repoId: string; nodesUrl: string; edgesUrl: string; repoRoot?: string };
  federated: { repoId: string; rootPath: string; nodesUrl: string; edgesUrl: string }[];
  counts: { nodes: number; edges: number };
  meta?: RepoMeta;
}

/** A read-only source slice returned by GET /api/source. */
export interface SourceSlice {
  path: string;
  start: number;
  end: number;
  lines: string[];
}

/** Fetch a read-only source slice for `path` over [start,end] (1-based,
 *  inclusive). Best-effort: any failure (missing file, traversal → 404, network)
 *  yields null so the Inspector degrades to showing nothing. The server
 *  clamps + caps the range; we still send what the record claims.
 *  Static export: no server — falls back to a baked slice (--with-source) when
 *  one exists for this exact range, else null. */
export async function fetchSource(
  path: string,
  start: number,
  end: number,
): Promise<SourceSlice | null> {
  if (isStaticMode()) return staticSourceSlice(path, start, end);
  try {
    const qs = new URLSearchParams({ path, start: String(start), end: String(end) });
    const res = await fetch(`/api/source?${qs.toString()}`);
    if (!res.ok) return null;
    return (await res.json()) as SourceSlice;
  } catch {
    return null;
  }
}

export async function fetchManifest(): Promise<GraphManifest> {
  // Absolute-from-origin: fetchManifest may run inside a Web Worker (base URL
  // = the worker script's /assets/ dir), so a relative "api/graph" would
  // resolve to /assets/api/graph and hit the SPA catch-all.
  const res = await fetch("/api/graph");
  if (!res.ok) throw new Error(`GET /api/graph -> ${res.status}`);
  return (await res.json()) as GraphManifest;
}

export async function fetchText(url: string): Promise<string> {
  // The server may gzip; fetch() transparently decodes Content-Encoding: gzip.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return await res.text();
}
