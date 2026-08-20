/** A minimal memoizing cache with a caching decision left to the caller —
 *  extracted so "never cache a failed/partial result" is one small, directly
 *  testable primitive rather than inline logic in mcp/src/index.ts.
 *
 *  Context: index.ts's per-repoPath {repoId, store} cache used to cache
 *  every resolution unconditionally, including a repo whose `.reposkein/`
 *  exists but isn't indexed yet (no meta.json — `repoId` resolves to
 *  `undefined`). That froze a session on the failure forever: an agent that
 *  fixed the repo out-of-band (ran `reposkein-mcp index` in another
 *  terminal) stayed stuck until the server restarted, which defeats
 *  `select_repo`'s whole "no restart needed" point. `shouldCache` lets the
 *  caller keep re-attempting `compute` for exactly the states worth
 *  retrying, while still caching (and not repeatedly re-doing) real work
 *  for a successful resolution. */
export function makeCache<T>(
  compute: (key: string) => Promise<T>,
  shouldCache: (value: T) => boolean
): (key: string) => Promise<T> {
  const cache = new Map<string, T>();
  return async (key: string): Promise<T> => {
    if (cache.has(key)) return cache.get(key) as T;
    const value = await compute(key);
    if (shouldCache(value)) cache.set(key, value);
    return value;
  };
}
