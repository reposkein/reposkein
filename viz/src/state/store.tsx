import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import GraphWorker from "../data/worker/graph.worker.ts?worker";
import { fromWorker, type ClientModel } from "../data/clientModel";
import type {
  WorkerError,
  WorkerProgress,
  WorkerResult,
} from "../data/worker/graph.worker";

type Status =
  | { kind: "loading"; phase: string }
  | { kind: "ready" }
  | { kind: "error"; message: string };

interface State {
  status: Status;
  model: ClientModel | null;
  expanded: Set<string>;
  selected: string | null;
  hovered: string | null;
  /** Bumped whenever the visible set changes (load / expand / collapse) or a
   *  star is framed, so the camera-fit hook can refit to what's on screen. */
  fitNonce: number;
}

type Action =
  | { t: "progress"; phase: string }
  | { t: "ready"; model: ClientModel }
  | { t: "error"; message: string }
  | { t: "toggleExpand"; key: string }
  | { t: "collapseLevel" }
  | { t: "select"; id: string | null }
  | { t: "hover"; id: string | null }
  | { t: "requestFit" };

/** Depth of a cluster key in the tree (root galaxy = 0). Lets collapseLevel
 *  shut the deepest-expanded branch first ("one level up"). */
function depthOf(model: ClientModel, key: string): number {
  return (model.ancestors.get(key)?.length ?? 1) - 1;
}

function reducer(state: State, a: Action): State {
  switch (a.t) {
    case "progress":
      return { ...state, status: { kind: "loading", phase: a.phase } };
    case "ready": {
      // Expand the root galaxy by default so the first level is visible.
      const expanded = new Set<string>([a.model.rootKey]);
      return {
        ...state,
        status: { kind: "ready" },
        model: a.model,
        expanded,
        fitNonce: state.fitNonce + 1,
      };
    }
    case "error":
      return { ...state, status: { kind: "error", message: a.message } };
    case "toggleExpand": {
      const expanded = new Set(state.expanded);
      if (expanded.has(a.key)) expanded.delete(a.key);
      else expanded.add(a.key);
      return { ...state, expanded, fitNonce: state.fitNonce + 1 };
    }
    case "collapseLevel": {
      if (!state.model || state.expanded.size === 0) return state;
      // Collapse the deepest currently-expanded cluster, but never the root
      // galaxy (keeps the constellation framed).
      let deepest: string | null = null;
      let deepestDepth = -1;
      for (const key of state.expanded) {
        if (key === state.model.rootKey) continue;
        const d = depthOf(state.model, key);
        if (d > deepestDepth) {
          deepestDepth = d;
          deepest = key;
        }
      }
      if (deepest === null) {
        // Nothing but the root expanded: just clear selection.
        if (state.selected === null) return state;
        return { ...state, selected: null, fitNonce: state.fitNonce + 1 };
      }
      const expanded = new Set(state.expanded);
      expanded.delete(deepest);
      return { ...state, expanded, selected: null, fitNonce: state.fitNonce + 1 };
    }
    case "select":
      return { ...state, selected: a.id, fitNonce: state.fitNonce + 1 };
    case "hover":
      return { ...state, hovered: a.id };
    case "requestFit":
      return { ...state, fitNonce: state.fitNonce + 1 };
  }
}

interface Store extends State {
  toggleExpand(key: string): void;
  collapseLevel(): void;
  select(id: string | null): void;
  hover(id: string | null): void;
  requestFit(): void;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    status: { kind: "loading", phase: "starting" },
    model: null,
    expanded: new Set<string>(),
    selected: null,
    hovered: null,
    fitNonce: 0,
  });

  useEffect(() => {
    const worker = new GraphWorker();
    worker.onmessage = (
      e: MessageEvent<WorkerResult | WorkerError | WorkerProgress>
    ) => {
      const m = e.data;
      if (m.type === "progress") dispatch({ t: "progress", phase: m.phase });
      else if (m.type === "error") dispatch({ t: "error", message: m.message });
      else if (m.type === "result")
        dispatch({ t: "ready", model: fromWorker(m) });
    };
    worker.onerror = (e) => dispatch({ t: "error", message: e.message });
    worker.postMessage({ cmd: "load" });
    return () => worker.terminate();
  }, []);

  const store = useMemo<Store>(
    () => ({
      ...state,
      toggleExpand: (key) => dispatch({ t: "toggleExpand", key }),
      collapseLevel: () => dispatch({ t: "collapseLevel" }),
      select: (id) => dispatch({ t: "select", id }),
      hover: (id) => dispatch({ t: "hover", id }),
      requestFit: () => dispatch({ t: "requestFit" }),
    }),
    [state]
  );

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore must be used within StoreProvider");
  return s;
}
