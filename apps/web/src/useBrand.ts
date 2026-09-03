import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

/** The deployment's label (INSIGHTS_NAME), or null for an unnamed instance. Also
 *  keeps the document title in step so browser tabs tell the dashboards apart. */
export function useBrand(): string | null {
  const q = useQuery({
    queryKey: ["brand"],
    queryFn: async () => {
      const r = await fetch("/brand");
      if (!r.ok) return null;
      const body = (await r.json()) as { name?: string | null };
      return body.name?.trim() || null;
    },
    staleTime: Infinity,
    retry: false,
  });
  const name = q.data ?? null;
  useEffect(() => {
    document.title = name ? `${name} · qkt-insights` : "qkt-insights";
  }, [name]);
  return name;
}
