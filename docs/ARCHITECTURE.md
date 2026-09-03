# How RepoSkein works

For humans.

Moved out of the [README](../README.md) so the front door stays short — this
covers how the graph is built and resolved, how summaries stay merge-smooth,
cross-repo federation, and the full per-language support matrix.

## How it works

```
 Your agent (Claude Code / Cursor / …)   ── guided by the reposkein skill
        │  MCP
        ▼
 @reposkein/mcp        semantic_find · get_context_profile · impact · get_temporal_context
   (TypeScript)        read_cypher · write_semantic_summary · init_cpg_skeleton · reindex_file
                       CLI: init · doctor · index · view
        │ reads
        ▼
 .reposkein/           ← nodes.jsonl + edges.jsonl: derived, git-ignored, rebuilt on demand
                       summaries/<xx>.jsonl: what your agents authored — commit this
        ▲ writes
        │
 reposkein-indexer    Tree-sitter parse → stable IDs → canonical JSONL
   (Rust)             + git hooks that keep the local graph in step with your tree
```

- **Structure is static.** The skeleton comes only from parsing — identical code produces a byte-identical graph (a CI-tested invariant), independent of who runs it.
- **Meaning is just-in-time.** Summaries are written as the agent visits nodes; they're content-hash-stamped (so they flag stale when code changes) and committed to git.
- **Derived stays out of git.** `nodes.jsonl` and `edges.jsonl` are a pure function of your working tree, so committing them buys nothing a re-index cannot rebuild while making every branch that touches code conflict with every other. Only `summaries/`, `meta.json` and `config.toml` are committed — and the summaries are sharded by a hash of the node id, so two branches summarising different code write different files and never meet in a merge.
- **Local-first.** The JSONL on disk is the source of truth; the optional [Neo4j backend](NEO4J.md) is a reconstructable projection most users never need.
- **Big files are recorded, not parsed.** A tree-sitter syntax tree runs roughly 10–20× the size of its source, so one vendored or minified bundle can dominate an index's memory. Files over `[index] max_file_bytes` in `.reposkein/config.toml` (default 2 MiB) still get a `File` node — the tree does contain them — but are never handed to an extractor, and the skip is reported as a warning. The setting is committed rather than an env var, so the graph stays a byte-identical function of the tree on every machine.

Full detail on the shard scheme, merge behavior, and upgrading an existing repo off a single-file `summaries.jsonl`: [`INSTALL.md` §4.2](INSTALL.md#42-merge-behaviour-for-reposkein).

### Architecture decisions (ADRs)

Decisions your agent (or you) record with `record_decision` live as one committed JSON file per decision at `.reposkein/decisions/<date>-<slug>.json` — file-per-decision for the same reason summaries are sharded: parallel branches never merge-conflict on a forge. Decisions anchor to graph nodes and paths, so `get_context_profile` and `impact` surface the decisions governing a piece of code, and `semantic_find` includes them in its corpus for "why" questions. Full tool reference: [`docs/TOOLS.md`](TOOLS.md#architecture-decisions-adrs).

### Cross-repo federation

Got nested repositories (a monorepo of indexed repos)? RepoSkein discovers them, links them with `FEDERATES_TO`, and stitches **cross-repo call, import, and heritage edges** (`INHERITS`/`IMPLEMENTS` to a base in a child repo) at load time. Pass `federated: true` to traverse across repo boundaries. Federation edges are derived at load (never committed), so each repo stays independently deterministic.

## Supported languages

| Language | Definitions | Imports → edges | Cross-file calls |
| --- | --- | --- | --- |
| Python | functions, classes, methods, nested defs, vars | ✅ relative / absolute / aliased | import-resolved (`exact`) |
| TypeScript / TSX | classes, interfaces, enums, methods, arrows | ✅ named / default / aliased / `* as ns` | import-resolved (`exact`) |
| JavaScript / JSX | *(via the TS grammar)* | ✅ ES imports *(no CommonJS yet)* | import-resolved (`exact`) |
| Rust | fns, structs, traits, enums, `impl` methods | ✅ `use` (groups, aliases, globs, `pub use` chains; workspace-aware) | import-resolved (`exact`) |
| Go | funcs, methods (`Type.method`), structs, interfaces | *not yet (cross-package planned)* | same-package (same-dir); cross-package by name |
| Java | classes, records, interfaces, enums, methods, constructors, fields | ✅ package-path *(no wildcard/static yet)* | import-resolved (`exact`) |
| C# | classes, structs, records, interfaces, enums, methods, properties | *not yet (cross-namespace planned)* | same-dir; cross-namespace by name |

**What resolves — honestly.** Every edge carries a `resolution` (`exact` / `name_match` / `ambiguous`) + confidence, so your agent knows what to trust. Same-file calls, `self`/`this` methods, and **import-followed free-function calls resolve `exact`**. Python **module-alias calls** (`import foo as f; f.bar()`) resolve `exact` to the target module's function. **Cross-file INHERITS/IMPLEMENTS edges** are resolved repo-wide: import-followed bases resolve `exact` (confidence 1.0); unique same-directory or repo-wide bases resolve `name_match` (0.8/0.7); ambiguous bases are skipped to avoid false hierarchy edges — and bases that live in a **federated child repo** are stitched into cross-repo heritage edges at load time. Go's **struct/interface embedding** (`type Dog struct { Animal }`) is captured as INHERITS. Constructors emit a distinct **`INSTANTIATES`** edge (`new Foo()` in TS/Java/C#, `Foo { .. }` and `Foo::new()` in Rust, `Foo{}` / `&Foo{}` composite literals in Go, and Python `Foo()` whose name resolves to a class) so an agent can ask *who creates instances of this type* — resolved against the type index and skipped when ambiguous. The graph is **type-free by design** (deterministic, no compiler in the loop), but it does track types where it can do so soundly from source alone: when a local is assigned a constructor (`x = Foo(); x.bar()`), that **`x.bar()` resolves `exact`** to `Foo.bar` (intraprocedural receiver typing). Method calls on receivers it *can't* trace that way (parameters, fields, return values) **resolve by name** (≤ `name_match`), and overloaded calls are flagged `ambiguous`. Go and C# don't emit import edges yet, so their cross-package/namespace calls resolve by name (same-package/-directory calls *do* resolve). These limits are inherent to the zero-infra, type-free design; a deeper optional type-aware layer (SCIP) is gated on benchmark evidence. [Adding a language](../CONTRIBUTING.md#adding-a-new-language) is a well-trodden path — contributions welcome.

## See also

- [`../README.md`](../README.md) — the front door.
- [`TOOLS.md`](TOOLS.md) — the MCP tool + CLI reference.
- [`VIEWER.md`](VIEWER.md) — the constellation viewer.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — dev setup, invariants, adding a language.
