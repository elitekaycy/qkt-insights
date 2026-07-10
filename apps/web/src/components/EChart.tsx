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

export const qktChartGrid = { left: 58, right: 22, top: 34, bottom: 44 };

export const qktChartAxis = {
  axisLine: { lineStyle: { color: "#2f363e" } },
  axisTick: { show: false },
  axisLabel: { color: "#f2f4f6", fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 11 },
  nameTextStyle: { color: "#f2f4f6", fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 11 },
  splitLine: { lineStyle: { color: "#22272d", type: "dashed" as const } },
};

export function qktChartTooltip(): QktChartOption["tooltip"] {
  return {
    backgroundColor: "#191d21",
    borderColor: "#2f363e",
    borderWidth: 1,
    textStyle: { color: "#f2f4f6", fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 12 },
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
