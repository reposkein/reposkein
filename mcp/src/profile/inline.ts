import type { NeighborEntry, ProfileTarget } from "./types.js";

function neighborPhrase(n: NeighborEntry, withCaveat: boolean, homeRepo?: string): string {
  let s = n.name;
  if (n.summary) {
    s += ` (${n.summary})`;
  } else {
    s += " (no summary yet — read and enrich)";
  }
  if (homeRepo && n.repo_id && n.repo_id !== homeRepo) {
    s += ` [repo: ${n.repo_id}]`;
  }
  if (withCaveat && n.resolution && n.resolution !== "exact") {
    const conf = n.confidence != null ? `, confidence ${n.confidence}` : "";
    s += ` [${n.resolution}${conf} — verify]`;
  }
  return s;
}

/** Assembles the prose `inlined_context` an agent pastes into its reasoning
 *  (PRD §7.4 / §10.3) so it doesn't burn turns reassembling the neighborhood. */
export function buildInlinedContext(
  target: ProfileTarget,
  upstream: NeighborEntry[],
  downstream: NeighborEntry[]
): string {
  const head = `${target.name} (${target.file_path}:${target.lines[0]}-${target.lines[1]})`;
  const parts: string[] = [];
  parts.push(target.summary ? `${head}: ${target.summary}.` : `${head} — no summary yet (read and enrich).`);
  if (upstream.length > 0) {
    parts.push("Called by " + upstream.map((u) => neighborPhrase(u, false, target.repo_id)).join(", ") + ".");
  }
  if (downstream.length > 0) {
    parts.push("Calls " + downstream.map((d) => neighborPhrase(d, true, target.repo_id)).join("; ") + ".");
  }
  return parts.join(" ");
}
