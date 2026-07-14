import { useEffect, useRef, useState } from "react";

type EChartsInstance = {
  setOption(option: QktChartOption, notMerge?: boolean): void;
  resize(): void;
  dispose(): void;
};

type EChartsApi = {
  init(
    element: HTMLDivElement,
    theme?: string,
    options?: { renderer?: "canvas" | "svg" },
  ): EChartsInstance;
};

declare global {
  interface Window {
    echarts?: EChartsApi;
  }
}

let echartsLoader: Promise<EChartsApi> | null = null;

function loadECharts(): Promise<EChartsApi> {
  if (window.echarts) return Promise.resolve(window.echarts);
  if (echartsLoader) return echartsLoader;

  echartsLoader = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-qkt-echarts="true"]');
    if (existing) {
      existing.addEventListener("load", () => (window.echarts ? resolve(window.echarts) : reject(new Error("ECharts did not initialize"))), {
        once: true,
      });
      existing.addEventListener("error", () => reject(new Error("Failed to load ECharts")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "/vendor/echarts.min.js";
    script.async = true;
    script.dataset.qktEcharts = "true";
    script.addEventListener("load", () => (window.echarts ? resolve(window.echarts) : reject(new Error("ECharts did not initialize"))), {
      once: true,
    });
    script.addEventListener("error", () => reject(new Error("Failed to load ECharts")), { once: true });
    document.head.appendChild(script);
  });

  return echartsLoader;
}

export type QktChartOption = {
  [key: string]: unknown;
  tooltip?: Record<string, unknown> | Array<Record<string, unknown>>;
};

export const chartColors = {
  primary: "#5cb8ff",
  accent: "#c8f74a",
  up: "#3fe08c",
  down: "#ff6b6b",
  warn: "#fbbf24",
  violet: "#a78bfa",
  muted: "#79828c",
} as const;

export const qktChartGrid = { left: 54, right: 18, top: 28, bottom: 34, containLabel: false };

export const qktChartAxis = {
  axisLine: { show: false },
  axisTick: { show: false },
  axisLabel: { color: "#79828c", fontFamily: "Archivo, system-ui, sans-serif", fontSize: 11, hideOverlap: true },
  nameTextStyle: { color: "#79828c", fontFamily: "Archivo, system-ui, sans-serif", fontSize: 11 },
  splitLine: { lineStyle: { color: "rgba(121,130,140,0.14)", type: "solid" as const } },
};

/** Inside zoom keeps charts clean; expanded views can add a visible brush deliberately. */
export function qktInsideZoom(): QktChartOption["dataZoom"] {
  return [{ type: "inside", throttle: 50, zoomOnMouseWheel: "shift", moveOnMouseWheel: true }];
}

export function qktChartTooltip(): QktChartOption["tooltip"] {
  return {
    backgroundColor: "#191d21",
    borderColor: "#2f363e",
    borderWidth: 1,
    padding: [9, 11],
    extraCssText: "border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.35)",
    textStyle: { color: "#f2f4f6", fontFamily: "Archivo, system-ui, sans-serif", fontSize: 12 },
  };
}

export function EChart({ option, height = 260 }: { option: QktChartOption; height?: number | `${number}%` }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsInstance | null>(null);
  const latestOption = useRef(option);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    latestOption.current = option;
    chart.current?.setOption(option, true);
  }, [option]);

  useEffect(() => {
    if (!el.current) return;

    let disposed = false;
    let resize: ResizeObserver | null = null;

    loadECharts()
      .then((echarts) => {
        if (disposed || !el.current) return;
        chart.current = echarts.init(el.current, "dark", { renderer: "canvas" });
        chart.current.setOption(latestOption.current, true);
        resize = new ResizeObserver(() => chart.current?.resize());
        resize.observe(el.current);
      })
      .catch(() => {
        if (!disposed) setLoadError(true);
      });

    return () => {
      disposed = true;
      resize?.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  if (loadError) {
    return (
      <div className="flex items-center justify-center text-xs text-red-200" style={{ height, width: "100%" }}>
        Chart failed to load.
      </div>
    );
  }

  return <div ref={el} style={{ height, width: "100%", minHeight: typeof height === "string" ? 220 : undefined }} />;
}
