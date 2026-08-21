import { useStore } from "../state/store";

/** The error screen (Astrolabe V3 §4). V2 rendered the message as centered text
 *  with `pointerEvents: "none"` — literally unactionable: no retry, nothing to
 *  click, and (because the underlying `Overlay` was non-interactive) not even
 *  selectable to copy the message into a bug report.
 *
 *  Retry re-runs the SAME load path as the first attempt: `retryLoad()` bumps
 *  the nonce that StoreProvider's loader effect keys on, so a fresh worker
 *  repeats fetch → parse → layout. There is no second retry-only code path to
 *  diverge from the real one.
 *
 *  OPAQUE, NOT BLURRED (Astrolabe V5 a11y pass): this screen replaces the
 *  entire app while it's up — there is no scene content behind it worth
 *  blurring, and (per V3 §6's own rule) a `backdrop-blur` is for TRANSIENT
 *  surfaces. An error screen can sit on a viewer's monitor for as long as the
 *  underlying failure persists, which is the opposite of transient. */
export function ErrorScreen({ message }: { message: string }) {
  const store = useStore();
  return (
    <div
      role="alert"
      data-testid="error-screen"
      className="pointer-events-auto fixed inset-0 z-[135] flex flex-col items-center justify-center gap-3 bg-[var(--color-brand-navy)] px-6 text-center"
    >
      <p className="text-[15px] font-medium text-[var(--color-brand-cream)]">
        Couldn&apos;t chart the constellation
      </p>
      <p
        data-testid="error-message"
        className="max-w-md break-words font-mono text-[11px] leading-relaxed text-[var(--color-brand-cream)] opacity-70"
      >
        {message}
      </p>
      <button
        type="button"
        data-testid="error-retry"
        onClick={() => store.retryLoad()}
        className="mt-1 min-h-6 rounded-[8px] border border-[color-mix(in_srgb,var(--color-brand-amber)_55%,transparent)] bg-[color-mix(in_srgb,var(--color-brand-amber)_16%,transparent)] px-3 py-1.5 text-[13px] text-[var(--color-brand-amber)] hover:opacity-85"
      >
        Retry
      </button>
      <p className="max-w-md text-[11px] leading-relaxed opacity-70">
        The graph is read from <span className="font-mono">.reposkein</span> — if this keeps
        failing, re-run the indexer and reload.
      </p>
    </div>
  );
}
