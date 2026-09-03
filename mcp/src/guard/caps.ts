export interface CapResult {
  rows: unknown[];
  truncated: boolean;
}

/** The row cap for tool results. Exported so callers can ask the store to
 *  stop streaming there instead of capping after the fact. */
export const MAX_ROWS = 200;

/** Bounds a result set to at most `maxRows` and `maxBytes` of serialized JSON
 *  (PRD §7.2 / §3.7 layer 3). Sets `truncated` when anything was dropped. */
export function applyCaps(
  rows: unknown[],
  maxRows = MAX_ROWS,
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
