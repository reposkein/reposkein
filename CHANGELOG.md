# Changelog

All notable changes to RepoSkein. Format roughly follows
[Keep a Changelog](https://keepachangelog.com); generated/maintained from
[Conventional Commits](https://www.conventionalcommits.org) (see `cliff.toml`).

## [Unreleased]

## [0.6.1] - 2026-08-22

### Security

- **Linear-time `Authorization` header parsing in `serve --http`.** The
  bearer-token parse used a regex vulnerable to polynomial ReDoS on
  attacker-controlled input; replaced with plain string operations
  (prefix check, single separator, slice+trim), same accepted inputs.
  (CodeQL #5)
- **Capped `REPOSKEIN_AGENT` before slug regexes.** The env var is now
  truncated to 256 chars before any trim regex runs, closing a polynomial
  ReDoS on an uncapped value. (CodeQL #4)

## [0.6.0] - 2026-08-22

### Added

- **`reposkein-mcp support` — offline supporter entitlement.** A new CLI
  subcommand (`support <token>`, `support -` to read a token from stdin,
  `support --status`, `support --remove`) installs, inspects, and removes a
  Ko-fi "Skein" member's supporter token. The token is a minimal Ed25519
  envelope (`rsk1.<payload>.<signature>`) verified entirely offline against
  a public key compiled into the package — no licence server, no
  activation call, no heartbeat, no revocation check, and no network call
  now or ever. Being a supporter turns ads off; that's the only effect.
  (#62)
- **Ko-fi support links + `FUNDING.yml`.** A visible, honest way to support
  the project's maintenance. (#59)
- **Ko-fi fulfillment worker.** A small, optional Cloudflare Worker under
  `workers/` that verifies Ko-fi's webhook and mints a supporter token on a
  Skein membership payment, delivered via a one-time claim link a human
  relays through Ko-fi's own supporter DM (Ko-fi's webhook can't message
  the payer directly). This is RepoSkein's own infrastructure — no
  user-facing feature depends on it, and a token already issued keeps
  verifying offline whether or not this worker is deployed. (#62, #64)
- **Disclosed sponsored-slot infrastructure — off by default, dormant.**
  Wiring for an opt-in, fail-open sponsored slot on the MCP tool-result
  envelope (`_meta["reposkein/sponsored"]` only, never mixed into
  `content`), gated behind a kill switch, explicit opt-in, credentials, and
  a non-supporter check, with `semantic_find` and every mutating tool
  permanently excluded. Shipped disclosed and currently **dormant by
  decision**: the governing ADR authorizes a future viewer-chip placement,
  not this MCP-result surface, so this infrastructure stays off until a
  separate decision ratifies it. Nothing about this release turns ads on
  for anyone. (#60, #61)
- **Canonical tagline + tool-description polish.** One agent-facing
  description sentence reused verbatim across `README.md`, `mcp/README.md`,
  and `mcp/package.json`; a paste-able install line surfaced in the README
  hero; and tightened `reindex_file` / `write_semantic_summary` tool
  descriptions (wording only — schemas and behavior unchanged). (#63)

## [0.5.0] - 2026-08-21

### Added

- **Astrolabe viewer redesign complete.** Four PRs finish the redesign begun on
  the React 19 + R3F v9 + Tailwind-tokens foundation (#50) and the ⌘K command
  palette (#51) shipped in 0.4.0:
  - **Status bar + mode chips.** One persistent chrome strip replaces
    scattered viewer chrome, with a never-null breadcrumb and mode chips
    surfacing the active view at all times. (#53)
  - **Inspector + summoned layers.** A single Inspector drawer and
    on-demand summoned layers replace five legacy panels, cutting the
    viewer's chrome surface without losing any capability. (#54)
  - **Navigation semantics.** Layered `Esc` (undoes the most local thing
    first), scoped collapse, view history, anchor-aware hops, and
    URL-as-view (the URL is always a faithful, shareable snapshot of what's
    on screen). (#55)
  - **Polish pass.** A first-run coach mark, responsive chrome down to
    narrow viewports, and an accessibility floor (focus order, contrast,
    keyboard reachability) across the redesigned surface. (#56)

  **Note for hosted-constellation users:** the GitHub Pages viewer deploys
  from the released `@reposkein/mcp` package, not from `main` — this release
  is what upgrades the deployed viewer app itself.

- **Optional shared remote MCP.** `reposkein-mcp serve --http` serves the MCP
  Streamable HTTP transport and the viewer/`/api/*` surface from one process
  against one git checkout, so a team can share a single running instance
  instead of each agent spawning its own local one. Strictly optional: stdio
  stays the default, and `serve --http` refuses to start without auth —
  `name:secret[:write]` bearer tokens via `REPOSKEIN_SERVE_TOKENS` or
  `config.toml`, timing-safe comparison. Read-only toolset by default;
  write capability (e.g. `record_decision`) is granted per token, and writes
  carry the token's identity for attribution. ADR-first: the decision to
  lift the hosted/multi-user non-goal was recorded and accepted before the
  feature shipped. (#57)

## [0.4.0] - 2026-08-21

### Added

- **Zero-config repo resolution.** `reposkein-mcp` no longer needs
  `REPOSKEIN_REPO_PATH` set up front: it walks up to the nearest ancestor
  `.reposkein/`, or (workspace mode) walks down two levels for a single
  unambiguous hit. New `list_repos` / `select_repo` MCP tools let an agent
  enumerate and switch the session-active repo mid-connection — the fix for
  "can't switch repos without a restart." (#44)
- **Per-session usage stats.** Every MCP tool call is now logged to
  `.reposkein/local/sessions/<session-id>.jsonl`, and `reposkein-mcp stats
  [--last | --session <id> | --all] [--json]` reports calls by tool, top
  queried nodes/files, ADRs/summaries written, and an estimated
  context-tokens-saved-vs-grep figure. (#45)
- **Merge-smooth summaries.** Committed summaries move from one
  `summaries.jsonl` to sharded storage at `.reposkein/summaries/<xx>.jsonl`
  (keyed by content hash), so two branches summarising different nodes no
  longer collide on the same file. Tolerant readers survive merge conflict
  markers and cross-source divergence, preserving the losing summary rather
  than dropping it. The layout migration runs automatically the next time a
  repo is indexed — no manual step. `reposkein-mcp doctor` gained checks for
  unsplit legacy files and `.gitignore` rules that silently mask shards. (#46)
- **Hosted constellation.** A reusable `publish-pages.yml` workflow
  downloads a released `reposkein-indexer` binary instead of building from
  source, asserts binary/repo schema compatibility via a new
  `--schema-version` flag, and exports a staleness badge and durable deep
  links (survives a federated `repo_id` change) into the published viewer.
  `reposkein-mcp init --ci` writes the workflow template into a consuming
  repo. (#47)
- **One-command team join.** `reposkein-mcp init` now detects a fresh clone
  of an already-`.reposkein`-committed repo and writes MCP config for
  whichever agent(s) it finds (Claude Code, opencode, Cursor) instead of
  printing a snippet to copy by hand. `doctor --ci` promotes drift checks to
  a failing exit code for CI use, and the binary fetch is now proxy-aware
  (`HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`). (#48)
- **⌘K command palette.** The viewer gains a keyboard-driven palette over
  nodes and commands, fully keyboard-navigable and accessibility-correct.
  (#51)

### Changed

- **Viewer stack: React 19 + React Three Fiber v9.** The Astrolabe redesign's
  foundation — `@react-three/drei` v10, `@react-three/postprocessing` v3,
  `three` 0.185, a `frameloop="demand"` render loop (every frame now has an
  explicit trigger), and a store split so pointer-rate state no longer
  re-renders the whole HUD. Verified pixel-equivalent against the previous
  build; zero intended visual change. (#50)

### Docs

- **README and docs overhaul.** The README becomes a front door; `docs/`
  gets a task-oriented index. (#49)

## [0.3.0] - 2026-08-20

### Added

- **Architecture Decision Records: the graph now remembers *why*.** Agents record
  significant design decisions with the new `record_decision` MCP tool, anchored to
  the graph nodes and paths they govern; recall them with `list_decisions` /
  `get_decision`, ratify or retire them with `set_decision_status`, and re-stamp a
  still-correct decision after code changes with `reaffirm_decision`. Records land
  as `proposed` (a human ratifies), bodies are immutable (`body_hash`-checked), and
  nothing is ever machine-deleted — a decision about deleted code is still history.
  (#42)

  - **Storage that survives teams.** One committed JSON file per decision at
    `.reposkein/decisions/<date>-<slug>.json` — parallel branches appending records
    never merge-conflict on forges (the lesson from #35). Ids are portable
    `adr:<date>-<slug>` (no repo_id, so forks and no-remote clones resolve them);
    anchors keep full `rs1:` node ids, matched tolerantly by suffix, with
    content-hash recovery when anchored code is renamed.
  - **Decisions surface where agents already look.** `get_context_profile` returns
    `target.decisions` plus `decisions_needing_review` for accepted decisions whose
    code drifted; `impact` returns `governing_decisions` over the target and its
    impacted callers; `semantic_find` ranks decisions in the corpus, so "why don't
    we X?" queries answer from recorded rationale (kind: `"Decision"` filters to it).
  - **Mechanical drift detection.** The indexer diffs the previous graph against the
    fresh one (`graph_delta` in `--json` stats — content-hash based, so line shifts
    and summary edits never fire it) and persists the delta to
    `.reposkein/local/last_delta.json`; hook-driven indexes discard stdout, and
    post-merge is exactly when teammate changes invalidate decisions, so the next
    `reindex_file` / `init_cpg_skeleton` call surfaces `decisions_affected` — the
    skill instructs the agent to conform, supersede, or reaffirm.
  - **Interop + hygiene.** `reposkein-mcp adr export` renders the log to
    `docs/adr/NNNN-slug.md` (Nygard sections; a derived view — JSON stays the system
    of record) and `adr import` brings an existing markdown ADR log in, idempotently.
    `reposkein-mcp doctor` validates the log: parse failures, duplicate ids,
    body-hash tampering, dangling/cyclic supersession, and a ~100-active-record
    budget warning.
  - The `reposkein-graph-rag` skill gains when-to-record guidance (significance
    test + anti-triggers) and the rule: check `list_decisions` before modifying
    governed code — never silently violate a decision. RepoSkein's own repo ships
    three seeded decisions recorded through these tools.

### Security

- **All nine open Dependabot alerts resolved** (lockfile-only; no API changes).
  The one runtime exposure in the shipped package — `body-parser` < 2.3.0 (DoS
  when an invalid `limit` silently disables size enforcement, low severity, via
  `@modelcontextprotocol/sdk` → `express`) — is bumped to 2.3.0. The remaining
  eight were development-scope build tooling in the mcp and viz dependency
  trees: `postcss` → 8.5.26 (source-map path traversal + its incomplete fix),
  `js-yaml` → 4.3.1 (quadratic CPU in `!!omap` and merge-key chains), and
  `brace-expansion` → 1.1.18 / 5.0.9 (exponential-time expansion DoS).

## [0.2.7] - 2026-08-07

### Changed

- **The derived graph is no longer committed; summaries are.** `.reposkein/nodes.jsonl`
  and `edges.jsonl` are regenerated artefacts, and committing them cost more than it
  bought. `reposkein-mcp init` now gitignores them, `ensureGraph` builds them on demand
  when they are absent, and the merge-driver declaration they required is removed from
  `.gitattributes` (the cleanup matches any `merge=` on those two paths, so both the
  `reposkein-jsonl` and `union` variants go). Semantic summaries, which are authored
  rather than derived, are what a repo shares. (#35)

  Two problems this removes, both measured in the CellarNode workspace:

  - **Context exhaustion in coding agents.** The pre-commit hook rewrote both files on
    every commit, so they landed in `git diff` output. In one consumer repo the tracked
    pair reached **7.2 MB, roughly 1.9x a 1M-token context window**, which repeatedly
    killed agents mid-task with autocompact thrashing.
  - **Silent duplicate node ids after a rebase.** Replaying a commit that touched the
    graph could leave duplicate ids that `git diff --name-only` does not surface, since
    the file is listed as changed either way. Observed at 26, 19, 4 and 40 duplicates
    on separate rebases, each requiring a re-index to clear.

  **Migrating an existing repo:** run `reposkein-mcp init` to pick up the new
  `.gitignore` and `.gitattributes`, then `git rm --cached .reposkein/nodes.jsonl
  .reposkein/edges.jsonl` and commit. The graph rebuilds locally on next use.

## [0.2.6] - 2026-07-06

### Added

- **`reposkein-mcp init` now gitignores the per-machine MCP config.** `init` appends
  `.mcp.json` and `opencode.json` to the repo's `.gitignore` (idempotent, and it
  creates the file if absent), so the per-machine config (which carries absolute
  machine paths and a local backend password) is never committed; only the
  `.reposkein/` graph is shared. The setup docs (`docs/INSTALL.md`, the
  `reposkein-setup` skill) now say the same, and this repo's own `.gitignore` lists
  them too. (#18)

## [0.2.5] - 2026-06-24

### Fixed

- **`get_context_profile`'s `hops` schema is now Gemini-compatible.** `hops` was declared
  as `z.union([z.literal(1), z.literal(2)])`, which serialises to JSON-Schema
  `anyOf: [{const: 1}, {const: 2}]`. Gemini's tool-schema validator rejects the numeric
  `const`/enum (a `TYPE_STRING` mismatch) and **400s the entire request** — so a single
  reposkein tool in the payload broke *every* Gemini model (`gemini-3-flash` and
  `gemini-3.1-pro`), while Anthropic and OpenAI silently tolerated it. Replaced with a
  bounded integer (`z.number().int().min(1).max(2)`, mirroring the `impact` tool's
  `depth`); the schema is now an exported const with a regression test asserting no tool
  schema emits `anyOf`/`oneOf`.

## [0.2.4] - 2026-06-17

Cleanup / polish pass (the low-value backlog from the code audit). No behavior change.

### Changed

- **Viewer bundle is code-split** into `three` / `react-three` / `tanstack` vendor
  chunks — smaller initial app chunk, faster first paint (static-export relative
  paths preserved).
- Removed dead code (`indexerBinPath`); recorded the intentional decision that
  `impact`/`get_context_profile` neighborhoods are **CALLS-only** (`INSTANTIATES`
  edges live in the graph for `read_cypher`/visualization but aren't traversed —
  both backends agree); `view` now warns instead of silently using a placeholder
  repo id; clarified the cross-repo-edge parity comments.

### Internal

- Added a 3-way merge property matrix (structure × summary divergence) locking the
  JSONL merge-driver behavior; guarded the viewer screenshot capture singleton.

## [0.2.3] - 2026-06-17

A hardening pass from a four-area code audit — correctness, robustness, and
supply-chain depth.

### Fixed

- **Python `INSTANTIATES` is single-sourced.** A Python `x = Foo()` produced two
  colliding `INSTANTIATES` edges (one via class-lift, one via the construction
  site); the JSONL dedup silently dropped one. Now exactly one edge per
  `(caller, class)` with a correct, non-double-counted `sites`. (Cache schema 13 → 14.)
- **Edge dedup is now an explicit prop-merge** (keyed `BTreeMap`) at the resolver
  boundary instead of `dedup_by` keep-first — colliding edges merge deterministically
  rather than silently dropping props.
- **`reposkein-mcp view` path guard hardened** — `safeJoin` now resolves symlinks
  (`realpathSync`) and re-checks containment, so a symlink inside the served root
  can't escape it.
- **The packaged bin is marked executable in the build** (`chmod 0755 dist/index.js`),
  so a bare/symlink invocation works without relying on npm's install-time chmod.

### Added (robustness / CI / supply chain)

- **End-to-end bin smoke test** in CI and pre-publish: launches `reposkein-mcp`
  **via a symlink** (as an executable, relying on the shebang) and asserts it answers
  an MCP `initialize` — the exact seam that let the 0.2.0 shebang and 0.2.1 symlink-guard
  bugs ship undetected. The release also packs the tarball and asserts the bin starts
  *before* publishing. The Glama `Dockerfile` gained the same build-time start assertion.
- **Version-lockstep CI check** (`indexer/Cargo.toml` == `mcp/package.json`) so a skew
  can't make the npm postinstall fetch a nonexistent release asset.
- **GitHub Actions pinned to commit SHAs** + a `dependabot.yml` to keep them current.

### Internal (viz viewer)

- Fixed a GPU-resource leak (geometries/materials now disposed on recompute), throttled
  hover + precomputed adjacency (no full edge-pipeline rebuild per pointer-move), fixed a
  guided-tour stale-state bug, removed dead code, and de-duplicated shared helpers.

## [0.2.2] - 2026-06-17

### Fixed

- **`reposkein-mcp` now starts when launched via a symlink** (global install /
  container / MCP registry such as Glama). The entry-point guard compared
  `import.meta.url` against `process.argv[1]` — but a global install runs the bin
  through a symlink (e.g. `/usr/bin/reposkein-mcp`), whose path never equals the
  resolved module path, so `main()` never ran and the server exited immediately
  ("Connection closed"). The guard now resolves the symlink via `realpathSync`.
  Together with 0.2.1's shebang, the globally-installed bin launches correctly.

## [0.2.1] - 2026-06-17

### Fixed

- **`reposkein-mcp` bin now carries a `#!/usr/bin/env node` shebang.** Executing
  the globally-installed binary *directly* (in a container / MCP registry such as
  Glama, or our own Docker image) ran it through `/bin/sh`, which tried to
  interpret the JavaScript as shell ("import: not found"). It now launches under
  Node. (npx- and agent-launched usage was unaffected.)

## [0.2.0] - 2026-06-16

### Added

- **`reposkein-mcp view` — an interactive 3D "constellation" graph viewer.** A
  zero-infra, read-only React + three.js SPA over the committed `.reposkein`
  JSONL (no Neo4j, no external services; served on `127.0.0.1`). Renders the code
  graph as an astronomy-style star map with level-of-detail clustering
  (repo → directory → file → symbol = galaxy → constellation → solar-system → star),
  deterministic seeded layout (cached in IndexedDB for instant reload), bloom /
  depth-fog / nebula halos / constellation lines / supernova expand, and
  brand-styled visuals.
  - **Legible:** per-edge-type colors + legend, importance-sized stars, adaptive
    labels, breadcrumb, per-language galaxy coloring.
  - **Analytical (leans on RepoSkein's graph):** one-click **lenses** (call graph /
    type hierarchy / imports / tests), **impact overlay** (transitive callers +
    covering tests), **confidence-audit** mode (see where the type-free resolver
    guesses), **temporal-coupling** overlay (git co-change), and edges encoded by
    `resolution`/`confidence`.
  - **Explorable:** ranked search-to-fly, **neighborhood focus** (N-hop), **source
    peek** in the detail panel (path-guarded read-only slice + `vscode://` open),
    flow particles showing call direction, keyboard navigation, and a minimap.
  - **Guided tour:** a cinematic, deterministically-derived flythrough (overview →
    largest modules → busiest hub → type hierarchy → entry point) with captions.
  - **Shareable:** PNG screenshot export, and a **static embeddable export**
    (`reposkein-mcp view --export <dir>`) that bakes the graph into a
    self-contained site (works from `file://` or any static host — e.g. a landing
    page) with no server.
- The npm package now bundles the prebuilt viewer; CI gates the `viz` package
  (typecheck/build/test/lint).

## [0.1.7] - 2026-06-16

### Added

- **Intraprocedural receiver-type resolution.** When a local variable is assigned
  an in-repo class constructor (`x = Foo()`, `const x = new Foo()`, `let x =
  Foo::new()`, `x := Foo{}`, …), that variable's later method calls (`x.bar()`)
  now resolve **`exact`/1.0** to the class's method instead of a low-confidence
  name match — across all 7 languages, deterministically from source alone (no
  compiler, no external index). Reassigned/shadowed locals are conservatively
  dropped (no guessing); calls on untraceable receivers (params/fields/returns)
  still fall back to name-match.

### Changed

- Extract-cache schema bumped 12 → 13 (the new `bound_local` binding fact changes
  extractor output).

## [0.1.6] - 2026-06-16

### Added

- **`INSTANTIATES` now covers Rust and Go construction idioms.** Rust
  associated-function constructors (`Foo::new()`, when `Foo` resolves to a
  repo class — `Vec::new()` and other external types are correctly skipped) and
  Go composite literals (`Foo{}`, `&Foo{}`, `pkg.Foo{}`) emit `INSTANTIATES`
  edges, alongside the existing `new Foo()` (TS/JS/Java/C#), Rust struct
  literals, and Python class-name calls. Anonymous composite literals
  (`[]int{}`, `map[string]int{}`) are not construction and emit nothing.

### Changed

- Extract-cache schema bumped 11 → 12 (Rust `Foo::new()` + Go composite-literal
  construction sites changed extractor output).

### CI

- The CI workflow declares least-privilege `permissions: contents: read`
  (resolves the CodeQL "workflow does not contain permissions" findings), and
  all workflows opt node20-declaring actions into the Node 24 runtime.

## [0.1.5] - 2026-06-16

Deeper structural resolution: heritage now crosses files **and** repos, plus a new
instantiation relation and sharper Go/Python edges.

### Added

- **Cross-file heritage.** `INHERITS`/`IMPLEMENTS` now resolve to base types
  declared in *other* files (not just the same file), across all heritage-bearing
  languages. Resolution mirrors the CALLS ladder — same-file & import-followed
  resolve `exact` (1.0), unique same-dir / repo-wide bases resolve `name_match`
  (0.8 / 0.7); **ambiguous bases are skipped** (a false hierarchy edge is worse
  than a missing one). Heritage edges now carry `resolution` + `confidence`.
- **Cross-repo heritage.** When a deriving type's base lives in a federated child
  repo, a deterministic `external_heritage` candidate is recorded at index time and
  **stitched into a cross-repo `INHERITS`/`IMPLEMENTS` edge at load time** — on both
  the Neo4j and zero-infra backends, mirroring cross-repo CALLS/IMPORTS.
- **`INSTANTIATES` edges.** Constructors now link the constructing function to the
  class it builds: `new Foo()` (TS/JS/Java/C#), struct literals (Rust), and Python
  `Foo()` whose callee resolves to a class. Resolved against the type index, skipped
  when ambiguous — so an agent can answer *who creates instances of this type?*
- **Go embedded-type heritage.** Struct and interface embedding
  (`type Dog struct { Animal }`, `type RW interface { Reader; Writer }`) is captured
  as `INHERITS` and resolved cross-file like every other language.
- **Python module-alias calls.** `import foo as f; f.bar()` (and `import foo;
  foo.bar()`, `import a.b as x; x.go()`) now resolve `exact` to the target module's
  function instead of a low-confidence name match.

### Changed

- Python heritage now captures **dotted superclass bases** (`class C(a.b.Base)`),
  resolved via the importing file's import.
- C# `INHERITS`-vs-`IMPLEMENTS` is now decided from the resolved target's label
  **cross-file** (previously only correct for same-file bases).
- Extract-cache schema bumped 9 → 11 (heritage moved to resolver-time facts; Go
  embedding, module aliases, and constructor sites changed extractor output).

## [0.1.4] - 2026-06-16

A four-reviewer security + quality audit pass, plus a hardened cold-start.

### Security

- **Prebuilt indexer binary is now integrity-verified** — the release publishes
  `SHA256SUMS`, the npm package bundles per-platform digests, and the postinstall
  fetch verifies sha256 before executing (fail-closed; never runs a mismatched
  binary). HTTPS-only + host-allowlisted redirects, atomic temp→verify→rename, and
  `npm publish --provenance`.
- Indexer child process gets an explicit env allow-list (no secret leakage).
- `init` no longer overwrites existing user git hooks (marker-gated); the JSONL
  merge driver is registered with an absolute binary path.

### Added

- **Bulletproof cold-start:** `reposkein-mcp init` now **builds the initial graph**
  (use `--no-index` to skip), and a new **`reposkein-mcp index [path]`** subcommand
  indexes via the bundled binary (npx users no longer need `reposkein-indexer` on PATH).
- **TS/JS barrel re-exports** (`export … from`, `export *`) → IMPORTS edges.
- **In-file heritage:** Rust supertraits and TS `interface extends` → INHERITS.

### Fixed

- **Federation parity:** the zero-infra store now exposes the full transitive repo
  set (grandchildren were silently excluded from federated reads).
- **`semantic_find`** neutralizes summaries (closes an injection path).
- **C#** uses the last segment of a qualified base type (`Ns.Base` → `Base`).
- Embedding/`git log`/indexer calls are now **timeout-bounded** (no hangs; embeddings
  fall back to lexical); embedding cache rows are validated on load + filenames
  sanitized; `git log` header parsing is shape-anchored; the temporal cache is atomic
  + versioned; `impact`'s test-path classifier matches the indexer.
- TS base type-args stripped (`extends Foo<T>` resolves); Python Variable ids deduped.

### Hardened

- `embed-server` image runs as non-root and binds `127.0.0.1` by default.
- A permanent guard test protects the `serde_json` sorted-keys determinism assumption.

## [0.1.3] - 2026-06-16

### Docs & packaging

- Restructured the README (introduction, table of contents, prerequisites,
  usage/demo, documentation index, contributing, acknowledgements, contact) with
  an animated brand header; added `CONTRIBUTING.md` (incl. the add-a-language recipe).
- Brand-consistent headers + navigation across all READMEs.
- Enriched the npm package metadata (keywords, homepage, repository, bugs) for a
  nicer npmjs.com page + search discoverability.
- Published the `embed-server` image to GHCR (public, multi-arch amd64/arm64) and
  documented the pull-don't-build path.

## [0.1.2] - 2026-06-16

### Added

- **`semantic_find`** — find where to start: rank functions/classes by a
  deterministic lexical BM25F score over qualified names, signatures, and
  summaries; seeds `get_context_profile`. Optional **pluggable embeddings** tier
  (default off) — `voyage` (`voyage-code-3` API), `http` (local/open model, e.g.
  `voyage-4-nano`), hybrid via Reciprocal Rank Fusion; vectors cached
  non-committed in `.reposkein/local/`, automatic fallback to lexical.
- **`get_temporal_context`** — git-derived co-change (files that change
  together), churn/recency, and ownership for a file. Derived, advisory, never
  committed.
- **`impact`** — transitive callers of a function/class, split into impacted
  code vs covering tests, in one call.

## [0.1.1] - 2026-06-15

### Added

- **Go, Java, and C# language support** — now 7 languages (Python, TS/JS, Rust,
  Go, Java, C#).
- **`reposkein-mcp doctor`** — host-agnostic health check (binary, index, repo id).
- **Rust `use`→`IMPORTS`** incl. groups, aliases, globs, and `pub use` re-export
  chains; workspace-aware crate-root detection.
- **Scope-aware resolver rung** — prefers same-directory candidates before
  repo-wide name matches, reducing false-ambiguous fan-out.
- npm package README; a `Dockerfile` for MCP-registry introspection (Glama);
  cross-agent skills via skills.sh.

### Changed

- Release binaries are **Apple-Silicon-only on macOS** (4 platforms:
  darwin-arm64, linux-x64/arm64, win32-x64) — Intel macOS dropped.
- GitHub Actions bumped to Node 24 (`actions/*@v5`).

### Fixed

- TS Interface/Enum id collision (silent dedup data loss) → `unique()` +
  `content_hash`.
- `role_for` substring match (`contest_*.py` mis-flagged as a test) →
  path-segment matching.
- One unreadable file aborted the whole index → skip with a warning.
- Resolver downgraded `exact` edges via last-write-wins → keep the
  best (highest-confidence) resolution per `(caller, target)` pair.

## [0.1.0] - 2026-06-15

First public release: a local-first, deterministic GraphRAG-over-code tool — a
Rust indexer (Tree-sitter → canonical JSONL → Neo4j *or* zero-infra in-memory
store) serving an LLM agent over MCP.

### Features

- **Deterministic indexer.** Tree-sitter parses Python, TypeScript/TSX,
  JavaScript/JSX, and Rust into a Code Property Graph emitted as byte-identical
  canonical JSONL (stable `rs1:` ids, BLAKE3 content hashes, sorted keys).
- **Two interchangeable backends.** Load into Neo4j, or run fully **zero-infra**
  over an in-memory `JsonlGraphStore` — at verified behavioral parity.
- **MCP server (`@reposkein/mcp`)** with five tools: `get_context_profile`
  (caller/callee neighborhood + inlined prose), `read_cypher` (read-only,
  guarded), `write_semantic_summary` (JIT, hash-stamped for staleness),
  `init_cpg_skeleton`, `reindex_file`.
- **Federation.** Nested repos via `FEDERATES_TO`; federated `read_cypher` and
  `get_context_profile`; **cross-repo CALLS** (import-scoped, precise) and
  **cross-repo IMPORTS** edges — on both backends.
- **Incremental reindex.** Per-file extract cache (cold-vs-warm byte-identical);
  cache-accelerated `index`/`reindex`.
- **Summaries reach git.** Agent-written summaries persist via a durable sidecar
  and graft into committed JSONL (hash-validated; stale dropped).
- **Git-native sync.** A 3-way JSONL merge driver + installed git hooks keep the
  graph in lockstep with source across branches and merges.
- **Distribution.** `npx @reposkein/mcp init` installs the prebuilt indexer
  binary (postinstall fetch), git hooks + merge driver, and the navigation
  skill, then prints the MCP config. Release pipeline builds binaries for
  darwin-arm64, linux-x64/arm64, and win32-x64 (Apple Silicon only on macOS).

### Security & determinism

- Read-only Cypher guard (default-deny procedures); summaries neutralized on the
  read path (prompt-injection bound); federation `root_path` traversal guard;
  concurrent-`load` schema-creation race tolerated.
- `load → export` byte-identical round-trip; cross-repo edges are DB-only/
  in-memory so they never perturb committed output.

[0.1.0]: https://github.com/reposkein/reposkein/releases/tag/v0.1.0
