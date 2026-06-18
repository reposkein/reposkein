# viz/

`@reposkein/viz` — read-only 3D constellation SPA. React + three.js via React Three Fiber. Served by `reposkein-mcp view` (which serves `mcp/dist/viz/`).

## STACK

- **Vite** (not webpack). `vite.config.ts` sets `base: "./"` so hashed assets resolve under any subpath.
- **pnpm@10.15.0** (pinned). CI installs with `pnpm install --frozen-lockfile`.
- **TanStack Router** (hash history in static export — browser-history would 404 on GH-Pages subpath), **TanStack Query**, **TanStack Table**.
- **React Three Fiber** + `drei` + `postprocessing` + `three`. `d3-force-3d` for layout. `camera-controls` for orbit.
- **No Tailwind / no styled-components.** CSS-in-`.css` files alongside components.

## STRUCTURE

```
src/
  main.tsx            # ENTRY (:49 createRoot). Mounts QueryClient + Router.
  routes/Root.tsx     # App shell: scene Canvas + HUD panels (:28 entry point)
  scene/              # R3F rendering layer — see scene/AGENTS.md
  data/               # the brains: graph engine + algorithms — see data/AGENTS.md
  panels/             # 7 HUD components: DetailPanel, FilterHUD, LegendPanel, LensSwitcher,
                      # MinimapPanel, SearchPanel, TourController
  state/store.tsx     # React Context + useReducer. ONE store. No Zustand/Redux.
```

## CONVENTIONS

- **`tsconfig.json`** enforces `strict + noUnusedLocals + noUnusedParameters + noUncheckedIndexedAccess + noFallthroughCasesInSwitch` and `moduleResolution: Bundler`.
- **`eslint.config.js`** is flat config. Turns off `@typescript-eslint/no-non-null-assertion` (R3F refs justify it).
- **Hidden filter sets**: an empty set means *show all*, not *hide all*. Universal across `state/store.tsx`, `data/lens.ts`, `panels/FilterHUD.tsx`.
- **`fitNonce`** in store state is the camera-refit trigger — bump it to re-frame.
- **Static export** (`view --export`) uses `window.__REPOSKEIN_GRAPH__` (set by baked `graph-data.js`) + `createHashHistory` because GH-Pages serves under a subpath.
- **Manual chunks** in `vite.config.ts`: `three`, `r3f`, `tanstack`. `chunkSizeWarningLimit: 700` (three.js is irreducible ~680 kB).
- **`worker: { format: "es" }`** — `data/worker/graph.worker.ts` runs the d3-force layout off-main-thread.

## ANTI-PATTERNS

- **Direct mutation of three.js scene objects** outside R3F. Use refs + R3F hooks (`useFrame`, `useThree`). Otherwise reconciliation breaks.
- **Hardcoding colors / sizes / label rules** anywhere — `scene/encoding.ts` is the SSoT.
- **Adding a state library** (Zustand, Jotai, Redux). One Context+reducer for the whole app — keep it.
- **Path-based browser-history routes** that won't survive a subpath deploy. Hash history is mandatory for the static export path.
- **Writing to `.reposkein/*.jsonl`**. The viewer is **read-only** — invariant from `../CONTRIBUTING.md`. Even the source-peek API is a path-guarded read-only slice.

## SCRIPTS

```bash
pnpm dev          # Vite HMR (UI-only — no /api/* endpoints)
pnpm build        # tsc --noEmit + vite build → dist/
pnpm test         # vitest (src/**/*.test.ts)
pnpm typecheck
pnpm lint

# End-to-end: requires the view server for /api/* (graph, source peek, vscode:// link)
pnpm build && node ../mcp/scripts/bundle-viz.mjs && (cd ../mcp && node dist/index.js view <indexed-repo>)
```
