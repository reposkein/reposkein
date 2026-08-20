# Host your constellation

RepoSkein's viewer can export a **self-contained static site** — the graph
is baked into `graph-data.js`, so the exported folder needs no server, no
Neo4j, and no network access. That makes it easy to publish a durable,
shareable link to your repo's constellation. This doc covers the two ways to
do that:

1. **GitHub Pages** (recommended default, if your repo is already on GitHub).
2. **Any other static host**, for repos that must stay off GitHub Pages.

> **⚠️ GitHub Pages is PUBLIC by default.** A repository's Pages site is
> reachable by anyone with the URL, even if the repository itself is
> private — Pages does not inherit repo visibility. Do not publish a
> constellation for a repo whose code, file paths, symbol names, or authored
> summaries are sensitive, unless you are on **GitHub Enterprise Cloud with
> private Pages enabled** (Settings → Pages → Visibility). If you're unsure,
> use one of the internal-host alternatives in §3 instead.

---

## 1. GitHub Pages (via the reusable publish workflow)

The fastest path is `reposkein-mcp init --ci`, which writes
`.github/workflows/reposkein-pages.yml` — a thin caller of RepoSkein's
reusable `publish-pages.yml` workflow:

```sh
reposkein-mcp init --ci
```

This writes a workflow that, on every push to `main`:

1. Checks out your repo (full history — needed for the temporal co-change
   overlay).
2. Downloads a **released** `reposkein-indexer` binary from GitHub Releases
   for the runner's platform (linux-x64/arm64) — no Rust toolchain needed.
3. Indexes your repo and asserts the indexer binary's release version and
   your `.reposkein/meta.json` schema version are compatible (fails loudly,
   rather than silently, on a skew).
4. Runs `reposkein-mcp view --export` to produce the self-contained static
   site, baking in the commit sha, build time, repo URL, and git-derived
   temporal co-change data.
5. Uploads and deploys it to GitHub Pages.

**One-time setup** (repo owner): Settings → Pages → Build and deployment →
Source: **"GitHub Actions"**. Until that's flipped, the workflow's build job
still succeeds (it produces the artifact); only the deploy job fails.

### What gets baked in

- `{commitSha, builtAt, repoUrl}` — drives the viewer's staleness badge
  ("graph @ `<sha>` · `<age>`", linking to the commit).
- Git-derived temporal co-change data (the same computation
  `/api/temporal` serves in live-server mode), so the coupling overlay works
  offline.
- `federated[]` entries for any nested `.reposkein/` repos, inlined in full
  (no runtime fetch — still self-contained).
- Optionally, size-capped per-node source slices (`with-source: true` input)
  for the DetailPanel's read-only source peek. Off by default — it adds
  bytes to the export proportional to your repo's symbol count. Covers the
  **root repo only** — nodes from a federated child repo (§ above) render
  without a baked source peek.

### Freshness monitoring

`reposkein-mcp init --ci` writes only the publish workflow. If you also want
a canary that fails (a visible red X) when the pipeline has silently
stopped publishing, add a scheduled caller of the reusable
`publish-pages-freshness.yml` workflow — see `.github/workflows/
pages-freshness.yml` in this repo for the pattern (checks the age of the
last successful `pages.yml` run via the GitHub API, defaults to a 7-day
threshold).

### Customizing the workflow

The generated workflow calls `publish-pages.yml` with sensible defaults.
Edit the `with:` block to change behavior — see the reusable workflow's
`workflow_call.inputs` for the full list (`repo-path`, `mcp-version`,
`with-source`, `source-max-bytes`, `artifact-name`, `deploy`).

---

## 2. Manual export

You don't need CI to produce the static site — `reposkein-mcp view --export`
works locally:

```sh
reposkein-mcp view --export ./_site . \
  --commit-sha "$(git rev-parse HEAD)" \
  --repo-url "https://github.com/<org>/<repo>"
```

`./_site` is now a self-contained folder: open `./_site/index.html` directly
(`file://` works — hash-based routing, no server needed) or upload it
anywhere static files are served.

---

## 3. Internal-host alternatives (when GitHub Pages is off the table)

Because the export is fully self-contained, `./_site` can be hosted
**anywhere that serves static files over HTTP(S)**, including:

- **An internal static-hosting bucket** (S3 / GCS / Azure Blob + a CDN,
  restricted to your VPN or IdP).
- **An internal artifact/docs server** (Nginx, a docs platform, an internal
  developer portal) — just point it at the exported folder.
- **GitLab Pages**, if your repo lives on GitLab instead — same export,
  different CI glue (adapt `publish-pages.yml`'s steps to a `.gitlab-ci.yml`
  job; the `reposkein-mcp view --export` step is host-agnostic).
- **A local file share / open locally** — for a quick one-off, `reposkein-mcp
  view --export ./_site .` and hand someone the folder; `_site/index.html`
  opens directly from `file://`.

None of these require any change to the export itself — `runExport` never
makes network calls and never depends on being served from a particular
origin (hash-history routing handles any subpath).

---

## See also

- [`INSTALL.md`](./INSTALL.md) — installing the MCP server + indexer.
- `reposkein-mcp view --help` (or `reposkein-mcp view -h`) for the full list
  of export flags.
