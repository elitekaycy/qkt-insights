import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import PublicApp from "./PublicApp";
import { setApiBase } from "./api";
import "./index.css";

// staleTime matches the server's 5s TTL cache: within that window the server
// would return the same payload anyway, so skip the request entirely.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5000 } },
});

// A shared link (/p/<token>) renders the read-only view against that token's public endpoints.
const shared = /^\/p\/([^/]+)\/?$/u.exec(location.pathname);
if (shared) setApiBase(`/public/${encodeURIComponent(shared[1]!)}`);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {shared ? <PublicApp /> : <App />}
    </QueryClientProvider>
  </React.StrictMode>,
);
