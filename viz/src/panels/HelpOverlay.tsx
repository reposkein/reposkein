import { KEYMAP } from "../data/keymap";
import { LayerShell } from "./LayerShell";

/** The help overlay (Astrolabe V3 §2), replacing V2's five-line "Keys" stub
 *  that lived inline in the status bar. Rows come from `data/keymap.ts` so the
 *  overlay and the handlers that implement the shortcuts can be checked against
 *  each other (`panels/helpOverlay.test.tsx`).
 *
 *  Centered via `inset-x-0 mx-auto` rather than `left-1/2 -translate-x-1/2` on
 *  purpose: LayerShell's entrance animation animates `transform`, which would
 *  fight a translate-based centering and snap the panel sideways on open. */
export function HelpOverlay() {
  return (
    <LayerShell
      id="help"
      title="Keyboard & pointer"
      placement="bottom-9 inset-x-0 mx-auto"
      width="w-[min(30rem,calc(100vw-1.5rem))]"
    >
      <div className="max-h-[min(70vh,34rem)] overflow-y-auto p-3">
        {KEYMAP.map((group) => (
          <section key={group.title} className="mb-3 last:mb-0">
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider opacity-45">
              {group.title}
            </h3>
            <dl className="flex flex-col gap-1">
              {group.bindings.map((b) => (
                <div key={`${group.title}-${b.keys.join("/")}-${b.description}`} className="flex items-baseline gap-2">
                  <dt className="flex shrink-0 items-center gap-1">
                    {b.keys.map((k) => (
                      <kbd
                        key={k}
                        className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-[rgba(148,163,207,0.2)] bg-white/5 px-1.5 font-mono text-[11px] opacity-85"
                      >
                        {k}
                      </kbd>
                    ))}
                  </dt>
                  <dd className="min-w-0 flex-1 text-[13px] opacity-75">{b.description}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </LayerShell>
  );
}
