import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
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

const queryClient = new QueryClient();

// TanStack Router: a root layout + the index route.
// The ?node=<id> search param enables deep-linking to a specific node.
const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>) => ({
    node: typeof search.node === "string" ? search.node : undefined,
  }),
  component: Root,
});

const routeTree = rootRoute.addChildren([indexRoute]);
// Static export (`view --export`) is hosted at an unknown subpath (e.g. GitHub
// Pages `/<repo>/`), where browser-history path routing wouldn't match `/` and
// the router would render Not Found. Hash history is path-independent, so the
// baked site works at any subpath / from file://. The local `view` server is
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
