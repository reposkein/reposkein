import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createHashHistory,
  RouterProvider,
  Outlet,
} from "@tanstack/react-router";
import { Root } from "./routes/Root";
import { isStaticMode } from "./data/staticMode";
import { validateViewSearch } from "./data/urlState";

const queryClient = new QueryClient();

// TanStack Router: a root layout + the index route.
// The search params are the shareable VIEW, not just a node pointer:
// `?node=<id>&lens=<id>&overlays=<tokens>` (Astrolabe V4 §7). The encoding and
// every tolerance rule live in `data/urlState.ts`, which is pure and tested;
// this is only the router's shape check.
const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: validateViewSearch,
  component: Root,
});

const routeTree = rootRoute.addChildren([indexRoute]);
// Static export (`view --export`) is hosted at an unknown subpath (e.g. GitHub
// Pages `/<repo>/`), where browser-history path routing wouldn't match `/` and
// the router would render Not Found. Hash history is path-independent, so the
// baked site works at any subpath. The local `view` server is
// served at `/`, so it keeps clean browser-history URLs.
const router = createRouter({
  routeTree,
  history: isStaticMode() ? createHashHistory() : undefined,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
);
