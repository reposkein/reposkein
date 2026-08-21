import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, useEdgeStats } from "../state/store";
import { deriveModeChips, dismissModeChip, type ModeChip } from "../data/modeChips";
import {
  breadcrumbMaxVisibleForWidth,
  collapseCrumbsForDisplay,
  resolveBreadcrumb,
  type Crumb,
} from "../data/breadcrumbPath";
import { startCameraNearestTracking, useCameraNearestClusterKey } from "../scene/cameraNearest";
import { badgeInfo, teamConstellationHref } from "../data/badge";
import { LENS_ORDER, LENS_PRESETS } from "../data/lens";
import { captureScreenshot } from "../scene/Screenshot";
import { isCommandPaletteOpen } from "./paletteOpenState";
import {
  isChipsPopoverOpen,
  isLensPopoverOpen,
  setChipsPopoverOpen,
  setLensPopoverOpen,
} from "./statusBarOverlayState";
import { openLayer, toggleLayer, useOpenLayer, type LayerId } from "./layerState";
import { pushToast } from "./toastState";
import { TourLaunchButton } from "./TourController";

const BAR = "h-7 text-[13px] text-[var(--color-brand-cream)]";
const MONO = "font-mono";
const DIM = "opacity-60";
/** Minimum hit area for every clickable pill in the bar — the bar itself is
 *  only 28px tall, so this is close to the ceiling of what fits, but it must
 *  hold regardless of how narrow the viewport gets (fix round 1, `#2`:
 *  "icon buttons keep min tap targets" — nothing below responsively shrinks
 *  these, only the SURROUNDING content is hidden/collapsed). */
const TAP = "min-h-6 min-w-6";

/** Width tiers driving progressive degradation (fix round 1, `#2`). Ordered
 *  widest-first so the comment above each documents "the first thing to give
 *  ground" as the bar narrows:
 *   1. the breadcrumb starts collapsing to a middle-ellipsis chain (widest
 *      threshold — it gives ground before anything else does);
 *   2. the staleness label (sha/age/team link) is dropped;
 *   3. the node/edge counts are dropped, leaving only the repo name;
 *   4. mode chips collapse into a single "N modes" popover chip.
 *  Controls (lens popover, minimap/legend/shot/frame/tour/help) never shrink
 *  or hide — see TAP above and the footer's `overflow-x-auto` safety net. */
const BP_HIDE_STALENESS = 768;
const BP_HIDE_COUNTS = 640;
const BP_COLLAPSE_CHIPS = 480;

/** The viewport width, updated on resize. The bar is `fixed inset-x-0`, so
 *  viewport width IS the bar's own width — no ResizeObserver on the footer
 *  element needed. SSR-safe default (this app is client-only, but jsdom/test
 *  environments without a real layout still get a sane wide-tier default). */
function useViewportWidth(): number {
  const [width, setWidth] = useState<number>(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

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
 *    popover (LensSwitcher's replacement) + the SUMMONED-LAYER toggles
 *    (Map/Legend/Filters/?) + tour/screenshot/frame-all.
 *
 *  V3: the Map / Legend pills no longer flip reducer booleans — they call
 *  `toggleLayer` (panels/layerState.ts), whose state is one nullable id, so
 *  opening one puts the other away. Filters joined them (FilterHUD retired) and
 *  `?` now summons the real keymap overlay instead of the five-line stub this
 *  file used to carry inline.
 *
 *  Esc stacking: the palette wins first (isCommandPaletteOpen), then either
 *  local ephemeral popover this bar owns (the lens popover / the collapsed
 *  "N modes" popover — statusBarOverlayState.ts, mirroring paletteOpenState's
 *  pattern so the NEWEST overlay always wins: a popover's own Escape handler
 *  closes and consumes the event before this one would have dismissed a
 *  chip), then the guided tour (it owns Esc while active — see
 *  TourController), then an open summoned layer (LayerShell consumes it), and
 *  only THEN does a topmost mode chip get dismissed.
 *  When nothing above is open and no chip is active, the event is left alone
 *  so Root's collapse-level Esc binding still runs — unchanged behavior for
 *  the common case. */
export function StatusBar() {
  const store = useStore();
  const model = store.model;
  const width = useViewportWidth();

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
  const displayCrumbs = useMemo(
    () => collapseCrumbsForDisplay(crumbs, breadcrumbMaxVisibleForWidth(width)),
    [crumbs, width],
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
  // palette, this bar's own local popovers, and an active tour have had
  // their say. Read the latest chips/tour through the same ref pattern so
  // the listener is attached exactly once.
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isCommandPaletteOpen()) return; // palette is above everything else
      if (isLensPopoverOpen() || isChipsPopoverOpen()) return; // newest overlay wins — the popover closes itself
      if (storeRef.current.tour) return; // the guided tour owns Esc while active
      if (openLayer() !== null) return; // a summoned layer consumes Esc first (LayerShell)
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
      className={`${BAR} pointer-events-auto fixed inset-x-0 bottom-0 z-[100] flex items-center gap-4 overflow-x-auto border-t border-[rgba(148,163,207,0.16)] bg-[color-mix(in_srgb,var(--color-brand-navy)_94%,transparent)] px-3`}
    >
      <StatusBarLeft hideStaleness={width < BP_HIDE_STALENESS} hideCounts={width < BP_HIDE_COUNTS} />
      <StatusBarCenter crumbs={displayCrumbs} />
      <StatusBarRight chips={chips} collapseChips={width < BP_COLLAPSE_CHIPS} />
    </footer>
  );
}

function StatusBarLeft({
  hideStaleness,
  hideCounts,
}: {
  hideStaleness: boolean;
  hideCounts: boolean;
}) {
  const store = useStore();
  const model = store.model;

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 whitespace-nowrap">
      <span data-testid="statusbar-repo-name" className="font-medium text-[var(--color-brand-amber)]">
        {model?.repoId ?? "RepoSkein"}
      </span>
      {model && !hideCounts && (
        <span className={`${MONO} text-[11px] ${DIM}`}>
          {model.counts.nodes} nodes · {model.counts.edges} edges
        </span>
      )}
      {model && !hideCounts && <EdgeCapIndicator />}
      {model && !hideStaleness && <StalenessLabel />}
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
  const capped = total > 0 && drawn < total;

  // Toast the moment the cap ENGAGES (V3 §5) — the pill alone is easy to miss,
  // and "why did some threads disappear when I expanded that folder?" is exactly
  // the question a silent cap leaves behind. Fires on the transition only, not
  // on every pass, and is deduped so a wobble around the threshold replaces the
  // message rather than stacking copies.
  const wasCapped = useRef(false);
  useEffect(() => {
    if (capped && !wasCapped.current) {
      pushToast(`Edge cap engaged — drawing ${drawn} of ${total} bundles`, {
        tone: "warn",
        hint: "Collapse a cluster or narrow the lens to see more",
        dedupeKey: "edge-cap",
      });
    }
    wasCapped.current = capped;
  }, [capped, drawn, total]);

  if (!capped) return null;
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

function StatusBarRight({ chips, collapseChips }: { chips: ModeChip[]; collapseChips: boolean }) {
  const store = useStore();
  // Subscribing to the layer singleton here (not the reducer) is what keeps a
  // layer toggle from re-rendering the constellation: only this bar and the
  // layer host care which layer is open.
  const layer = useOpenLayer();

  return (
    <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
      {chips.length > 0 &&
        (collapseChips ? (
          <ChipsSummaryPopover chips={chips} />
        ) : (
          chips.map((chip) => <ModeChipPill key={chip.kind} chip={chip} />)
        ))}
      <LensPopoverButton />
      <LayerToggle
        id="minimap"
        label="Map"
        name="map"
        hint="Overview of the clusters currently on screen"
        open={layer}
      />
      <LayerToggle
        id="legend"
        label="Legend"
        name="legend"
        hint="What every color and line weight means"
        open={layer}
      />
      <LayerToggle
        id="filters"
        label="Filters"
        name="filters"
        hint="Symbol kinds, relationships, confidence, edge bundling"
        open={layer}
      />
      {store.model && (
        <IconToggle
          label="Shot"
          title="Capture a PNG screenshot of the current view"
          active={false}
          onClick={() => {
            captureScreenshot();
            pushToast("Screenshot saved", { tone: "accent", dedupeKey: "screenshot" });
          }}
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
      <TourLaunchButton />
      <LayerToggle
        id="help"
        label="?"
        name="keyboard shortcuts"
        hint="Every key and pointer gesture"
        open={layer}
      />
    </div>
  );
}

/** A summoned-layer pill. Pressed state comes from the layer singleton, so the
 *  bar and the layer can never disagree about what's open — and because the
 *  singleton holds ONE id, pressing Legend visibly un-presses Map.
 *
 *  `label` is the pill's text, `name` its prose name for the tooltip. They are
 *  separate because the help pill's label is the glyph "?", and lower-casing a
 *  label to build a sentence produced "Hide ? — …" (fix round 1, M6a).
 *
 *  `data-layer-toggle` is load-bearing, not decoration: LayerShell's
 *  outside-click dismissal treats these pills as INSIDE, so the mousedown
 *  doesn't close the layer only for the following click to re-open it. */
function LayerToggle({
  id,
  label,
  name,
  hint,
  open,
}: {
  id: LayerId;
  /** The pill's visible text — may be a glyph. */
  label: string;
  /** The prose name used in the tooltip sentence. */
  name: string;
  hint: string;
  open: LayerId | null;
}) {
  const active = open === id;
  return (
    <IconToggle
      label={label}
      title={`${active ? "Hide" : "Show"} ${name} — ${hint}`}
      active={active}
      onClick={() => toggleLayer(id)}
      layerToggle
    />
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
      className={`${TAP} flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--color-brand-amber)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-brand-amber)_14%,transparent)] px-2 py-1 text-[11px] text-[var(--color-brand-amber)] transition-opacity duration-150 ease-out hover:opacity-80`}
    >
      <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-brand-amber)]" />
      {chip.label}
    </button>
  );
}

/** Below `BP_COLLAPSE_CHIPS` (fix round 1, `#2`), every active mode chip
 *  collapses into ONE "N modes" pill with its own popover — each row inside
 *  still dismisses via the exact same `dismissModeChip`, so nothing about
 *  the underlying mode-clearing semantics changes, only the bar's use of
 *  horizontal space. Uses the same `isChipsPopoverOpen` singleton as the
 *  lens popover so it wins Esc over the (now-hidden) individual chips. */
function ChipsSummaryPopover({ chips }: { chips: ModeChip[] }) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  function updateOpen(next: boolean) {
    setOpen(next);
    setChipsPopoverOpen(next);
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) updateOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        updateOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Safety net: never leave the singleton stuck reporting "open" if this
  // component unmounts (e.g. the bar widens past the collapse threshold)
  // while the popover happens to be open.
  useEffect(() => () => setChipsPopoverOpen(false), []);

  return (
    <span ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => updateOpen(!open)}
        title={`${chips.length} active mode${chips.length === 1 ? "" : "s"}`}
        aria-expanded={open}
        className={`${TAP} flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--color-brand-amber)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-brand-amber)_14%,transparent)] px-2 py-1 text-[11px] text-[var(--color-brand-amber)]`}
      >
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-brand-amber)]" />
        {chips.length} mode{chips.length === 1 ? "" : "s"} ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full right-0 mb-2 flex w-48 flex-col gap-0.5 rounded-[8px] border border-[rgba(148,163,207,0.18)] bg-[color-mix(in_srgb,var(--color-brand-navy)_96%,white_4%)] p-1 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.6)]"
        >
          {chips.map((chip) => (
            <button
              key={chip.kind}
              type="button"
              onClick={() => {
                dismissModeChip(chip.kind, store);
                if (chips.length <= 1) updateOpen(false);
              }}
              title={`${chip.label} — click to dismiss`}
              className="flex items-center justify-between gap-2 rounded-[6px] px-2 py-1 text-left text-[12px] text-[var(--color-brand-cream)] opacity-85 hover:opacity-100"
            >
              <span>{chip.label}</span>
              <span aria-hidden="true" className="opacity-60">
                ✕
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function LensPopoverButton() {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const current = store.lens;
  const rootRef = useRef<HTMLSpanElement>(null);

  function updateOpen(next: boolean) {
    setOpen(next);
    setLensPopoverOpen(next);
  }

  // Ephemeral local UI, not a mode — closes on outside click or Escape, and
  // (via `stopPropagation`) doesn't let that Escape also fall through to the
  // mode-chip / collapse-level handling below it in the stack. The
  // `isLensPopoverOpen` singleton (set via `updateOpen` above) is what lets
  // StatusBar's OWN capture-phase Esc handler defer to this bubble-phase one
  // instead of racing it (fix round 1, `#1`).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) updateOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        updateOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Safety net: never leave the singleton stuck reporting "open" if this
  // component unmounts while the popover happens to be open.
  useEffect(() => () => setLensPopoverOpen(false), []);

  return (
    <span ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => updateOpen(!open)}
        title="Switch lens"
        aria-expanded={open}
        className={`${TAP} rounded-full border border-[rgba(148,163,207,0.25)] px-2 py-1 text-[11px] opacity-80 hover:opacity-100`}
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
                  updateOpen(false);
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
  layerToggle,
}: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
  /** Marks this pill as a summoned-layer toggle — see LayerToggle's docstring. */
  layerToggle?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      data-layer-toggle={layerToggle ? "" : undefined}
      className={`${TAP} rounded-full border px-2 py-1 text-[11px] transition-colors ${
        active
          ? "border-[color-mix(in_srgb,var(--color-brand-teal)_45%,transparent)] text-[var(--color-brand-teal)]"
          : "border-[rgba(148,163,207,0.2)] opacity-70 hover:opacity-100"
      }`}
    >
      {label}
    </button>
  );
}

