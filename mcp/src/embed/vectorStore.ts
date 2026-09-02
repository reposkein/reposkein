/**
 * Fixed-stride binary vector store for the optional hybrid `semantic_find` tier.
 *
 * Two files beside each other under `.reposkein/local/embeddings/` — gitignored,
 * never committed, never required:
 *
 *   <name>.vec        dims * 4 bytes per slot, little-endian float32
 *   <name>.idx.jsonl  one {id, doc_hash} per line; the line number IS the slot
 *
 * Both are append-only in the steady state, which is what lets an interrupted
 * cold run resume: an OOM-kill does not unwind the stack, so anything that only
 * persisted at the end would persist nothing.
 *
 * ## Why not the JSON cache this replaces
 *
 * It stored vectors as JSON text — 21,865 bytes per 1024-dim vector against
 * 4,096 for the floats — and handed them back as `number[]`, 8,252 bytes each
 * and all of it ON the V8 heap, whose limit in this process is about 4.19 GB.
 * At 200k nodes that was ~6 GB to load and ~14.8 GB to save; it OOMed around
 * 140k. And because ranking lived in the caller, every query re-read the lot.
 *
 * A `Float32Array` view over a `Buffer` is 4 bytes per dimension and lives
 * OUTSIDE the heap limit, so the change is worth roughly 10x of headroom rather
 * than 2x. Ranking moved in here for the same reason: `topK` allocates k
 * results, not one object per corpus node.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface VectorRecord {
  id: string;
  /** Hash of the document string this vector was built from (invalidation key). */
  docHash: string;
  vector: number[] | Float32Array;
}

export interface ScoredId {
  id: string;
  score: number;
}

export interface VectorStorePaths {
  vectors: string;
  index: string;
}

/** The two files for a store, given its base path (no extension). */
export function vectorStorePaths(base: string): VectorStorePaths {
  return { vectors: `${base}.vec`, index: `${base}.idx.jsonl` };
}

interface Slot {
  slot: number;
  docHash: string;
}

export class VectorStore {
  private readonly paths: VectorStorePaths;
  private readonly dims: number;
  /** id -> slot. Small: two short strings and a number per embedded node. */
  private readonly slots = new Map<string, Slot>();
  /** Every vector, contiguous, off-heap. */
  private buf: Buffer;
  /** Cached L2 norms, one float per slot — computed at load, not per query. */
  private norms: Float64Array;
  /** Slots appended since the last flush, still only in `buf`. */
  private pending: Array<{ id: string; docHash: string }> = [];

  constructor(base: string, dims: number) {
    this.paths = vectorStorePaths(base);
    this.dims = dims;
    this.buf = Buffer.alloc(0);
    this.norms = new Float64Array(0);
    this.load();
  }

  get size(): number {
    return this.slots.size;
  }

  private stride(): number {
    return this.dims * 4;
  }

  private load(): void {
    if (!existsSync(this.paths.index) || !existsSync(this.paths.vectors)) return;
    let raw: Buffer;
    let indexText: string;
    try {
      raw = readFileSync(this.paths.vectors);
      indexText = readFileSync(this.paths.index, "utf8");
    } catch {
      return; // unreadable store is a cold start, never an error
    }

    // A store written at a different dimensionality is not a store we can read:
    // the same bytes mean something else, and scoring them would be silently
    // wrong. Treat it as absent so everything is re-embedded.
    if (raw.length % this.stride() !== 0) return;
    const capacity = raw.length / this.stride();

    let slot = 0;
    for (const line of indexText.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // a torn or malformed line costs one re-embed, not the query
      }
      const o = parsed as Record<string, unknown>;
      const id = o["id"];
      const docHash = o["doc_hash"];
      if (typeof id !== "string" || typeof docHash !== "string") continue;
      // An index row with no vector behind it is a torn write: the line landed,
      // the bytes did not.
      if (slot >= capacity) break;
      // Last write for an id wins, exactly as the append-only file implies.
      this.slots.set(id, { slot, docHash });
      slot++;
    }

    this.buf = raw;
    this.recomputeNorms(capacity);
  }

  private recomputeNorms(capacity: number): void {
    this.norms = new Float64Array(capacity);
    for (let s = 0; s < capacity; s++) {
      const v = this.vectorAt(s);
      let sum = 0;
      for (let i = 0; i < this.dims; i++) sum += v[i]! * v[i]!;
      this.norms[s] = Math.sqrt(sum);
    }
  }

  /** A view, not a copy: no per-call allocation of the vector itself. */
  private vectorAt(slot: number): Float32Array {
    const start = slot * this.stride();
    return new Float32Array(this.buf.buffer, this.buf.byteOffset + start, this.dims);
  }

  get(id: string): Float32Array | undefined {
    const s = this.slots.get(id);
    return s === undefined ? undefined : this.vectorAt(s.slot);
  }

  docHash(id: string): string | undefined {
    return this.slots.get(id)?.docHash;
  }

  /** Add or replace vectors. Held in memory until `flush`. */
  upsertMany(records: VectorRecord[]): void {
    if (records.length === 0) return;
    const chunks: Buffer[] = [this.buf];
    let slot = this.buf.length / this.stride();
    for (const r of records) {
      const b = Buffer.allocUnsafe(this.stride());
      for (let i = 0; i < this.dims; i++) b.writeFloatLE(Number(r.vector[i] ?? 0), i * 4);
      chunks.push(b);
      this.slots.set(r.id, { slot, docHash: r.docHash });
      this.pending.push({ id: r.id, docHash: r.docHash });
      slot++;
    }
    this.buf = Buffer.concat(chunks);
    this.recomputeNorms(this.buf.length / this.stride());
  }

  /** Append everything since the last flush. Best-effort: a failed flush costs
   *  re-embedding, never correctness. */
  flush(): void {
    if (this.pending.length === 0) return;
    const pending = this.pending;
    this.pending = [];
    try {
      mkdirSync(dirname(this.paths.vectors), { recursive: true });
      const start = (this.buf.length / this.stride() - pending.length) * this.stride();
      appendFileSync(this.paths.vectors, this.buf.subarray(start));
      appendFileSync(
        this.paths.index,
        pending.map((p) => JSON.stringify({ id: p.id, doc_hash: p.docHash })).join("\n") + "\n"
      );
    } catch {
      // best-effort
    }
  }

  /**
   * The k most similar ids by cosine, best first.
   *
   * Ranking lives here rather than in the caller so that the caller never has
   * to hold the corpus: this allocates k results, not one object per node.
   * `candidates`, when given, restricts scoring to that set.
   */
  topK(query: number[] | Float32Array, k: number, candidates?: Set<string>): ScoredId[] {
    if (k <= 0 || this.slots.size === 0) return [];
    let qNorm = 0;
    for (let i = 0; i < this.dims; i++) qNorm += Number(query[i] ?? 0) ** 2;
    qNorm = Math.sqrt(qNorm);
    if (qNorm === 0) return [];

    // A bounded insertion list: k is small (tens), so this beats a heap in
    // practice and keeps the allocation proportional to k.
    const best: ScoredId[] = [];
    for (const [id, { slot }] of this.slots) {
      if (candidates !== undefined && !candidates.has(id)) continue;
      const norm = this.norms[slot]!;
      if (norm === 0) continue; // a zero vector has no direction to compare
      const v = this.vectorAt(slot);
      let dot = 0;
      for (let i = 0; i < this.dims; i++) dot += v[i]! * Number(query[i] ?? 0);
      const score = dot / (norm * qNorm);

      if (best.length < k) {
        best.push({ id, score });
        best.sort(byScoreThenId);
      } else if (score > best[best.length - 1]!.score) {
        best[best.length - 1] = { id, score };
        best.sort(byScoreThenId);
      }
    }
    return best;
  }

  /**
   * Rewrite both files with one slot per live id.
   *
   * Appending means a re-embedded node leaves its old slot behind. Worth doing
   * when the dead weight is material; pointless otherwise.
   */
  compact(): void {
    const live = [...this.slots.entries()];
    const capacity = this.buf.length / this.stride();
    if (live.length === capacity) return;
    try {
      mkdirSync(dirname(this.paths.vectors), { recursive: true });
      const out = Buffer.allocUnsafe(live.length * this.stride());
      const lines: string[] = [];
      live.forEach(([id, s], i) => {
        this.buf.copy(out, i * this.stride(), s.slot * this.stride(), (s.slot + 1) * this.stride());
        lines.push(JSON.stringify({ id, doc_hash: s.docHash }));
      });
      // Unique per process: concurrent compactions must not rename through a
      // shared temp path, where the loser would publish a stale snapshot.
      const uniq = `${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
      const tmpVec = `${this.paths.vectors}.${uniq}.tmp`;
      const tmpIdx = `${this.paths.index}.${uniq}.tmp`;
      writeFileSync(tmpVec, out);
      writeFileSync(tmpIdx, lines.length ? lines.join("\n") + "\n" : "");
      renameSync(tmpVec, this.paths.vectors);
      renameSync(tmpIdx, this.paths.index);
      this.buf = out;
      live.forEach(([id, s], i) => this.slots.set(id, { slot: i, docHash: s.docHash }));
      this.recomputeNorms(live.length);
    } catch {
      // best-effort; a failed compaction leaves a correct, larger store
    }
  }

  /** How much of the file is dead slots, 0..1. */
  wastedFraction(): number {
    const capacity = this.buf.length / this.stride();
    if (capacity === 0) return 0;
    return (capacity - this.slots.size) / capacity;
  }
}

/** Descending score, ties broken by ascending id.
 *  Ranking feeds a tool result, so equal scores must not reorder run to run. */
function byScoreThenId(a: ScoredId, b: ScoredId): number {
  const d = b.score - a.score;
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function openVectorStore(base: string, dims: number): VectorStore {
  return new VectorStore(base, dims);
}

/** Remove a legacy JSON vector cache, which the binary store supersedes.
 *  At 200k nodes that file was over 4 GB; leaving it costs real disk. */
export function removeLegacyJsonCache(base: string): void {
  const legacy = `${base}.jsonl`;
  try {
    if (existsSync(legacy) && statSync(legacy).isFile()) unlinkSync(legacy);
  } catch {
    // best-effort
  }
}
