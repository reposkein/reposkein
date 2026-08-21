/** THE URL AS A VIEW (Astrolabe V4 §7).
 *
 *  V3's link carried `?node=<id>` and nothing else, so "look at this" shared a
 *  star and threw away the reason it mattered — the recipient got the default
 *  lens and no overlays, with no way to tell anything was missing. The property
 *  these tests exist for is the ROUND TRIP: encode a view, parse it back, and
 *  get the same view. Everything else is tolerance for links that are old,
 *  hand-edited, or from another build. */
import { describe, expect, it } from "vitest";
import {
  NO_OVERLAYS,
  encodeViewSearch,
  isDefaultView,
  parseViewSearch,
  sameViewSearch,
  validateViewSearch,
  type LinkableView,
} from "./urlState";
import { DEFAULT_FOCUS_DEPTH } from "./neighborhood";

function view(overrides: Partial<LinkableView> = {}): LinkableView {
  return {
    selected: null,
    lens: "all",
    impact: null,
    focus: null,
    focusDepth: DEFAULT_FOCUS_DEPTH,
    coupling: false,
    audit: "off",
    ...overrides,
  };
}

const NODE = "rs1:r:sym:mcp/a.ts#run@0";

describe("encodeViewSearch — defaults are OMITTED, never emitted empty", () => {
  it("a fresh view produces no params at all", () => {
    expect(encodeViewSearch(view())).toEqual({});
  });

  it("the default lens is not written", () => {
    expect(encodeViewSearch(view({ lens: "all" })).lens).toBeUndefined();
    expect(encodeViewSearch(view({ lens: "calls" })).lens).toBe("calls");
  });

  it("`overlays` is absent rather than an empty string when nothing is on", () => {
    // `?overlays=` invites the reader to think something is active.
    expect("overlays" in encodeViewSearch(view())).toBe(false);
  });

  it("writes the node, the lens and every overlay", () => {
    const search = encodeViewSearch(
      view({
        selected: NODE,
        lens: "calls",
        impact: {},
        coupling: true,
        audit: "ambiguous",
      }),
    );
    expect(search.node).toBe(NODE);
    expect(search.lens).toBe("calls");
    expect(search.overlays).toBe("impact,coupling,audit:ambiguous");
  });

  it("carries the focus DEPTH, not just the fact of focus", () => {
    const search = encodeViewSearch(view({ focus: {}, focusDepth: 3 }));
    expect(search.overlays).toBe("focus:3");
  });

  it("clamps a nonsense depth on the way out", () => {
    expect(encodeViewSearch(view({ focus: {}, focusDepth: 99 })).overlays).toBe("focus:3");
  });

  /** HASH-HISTORY SAFETY. In a query string `+` decodes to a space, so
   *  `audit=ambiguous+name` came back as `ambiguous name`. */
  it("never emits a '+' — the ambiguous+name audit mode goes on the wire hyphenated", () => {
    const search = encodeViewSearch(view({ audit: "ambiguous+name" }));
    expect(search.overlays).toBe("audit:ambiguous-name");
    expect(search.overlays).not.toContain("+");
  });
});

describe("parseViewSearch", () => {
  it("reads all three params", () => {
    const parsed = parseViewSearch({
      node: NODE,
      lens: "tests",
      overlays: "impact,coupling,audit:ambiguous-name",
    });
    expect(parsed.node).toBe(NODE);
    expect(parsed.lens).toBe("tests");
    expect(parsed.overlays).toEqual({
      impact: true,
      focus: null,
      coupling: true,
      audit: "ambiguous+name",
    });
  });

  it("an empty search is the default view", () => {
    const parsed = parseViewSearch({});
    expect(parsed.node).toBeNull();
    expect(parsed.lens).toBeNull();
    expect(parsed.overlays).toEqual(NO_OVERLAYS);
    expect(isDefaultView(parsed)).toBe(true);
  });

  /** A shared link is untrusted AND possibly old: a renamed lens, an overlay
   *  this build dropped, a depth out of range. Every unknown token is dropped so
   *  the recipient gets as much of the view as still exists. */
  describe("tolerance", () => {
    it("an unknown lens leaves the lens alone rather than erroring", () => {
      expect(parseViewSearch({ lens: "quantum" }).lens).toBeNull();
      expect(parseViewSearch({ lens: "" }).lens).toBeNull();
    });

    it("an unknown overlay token is ignored, and the known ones still apply", () => {
      const parsed = parseViewSearch({ overlays: "impact,teleport,coupling" });
      expect(parsed.overlays.impact).toBe(true);
      expect(parsed.overlays.coupling).toBe(true);
    });

    it("clamps an out-of-range focus depth", () => {
      expect(parseViewSearch({ overlays: "focus:9" }).overlays.focus).toBe(3);
      expect(parseViewSearch({ overlays: "focus:0" }).overlays.focus).toBe(1);
    });

    it("falls back to the default depth for a garbage one (clampDepth propagates NaN)", () => {
      expect(parseViewSearch({ overlays: "focus:abc" }).overlays.focus).toBe(
        DEFAULT_FOCUS_DEPTH,
      );
      expect(parseViewSearch({ overlays: "focus" }).overlays.focus).toBe(DEFAULT_FOCUS_DEPTH);
    });

    it("an unknown audit mode leaves audit off", () => {
      expect(parseViewSearch({ overlays: "audit:whatever" }).overlays.audit).toBeNull();
    });

    it("tolerates whitespace and empty tokens", () => {
      const parsed = parseViewSearch({ overlays: " impact , ,coupling," });
      expect(parsed.overlays.impact).toBe(true);
      expect(parsed.overlays.coupling).toBe(true);
    });

    it("an empty node string is no node", () => {
      expect(parseViewSearch({ node: "" }).node).toBeNull();
    });
  });
});

describe("round trip — the property the whole encoding exists for", () => {
  const cases: [string, LinkableView][] = [
    ["a bare node", view({ selected: NODE })],
    ["a node under a lens", view({ selected: NODE, lens: "imports" })],
    ["impact", view({ selected: NODE, impact: {} })],
    ["focus at each depth 1", view({ selected: NODE, focus: {}, focusDepth: 1 })],
    ["focus at each depth 2", view({ selected: NODE, focus: {}, focusDepth: 2 })],
    ["focus at each depth 3", view({ selected: NODE, focus: {}, focusDepth: 3 })],
    ["coupling", view({ coupling: true })],
    ["audit ambiguous", view({ audit: "ambiguous" })],
    ["audit ambiguous+name", view({ audit: "ambiguous+name" })],
    [
      "everything at once",
      view({
        selected: NODE,
        lens: "types",
        focus: {},
        focusDepth: 3,
        coupling: true,
        audit: "ambiguous+name",
      }),
    ],
  ];

  for (const [name, v] of cases) {
    it(`reproduces ${name}`, () => {
      const parsed = parseViewSearch(encodeViewSearch(v));
      expect(parsed.node).toBe(v.selected);
      expect(parsed.lens).toBe(v.lens === "all" ? null : v.lens);
      expect(parsed.overlays.impact).toBe(Boolean(v.impact));
      expect(parsed.overlays.focus).toBe(v.focus ? v.focusDepth : null);
      expect(parsed.overlays.coupling).toBe(v.coupling);
      expect(parsed.overlays.audit).toBe(v.audit === "off" ? null : v.audit);
    });
  }

  it("survives a real URLSearchParams trip — the hash-history hazard", () => {
    const v = view({ selected: NODE, lens: "calls", audit: "ambiguous+name", coupling: true });
    const encoded = encodeViewSearch(v);
    // Exactly what the browser does to a query string, `+`-decoding included.
    const qs = new URLSearchParams(encoded as Record<string, string>).toString();
    const back = Object.fromEntries(new URLSearchParams(qs));
    const parsed = parseViewSearch(back);
    expect(parsed.node).toBe(NODE);
    expect(parsed.lens).toBe("calls");
    expect(parsed.overlays.audit).toBe("ambiguous+name");
    expect(parsed.overlays.coupling).toBe(true);
  });
});

describe("validateViewSearch — the router's shape check, not the app's meaning", () => {
  it("keeps the three params it owns, as strings", () => {
    expect(validateViewSearch({ node: "n", lens: "calls", overlays: "impact" })).toEqual({
      node: "n",
      lens: "calls",
      overlays: "impact",
    });
  });

  it("drops non-strings and everything it does not own", () => {
    expect(validateViewSearch({ node: 42, lens: null, junk: "x" })).toEqual({});
  });

  it("does NOT interpret the values — an unknown lens survives to the app", () => {
    expect(validateViewSearch({ lens: "quantum" }).lens).toBe("quantum");
  });
});

describe("sameViewSearch — what keeps the URL sync out of browser history", () => {
  it("is true for structurally equal params", () => {
    expect(sameViewSearch({ node: "a", overlays: "impact" }, { node: "a", overlays: "impact" })).toBe(
      true,
    );
    expect(sameViewSearch({}, {})).toBe(true);
  });

  it("is false for any difference, including absent vs empty", () => {
    expect(sameViewSearch({ node: "a" }, { node: "b" })).toBe(false);
    expect(sameViewSearch({ node: "a" }, {})).toBe(false);
    expect(sameViewSearch({ overlays: "impact" }, { overlays: "coupling" })).toBe(false);
    expect(sameViewSearch({}, { overlays: "" })).toBe(false);
  });
});

describe("isDefaultView", () => {
  it("is true only when there is genuinely nothing to restore", () => {
    expect(isDefaultView(parseViewSearch({}))).toBe(true);
    expect(isDefaultView(parseViewSearch({ node: NODE }))).toBe(false);
    expect(isDefaultView(parseViewSearch({ lens: "calls" }))).toBe(false);
    expect(isDefaultView(parseViewSearch({ overlays: "coupling" }))).toBe(false);
    // An unrecognised lens leaves nothing to do.
    expect(isDefaultView(parseViewSearch({ lens: "quantum" }))).toBe(true);
  });
});
