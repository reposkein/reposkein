<div align="center">
<img src="https://capsule-render.vercel.app/api?type=waving&color=0:070A12,45:2DD4BF,100:F2B84B&height=150&section=header&text=RepoSkein&fontColor=EAE7DC&fontSize=56&animation=fadeIn" width="100%" alt="RepoSkein" />
</div>

# @reposkein/viz

**The RepoSkein constellation viewer** — a read-only single-page app (React + [three.js](https://threejs.org/)) that renders the committed `.reposkein` code graph as an interactive 3D astronomy-style **constellation**.

It's the UI behind `reposkein-mcp view`: a local, zero-infra browser app for exploring the same deterministic graph your agent navigates. **[Try the live demo →](https://reposkein.github.io/reposkein/)** (RepoSkein viewing its own multi-language graph), or read the [viewer section in the main README](https://github.com/reposkein/reposkein#visualize-the-graph--the-constellation-viewer).

This is a `private`, **pnpm** package (the rest of the repo's JS lives in `mcp/`, which uses npm). You don't install it directly — the [`@reposkein/mcp`](https://github.com/reposkein/reposkein/tree/main/mcp) npm package ships the prebuilt viewer, so `reposkein-mcp view` works out of the box after `npm i -g @reposkein/mcp`.

## What it does

Levels of detail map onto an astronomy metaphor — **Repository → Directory → File → Symbol** become **galaxy → constellation → solar-system → star**. Zoom or click to expand a cluster (a brief supernova animation); click a star to inspect it. Edge **color** encodes type (`CALLS`/`IMPORTS`/`INHERITS`/`IMPLEMENTS`/`INSTANTIATES`) and **opacity** encodes the resolver's confidence (`exact`/`name_match`/`ambiguous`), so you can *see* where the type-free resolver is sure versus guessing. On top of that: one-click lenses (call graph / type hierarchy / imports / tests), an impact overlay, a temporal-coupling (git co-change) overlay, ranked search-to-fly, N-hop neighborhood focus, a path-guarded read-only source peek, keyboard navigation, a minimap, PNG export, and a deterministically-derived guided tour. Federation galaxies and agent-written summaries render when present.

## Develop

```sh
pnpm install
pnpm dev          # Vite dev server with HMR
```

`pnpm dev` is enough for UI work, but the **full experience needs the `view` server** for its `/api/*` endpoints (graph data, the path-guarded source peek, the `vscode://` open-in-editor link). For an end-to-end check, build the viewer, bundle it into the mcp package, and run the real server:

```sh
pnpm build                                   # → viz/dist
node ../mcp/scripts/bundle-viz.mjs           # copy viz/dist into the mcp package
cd ../mcp && reposkein-mcp view /path/to/an/indexed/repo
```

Other scripts: `pnpm typecheck`, `pnpm lint`, `pnpm test` (Vitest), `pnpm build` (`tsc --noEmit` then `vite build`).

## Architecture (in brief)

- **Data contract** — the committed `.reposkein` graph: `nodes.jsonl` + `edges.jsonl`. The `view` server reads these and serves them over `/api/*`; the static export bakes the same data into `graph-data.js` as `window.__REPOSKEIN_GRAPH__` (so the SPA works with no server). Nothing else is required.
- **LOD cluster tree** — nodes are grouped into the Repository → Directory → File → Symbol hierarchy that drives the galaxy/constellation/solar-system/star levels of detail and the expand/collapse interactions.
- **Deterministic layout** — a seeded force layout runs in a Web Worker (`d3-force-3d`) so the same graph always produces the same map; results are cached in IndexedDB for instant reloads. The layout is render-time only.
- **Rendering** — a single-buffer GPU pipeline (instanced geometry, depth fog / bloom / nebula halos via postprocessing) keeps large graphs interactive.
- **Overlays** — lenses, impact, confidence-audit, and temporal coupling are derived views computed over the same in-memory graph; they re-color and filter what's already loaded rather than refetching.

## Hard invariants

The viewer honors RepoSkein's [core invariants](https://github.com/reposkein/reposkein/blob/main/CONTRIBUTING.md) — please keep them intact:

- **Read-only.** It renders the committed graph and **never mutates** `.reposkein/*.jsonl`. The source peek is a path-guarded, read-only file slice; there are no write paths.
- **Zero-infra.** It works directly over the committed JSONL — no Neo4j, no external service. The static export needs no server at all.
- **Deterministic.** Same graph → same map. The seeded layout is render-time only and is never committed.

## License

[Apache-2.0](https://github.com/reposkein/reposkein/blob/main/LICENSE).
