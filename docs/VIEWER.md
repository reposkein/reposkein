# Constellation viewer

For humans.

Moved out of the [README](../README.md) so the front door stays short.

```sh
reposkein-mcp view .          # opens http://127.0.0.1:<port> in your browser
```

`view` starts a **local, read-only, zero-infra** web app (React + three.js, bound to `127.0.0.1`) that renders your `.reposkein` graph as an interactive 3D astronomy-style **constellation**. There's no Neo4j and no external service — it reads the JSONL on disk directly and never mutates it. **[Try the live demo →](https://reposkein.github.io/reposkein/)** (RepoSkein viewing its own multi-language graph).

The map is **deterministic**: a seeded force layout means the same graph always lays out the same way (cached in IndexedDB for instant reloads), and the layout is render-time only — it never touches the JSONL. Levels of detail map onto an astronomy metaphor — **Repository → Directory → File → Symbol** become **galaxy → constellation → solar-system → star** — so you zoom or click to expand a cluster (a brief supernova animation) and click a star to inspect it. Federation galaxies and agent-written summaries render when present.

- **Legible** — per-edge-type colors + legend, importance-sized stars, adaptive labels, breadcrumb, per-language galaxy coloring, depth fog / bloom / nebula halos.
- **Edges encode resolution** — color = edge type (`CALLS`/`IMPORTS`/`INHERITS`/`IMPLEMENTS`/`INSTANTIATES`), opacity = confidence (`exact`/`name_match`/`ambiguous`), and flow particles show call direction.
- **Analytical** — one-click lenses (call graph / type hierarchy / imports / tests), an impact overlay (transitive callers + covering tests), a confidence-audit mode (see where the type-free resolver guesses), and a temporal-coupling overlay (git co-change).
- **Explorable** — a ⌘K (or `/`) command palette that searches symbols, files and directories and runs every command; N-hop neighborhood focus; a source peek in the Inspector (a path-guarded read-only file slice + an "Open in editor" `vscode://` link); keyboard nav (`f` frame the selection, arrows/Tab to hop neighbors, `x`/`⇧X` to zoom out a level or to file level, `[`/`]` to walk view history, `m` map, `d` idle drift, `?` keymap, `Esc` to back out one step); a viewport-aware minimap; and PNG screenshot export.
- **Shareable views** — the URL is the view: `?node&lens&overlays` carries the selected node, the active lens and every live overlay, so "Copy link to this view" reproduces what you were looking at rather than just where you were pointing.
- **One chrome strip** — a 28px status bar is the only always-on surface (repo identity, counts, breadcrumb, active-mode chips). The Inspector appears when you select a star; the legend, map, filters and keymap are **summoned layers**, one at a time, each dismissed with `Esc`.
- **Guided tour** — a cinematic, deterministically-derived flythrough (overview → largest modules → busiest hub → type hierarchy → entry point) with captions.

```sh
reposkein-mcp view --export ./site .   # write a self-contained static site
```

`--export` bakes the graph into `graph-data.js` (as `window.__REPOSKEIN_GRAPH__`) and emits a **self-contained static site** — no backend, no database, no external requests (fonts and every asset ship with it), which is exactly how the live demo above is published. Handy for sharing a snapshot, embedding in docs, or a project landing page.

Serve it over `http(s)` — any static host, or `python3 -m http.server` in the export directory. Opening `index.html` straight off disk does **not** work: the entry is an ES module, and browsers refuse module scripts from a `file://` origin.

## Publishing a durable link

Want a shareable, always-current URL instead of a one-off export? See [`HOSTING.md`](HOSTING.md) — GitHub Pages via `reposkein-mcp init --ci`, or any other static host.

## See also

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the graph underneath the viewer is built.
- [`HOSTING.md`](HOSTING.md) — publishing an exported constellation.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md#working-on-the-viewer-viz) — working on `viz/` itself.
- [`../viz/README.md`](../viz/README.md) — the `@reposkein/viz` package (architecture, dev/build).
