/** The keymap, as DATA (Astrolabe V3 §2 — the help overlay).
 *
 *  V2 shipped a five-line "Keys" stub inside the status bar. The full keymap now
 *  lives here rather than as JSX so it is one list that both the help overlay
 *  renders and `panels/helpOverlay.test.tsx` checks against the bindings Root
 *  actually registers — a shortcut added to the key handler but not to the
 *  overlay (or vice versa) is a visible drift, not a silent one.
 *
 *  `keys` are display strings (`"⌘K"`, `"←→"`); `binding` is the literal
 *  `KeyboardEvent.key` Root/the palette listen for, or null for pointer gestures
 *  and for keys handled inside a focused widget. */

export interface KeyBinding {
  keys: string[];
  description: string;
  /** The `KeyboardEvent.key` value a global handler matches, when there is one. */
  binding: string | null;
}

export interface KeymapGroup {
  title: string;
  bindings: KeyBinding[];
}

export const KEYMAP: KeymapGroup[] = [
  {
    title: "Find & command",
    bindings: [
      { keys: ["⌘K", "Ctrl K"], description: "Command palette — symbols, files, commands", binding: "k" },
      { keys: ["/"], description: "Search (opens the same palette)", binding: "/" },
      { keys: [">"], description: "Inside the palette: commands only", binding: null },
      { keys: ["↵"], description: "Open the highlighted result and fly to it", binding: null },
      { keys: ["⌘↵"], description: "Reveal the result without moving the camera", binding: null },
    ],
  },
  {
    title: "Move around",
    bindings: [
      { keys: ["←", "→", "↑", "↓"], description: "Hop to the next / previous neighbor", binding: null },
      { keys: ["Tab", "⇧Tab"], description: "Hop neighbors (same as the arrows)", binding: "Tab" },
      { keys: ["f"], description: "Frame all — refit the camera to what's on screen", binding: "f" },
      { keys: ["Esc"], description: "Back out one level: overlay → layer → mode → expansion", binding: "Escape" },
    ],
  },
  {
    title: "Summon a layer",
    bindings: [
      { keys: ["m"], description: "Map — overview of the visible clusters", binding: "m" },
      { keys: ["?"], description: "This keymap", binding: "?" },
      { keys: ["Esc"], description: "Dismiss the open layer", binding: "Escape" },
    ],
  },
  {
    title: "Pointer",
    bindings: [
      { keys: ["drag"], description: "Orbit", binding: null },
      { keys: ["scroll"], description: "Zoom", binding: null },
      { keys: ["click cluster"], description: "Expand or collapse it", binding: null },
      { keys: ["click star"], description: "Inspect it (opens the Inspector)", binding: null },
      { keys: ["click empty space"], description: "Collapse one level", binding: null },
    ],
  },
];

/** Every distinct global `KeyboardEvent.key` the keymap claims is bound. */
export function documentedBindings(): Set<string> {
  const out = new Set<string>();
  for (const group of KEYMAP) {
    for (const b of group.bindings) if (b.binding) out.add(b.binding);
  }
  return out;
}
