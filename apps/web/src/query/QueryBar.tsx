import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { parseQuery, withoutChip, withoutKeys, type QueryContext, type QueryKey } from "@qkt-insights/contract/query";
import { suggest, type SuggestData } from "./suggest";
import { Icon } from "../components/ui";

/*
 * The search bar of Trades, a strategy's trades, the calendar drill and Logs, after the
 * backtester journal's: one box, every active filter a removable chip inside it, completions
 * from the data, a specific message for a word it cannot read, and the same filters as buttons
 * for people who would rather click. The query is plain text in the URL (`q`), so it survives a
 * reload, a shared link and a move to another page.
 */

export interface Preset {
  label: string;
  key: QueryKey;
  /** [button label, token] pairs; a null token clears the key. */
  options: Array<[string, string | null]>;
}

export const TRADE_PRESETS: Preset[] = [
  { label: "Side", key: "side", options: [["All", null], ["Long", "side:long"], ["Short", "side:short"]] },
  { label: "Outcome", key: "outcome", options: [["All", null], ["Wins", "win"], ["Losses", "loss"], ["Open", "open"]] },
  { label: "Ended by", key: "ended", options: [["Any", null], ["Stop", "ended:stop"], ["Target", "ended:tp"], ["Signal", "ended:signal"]] },
  { label: "R", key: "r", options: [["Any", null], ["< 0R", "r:<0"], ["≥ 1R", "r:>=1"], ["≥ 2R", "r:>=2"]] },
  { label: "Held", key: "held", options: [["Any", null], ["< 1h", "held:<1h"], ["1–4h", "held:1h..4h"], ["4–24h", "held:4h..24h"], ["≥ 1d", "held:>=1d"]] },
];

export const LOG_PRESETS: Preset[] = [
  { label: "Level", key: "level", options: [["Any", null], ["Error", "level:error"], ["Warn", "level:warn"], ["Info", "level:info"], ["Debug", "level:debug"]] },
  { label: "Written", key: "time", options: [["Any time", null], ["1h", "time:1h"], ["Today", "time:today"], ["24h", "time:24h"], ["7 days", "time:7d"]] },
];

const SEARCH = "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35";
const FILTER = "M22 3H2l8 9.46V19l4 2v-8.54z";
const X = "M18 6L6 18M6 6l12 12";

function Kbd({ children }: { children: ReactNode }) {
  return <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-strong bg-raised px-1 font-mono text-[10px] text-body">{children}</span>;
}

/**
 * A phone's search button for a page's query bar: `toggle` opens the box (rendered before focusing, inside the tap,
 * so a phone raises its keyboard) or closes it; `box` goes on the box's wrapper.
 */
export function useSearchToggle() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toggle = () => {
    if (open) return setOpen(false);
    flushSync(() => setOpen(true));
    box.current?.querySelector("input")?.focus();
  };
  return { open, box, toggle };
}

/** True when a keystroke belongs to a field the viewer is typing in. */
function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

export function QueryBar({
  value,
  onChange,
  keys,
  data,
  page,
  presets = [],
  placeholder,
  errors: serverErrors = [],
  trailing,
}: {
  /** The applied query (canonical text, as in the URL). */
  value: string;
  onChange: (q: string) => void;
  /** The keys this page applies; others stay as chips but say the page ignores them. */
  keys: ReadonlySet<QueryKey>;
  data: Omit<SuggestData, "keys" | "active">;
  /** The page's name for "Logs ignores pnl:". */
  page: string;
  presets?: Preset[];
  placeholder?: string;
  /** What the server could not read in the applied query. */
  errors?: string[];
  /** Range chips and the count, on the bar's line; they wrap under it, the count first, when the line is full. */
  trailing?: ReactNode;
}) {
  const ctx: QueryContext = useMemo(() => ({ strategies: data.strategies, instruments: data.instruments }), [data.strategies, data.instruments]);
  const parsed = useMemo(() => parseQuery(value, ctx), [value, ctx]);
  const [text, setText] = useState("");
  const [focus, setFocus] = useState(false);
  const [sel, setSel] = useState(-1);
  const [errors, setErrors] = useState<string[]>([]);
  const [panel, setPanel] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();

  const sugg = useMemo(() => suggest(text, { ...data, keys, active: value }), [text, data, keys, value]);
  const open = focus && sugg.length > 0;
  const shownErrors = [...new Set([...errors, ...parsed.errors, ...serverErrors])];

  // "/" puts the cursor in the bar from anywhere on the page
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Adds the typed line: valid words become chips, the rest stays in the box with its message. */
  const apply = (line: string): boolean => {
    const r = parseQuery(line, ctx);
    if (r.chips.length) onChange(parseQuery(`${value} ${r.canonical}`, ctx).canonical);
    setErrors(r.errors);
    setText(r.tokens.filter((t) => t.error).map((t) => t.raw).join(" "));
    setSel(-1);
    return r.errors.length === 0;
  };
  const accept = (i: number) => {
    const s = sugg[i];
    if (!s) return;
    const before = text.replace(/\S*$/, "");
    if (s.text.endsWith(":") || s.text === "#") {
      setText(before + s.text);
      setSel(-1);
      return;
    }
    if (before.trim()) apply(`${before} ${s.text}`);
    else {
      onChange(parseQuery(`${value} ${s.text}`, ctx).canonical);
      setText("");
      setErrors([]);
      setSel(-1);
    }
  };
  const clearAll = () => {
    onChange("");
    setText("");
    setErrors([]);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => (sugg.length ? (i + 1) % sugg.length : -1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => (sugg.length ? (i <= 0 ? sugg.length - 1 : i - 1) : -1));
    } else if (e.key === "Tab" && open && text.trim()) {
      e.preventDefault();
      accept(sel >= 0 ? sel : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && sel >= 0) accept(sel);
      else if (text.trim()) apply(text);
    } else if (e.key === "Backspace" && !text && parsed.chips.length) {
      onChange(withoutChip(value, parsed.chips[parsed.chips.length - 1]!.text!, ctx));
    } else if (e.key === "Escape") {
      e.stopPropagation();
      if (open && sel >= 0) setSel(-1);
      else if (text || errors.length) {
        setText("");
        setErrors([]);
      } else if (value) clearAll();
      else input.current?.blur();
    }
  };
  const onType = (v: string) => {
    setSel(-1);
    setFocus(true);
    // a space after complete words commits them, like a chip field
    if (/\s$/.test(v) && v.trim()) {
      const r = parseQuery(v, ctx);
      if (!r.errors.length && r.chips.length) {
        onChange(parseQuery(`${value} ${r.canonical}`, ctx).canonical);
        setText("");
        setErrors([]);
        return;
      }
    }
    setText(v);
    if (errors.length) setErrors([]);
  };

  const presetValue = (p: Preset) => parsed.chips.find((c) => c.key === p.key)?.text ?? null;
  const setPreset = (p: Preset, token: string | null) => {
    const rest = withoutKeys(value, [p.key], ctx);
    onChange(token ? parseQuery(`${rest} ${token}`, ctx).canonical : rest);
  };
  const activePresets = presets.filter((p) => presetValue(p) != null).length;

  return (
    <div className="relative flex w-full min-w-0 flex-wrap items-center gap-2" role="search" aria-label={`Search and filter ${page.toLowerCase()}`}>
      <div
        ref={box}
        className={`relative flex min-h-[34px] min-w-0 flex-1 basis-[18rem] flex-wrap items-center gap-1.5 rounded-lg border bg-panel py-1 pl-3 pr-2 transition ${
          shownErrors.length ? "border-danger/70" : focus ? "border-accent-hi ring-3 ring-accent-soft" : "border-ctl hover:border-muted"
        }`}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          if (e.target !== input.current) {
            e.preventDefault();
            input.current?.focus();
          }
        }}
      >
        <Icon d={SEARCH} className="h-[15px] w-[15px] text-muted" />
        {parsed.chips.map((c) => {
          const ignored = c.key != null && !keys.has(c.key);
          return (
            <span
              key={c.text}
              title={ignored ? `${page} ignores ${c.key === "text" ? "free text" : `${c.key}:`}; it applies on other pages` : c.label}
              className={`inline-flex h-6 max-w-full items-center gap-0.5 rounded-md border pl-2 pr-0.5 font-mono text-xs [font-variant-ligatures:none] ${
                ignored ? "border-dashed border-line-strong bg-transparent text-faint line-through decoration-faint/60" : "border-accent-hi/40 bg-accent-soft text-accent-ink"
              }`}
            >
              <span className="truncate">{c.text}</span>
              <button
                type="button"
                aria-label={`Remove filter ${c.text}`}
                onClick={() => {
                  onChange(withoutChip(value, c.text!, ctx));
                  input.current?.focus();
                }}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-current opacity-70 transition hover:bg-hover hover:opacity-100"
              >
                <Icon d={X} className="h-3 w-3" />
              </button>
            </span>
          );
        })}
        <input
          ref={input}
          value={text}
          onChange={(e) => onType(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => setFocus(false), 120)}
          placeholder={parsed.chips.length ? "Add a filter…" : (placeholder ?? "Search or filter")}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          role="combobox"
          aria-label={`Search and filter ${page.toLowerCase()}`}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && sel >= 0 ? `${listId}-${sel}` : undefined}
          aria-invalid={shownErrors.length > 0}
          // the box draws the focus ring; the page's :focus-visible outline would draw a second one inside it
          style={{ outline: "none" }}
          className="h-6 min-w-[6rem] flex-1 bg-transparent text-sm text-bright placeholder:text-muted"
        />
        {!focus && !text && !parsed.chips.length && (
          <span className="hidden sm:inline-flex" aria-hidden>
            <Kbd>/</Kbd>
          </span>
        )}
        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Filter suggestions"
            onMouseDown={(e) => e.preventDefault()}
            className="pop-in absolute left-0 right-0 top-[calc(100%+4px)] z-40 overflow-hidden rounded-xl border border-line-strong bg-raised py-1 shadow-pop"
          >
            {sugg.map((s, i) => (
              <li
                key={s.text}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === sel}
                onMouseEnter={() => setSel(i)}
                onClick={() => {
                  accept(i);
                  input.current?.focus();
                }}
                ref={(el) => {
                  if (el && i === sel) el.scrollIntoView({ block: "nearest" });
                }}
                className={`grid cursor-pointer grid-cols-[minmax(0,11rem)_1fr] items-center gap-3 px-3 py-1.5 text-sm sm:grid-cols-[16rem_1fr_auto] ${i === sel ? "bg-hover" : ""}`}
              >
                <span className="truncate font-mono text-xs font-medium text-accent-ink [font-variant-ligatures:none]">{s.text}</span>
                <span className="min-w-0 truncate text-body">
                  {s.label}
                  {s.hint && <span className="text-muted"> · {s.hint}</span>}
                </span>
                <span className="eyebrow hidden !text-[10px] !text-faint sm:inline">{s.group}</span>
              </li>
            ))}
            <li aria-hidden className="mt-1 hidden items-center gap-1.5 border-t border-line px-3 pb-1 pt-2 text-[11px] text-muted sm:flex">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move <Kbd>Enter</Kbd> add <Kbd>Tab</Kbd> complete <Kbd>Esc</Kbd> close
            </li>
          </ul>
        )}
      </div>
      {presets.length > 0 && (
        <div className="relative">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={panel}
            onClick={() => setPanel((p) => !p)}
            className={`inline-flex h-[34px] items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition ${panel ? "border-accent-hi bg-accent-soft text-bright" : "border-ctl bg-raised text-bright hover:bg-well"}`}
          >
            <Icon d={FILTER} className="h-3.5 w-3.5" />
            Filters
            {activePresets > 0 && <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-on-accent">{activePresets}</span>}
          </button>
          {panel && <PresetPanel presets={presets} value={presetValue} onPick={setPreset} onClose={() => setPanel(false)} />}
        </div>
      )}
      {value && (
        <button type="button" onClick={clearAll} className="h-[34px] rounded-lg px-2.5 text-sm font-medium text-muted transition hover:bg-hover hover:text-bright">
          Clear all
        </button>
      )}
      {trailing}
      {shownErrors.length > 0 && (
        <div role="alert" className="basis-full text-xs text-loss">
          {shownErrors[0]}
          {shownErrors.length > 1 && <span className="text-muted"> (and {shownErrors.length - 1} more)</span>}
        </div>
      )}
    </div>
  );
}

/** The same filters as buttons; the hint teaches the text form. */
function PresetPanel({
  presets,
  value,
  onPick,
  onClose,
}: {
  presets: Preset[];
  value: (p: Preset) => string | null;
  onPick: (p: Preset, token: string | null) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest("[aria-haspopup=dialog]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const sample = presets.flatMap((p) => p.options.map(([, t]) => t).filter(Boolean).slice(0, 1)).join(" ");
  return (
    <div ref={ref} role="dialog" aria-label="Filters" className="pop-in absolute right-0 top-[calc(100%+6px)] z-40 w-[min(92vw,30rem)] rounded-xl border border-line-strong bg-raised p-4 shadow-pop">
      <div className="grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-2.5">
        {presets.map((p) => {
          const cur = value(p);
          return (
            <div key={p.key} className="contents">
              <span className="eyebrow">{p.label}</span>
              <div role="group" aria-label={p.label} className="flex flex-wrap gap-0.5 rounded-lg border border-line bg-panel p-0.5">
                {p.options.map(([label, token]) => {
                  const on = token === cur;
                  return (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={on}
                      onClick={() => onPick(p, token)}
                      className={`h-7 rounded-md px-2.5 text-xs font-medium transition ${on ? "bg-well text-bright" : "text-muted hover:text-bright"}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-muted">
        Or type in the search box: <span className="font-mono text-body [font-variant-ligatures:none]">{sample}</span>
      </p>
    </div>
  );
}
