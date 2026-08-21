import { useStore } from "../state/store";
import { EDGE_TYPE_META, SYMBOL_KIND_META } from "../scene/encoding";
import { edgeTypeColorVar, nodeKindColorVar } from "../data/encodingVars";
import { LayerShell } from "./LayerShell";

/** The filters layer (Astrolabe V3 §2), replacing FilterHUD.
 *
 *  Two substantive changes beyond the move to a summoned layer:
 *
 *  1. THE ONE-DARK PALETTE IS GONE. FilterHUD carried its own hard-coded kind
 *     colors (`#e5c07b`, `#56b6c2`, …) that had NOTHING to do with the hues the
 *     scene actually draws — a "Class" chip was One-Dark cyan while the star was
 *     `#5fe0e0`. Chips now read `--color-node-*` / `--color-edge-*`, generated
 *     from `scene/encoding.ts`, so a chip and its stars are the same color by
 *     construction (`panels/colorIdentity.test.tsx`).
 *  2. PLAIN LANGUAGE. "CONFIDENCE AUDIT", "MIN CONFIDENCE", "EDGE BUNDLING" were
 *     label-shaped, not sentence-shaped. Each control now says what it does to
 *     the picture.
 *
 *  Semantics are unchanged: `filters.kinds` / `filters.edgeTypes` are HIDDEN
 *  sets (empty = show everything), so a lit chip means "visible". */
export function FiltersPopover() {
  const store = useStore();
  const { filters, audit } = store;
  const hasFilters =
    filters.kinds.size > 0 ||
    filters.edgeTypes.size > 0 ||
    filters.minConfidence > 0 ||
    audit !== "off";

  return (
    <LayerShell id="filters" title="Filters" dock="right" width="w-[264px]">
      <div className="max-h-[min(70vh,32rem)] overflow-y-auto p-2.5">
        <Field label="Symbol kinds" hint="Dim a kind to hide those stars">
          <div className="flex flex-wrap gap-1">
            {SYMBOL_KIND_META.map(({ kind, filterKey, label }) => {
              const hidden = filters.kinds.has(filterKey);
              return (
                <ColorChip
                  key={kind}
                  testId={`filter-chip-node-${kind}`}
                  colorVar={nodeKindColorVar(kind)}
                  label={label}
                  on={!hidden}
                  onClick={() => store.setKindFilter(filterKey, !hidden)}
                />
              );
            })}
          </div>
        </Field>

        <Field label="Relationships" hint="Dim an edge type to hide those threads">
          <div className="flex flex-wrap gap-1">
            {EDGE_TYPE_META.map(({ type, label }) => {
              const hidden = filters.edgeTypes.has(type);
              return (
                <ColorChip
                  key={type}
                  testId={`filter-chip-edge-${type}`}
                  colorVar={edgeTypeColorVar(type)}
                  label={label}
                  on={!hidden}
                  onClick={() => store.setEdgeTypeFilter(type, !hidden)}
                />
              );
            })}
          </div>
        </Field>

        <Field
          label="Confidence audit — highlight low-confidence edges"
          hint="Shows only the connections the resolver had to guess at"
        >
          <div className="flex gap-1">
            <ToggleButton
              label="Guessed only"
              title="Show ONLY ambiguous (guessed) edges; hide everything else"
              on={audit === "ambiguous"}
              onClick={() => store.setAudit(audit === "ambiguous" ? "off" : "ambiguous")}
            />
            <ToggleButton
              label="+ name matches"
              title="Also include name_match edges (still low-confidence)"
              on={audit === "ambiguous+name"}
              onClick={() =>
                store.setAudit(audit === "ambiguous+name" ? "off" : "ambiguous+name")
              }
            />
          </div>
          {audit !== "off" && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-brand-amber)]">
              Showing only low-confidence edges — this is where the resolver is guessing.
            </p>
          )}
        </Field>

        <Field
          label="Minimum confidence"
          hint="Hide connections the resolver is less sure of than this"
          value={filters.minConfidence.toFixed(2)}
        >
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={filters.minConfidence}
            onChange={(e) => store.setMinConfidence(parseFloat(e.target.value))}
            aria-label="Minimum edge confidence"
            className="w-full accent-[var(--color-brand-amber)]"
          />
        </Field>

        <Field
          label="Edge bundling"
          hint="1 = threads hug the folder hierarchy · 0 = straight chords"
          value={store.bundleBeta.toFixed(2)}
        >
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={store.bundleBeta}
            onChange={(e) => store.setBundleBeta(parseFloat(e.target.value))}
            aria-label="Edge bundling strength"
            className="w-full accent-[var(--color-brand-amber)]"
          />
        </Field>

        <Field label="Overlays">
          <CouplingToggle />
        </Field>

        {hasFilters && (
          <button
            type="button"
            onClick={() => store.clearFilters()}
            className="mt-1 w-full rounded-[6px] border border-[rgba(148,163,207,0.2)] py-1 text-[11px] opacity-70 hover:opacity-100"
          >
            Reset every filter
          </button>
        )}
      </div>
    </LayerShell>
  );
}

/** Temporal-coupling overlay (best-effort git co-change). Additive; degrades
 *  gracefully when the repo has no usable history. */
function CouplingToggle() {
  const store = useStore();
  const on = store.coupling;
  // "no data": fetched (cochange !== null) but the map came back empty.
  const fetched = store.cochange !== null;
  const noData = on && fetched && Object.keys(store.cochange!).length === 0;

  return (
    <div>
      <ToggleButton
        label={on ? "Co-change links on" : "Show co-change links"}
        title="Draw git co-change links between files that change together"
        on={on}
        onClick={() => store.toggleCoupling()}
        full
      />
      {on && !fetched && (
        <p className="mt-1 text-[11px] opacity-70">Reading git history…</p>
      )}
      {noData && (
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-brand-amber)]">
          No co-change data — git history isn&apos;t available for this repo.
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  children,
}: {
  label: string;
  hint?: string;
  value?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-3 last:mb-0">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wider opacity-70">{label}</h3>
        {value !== undefined && (
          <span className="font-mono text-[11px] tabular-nums opacity-70">{value}</span>
        )}
      </div>
      {hint && <p className="mb-1.5 mt-0.5 text-[11px] leading-tight opacity-70">{hint}</p>}
      {children}
    </section>
  );
}

/** An encoding-colored chip. `on` (visible) paints border + text from the kind's
 *  own token; `off` (hidden) drops to a neutral, dimmed outline so "hidden" is
 *  legible without relying on the hue. The var reaches CSS through inline
 *  custom properties because Tailwind v4 can't emit a class from a runtime
 *  string — the single dynamic channel, everything else is a token utility. */
function ColorChip({
  label,
  colorVar,
  on,
  onClick,
  testId,
}: {
  label: string;
  colorVar: string;
  on: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      data-testid={testId}
      data-color-var={colorVar}
      title={on ? `${label} — click to hide` : `${label} — click to show`}
      style={on ? { color: colorVar, borderColor: colorVar } : undefined}
      className={`min-h-6 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
        on ? "bg-white/5" : "border-[rgba(148,163,207,0.18)] opacity-70"
      }`}
    >
      {label}
    </button>
  );
}

function ToggleButton({
  label,
  title,
  on,
  onClick,
  full,
}: {
  label: string;
  title: string;
  on: boolean;
  onClick: () => void;
  full?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`min-h-6 rounded-[6px] border px-2 py-1 text-[11px] transition-colors ${
        full ? "w-full" : "flex-1"
      } ${
        on
          ? "border-[color-mix(in_srgb,var(--color-brand-amber)_55%,transparent)] bg-[color-mix(in_srgb,var(--color-brand-amber)_16%,transparent)] text-[var(--color-brand-amber)]"
          : "border-[rgba(148,163,207,0.2)] opacity-70 hover:opacity-100"
      }`}
    >
      {label}
    </button>
  );
}
