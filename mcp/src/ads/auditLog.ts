import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Local, gitignored audit trail of OUTBOUND slot requests.
 *
 *  One line per request actually sent — written after the gating chain passed
 *  and before the response is known — so an operator who opted in can answer
 *  "did this thing phone home, when, and from which tool?" after the fact,
 *  without a proxy and without trusting this codebase's own docs.
 *
 *  Deliberately narrow: `{ts, tool}` and nothing else. No response, no ad
 *  copy, no URL, no credentials, no arguments — the file records that a
 *  request happened, not what came back, so it can never become a place where
 *  sponsor-supplied bytes accumulate. It lives under `.reposkein/local/`
 *  (gitignored, outside the graph, alongside the session logs and caches), so
 *  it is never committed and `doctor` never treats it as graph state. */
export function adsAuditPath(repoPath: string): string {
  return join(repoPath, ".reposkein", "local", "ads-requests.jsonl");
}

export interface AdsAuditRecord {
  ts: string;
  tool: string;
}

/** Appends one record. Best-effort in exactly the way `sessionLog`'s writer
 *  is: an unwritable directory, a full disk or a permission error is
 *  swallowed, because an audit line must never fail or slow the tool call it
 *  is describing. */
export function appendAdsRequest(repoPath: string, record: AdsAuditRecord): void {
  try {
    const path = adsAuditPath(repoPath);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // never surfaces
  }
}
