export interface CapResult {
  rows: unknown[];
  truncated: boolean;
}

/** Bounds a result set to at most `maxRows` and `maxBytes` of serialized JSON
 *  (PRD §7.2 / §3.7 layer 3). Sets `truncated` when anything was dropped. */
export function applyCaps(
  rows: unknown[],
  maxRows = 200,
  maxBytes = 64 * 1024
): CapResult {
  const out: unknown[] = [];
  let bytes = 0;
  let truncated = false;
  for (let i = 0; i < rows.length; i++) {
    if (out.length >= maxRows) {
      truncated = true;
      break;
    }
    const size = Buffer.byteLength(JSON.stringify(rows[i]) ?? "", "utf8");
    if (bytes + size > maxBytes && out.length > 0) {
      truncated = true;
      break;
    }
    out.push(rows[i]);
    bytes += size;
  }
  return { rows: out, truncated };
}
