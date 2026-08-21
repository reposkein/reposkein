/** `reposkein-mcp support` — install, inspect, and remove a supporter
 *  entitlement token.
 *
 *  Four shapes, no subcommands:
 *
 *      reposkein-mcp support <token>     verify and store it
 *      reposkein-mcp support -           read the token from stdin instead
 *      reposkein-mcp support --status    what is installed and until when
 *      reposkein-mcp support --remove    delete it
 *
 *  `-` exists because a token passed as an argument is not private: it lands
 *  in `~/.bash_history`, and while the process runs it is visible in `ps` and
 *  `/proc/<pid>/cmdline` to every other user on the machine. Piping it in
 *  keeps it off both. It is not a secret worth much — the worst outcome of a
 *  leak is somebody else getting no ads — but "it barely matters" is a poor
 *  reason to make the private option unavailable.
 *
 *  The token is verified BEFORE it is written: an install that stores
 *  unverified bytes and only complains later leaves the user with a file that
 *  looks installed and does nothing. Nothing here contacts the network — see
 *  `ads/supporter.ts` — so `support` works offline, which matters because the
 *  token typically arrives by copy-paste into a terminal that may not be the
 *  one that fetched it. */

import { readFileSync } from "node:fs";
import { readSupporterStatus, type SupporterStatus } from "../ads/supporter.js";
import { removeSupporterTokenFile, supporterTokenPath, writeSupporterTokenFile } from "../ads/supporterStore.js";
import { SUPPORTER_GRACE_MS, verifySupporterTokenClaims, type SupporterRejection } from "../ads/supporterToken.js";
import { colorEnabled, styler } from "./ansi.js";

/** Where a token comes from. A string in the CLI layer on purpose: the
 *  verification path (`ads/supporter.ts` and everything it imports) must
 *  contain no URL at all, so that "this never contacts a server" is provable
 *  by reading the import graph rather than by trusting a comment. */
const KOFI_URL = "https://ko-fi.com/mongx";

export interface SupportArgs {
  mode: "install" | "status" | "remove";
  token?: string;
  /** `-` was given: the token comes from stdin, not from argv. */
  stdin?: boolean;
  json: boolean;
  error?: string;
}

export function parseSupportArgs(argv: string[]): SupportArgs {
  let json = false;
  let mode: SupportArgs["mode"] | undefined;
  let token: string | undefined;
  let stdin = false;

  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--status") {
      if (mode) return { mode: "status", json, error: "pass only one of <token> / - / --status / --remove" };
      mode = "status";
    } else if (arg === "--remove" || arg === "--forget") {
      if (mode) return { mode: "remove", json, error: "pass only one of <token> / - / --status / --remove" };
      mode = "remove";
    } else if (arg === "-") {
      // Checked before the generic `-` prefix test below, which would
      // otherwise reject the conventional stdin sentinel as an unknown flag.
      if (mode) return { mode: "install", json, error: "pass only one of <token> / - / --status / --remove" };
      mode = "install";
      stdin = true;
    } else if (arg.startsWith("-")) {
      return { mode: "status", json, error: `unknown flag ${arg}` };
    } else {
      if (mode) return { mode: "install", json, error: "pass only one of <token> / - / --status / --remove" };
      mode = "install";
      token = arg;
    }
  }
  if (!mode) return { mode: "status", json };
  const base: SupportArgs = { mode, json };
  if (stdin) base.stdin = true;
  if (token !== undefined) base.token = token;
  return base;
}

/** Human-readable explanation of a rejection. Deliberately specific: "invalid
 *  token" tells a paying supporter nothing about whether to re-copy it or ask
 *  for a new one. */
export function explainRejection(reason: SupporterRejection): string {
  switch (reason) {
    case "empty":
      return "the token is empty";
    case "too_large":
      return "the token is far larger than any real one — this is probably not a token";
    case "malformed":
      return "the token is not in the expected `rsk1.<payload>.<signature>` shape (a truncated copy-paste does this)";
    case "unknown_key":
      return "the token names a signing key this version of RepoSkein does not know — upgrade the package";
    case "bad_signature":
      return "the signature does not match — the token was altered in transit, or is not one of ours";
    case "bad_payload":
      return "the token's payload is not a well-formed entitlement";
    case "wrong_tier":
      return "the token is for a different tier than the one that removes sponsorship";
    case "implausible_lifetime":
      return "the token claims an implausibly long lifetime and was refused";
    case "not_yet_valid":
      return "the token was issued in the future — check this machine's clock";
  }
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function daysBetween(from: number, to: number): number {
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

/** The renewal pointer every non-entitled outcome ends with. */
function renewalHint(): string {
  return `Support RepoSkein at ${KOFI_URL} to get a token (or a new one).`;
}

export function renderStatus(status: SupporterStatus, now: number, color: boolean): string {
  const c = styler(color);
  const lines: string[] = [];
  switch (status.state) {
    case "none":
      lines.push(`${c.bold("Supporter:")} none installed`);
      lines.push(`  no token at ${status.path}`);
      lines.push(`  ${c.dim(renewalHint())}`);
      break;
    case "valid": {
      const days = daysBetween(now, status.claims.exp * 1000);
      lines.push(`${c.bold("Supporter:")} ${c.teal("active")} — tier ${c.bold(status.claims.tier)}`);
      lines.push(`  expires ${formatDate(status.claims.exp)} (${days} day${days === 1 ? "" : "s"} from now)`);
      lines.push(`  subject ${status.claims.sub.slice(0, 8)}… (opaque; not an account, not an email)`);
      lines.push(`  token ${status.path}${modeNote(status.mode, c.amber)}`);
      lines.push(`  ${c.dim("Sponsored slots are suppressed on this machine.")}`);
      break;
    }
    case "grace": {
      const left = daysBetween(now, status.claims.exp * 1000 + SUPPORTER_GRACE_MS);
      lines.push(`${c.bold("Supporter:")} ${c.amber("in grace period")} — tier ${c.bold(status.claims.tier)}`);
      lines.push(`  expired ${formatDate(status.claims.exp)}; still honoured for ${left} more day${left === 1 ? "" : "s"}`);
      lines.push(`  token ${status.path}${modeNote(status.mode, c.amber)}`);
      lines.push(`  ${c.dim(renewalHint())}`);
      break;
    }
    case "expired":
      lines.push(`${c.bold("Supporter:")} ${c.amber("expired")} — tier ${status.claims.tier}`);
      lines.push(`  expired ${formatDate(status.claims.exp)}; the ${SUPPORTER_GRACE_MS / (24 * 60 * 60 * 1000)}-day grace period has also passed`);
      lines.push(`  token ${status.path}`);
      lines.push(`  ${c.dim(renewalHint())}`);
      break;
    case "invalid":
      lines.push(`${c.bold("Supporter:")} ${c.amber("invalid token")}`);
      lines.push(`  ${explainRejection(status.reason)}`);
      lines.push(`  token ${status.path}${modeNote(status.mode, c.amber)}`);
      lines.push(`  ${c.dim(`Remove it with \`reposkein-mcp support --remove\`. ${renewalHint()}`)}`);
      break;
  }
  return lines.join("\n");
}

/** Flags a token file readable by anyone but its owner. Not fatal — the file
 *  is already there and already readable — but worth saying once. */
function modeNote(mode: number | null, warn: (s: string) => string): string {
  if (mode === null || (mode & 0o077) === 0) return "";
  return ` ${warn(`(mode ${mode.toString(8).padStart(3, "0")} — readable by others; \`chmod 600\` it)`)}`;
}

export function renderStatusJson(status: SupporterStatus, now: number): string {
  const base: Record<string, unknown> = { state: status.state, path: status.path, kofi: KOFI_URL };
  if (status.state === "valid" || status.state === "grace" || status.state === "expired") {
    base.tier = status.claims.tier;
    base.subject = status.claims.sub;
    base.issuedAt = new Date(status.claims.iat * 1000).toISOString();
    base.expiresAt = new Date(status.claims.exp * 1000).toISOString();
    base.graceEndsAt = new Date(status.claims.exp * 1000 + SUPPORTER_GRACE_MS).toISOString();
    base.entitled = status.state !== "expired";
  } else if (status.state === "invalid") {
    base.reason = status.reason;
    base.entitled = false;
  } else {
    base.entitled = false;
  }
  base.checkedAt = new Date(now).toISOString();
  return JSON.stringify(base, null, 2);
}

/** Reads the whole of stdin. `readFileSync(0)` rather than an async stream
 *  reader so `runSupport` stays synchronous like every other subcommand's
 *  entry point. Bounded by the token size check that follows it. */
function readStdinSync(): string {
  return readFileSync(0, "utf8");
}

/** Entry point. Returns the process exit code: 0 when the machine ends up
 *  entitled (or a removal succeeded), 1 otherwise — so a script can branch on
 *  `reposkein-mcp support --status` without parsing text.
 *
 *  `readStdin` is a test seam; production always reads fd 0. */
export function runSupport(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
  readStdin: () => string = readStdinSync
): number {
  const args = parseSupportArgs(argv);
  if (args.error) {
    console.error(`reposkein support: ${args.error}`);
    return 1;
  }
  const color = colorEnabled();

  if (args.mode === "remove") {
    const path = supporterTokenPath(env);
    let removed: boolean;
    try {
      removed = removeSupporterTokenFile(env);
    } catch (err) {
      console.error(`reposkein support: could not remove ${path}: ${(err as Error).message}`);
      return 1;
    }
    if (args.json) {
      console.log(JSON.stringify({ removed, path }, null, 2));
    } else {
      console.log(removed ? `Removed supporter token (${path}).` : `No supporter token to remove (${path}).`);
    }
    return 0;
  }

  if (args.mode === "install") {
    let raw: string;
    if (args.stdin) {
      // A bare `-` on an interactive terminal would otherwise just hang with
      // no explanation while it waits for EOF.
      if (process.stdin.isTTY) console.error("reposkein support: reading token from stdin — paste it, then press Ctrl-D.");
      try {
        raw = readStdin();
      } catch (err) {
        console.error(`reposkein support: could not read the token from stdin: ${(err as Error).message}`);
        return 1;
      }
    } else {
      raw = args.token ?? "";
    }
    const token = raw.trim();
    const parsed = verifySupporterTokenClaims(token);
    if (!parsed.ok) {
      console.error(`reposkein support: refusing to install — ${explainRejection(parsed.reason)}.`);
      console.error(`  ${renewalHint()}`);
      return 1;
    }
    // Reject an already-dead token at install time too. Storing one would
    // leave `--status` reporting "expired" for something the user just
    // pasted, which reads like a bug rather than a stale token.
    const expMs = parsed.claims.exp * 1000;
    if (now > expMs + SUPPORTER_GRACE_MS) {
      console.error(
        `reposkein support: refusing to install — that token expired on ${formatDate(parsed.claims.exp)} and its grace period has passed.`
      );
      console.error(`  ${renewalHint()}`);
      return 1;
    }
    let path: string;
    try {
      path = writeSupporterTokenFile(token, env);
    } catch (err) {
      console.error(`reposkein support: could not write ${supporterTokenPath(env)}: ${(err as Error).message}`);
      return 1;
    }
    const status = readSupporterStatus(env, now);
    if (args.json) {
      console.log(renderStatusJson(status, now));
    } else {
      const c = styler(color);
      console.log(`${c.teal("Supporter token installed.")} ${path} (mode 600)`);
      console.log(renderStatus(status, now, color));
    }
    return status.state === "valid" || status.state === "grace" ? 0 : 1;
  }

  const status = readSupporterStatus(env, now);
  console.log(args.json ? renderStatusJson(status, now) : renderStatus(status, now, color));
  return status.state === "valid" || status.state === "grace" ? 0 : 1;
}
