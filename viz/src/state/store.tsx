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
}

type Action =
  | { t: "progress"; phase: string }
  | { t: "ready"; model: ClientModel }
  | { t: "error"; message: string }
  | { t: "toggleExpand"; key: string }
  | { t: "select"; id: string | null }
  | { t: "hover"; id: string | null };

function reducer(state: State, a: Action): State {
  switch (a.t) {
    case "progress":
      return { ...state, status: { kind: "loading", phase: a.phase } };
    case "ready": {
      // Expand the root galaxy by default so the first level is visible.
      const expanded = new Set<string>([a.model.rootKey]);
      return { ...state, status: { kind: "ready" }, model: a.model, expanded };
    }
    case "error":
      return { ...state, status: { kind: "error", message: a.message } };
    case "toggleExpand": {
      const expanded = new Set(state.expanded);
      if (expanded.has(a.key)) expanded.delete(a.key);
      else expanded.add(a.key);
      return { ...state, expanded };
    }
    case "select":
      return { ...state, selected: a.id };
    case "hover":
      return { ...state, hovered: a.id };
  }
}

interface Store extends State {
  toggleExpand(key: string): void;
  select(id: string | null): void;
  hover(id: string | null): void;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    status: { kind: "loading", phase: "starting" },
    model: null,
    expanded: new Set<string>(),
    selected: null,
    hovered: null,
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
      select: (id) => dispatch({ t: "select", id }),
      hover: (id) => dispatch({ t: "hover", id }),
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
