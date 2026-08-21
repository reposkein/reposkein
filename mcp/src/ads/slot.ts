import {
  AD_ELIGIBLE_TOOLS,
  SLOT_TIMEOUT_MS,
  resolveAdsVerdict,
  type AdsVerdict,
} from "./config.js";
import { luluAdsSource } from "./luluSource.js";
import { sanitizeSponsored } from "./sanitize.js";
import { isSupporter as defaultIsSupporter } from "./supporter.js";
import { readConfigBool } from "../store/teamConfig.js";
import { appendAdsRequest } from "./auditLog.js";
import { SPONSORED_META_KEY, type SlotContext, type SponsoredSlot, type SponsoredSource } from "./types.js";

/** Minimal shape the hook needs from a tool result — structurally compatible
 *  with `tools/readCypher.ts`'s `ToolResult` without importing it (the hook
 *  must stay usable around any handler). */
export interface AdResultLike {
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
}

export interface AdsHookOptions {
  /** The active repo root for `[ads] enabled`, resolved lazily so a disabled
   *  integration costs nothing. */
  resolveRepoPath: () => string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests. Omitted in production: the real source is built (and
   *  the `lulu-ads` package first imported) only after the gating chain
   *  passes. Pass `null` to guarantee no source can ever be built. */
  source?: SponsoredSource | null;
  isSupporter?: () => boolean;
  timeoutMs?: number;
  /** Test seam: `[ads] enabled` lookup. */
  readOptIn?: (repoPath: string) => boolean | null;
  /** Test seams for the local request audit (`.reposkein/local/ads-requests.jsonl`).
   *  Defaults: the real appender, deferred with `setImmediate`. */
  audit?: (repoPath: string, record: { ts: string; tool: string }) => void;
  schedule?: (fn: () => void) => void;
}

export interface AdsHook {
  /** Wraps a tool handler so its RESPONSE ENVELOPE may carry a sponsored slot.
   *  Wrap OUTSIDE `withLog` (`withAds(name, withLog(name, handler))`): the
   *  slot must not exist yet when the session logger captures the result, or
   *  sponsored bytes would show up in `.reposkein/local/sessions` byte counts.
   *  Attachment is copy-on-write for the same reason — the object the logger
   *  holds by reference is never mutated. */
  withAds<Args, R extends AdResultLike>(
    tool: string,
    cb: (args: Args) => Promise<R>
  ): (args: Args) => Promise<R>;
}

/** Builds the sponsorship hook for ONE server connection (mirrors
 *  `createToolLogger`: per-connection state, no module globals).
 *
 *  Everything about this is fail-open. A disabled integration, absent
 *  credentials, a rejecting source, a hanging source, a hostile payload and an
 *  outright bug all land in the same place: the tool's own result, returned
 *  unchanged. There is no code path here that can make a tool call fail, and
 *  none that can slow it by more than `timeoutMs`. */
export function createAdsHook(opts: AdsHookOptions): AdsHook {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? SLOT_TIMEOUT_MS;
  const isSupporter = opts.isSupporter ?? defaultIsSupporter;
  const audit = opts.audit ?? appendAdsRequest;
  const schedule = opts.schedule ?? setImmediate;

  // The config.toml opt-in is memoized for the connection's lifetime: one
  // filesystem read per repo, never one per tool call. The env kill switch and
  // the credential/supporter checks are re-evaluated on every call (they are
  // pure reads of already-loaded state), so `REPOSKEIN_ADS=off` takes effect
  // immediately while a config.toml edit needs a reconnect.
  const optInMemo = new Map<string, boolean | null>();
  const readOptIn = (repoPath: string): boolean | null => {
    if (!optInMemo.has(repoPath)) {
      const read = opts.readOptIn;
      try {
        optInMemo.set(repoPath, read ? read(repoPath) : resolveOptInFromDisk(repoPath));
      } catch {
        optInMemo.set(repoPath, null);
      }
    }
    return optInMemo.get(repoPath) ?? null;
  };

  let source: SponsoredSource | null | undefined = opts.source;

  function sourceFor(verdict: Extract<AdsVerdict, { enabled: true }>): SponsoredSource | null {
    if (source !== undefined) return source;
    source = luluAdsSource({
      publisherId: verdict.publisherId,
      apiKey: verdict.apiKey,
      baseUrl: verdict.baseUrl,
    });
    return source;
  }

  /** One bounded slot request, or null. Never throws, never exceeds the
   *  budget: an `AbortController` is signalled at the deadline and the race
   *  resolves null regardless of what the source does afterwards, so even a
   *  source that ignores the signal entirely cannot delay a tool result. */
  async function requestSlot(
    src: SponsoredSource,
    ctx: SlotContext,
    clickHosts: string[]
  ): Promise<SponsoredSlot | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      const raw = await Promise.race([
        src.requestSlot(ctx, { timeoutMs, signal: controller.signal }).catch(() => null),
        deadline,
      ]);
      if (raw === null || raw === undefined) return null;
      return sanitizeSponsored(raw, { clickHosts });
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function maybeSlot(tool: string): Promise<SponsoredSlot | null> {
    if (!AD_ELIGIBLE_TOOLS.includes(tool)) return null;
    const repoPath = opts.resolveRepoPath();
    const verdict = resolveAdsVerdict({
      repoPath,
      env,
      isSupporter,
      readOptIn,
    });
    if (!verdict.enabled) return null;
    const src = sourceFor(verdict);
    if (!src) return null;
    // Audit BEFORE the call, deferred off the hot path (the instrumentTool
    // pattern): the line records that a request left this machine, so it must
    // be written even if the request then hangs, fails, or is aborted at the
    // deadline. Never blocks and never throws.
    if (repoPath) {
      const ts = new Date().toISOString();
      schedule(() => audit(repoPath, { ts, tool }));
    }
    return requestSlot(src, { tool }, verdict.clickHosts);
  }

  function withAds<Args, R extends AdResultLike>(
    tool: string,
    cb: (args: Args) => Promise<R>
  ): (args: Args) => Promise<R> {
    return async (args: Args): Promise<R> => {
      const result = await cb(args);
      try {
        // Error results are off-limits: a failure is never a sales surface,
        // and a caller debugging one should see nothing but the failure.
        if (!result || typeof result !== "object" || result.isError === true) return result;
        const slot = await maybeSlot(tool);
        if (!slot) return result;
        return attachSponsored(result, slot);
      } catch {
        // A sponsorship bug must be invisible to the caller.
        return result;
      }
    };
  }

  return { withAds };
}

/** `[ads] enabled` from `.reposkein/config.toml`. */
function resolveOptInFromDisk(repoPath: string): boolean | null {
  return readConfigBool(repoPath, "ads", "enabled");
}

/** Attaches the slot to the response ENVELOPE, copy-on-write.
 *
 *  `_meta` under a namespaced key — not `content`, and never a
 *  `structuredContent` object invented for the purpose. Rationale: `content`
 *  is the tool's answer and the one surface an agent reads as prose, so
 *  sponsored data must never appear there in any form (concatenated or
 *  appended); and materializing a `structuredContent` that only holds an ad
 *  would let a host that prefers structured output over text render the ad
 *  INSTEAD of the answer. When a tool already returns structuredContent, the
 *  slot is mirrored there as a clearly separate `sponsored` key so hosts that
 *  render structured fields can disclose it.
 *
 *  The `sponsored` label travels inside the slot object and the envelope key
 *  itself is fixed: nothing here can rename, hide, or restyle the disclosure. */
export function attachSponsored<R extends AdResultLike>(result: R, slot: SponsoredSlot): R {
  const meta = { ...(result._meta ?? {}), [SPONSORED_META_KEY]: slot };
  const out: R = { ...result, _meta: meta };
  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    out.structuredContent = { ...(structured as Record<string, unknown>), sponsored: slot };
  }
  return out;
}
