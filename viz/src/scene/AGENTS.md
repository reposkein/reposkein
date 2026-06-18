# viz/src/scene/

R3F rendering layer. 22 files. The pixels.

## FILES

| File | Role |
|---|---|
| `encoding.ts` | **SSoT for visual encoding** — colors, sizes, labels, edge-type palette. Read this first. |
| `StarField.tsx` (602 LOC) | Core scene: instanced stars, edges, fog/bloom orchestration. |
| `EdgeLines.tsx` | Edge segments. Color = type; opacity = `resolution` (`exact`/`name_match`/`ambiguous`). |
| `ConstellationLines.tsx` | Constellation-level cluster edges. |
| `FlowParticles.tsx` | Per-edge flow particles → call direction. |
| `Labels.tsx` | Adaptive-density label renderer (LOD-aware). |
| `NebulaHalos.tsx` | Per-galaxy halo (language-colored). |
| `TemporalLinks.tsx` | Git co-change overlay. |
| `Controls.tsx` | `camera-controls` wrapper + keyboard nav (`/`, `f`, arrows, `Esc`). |
| `Screenshot.tsx` + `screenshotName.ts` | PNG export. |
| `supernova.ts` | Cluster-expand burst animation. |
| `bundleGeometry.ts` | Edge bundling math. |
| `constellation.ts` | Per-cluster constellation layout calc. |
| `flow.ts` | Flow-particle position update. |
| `minimap.ts` | 2D minimap projection. |
| `sprites.ts` | Star sprite atlas. |
| `*.test.ts` | Vitest for each pure module (`bundleGeometry`, `constellation`, `flow`, `minimap`, `screenshotName`). |

## INVARIANTS

- **Read encoding from `encoding.ts`.** No hardcoded colors / sizes / opacities in `*.tsx`. Adding an edge type? Add it there first.
- **Edge encoding** is canonical:
  - **Color** = edge type: `CALLS`, `IMPORTS`, `INHERITS`, `IMPLEMENTS`, `INSTANTIATES`
  - **Opacity** = resolver confidence: `exact (1.0)` > `name_match (0.7-0.8)` > `ambiguous (0.4)`
  - Confidence-audit mode inverts opacity to surface low-confidence edges.
- **GPU pipeline**: single-buffer **instanced** geometry. ~10k+ nodes must stay interactive on integrated GPUs.
- **Read-only.** No mutation of `.reposkein/*.jsonl` from any scene component.

## CONVENTIONS

- Pure-math modules end in `.ts` (testable). React components end in `.tsx`.
- Three.js objects accessed via `useRef` + `useFrame`. No imperative `scene.add(...)` from effects.
- Tests target the pure modules; visual `.tsx` components are not snapshot-tested (animations).

## ANTI-PATTERNS

- **Per-node draw calls.** Use instanced meshes. A `<mesh>` per node = framerate cliff.
- **`new THREE.Color("#...")` in render.** Allocate in `encoding.ts` module scope or `useMemo`.
- **Mutating the data store from scene events.** Scene reads from `state/store.tsx`; user actions dispatch reducer actions, scene re-reads. One-way.
- **`postprocessing` effects added directly inside `<Canvas>`.** Wire through `<EffectComposer>` so depth/normal passes compose correctly.
