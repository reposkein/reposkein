import type { SlotContext, SponsoredSource } from "./types.js";

/** Adapter over the `lulu-ads` npm package's LOW-LEVEL client.
 *
 *  What this uses, and nothing else:
 *    `new LuluAds({publisherId, apiKey, baseUrl}).sponsoredSlot({context, timeoutMs})`
 *  → one `POST {baseUrl}/slot` with header `x-api-key` and body
 *    `{"context": {...}}`, hard-aborted by the SDK's own
 *    `AbortSignal.timeout(timeoutMs)`, returning data or null, never throwing.
 *
 *  What this deliberately does NOT use, after reading the package (v0.9.0):
 *    - `enableLuluAds` / `withLuluAds`: they proxy `registerTool` and MUTATE
 *      the tool result — appending a rendered text card to `content` for CLI
 *      clients and, when `content` is a single text block, REPLACING it with
 *      `JSON.stringify(structuredContent)`. That rewrites our answer, which
 *      both the governing ADR ("never concatenated into result text") and the
 *      byte-identical fail-open guarantee forbid.
 *    - `warmUp()`: it POSTs `/telemetry/init` at startup. An opt-in ad slot
 *      must make ZERO network calls until a tool call actually passes the
 *      gating chain, so nothing here pings anything at boot.
 *    - `formatSuffix` / `formatCliCard`: both exist to concatenate sponsor
 *      copy into prose. Not on this codebase's response path, ever.
 *    - the widget/MCP-Apps exports: no rendered ad surface is in scope for
 *      REP-28.
 *
 *  The import is DYNAMIC and lazy: with ads off (the default) the package is
 *  never even loaded, which also keeps its ~270KB bundled widget HTML out of
 *  the stdio server's startup path. */
export function luluAdsSource(cfg: {
  publisherId: string;
  apiKey: string;
  baseUrl: string;
}): SponsoredSource {
  // Built on first successful use and reused: the SDK client is a plain
  // object holding config plus an in-memory cache; constructing it performs
  // no I/O (see its constructor — warmUp is the only network side effect and
  // we never call it).
  let client: { sponsoredSlot(opts: unknown): Promise<unknown> } | null = null;

  return {
    async requestSlot(ctx: SlotContext, opts: { timeoutMs: number; signal: AbortSignal }) {
      if (opts.signal.aborted) return null;
      if (!client) {
        const mod = (await import("lulu-ads")) as unknown as {
          LuluAds: new (o: { publisherId: string; apiKey: string; baseUrl: string }) => {
            sponsoredSlot(o: unknown): Promise<unknown>;
          };
        };
        client = new mod.LuluAds({
          publisherId: cfg.publisherId,
          apiKey: cfg.apiKey,
          baseUrl: cfg.baseUrl,
        });
      }
      // `context` is built here, key by key, from `SlotContext` alone. The
      // SDK's own allowlist would also accept `prompt`, `route`, `locale`,
      // `country` and `category`; we never populate them, so they cannot leak
      // by accident. `query` carries coarse keywords ONLY when the caller
      // supplied them (no tool on the eligible list does today).
      return client.sponsoredSlot({
        context: {
          tool: ctx.tool,
          ...(ctx.keywords ? { query: ctx.keywords } : {}),
        },
        timeoutMs: opts.timeoutMs,
      });
    },
  };
}
