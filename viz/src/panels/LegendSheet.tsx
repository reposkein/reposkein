import { useMemo } from "react";
import {
  EDGE_TYPE_META,
  LANGUAGE_HEX,
  LANGUAGE_LABEL,
  NODE_KIND_META,
} from "../scene/encoding";
import {
  edgeTypeColorVar,
  languageColorVar,
  nodeKindColorVar,
} from "../data/encodingVars";
import { presentLanguages } from "../data/language";
import { useStoreState } from "../state/store";
import { LayerShell } from "./LayerShell";

/** The legend sheet (Astrolabe V3 §2). Summoned, not docked — the V2 legend was
 *  a permanently-mounted bottom-left panel that overlapped the minimap, which is
 *  the single loudest complaint this phase exists to fix.
 *
 *  EVERY row is generated from `scene/encoding.ts`'s META tables — there is no
 *  literal color, label, or kind list in this file. Swatches reference the CSS
 *  custom property generated from that same table (`data/encodingVars.ts`), so
 *  a legend swatch, a filter chip, a palette row's dot and the WebGL star all
 *  resolve to ONE hex. `panels/colorIdentity.test.tsx` asserts that chain end
 *  to end.
 *
 *  The var goes through an inline `backgroundColor` because Tailwind v4 extracts
 *  utilities statically: `bg-[var(--color-node-${kind})]` would never be
 *  emitted. That single dynamic channel (matching the precedent already set by
 *  the command palette's kind dots) is the only inline style here; every other
 *  visual decision is a token utility. */
export function LegendSheet() {
  const model = useStoreState().model;
  // Only the languages actually present in this graph — a legend listing Java
  // for a pure-TS repo is noise. Recomputed once per model.
  const languages = useMemo(() => (model ? presentLanguages(model) : []), [model]);

  return (
    <LayerShell id="legend" title="Legend" placement="bottom-9 right-3" width="w-56">
      <div className="max-h-[min(60vh,26rem)] overflow-y-auto p-2.5">
        <Group label="Node kind">
          {NODE_KIND_META.map(({ kind, label }) => (
            <Row key={kind} label={label}>
              <Dot testId={`legend-swatch-node-${kind}`} color={nodeKindColorVar(kind)} />
            </Row>
          ))}
        </Group>

        <Group label="Edge type">
          {EDGE_TYPE_META.map(({ type, label }) => (
            <Row key={type} label={label}>
              <Dash testId={`legend-swatch-edge-${type}`} color={edgeTypeColorVar(type)} />
            </Row>
          ))}
        </Group>

        {languages.length > 0 && (
          <Group label="Languages">
            {languages.map((lang) => (
              <Row
                key={lang}
                label={LANGUAGE_LABEL[lang] ?? lang}
                title="Galaxy / nebula halos are tinted by their dominant language"
              >
                <Dot
                  testId={`legend-swatch-lang-${lang}`}
                  color={languageColorVar(lang, lang in LANGUAGE_HEX)}
                />
              </Row>
            ))}
          </Group>
        )}

        <p className="mt-2 border-t border-[rgba(148,163,207,0.14)] pt-2 text-[11px] leading-relaxed opacity-50">
          Edge opacity = confidence · halo tint = language · star size = degree
        </p>
      </div>
    </LayerShell>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mb-2.5 last:mb-0">
      <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wider opacity-45">{label}</h3>
      <ul className="flex flex-col gap-1">{children}</ul>
    </section>
  );
}

function Row({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-2" title={title}>
      {children}
      <span className="text-[13px] opacity-80">{label}</span>
    </li>
  );
}

function Dot({ color, testId }: { color: string; testId: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      data-color-var={color}
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

function Dash({ color, testId }: { color: string; testId: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      data-color-var={color}
      className="inline-block h-0.5 w-4 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}
