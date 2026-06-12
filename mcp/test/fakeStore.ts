import type { GraphStore } from "../src/store/GraphStore.js";

/** A GraphStore whose every method throws unless overridden. Unit tests
 *  override only the methods they exercise. */
export function fakeStore(overrides: Partial<GraphStore> = {}): GraphStore {
  const unimpl = (name: string) => async () => {
    throw new Error(`fakeStore.${name} not implemented in this test`);
  };
  return {
    getNode: unimpl("getNode"),
    resolveByPathAndName: unimpl("resolveByPathAndName"),
    resolveByName: unimpl("resolveByName"),
    callers: unimpl("callers"),
    callees: unimpl("callees"),
    calleesAt2Hops: unimpl("calleesAt2Hops"),
    writeSummary: unimpl("writeSummary"),
    federatedRepoIds: unimpl("federatedRepoIds"),
    runRead: unimpl("runRead"),
    close: async () => {},
    ...overrides,
  } as GraphStore;
}
