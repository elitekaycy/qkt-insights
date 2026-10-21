import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import PublicApp from "./PublicApp";
import { setApiBase } from "./api";
import { RouterProvider } from "./router";
import "./index.css";

// staleTime matches the server's 5s TTL cache: within that window the server
// would return the same payload anyway, so skip the request entirely.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5000 } },
});

// A shared link (/p/<token>, and its pages under it) renders the read-only view against that
// token's public endpoints; its URLs nest under the token so deep links survive a reload.
const shared = /^\/p\/([^/]+)(?:\/.*)?$/u.exec(location.pathname);
if (shared) setApiBase(`/public/${encodeURIComponent(shared[1]!)}`);
const base = shared ? `/p/${shared[1]}` : "";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider base={base}>{shared ? <PublicApp /> : <App />}</RouterProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
