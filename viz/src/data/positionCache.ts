/** IndexedDB position cache (design: instant reload).
 *
 *  The force layout is the one slow step (~7.5s at ~14k nodes). Because it's
 *  deterministic + seeded, the SAME graph always lays out byte-identically — so
 *  we can cache the computed positions and skip the simulation on reload. This
 *  is a pure SPEED optimisation; it never changes output for a given graph.
 *
 *  Keyed by the layout fingerprint (sorted node-id set + count + LAYOUT_VERSION,
 *  see layout.layoutFingerprint). IndexedDB is available on BOTH the main thread
 *  (static-export path) AND in web workers (the live worker path).
 *
 *  Every operation is best-effort and NEVER throws to the caller: a miss, a
 *  quota error, a private-mode block, or no IndexedDB at all all resolve to
 *  "no cache" so the pipeline falls back to computing the layout. */

const DB_NAME = "reposkein-layout-cache";
const STORE = "positions";
const DB_VERSION = 1;

/** Resolve the IndexedDB factory in either a Window or a WorkerGlobalScope.
 *  Returns null when IndexedDB is unavailable (SSR/tests/old engines). */
function idbFactory(): IDBFactory | null {
  try {
    if (typeof indexedDB !== "undefined") return indexedDB;
  } catch {
    // Accessing indexedDB can throw in sandboxed contexts.
  }
  return null;
}

/** Open (and lazily create) the cache database. Resolves null on any failure. */
function openDb(): Promise<IDBDatabase | null> {
  const factory = idbFactory();
  if (!factory) return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/** Look up cached positions for a fingerprint. Resolves the Float32Array on a
 *  hit, or null on miss / any error. The stored value is an ArrayBuffer; we
 *  wrap it in a fresh Float32Array view. */
export async function loadCachedPositions(fingerprint: string): Promise<Float32Array | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Float32Array | null) => {
      if (done) return;
      done = true;
      db.close();
      resolve(v);
    };
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(fingerprint);
      req.onsuccess = () => {
        const val = req.result as ArrayBuffer | undefined;
        if (val && val.byteLength > 0 && val.byteLength % 12 === 0) {
          finish(new Float32Array(val));
        } else {
          finish(null);
        }
      };
      req.onerror = () => finish(null);
      tx.onerror = () => finish(null);
      tx.onabort = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

/** Store positions for a fingerprint. Best-effort; resolves (void) whether or
 *  not the write succeeded — a quota error must never break the load. We store
 *  the underlying ArrayBuffer (slicing the exact byte range the view covers). */
export async function storeCachedPositions(
  fingerprint: string,
  positions: Float32Array,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      db.close();
      resolve();
    };
    try {
      const buf = positions.buffer.slice(
        positions.byteOffset,
        positions.byteOffset + positions.byteLength,
      );
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(buf, fingerprint);
      tx.oncomplete = finish;
      tx.onerror = finish;
      tx.onabort = finish;
    } catch {
      finish();
    }
  });
}
