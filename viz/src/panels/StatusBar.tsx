import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, useEdgeStats } from "../state/store";
import { deriveModeChips, dismissModeChip, type ModeChip } from "../data/modeChips";
import { resolveBreadcrumb, type Crumb } from "../data/breadcrumbPath";
import { startCameraNearestTracking, useCameraNearestClusterKey } from "../scene/cameraNearest";
import { badgeInfo, teamConstellationHref } from "../data/badge";
import { LENS_ORDER, LENS_PRESETS } from "../data/lens";
import { captureScreenshot } from "../scene/Screenshot";
import { isCommandPaletteOpen } from "./paletteOpenState";
import { TourController } from "./TourController";

const BAR = "h-7 text-[13px] text-[var(--color-brand-cream)]";
const MONO = "font-mono";
const DIM = "opacity-60";

/** The 28px persistent status bar (REP-18 / Astrolabe V2). The ONLY chrome
 *  that is always on screen: everything HeaderBar / LensSwitcher / the
 *  standalone Breadcrumb used to show now lives here, or in the palette.
 *
 *  LEFT: repo identity + counts + edge-cap + staleness (Task 4 metadata).
 *  CENTER: a breadcrumb that is NEVER null — the selection chain when
 *    something is selected, else the camera-nearest cluster's chain (a
 *    throttled external-store subscription, see scene/cameraNearest.ts —
 *    deliberately NOT per-frame React state).
 *  RIGHT: mode chips (derived, one selector, see data/modeChips.ts) + a lens
 *    popover (LensSwitcher's replacement) + minimap/legend/help toggles +
 *    tour/screenshot/frame-all.
 *
 *  Esc stacking: the palette wins first (isCommandPaletteOpen), the guided
 *  tour wins second (it owns Esc while active — see TourController), and
 *  only then does a topmost mode chip get dismissed. When no chip is active
 *  the event is left alone so Root's collapse-level Esc binding still runs —
 *  unchanged behavior for the common case. */
export function StatusBar() {
  const store = useStore();
  const model = store.model;

  // A ref mirroring the latest store, read from callbacks that must NOT be
  // recreated on every dispatch (the camera-nearest poll's getters and the
  // Esc handler below) — `store` itself is a fresh object every render (see
  // state/store.tsx's useStore), so closing over it directly would go stale
  // the moment this effect's OWN deps don't include the field that changed.
  const storeRef = useRef(store);
  storeRef.current = store;

  const chips = deriveModeChips(store);
  const nearestKey = useCameraNearestClusterKey();
  const crumbs = useMemo<Crumb[]>(
    () => (model ? resolveBreadcrumb(model, store.selected, nearestKey) : []),
    [model, store.selected, nearestKey],
  );

  // Start the throttled camera-nearest poll once the model exists; stop it
  // when the bar (or the model) goes away. Reads storeRef fresh on every
  // tick, so expand/collapse changes are always seen even though this effect
  // itself only re-runs when the model identity changes.
  useEffect(() => {
    if (!model) return;
    return startCameraNearestTracking(
      () => storeRef.current.model,
      () => storeRef.current.expanded,
    );
  }, [model]);

  // Esc dismisses the topmost (leftmost) active chip — but only after the
  // palette and an active tour have had their say. Read the latest chips/tour
  // through the same ref pattern so the listener is attached exactly once.
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isCommandPaletteOpen()) return; // palette is above chips in the stack
      if (storeRef.current.tour) return; // the guided tour owns Esc while active
      const topmost = chipsRef.current[0];
      if (!topmost) return; // nothing to dismiss — let collapseLevel run as before
      e.preventDefault();
      e.stopImmediatePropagation();
      dismissModeChip(topmost.kind, storeRef.current);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <footer
      role="contentinfo"
      className={`${BAR} fixed inset-x-0 bottom-0 z-[100] flex items-center gap-4 border-t border-[rgba(148,163,207,0.16)] bg-[color-mix(in_srgb,var(--color-brand-navy)_94%,transparent)] px-3`}
    >
      <StatusBarLeft />
      <StatusBarCenter crumbs={crumbs} />
      <StatusBarRight chips={chips} />
    </footer>
  );
}

function StatusBarLeft() {
  const store = useStore();
  const model = store.model;

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 whitespace-nowrap">
      <span data-testid="statusbar-repo-name" className="font-medium text-[var(--color-brand-amber)]">
        {model?.repoId ?? "RepoSkein"}
      </span>
      {model && (
        <span className={`${MONO} text-[11px] ${DIM}`}>
          {model.counts.nodes} nodes · {model.counts.edges} edges
        </span>
      )}
      {model && <EdgeCapIndicator />}
      {model && <StalenessLabel />}
    </div>
  );
}

/** "capped N/M" — shown ONLY when the render cap is actually reducing what's
 *  drawn (drawn < total). The old EdgeStatsReadout always showed "showing N
 *  of M" whenever there were any edges; this bar deliberately shows nothing
 *  in the common uncapped case (REP-18 brief: "edge-cap indicator WHEN
 *  ENGAGED") — the count is still visible in the left-side node/edge totals,
 *  so nothing is lost, only decluttered. Its own component so only THIS
 *  subscribes to the edgeStats channel (pointer/pass rate, not the reducer —
 *  see state/store.tsx's docstring on why that split exists). */
function EdgeCapIndicator() {
  const { drawn, total } = useEdgeStats();
  if (total <= 0 || drawn >= total) return null;
  return (
    <span
      className={`${MONO} text-[11px] text-[var(--color-brand-amber)]`}
      title="Edge bundles currently drawn / total bundles before the render cap"
    >
      capped {drawn}/{total}
    </span>
  );
}

function StalenessLabel() {
  const store = useStore();
  const info = badgeInfo(store.model?.repoMeta ?? null);
  const teamHref = teamConstellationHref(store.model?.repoMeta ?? null);
  if (!info && !teamHref) return null;
  return (
    <span className="flex items-center gap-2">
      {info &&
        (info.href ? (
          <a
            href={info.href}
            target="_blank"
            rel="noreferrer"
            className={`${MONO} text-[11px] ${DIM} hover:opacity-90`}
            title={store.model?.repoMeta?.builtAt ? `baked ${store.model.repoMeta.builtAt}` : undefined}
          >
            {info.label}
          </a>
        ) : (
          <span className={`${MONO} text-[11px] ${DIM}`}>{info.label}</span>
        ))}
      {teamHref && (
        <a
          href={teamHref}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-[var(--color-brand-amber)] hover:opacity-90"
          title="Open this team's published constellation"
        >
          team ↗
        </a>
      )}
    </span>
  );
}

function StatusBarCenter({ crumbs }: { crumbs: Crumb[] }) {
  const store = useStore();

  function onCrumbClick(crumb: Crumb) {
    if (!crumb.clickable) return;
    store.revealAndSelect(crumb.key, { fly: true, collapseDeeper: true });
  }

  if (crumbs.length === 0) return <div className="flex-1 min-w-0" />;

  return (
    <div className="flex min-w-0 flex-1 items-center justify-center overflow-hidden whitespace-nowrap px-2">
      {crumbs.map((crumb, i) => (
        <span key={`${crumb.key}-${i}`} className="flex min-w-0 items-center">
          {i > 0 && <span className="mx-1.5 shrink-0 opacity-35">·</span>}
          {crumb.clickable ? (
            <button
              type="button"
              onClick={() => onCrumbClick(crumb)}
              title={crumb.label}
              className={`${MONO} min-w-0 truncate text-[13px] transition-opacity ${
                i === crumbs.length - 1
                  ? "text-[var(--color-brand-cream)] opacity-95"
                  : "opacity-60 hover:opacity-90"
              }`}
            >
              {crumb.label}
            </button>
          ) : (
            <span
              title={crumb.label}
              className={`${MONO} min-w-0 truncate text-[13px] text-[var(--color-brand-cream)] opacity-95`}
            >
              {crumb.label}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

function StatusBarRight({ chips }: { chips: ModeChip[] }) {
  const store = useStore();
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
      {chips.map((chip) => (
        <ModeChipPill key={chip.kind} chip={chip} />
      ))}
      <LensPopoverButton />
      <IconToggle
        label="Map"
        title={store.showMinimap ? "Hide minimap" : "Show minimap"}
        active={store.showMinimap}
        onClick={() => store.toggleMinimap()}
      />
      <IconToggle
        label="Legend"
        title={store.showLegend ? "Hide legend" : "Show legend"}
        active={store.showLegend}
        onClick={() => store.toggleLegend()}
      />
      {store.model && (
        <IconToggle
          label="Shot"
          title="Capture a PNG screenshot of the current view"
          active={false}
          onClick={() => captureScreenshot()}
        />
      )}
      {store.model && (
        <IconToggle
          label="Frame"
          title="Frame all — refit the camera to what's currently on screen"
          active={false}
          onClick={() => store.requestFit()}
        />
      )}
      {store.model && <TourController />}
      <IconToggle
        label="?"
        title="Keyboard shortcuts"
        active={helpOpen}
        onClick={() => setHelpOpen((o) => !o)}
      />
      {helpOpen && <HelpOverlay onDismiss={() => setHelpOpen(false)} />}
    </div>
  );
}

/** Amber-dotted mode chip — clicking it dismisses that mode via the exact
 *  same store action a manual toggle would use (data/modeChips.ts). The
 *  `transition-opacity` here is what makes a silent mode-clear (selecting a
 *  different node clears impact, changing lens clears audit, ...) READ as a
 *  visible chip transition rather than an instant pop: the chip fades as it
 *  mounts, and — because chips are a pure function of state — a mode turning
 *  off is simply the chip's absence on the next render. */
function ModeChipPill({ chip }: { chip: ModeChip }) {
  const store = useStore();
  return (
    <button
      type="button"
      onClick={() => dismissModeChip(chip.kind, store)}
      title={`${chip.label} — click to dismiss`}
      className="flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--color-brand-amber)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-brand-amber)_14%,transparent)] px-2 py-0.5 text-[11px] text-[var(--color-brand-amber)] transition-opacity duration-150 ease-out hover:opacity-80"
    >
      <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-brand-amber)]" />
      {chip.label}
    </button>
  );
}

function LensPopoverButton() {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const current = store.lens;
  const rootRef = useRef<HTMLSpanElement>(null);

  // Ephemeral local UI, not a mode — closes on outside click or Escape, and
  // (via `stopPropagation`) doesn't let that Escape also fall through to the
  // mode-chip / collapse-level handling below it in the stack.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Switch lens"
        aria-expanded={open}
        className="rounded-full border border-[rgba(148,163,207,0.25)] px-2 py-0.5 text-[11px] opacity-80 hover:opacity-100"
      >
        Lens{current !== "all" ? `: ${LENS_PRESETS[current].label}` : ""} ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full right-0 mb-2 flex w-44 flex-col gap-0.5 rounded-[8px] border border-[rgba(148,163,207,0.18)] bg-[color-mix(in_srgb,var(--color-brand-navy)_96%,white_4%)] p-1 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.6)]"
        >
          {LENS_ORDER.map((id) => {
            const active = id === current;
            return (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  store.setLens(id);
                  setOpen(false);
                }}
                title={LENS_PRESETS[id].hint}
                className={`rounded-[6px] px-2 py-1 text-left text-[12px] ${
                  active
                    ? "bg-[color-mix(in_srgb,var(--color-brand-amber)_18%,transparent)] text-[var(--color-brand-amber)]"
                    : "text-[var(--color-brand-cream)] opacity-80 hover:opacity-100"
                }`}
              >
                {LENS_PRESETS[id].label}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

function IconToggle({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
        active
          ? "border-[color-mix(in_srgb,var(--color-brand-teal)_45%,transparent)] text-[var(--color-brand-teal)]"
          : "border-[rgba(148,163,207,0.2)] opacity-70 hover:opacity-100"
      }`}
    >
      {label}
    </button>
  );
}

/** Minimal keymap stub (V3 owns the full overlay per the REP-18 brief). Every
 *  line here previously lived as the HeaderBar's two hint rows. */
function HelpOverlay({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      className="fixed bottom-9 right-3 z-[110] w-64 rounded-[10px] border border-[rgba(148,163,207,0.2)] bg-[color-mix(in_srgb,var(--color-brand-navy)_96%,white_4%)] p-3 text-[12px] text-[var(--color-brand-cream)] shadow-[0_8px_24px_-8px_rgba(0,0,0,0.6)]"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider opacity-60">Keys</span>
        <button type="button" onClick={onDismiss} className="opacity-60 hover:opacity-100">
          ✕
        </button>
      </div>
      <ul className="space-y-1 opacity-85">
        <li>
          <kbd className={MONO}>/</kbd> search · <kbd className={MONO}>⌘K</kbd> commands
        </li>
        <li>
          <kbd className={MONO}>f</kbd> frame all · <kbd className={MONO}>Esc</kbd> back / dismiss
        </li>
        <li>
          <kbd className={MONO}>←→</kbd> / <kbd className={MONO}>Tab</kbd> hop neighbor
        </li>
        <li className="opacity-70">scroll = zoom · drag = orbit</li>
        <li className="opacity-70">click cluster = expand · click star = inspect</li>
      </ul>
    </div>
  );
}

