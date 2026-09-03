/**
 * Synchronous JSONL line reading, without materialising the file.
 *
 * The graph load has to stay synchronous — `ensureFresh` is called from every
 * store method — so `readline` is not available. This reads through a fixed
 * buffer instead, which keeps peak proportional to the buffer and the longest
 * line rather than to the file.
 *
 * It matters most under federation: `collectRepos` used to hold the COMPLETE
 * text of every federated repo simultaneously before parsing any of it, so a
 * root plus ten children meant the whole federation's JSONL was resident at
 * once. Measured on a 10-child, 130k-node federation (111 MiB on disk), the
 * load cost 751 MiB RSS — and every `serve --http` session paid it again.
 */

import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** 64 KiB: large enough that syscalls are not the bottleneck, small enough to
 *  be irrelevant next to the parsed graph. */
const CHUNK = 64 * 1024;

/**
 * Yield each non-empty line of a UTF-8 JSONL file.
 *
 * Lazy: nothing is read until iteration starts, and the file is closed when
 * iteration finishes or the consumer stops early.
 */
export function* readLines(path: string): Generator<string> {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return; // a missing file is an empty graph, never an error
  }
  const buf = Buffer.allocUnsafe(CHUNK);
  // A multi-byte character can straddle a chunk edge, and a plain
  // buf.toString() would replace the split halves with U+FFFD — silently
  // corrupting any non-ASCII identifier or summary. StringDecoder holds the
  // incomplete sequence back until the next chunk completes it.
  const decoder = new StringDecoder("utf8");
  let carry = "";
  try {
    for (;;) {
      const bytes = readSync(fd, buf, 0, CHUNK, null);
      if (bytes === 0) break;
      carry += decoder.write(buf.subarray(0, bytes));
      let nl = carry.indexOf("\n");
      while (nl !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line.trim() !== "") yield line;
        nl = carry.indexOf("\n");
      }
    }
    carry += decoder.end();
    if (carry.trim() !== "") yield carry;
  } finally {
    closeSync(fd);
  }
}
