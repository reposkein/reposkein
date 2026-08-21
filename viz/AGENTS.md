# viz/

`@reposkein/viz` — read-only 3D constellation SPA. React + three.js via React Three Fiber. Served by `reposkein-mcp view` (which serves `mcp/dist/viz/`).

## STACK

- **Vite** (not webpack). `vite.config.ts` sets `base: "./"` so hashed assets resolve under any subpath.
- **pnpm@10.15.0** (pinned). CI installs with `pnpm install --frozen-lockfile`.
- **TanStack Router** (hash history in static export — browser-history would 404 on GH-Pages subpath), **TanStack Query**, **TanStack Table**.
- **React 19** + **React Three Fiber v9** + `drei` v10 + `@react-three/postprocessing` v3 + `three` 0.185. `d3-force-3d` for layout. `camera-controls` v3 for orbit. **These versions move together** — R3F v9 requires React 19, drei v10 and postprocessing v3 require R3F v9, postprocessing v3.0.5 requires three ≥ 0.182. Bumping one alone breaks the peer graph.
- **Tailwind v4** (via `@tailwindcss/vite`) + **shadcn/ui** are the styling system for new chrome. `components.json` is configured (`@/` → `src/`, `cn()` in `src/lib/utils.ts`); no component has been generated yet.
- **Tailwind preflight is NOT imported.** `src/index.css` expands `@import "tailwindcss"` by hand and omits the base layer, because preflight's global resets (`box-sizing`, `border-width: 0`, button/input appearance, base font) would restyle every surviving inline-styled panel and every drei `<Html>` label. Re-adding `@import "tailwindcss/preflight.css" layer(base);` is a one-line flip — do it in the task that migrates the LAST inline-styled surface, and expect to restate those resets on any shadcn component added before then.
- **Legacy inline styles.** Existing HUD panels still carry inline `style={{…}}` objects. They are being replaced task by task; do not add new ones, and do not mass-convert them outside a task that owns the surface.

See ADR `adr:2026-08-21-viewer-redesign-baseline-react-19-tailwind-v4-tokens-generat` for why.

## STRUCTURE

```
src/
  main.tsx            # ENTRY (:50 createRoot). Imports index.css. Mounts QueryClient + Router.
  index.css           # Tailwind entry (theme + utilities, NO preflight) + font/token imports
  routes/Root.tsx     # App shell: scene Canvas + chrome (one ChromeGroup fade group,
                      # so the guided tour can fade all chrome but its own transport)
  scene/              # R3F rendering layer — see scene/AGENTS.md
  data/               # the brains: graph engine + algorithms — see data/AGENTS.md
  panels/             # HUD chrome. ONE persistent surface (StatusBar), ONE selection-scoped
                      # drawer (Inspector), FOUR mutually-exclusive summoned layers
                      # (MinimapLayer / LegendSheet / FiltersPopover / HelpOverlay via
                      # LayerHost + LayerShell + layerState), CommandPalette, TourController,
                      # Toasts, LoadingScreen, ErrorScreen.
                      # layerState.ts / paletteOpenState.ts / statusBarOverlayState.ts /
                      # toastState.ts are module singletons — chrome state deliberately
                      # OUTSIDE the reducer (see below).
  state/store.tsx     # ONE reducer + split contexts (state / actions / channels)
  state/channel.ts    # useSyncExternalStore slots for pointer-rate values
  styles/tokens.ts    # encoding.ts → @theme generator (pure, unit-tested)
  styles/fonts.css    # self-hosted JetBrains Mono @font-face
  lib/utils.ts        # shadcn cn()
  assets/fonts/       # vendored woff2 (latin 400/500/700) + OFL license
vite/tokens-plugin.ts # the Vite plugin that runs styles/tokens.ts
```

## CONVENTIONS

- **`tsconfig.json`** enforces `strict + noUnusedLocals + noUnusedParameters + noUncheckedIndexedAccess + noFallthroughCasesInSwitch` and `moduleResolution: Bundler`. `@/*` → `src/*` (mirrored in `vite.config.ts` and `vitest.config.ts`).
- **`eslint.config.js`** is flat config. Turns off `@typescript-eslint/no-non-null-assertion` (R3F refs justify it).
- **Hidden filter sets**: an empty set means *show all*, not *hide all*. Universal across `state/store.tsx`, `data/lens.ts`, `panels/FiltersPopover.tsx`.
- **Chrome state lives outside the reducer.** Every `useStore()`/`useStoreState()` consumer re-renders on any reducer transition — including the R3F components inside `<Canvas>`. So *ephemeral* UI state (which summoned layer is open, whether the palette is open, live toasts) lives in module singletons with `useSyncExternalStore` subscriptions: `panels/layerState.ts`, `panels/paletteOpenState.ts`, `panels/statusBarOverlayState.ts`, `panels/toastState.ts`. Summoning the legend must not re-render the constellation. Corollary: a command that toggles one of these is a side effect on the singleton, so it goes through `PaletteEnv` (`state/commands.ts`) alongside screenshot/clipboard — never a reducer action.
- **One layer at a time, structurally.** `layerState` holds ONE nullable `LayerId`, so "opening one closes the others" is unrepresentable-otherwise rather than a rule to remember. (V2 kept two independent booleans, both defaulting to `true`, both docked bottom-left — they painted over each other on first load.)
- **Esc stack**: palette > tour > layer > mode chip > collapse-level. Each surface reads the singleton for everything above it and steps aside; whoever acts calls `stopImmediatePropagation` so exactly one thing happens per keypress. `panels/globalKeys.ts` is the last resort. Tests: `panels/layerStack.test.tsx`, `panels/globalKeys.test.tsx`.
- **`fitNonce`** in store state is the camera-refit trigger — bump it to re-frame. **Bump it once per user intent**: a batched action (`revealAndSelect`) exists precisely so "reveal + select + fly" is one transition instead of N.
- **Token bridge.** `scene/encoding.ts` stays the SSoT for every hue. `src/styles/tokens.ts` renders its tables into `src/styles/tokens.generated.css` (`@theme static`), run by the `reposkein-tokens` Vite plugin at dev AND build. The generated file is **git-ignored** so it can never become a second source of truth — add a color to `encoding.ts` and the CSS variable appears. `styles/tokens.test.ts` guards determinism + coverage.
- **Fonts are self-hosted**, referenced relatively from `src/styles/fonts.css`, so the static export makes **zero external requests** (self-hosted fonts, relative asset URLs). Never add a CDN font or stylesheet. Note the export is **not** a `file://` target: its entry is a module script, and browsers block module scripts from `file://` origins — it needs an `http(s)` origin (the `view` server, GitHub Pages, any static host, `python3 -m http.server`).
- **`frameloop="demand"`** on the Canvas. Any `useFrame` that animates by mutating a material/attribute MUST call `invalidate()` while it is running — otherwise it renders one frame and freezes. `scene/frameloop.ts` holds the audit table and the `useContinuousFrames` helper; keep it accurate when adding an animation.
- **Static export** (`view --export`) uses `window.__REPOSKEIN_GRAPH__` (set by baked `graph-data.js`) + `createHashHistory` because GH-Pages serves under a subpath.
- **Manual chunks** in `vite.config.ts`: `three`, `r3f`, `tanstack`. `chunkSizeWarningLimit: 800` (three.js is irreducible ~735 kB).
- **`worker: { format: "es" }`** — `data/worker/graph.worker.ts` runs the d3-force layout off-main-thread.
- **Tests** are `vitest`, node environment by default (`vitest.config.ts`, deliberately separate from `vite.config.ts`). A component test opts into jsdom with a `// @vitest-environment jsdom` docblock so one React test doesn't slow the other ~190.

## STATE

One reducer, three contexts. The split is not a second state library — it is what keeps the single reducer affordable:

- **`useStoreState()`** — reducer state. Re-renders on any transition.
- **`useActions()`** — the action surface. Identity-stable for the provider's lifetime, so a dispatch-only component never re-renders.
- **`useStore()`** — both, merged. Convenience for call sites that need each; costs a re-render per transition (same as before the split).
- **`useHovered()` / `useSetHovered()`, `useEdgeStats()` / `useSetEdgeStats()`** — values that change at POINTER or per-render-pass rate, on `useSyncExternalStore` channels (`state/channel.ts`) instead of in the reducer. Only subscribers re-render; the HUD chrome must never read `hovered`.

## ANTI-PATTERNS

- **Direct mutation of three.js scene objects** outside R3F. Use refs + R3F hooks (`useFrame`, `useThree`). Otherwise reconciliation breaks.
- **Hardcoding colors / sizes / label rules** anywhere — `scene/encoding.ts` is the SSoT. That now includes CSS: read `var(--color-node-function)`, never re-type `#ffe08a`.
- **Editing `src/styles/tokens.generated.css`.** It is regenerated on every dev boot and build; edit `encoding.ts`.
- **Adding a state library** (Zustand, Jotai, Redux). One reducer for the whole app — keep it. Pointer-rate values go on a channel, not into a new store.
- **A `useFrame` animation with no `invalidate()`.** Under `frameloop="demand"` it silently runs for exactly one frame.
- **A loop of `toggleExpand` dispatches** to reveal a node. Use `revealAndSelect` / `revealWithoutRefit` — one transition, one refit.
- **New inline `style={{…}}` objects** on chrome. Use Tailwind utilities and the generated tokens.
- **Enabling Tailwind preflight** while inline-styled panels remain (it will restyle them).
- **Path-based browser-history routes** that won't survive a subpath deploy. Hash history is mandatory for the static export path.

- **Writing to `.reposkein/*.jsonl`**. The viewer is **read-only** — invariant from `../CONTRIBUTING.md`. Even the source-peek API is a path-guarded read-only slice.

## SCRIPTS

```bash
pnpm dev          # Vite HMR (UI-only — no /api/* endpoints)
pnpm build        # tsc --noEmit + vite build → dist/
pnpm test         # vitest (src/**/*.test.ts, src/**/*.test.tsx)
pnpm typecheck
pnpm lint

# End-to-end: requires the view server for /api/* (graph, source peek, vscode:// link)
pnpm build && node ../mcp/scripts/bundle-viz.mjs && (cd ../mcp && node dist/index.js view <indexed-repo>)
```
