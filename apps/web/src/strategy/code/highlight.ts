import { createHighlighterCore, type HighlighterCore, type ThemeRegistration } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import grammar from "./qkt.tmLanguage.json";

/*
 * qkt source highlighted with qkt's own TextMate grammar. qkt.tmLanguage.json is a copy of
 * qkt's editor/textmate/qkt.tmLanguage.json, which qkt generates from its parser
 * (`qkt editor grammar --format textmate`, src/main/kotlin/com/qkt/editor/GrammarGenerator.kt). To
 * refresh it after a DSL change, copy that file here unchanged; never edit the copy.
 *
 * Colours are theme tokens (index.css `--code-*`), so the code follows light and dark like the rest of
 * the app. The JavaScript regex engine needs no WebAssembly.
 */

/** One run of text with the colour and style its scope gets. */
export interface CodeToken {
  content: string;
  color?: string;
  /** Shiki's font style bits: 1 italic, 2 bold, 4 underline. */
  fontStyle?: number;
}

const role = (name: string) => `var(--code-${name})`;

/** Each grammar scope family to one of a few roles; keyword.other.action (BUY, SELL, CLOSE) stands out from the other keywords. */
export const QKT_THEME: ThemeRegistration = {
  name: "qkt-insights",
  type: "dark",
  fg: role("text"),
  bg: "transparent",
  settings: [
    { settings: { foreground: role("text") } },
    { scope: ["comment"], settings: { foreground: role("comment"), fontStyle: "italic" } },
    { scope: ["string"], settings: { foreground: role("string") } },
    { scope: ["constant.character.escape"], settings: { foreground: role("constant") } },
    { scope: ["constant"], settings: { foreground: role("constant") } },
    { scope: ["keyword.control"], settings: { foreground: role("keyword"), fontStyle: "bold" } },
    { scope: ["keyword.other"], settings: { foreground: role("modifier") } },
    { scope: ["keyword.other.action"], settings: { foreground: role("action"), fontStyle: "bold" } },
    { scope: ["keyword.operator"], settings: { foreground: role("operator") } },
    { scope: ["support.function"], settings: { foreground: role("function") } },
    { scope: ["variable.language", "support.variable.field"], settings: { foreground: role("field") } },
    { scope: ["variable.other.alias", "variable.other.member"], settings: { foreground: role("alias") } },
    { scope: ["entity.name.namespace"], settings: { foreground: role("namespace") } },
    { scope: ["invalid"], settings: { foreground: role("invalid") } },
  ],
};

let highlighter: Promise<HighlighterCore> | null = null;

function load(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [QKT_THEME],
    langs: [{ ...grammar, name: "qkt" } as never],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

/** `text` as lines of coloured tokens; a line that holds nothing is an empty array. */
export async function highlightQkt(text: string): Promise<CodeToken[][]> {
  const h = await load();
  return h.codeToTokensBase(text, { lang: "qkt", theme: QKT_THEME.name! }).map((line) =>
    line.map((t) => ({ content: t.content, color: t.color, fontStyle: t.fontStyle })),
  );
}
