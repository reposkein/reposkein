import { readConfigBool } from "../store/teamConfig.js";

/** The ad network's default API host. Its click links are always
 *  `https://<host>/c/{token}` (getlulu.dev/docs/contract: "never a raw
 *  advertiser URL"), which is why the click-host allowlist is derived from
 *  whatever base URL we are actually talking to rather than hardcoded twice. */
export const DEFAULT_ADS_BASE_URL = "https://ads.getlulu.dev";

/** Hard wall-clock budget for one slot request. The SDK's own default is
 *  1500ms (3000ms when the backend may classify) — far too long to sit in
 *  front of an agent's tool result, so we impose ours on every call and treat
 *  the deadline as a no-slot, never an error. */
export const SLOT_TIMEOUT_MS = 800;

/** Tools allowed to carry a sponsored slot. An ALLOWLIST, not a denylist: a
 *  tool added to this server later carries no ad until someone puts it here on
 *  purpose.
 *
 *  `get_context_profile` only, and deliberately:
 *  - It is the highest-volume tool in the intended workflow (one
 *    `semantic_find` seeds several profile expansions — see docs/TOOLS.md) and
 *    it is a deterministic neighbourhood expansion, so an envelope field
 *    cannot bias, reorder, or displace anything the caller asked for.
 *  - `semantic_find` is excluded PERMANENTLY, not by oversight: the governing
 *    ADR (.reposkein/decisions/2026-08-21-sponsorship-placement-*.json,
 *    ruling 2) rules that "an agent (or a person) calling semantic_find must
 *    get back what best matches the query, never what a sponsor paid to
 *    surface". Ranked retrieval stays uncontaminated even at the envelope
 *    level.
 *  - Every mutating tool (see WRITE_TOOLS) and every error path is excluded:
 *    ads never ride along with a write or a failure. */
export const AD_ELIGIBLE_TOOLS: readonly string[] = ["get_context_profile"];

/** Why no slot will be requested. Diagnostic only — never surfaced to a
 *  caller, never logged with credential values. */
export type AdsOffReason =
  | "kill_switch"
  | "not_opted_in"
  | "config_not_confirmed"
  | "no_credentials"
  | "supporter"
  | "bad_base_url";

export type AdsVerdict =
  | { enabled: false; reason: AdsOffReason }
  | {
      enabled: true;
      publisherId: string;
      apiKey: string;
      baseUrl: string;
      /** Hosts a click URL may point at. */
      clickHosts: string[];
    };

export interface ResolveAdsOptions {
  /** Active repo root, for `[ads] enabled` in `.reposkein/config.toml`.
   *  Undefined (no repo resolved) simply means that opt-in source is absent. */
  repoPath?: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** REP-29 fills this in. Default: nobody is a supporter yet. */
  isSupporter?: () => boolean;
  /** Test seam for the config.toml read, and the connection-lifetime memo in
   *  `slot.ts` (one filesystem read per repo, not one per tool call). */
  readOptIn?: (repoPath: string) => boolean | null;
}

/** The whole gating chain, in one place, evaluated in this order:
 *
 *   1. `REPOSKEIN_ADS=off` — an unconditional kill switch that outranks
 *      config, credentials, everything. Checked first so "off" can never be
 *      overridden by a repo's committed config.
 *   2. Opt-in — `REPOSKEIN_ADS=on` in the ENVIRONMENT. A repo's
 *      `[ads] enabled = true` declares the repo's willingness, but is not
 *      sufficient on its own: config.toml is committed and travels with a
 *      clone, so honouring it alone would let whoever wrote it opt in every
 *      person who later checks the repo out. The environment is the only
 *      place the operator running THIS process can speak for themselves, so
 *      it must confirm. Absent the env switch, ads are off — which is the
 *      default for every install.
 *   3. Credentials — `LULU_ADS_PUBLISHER_ID` + `LULU_ADS_API_KEY`, env only,
 *      never config, never argv, never logged. Absent either, the integration
 *      is inert: no network call is even attempted.
 *   4. Supporter — a verified supporter never sees a slot (REP-29).
 *
 *  Nothing in this function touches the network; it is the only thing that
 *  decides whether anything ever will. */
export function resolveAdsVerdict(opts: ResolveAdsOptions = {}): AdsVerdict {
  const env = opts.env ?? process.env;

  const switchValue = (env.REPOSKEIN_ADS ?? "").trim().toLowerCase();
  if (switchValue === "off" || switchValue === "0" || switchValue === "false") {
    return { enabled: false, reason: "kill_switch" };
  }

  const envOptIn = switchValue === "on" || switchValue === "1" || switchValue === "true";
  if (!envOptIn) {
    // Distinguish "a repo asked, the operator hasn't confirmed" from "nobody
    // asked at all" — the first is a state an operator may want to notice.
    const readOptIn = opts.readOptIn ?? ((p: string) => readConfigBool(p, "ads", "enabled"));
    const configAsked = opts.repoPath ? readOptIn(opts.repoPath) === true : false;
    return { enabled: false, reason: configAsked ? "config_not_confirmed" : "not_opted_in" };
  }

  const publisherId = (env.LULU_ADS_PUBLISHER_ID ?? "").trim();
  const apiKey = (env.LULU_ADS_API_KEY ?? "").trim();
  if (publisherId === "" || apiKey === "") {
    return { enabled: false, reason: "no_credentials" };
  }

  const isSupporter = opts.isSupporter ?? (() => false);
  if (isSupporter()) {
    return { enabled: false, reason: "supporter" };
  }

  const baseUrl = (env.LULU_ADS_BASE_URL ?? "").trim() || DEFAULT_ADS_BASE_URL;
  let host: string;
  try {
    const parsed = new URL(baseUrl);
    // Plaintext is refused for any REMOTE host: an ad request carries the
    // publisher's API key, and the click URL comes back over the same
    // connection, so http:// off-machine would hand both to anyone on the
    // path. Loopback is the one exception, and only because it cannot leave
    // the machine: it exists so a test or a local mock ad server can be
    // pointed at without inventing TLS for it. Note the click-host allowlist
    // is derived from this host, so a loopback base URL also means click URLs
    // must point at loopback — a mock cannot smuggle in a real destination.
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !loopback) {
      return { enabled: false, reason: "bad_base_url" };
    }
    host = parsed.hostname;
  } catch {
    return { enabled: false, reason: "bad_base_url" };
  }

  return {
    enabled: true,
    publisherId,
    apiKey,
    baseUrl: baseUrl.replace(/\/$/, ""),
    clickHosts: [host],
  };
}
