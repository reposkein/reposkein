# indexer/crates/core/

The deterministic engine. Walk → classify → hash → id → resolve → JSONL. Everything downstream (CLI, Neo4j, MCP) reads what this crate emits.

## FILES (by role)

| File | LOC | Role |
|---|---|---|
| `model.rs` | — | `Node` / `Edge` / `Resolution` types. Single source of truth for the wire format. |
| `id.rs` | — | Qualified-name + stable-ID rules. **FROZEN @arity test lives here.** |
| `resolve.rs` | 2291 | Cross-file resolution: imports, heritage, INSTANTIATES, intraprocedural receiver typing. |
| `merge.rs` | 639 | 3-way merge driver for `.reposkein/*.jsonl` (used by git's mergedriver). |
| `lib.rs` | 973 | `index_tree_with` pipeline + federation discovery + the public API. |
| `jsonl.rs` | — | Canonical serializer. Sorts every collection before writing. |
| `walk.rs` | — | File-tree walk with `ignore` crate. Respects `.gitignore` + `.reposkein/.gitignore`. |
| `cache.rs` | — | `EXTRACT_CACHE_SCHEMA` — bump on any extractor output change. |
| `classify.rs` | — | Extension → language; test-file detection. |
| `extractor.rs` | — | The `Extractor` trait every `lang-*` implements. |
| `hash.rs` | — | BLAKE3 content hashing (stable across machines). |
| `heritage.rs` | — | INHERITS / IMPLEMENTS edge derivation. |
| `meta.rs` | — | `.reposkein/meta.json` writer (counts + schema version). |

## FROZEN RULES (NEVER CHANGE WITHOUT A TEST DIFF)

- **`@arity` qualified-name rule** in `id.rs`. Changing the format (e.g. `foo@2` → `foo/2`) rewrites every node id and **orphans every committed `write_semantic_summary` summary** across every user's repo. Every change MUST land with a `*_frozen` test update.
- **JSONL field order + sort order** in `jsonl.rs`. Any reordering breaks `determinism_two_runs_byte_identical` and the Neo4j `load → export` round-trip.
- **Edge `resolution` ladder**: `exact (1.0)` > `name_match (0.8 same-dir / 0.7 repo-wide)` > `ambiguous (skipped)`. Hardcoded in `resolve.rs`; surfaced to viz + MCP.

## CONVENTIONS

- `pub use` re-exports only the surface used by `cli` + `mcp`. Internal types stay private.
- Iteration: always `BTreeMap` / sorted `Vec`, never `HashMap` directly in output paths.
- Tree-sitter access via `child_by_field_name` (not positional indexing) — hidden grammar nodes drift.

## ANTI-PATTERNS

- Adding a field to `Node` / `Edge` without `#[serde(default)]` — breaks backward compat reading old `.reposkein/`.
- Bumping `EXTRACT_CACHE_SCHEMA` *backwards* — caches become stale silently.
- New `HashSet<NodeId>` in a serializer path. Use `BTreeSet`.
- A heuristic that depends on file-system order. Walk order is fixed by `walk.rs`.
