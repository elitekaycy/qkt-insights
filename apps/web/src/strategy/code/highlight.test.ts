import { describe, expect, it } from "vitest";
import { highlightQkt } from "./highlight";

const SOURCE = `-- gold breakout
STRATEGY gold_breakout VERSION 1
SYMBOLS
    g = EXNESS:XAUUSD EVERY 1h
RULES
    WHEN g.close > ema(g.close, 20) AND POSITION.g IS NULL
    THEN BUY g SIZING RISK 1 PCT OF EQUITY STOP_LOSS 2.5 "note"
`;

function colourOf(lines: Awaited<ReturnType<typeof highlightQkt>>, text: string): string | undefined {
  for (const line of lines) for (const t of line) if (t.content.trim() === text) return t.color;
  return undefined;
}

describe("qkt highlighting", () => {
  it("colours qkt's own scopes with the app's code roles", async () => {
    const lines = await highlightQkt(SOURCE);
    expect(lines).toHaveLength(SOURCE.split("\n").length);
    expect(colourOf(lines, "-- gold breakout")).toBe("var(--code-comment)");
    expect(colourOf(lines, "STRATEGY")).toBe("var(--code-keyword)");
    expect(colourOf(lines, "WHEN")).toBe("var(--code-keyword)");
    expect(colourOf(lines, "BUY")).toBe("var(--code-action)");
    expect(colourOf(lines, "SIZING")).toBe("var(--code-modifier)");
    expect(colourOf(lines, "ema")).toBe("var(--code-function)");
    expect(colourOf(lines, "20")).toBe("var(--code-constant)");
    expect(colourOf(lines, "\"note\"")).toBe("var(--code-string)");
    expect(colourOf(lines, "close")).toBe("var(--code-field)");
    expect(colourOf(lines, "POSITION")).toBe("var(--code-field)");
    expect(colourOf(lines, "AND")).toBe("var(--code-operator)");
  });

  it("keeps every character of the text, line by line", async () => {
    const lines = await highlightQkt(SOURCE);
    expect(lines.map((l) => l.map((t) => t.content).join("")).join("\n")).toBe(SOURCE);
  });
});
