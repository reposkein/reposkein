# indexer/

Rust cargo workspace. Produces `reposkein-indexer` binary + per-language Tree-sitter extractors. Output is the canonical `.reposkein/*.jsonl`.

## CRATES

```
core/        # graph engine (model, id, jsonl, merge, resolve, walk, cache)
lang-common/ # shared helpers across extractors (text, unique, collect_calls)
cli/         # the reposkein-indexer binary; registers extractors, installs git hooks
lang-python/ # |
lang-ts/     # | one Extractor impl each; lang-ts ships BOTH TypeScript + JavaScript
lang-rust/   # |
lang-go/     # | (TEMPLATE for new languages — copy this one)
lang-java/   # |
lang-csharp/ # |
neo4j-io/    # optional Neo4j load/export/projection (sync wrapper around async neo4rs)
```

## DEP GRAPH

- `lang-common` → `core`
- each `lang-*` → `core` + `lang-common` (+ its tree-sitter grammar crate)
- `cli` → `core` + every `lang-*` + `neo4j-io`
- `neo4j-io` → `core` + `neo4rs` + `tokio` (private runtime)

## ENTRY POINT

`crates/cli/src/main.rs:540` — `fn main()`. Extractors are registered in-place; bump `EXTRACT_CACHE_SCHEMA` in `core/src/cache.rs` when adding one.

## CONVENTIONS

- Errors: `anyhow::Result` everywhere. **No `thiserror`, no custom error enums.**
- No Cargo `[features]` on any crate (kept simple — features defer to env vars).
- `rust-toolchain.toml` pins `channel = "stable"` + `rustfmt` + `clippy`.
- Shared deps live in `[workspace.dependencies]` (`Cargo.toml`). Crates use `dep = { workspace = true }`.
- Workspace `[workspace.package]` centralizes version/edition/license — `scripts/release.sh` rewrites only this version (it propagates to all crates).

## ANTI-PATTERNS

- `serde_json = { features = ["preserve_order"] }` — would tie JSONL byte-order to HashMap insertion order. CI catches via determinism tests.
- Introducing `HashMap` iteration into the indexer path without sorting first.
- `chrono::Utc::now()`, `rand::*`, `SystemTime::now()` anywhere in extract → resolve → serialize. Time/randomness break determinism.
- A new `Cargo.lock` for a member crate — the workspace `Cargo.lock` is the only one.

## ADDING A LANGUAGE

Use `lang-go/` as the template (Go was added last, has the cleanest structure). Steps in [`../CONTRIBUTING.md`](../CONTRIBUTING.md):

1. New crate `crates/lang-<x>/` with `lib.rs` (`Extractor` impl) + `defs.rs` (Walk) + `calls.rs` (+ optional `imports.rs`, `classify.rs`).
2. Decide the `@arity` qualified-name rule and **freeze it in `core/src/id.rs` with a `*_frozen` test** — changing it later orphans every summary.
3. Register in `cli/src/main.rs`'s extractor slice. Bump `EXTRACT_CACHE_SCHEMA`.
4. Read fields via `child_by_field_name` (robust to hidden grammar nodes). Return `default()` on parse failure — **never panic**.

## TESTS

```bash
cargo test                                          # unit + non-gated integration
cargo test -p reposkein-neo4j-io -- --ignored       # needs NEO4J_PASSWORD; CI serializes with --test-threads=1
cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings
```

CLI integration tests live in `crates/cli/tests/*.rs` (`index_cli`, `reindex_cli`, `merge_cli`, `init_hooks_cli`). Neo4j round-trip test (`load → export`) is the determinism contract for the optional backend.
