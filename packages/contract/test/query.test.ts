import { describe, it, expect } from "vitest";
import { parseQuery, parseToken, parseDuration, parseWindow, tokenize, withoutChip, withTokens, withoutKeys, foldInstrument } from "../src/query.js";

const H = 3_600_000, D = 86_400_000;
const NOW = Date.UTC(2026, 9, 21, 15, 30);
const CTX = { strategies: ["gold_ema_pullback", "gold_donchian_breakout", "eurusd_rsi_fade"], instruments: ["ICMARKETS:XAUUSD", "ICM_S05:XAUUSD", "EURUSD"], now: NOW };

const one = (raw: string) => parseQuery(raw, CTX);

describe("query tags", () => {
  it("strategy: exact, unique prefix, unattributed, unknown", () => {
    expect(one("strategy:gold_ema_pullback").filter.strategy).toBe("gold_ema_pullback");
    expect(one("strategy:EURUSD_RSI").filter.strategy).toBe("eurusd_rsi_fade");
    expect(one("strategy:eurusd").chips[0]!.text).toBe("strategy:eurusd_rsi_fade");
    expect(one("strategy:unattributed").filter.strategy).toBeNull();
    expect(one("strategy:none").chips[0]!.text).toBe("strategy:unattributed");
    // "gold" matches two strategies: the error names them
    expect(one("strategy:gold").errors[0]).toMatch(/no strategy "gold" here\. Try gold_ema_pullback, gold_donchian_breakout/);
    expect(one("strategy:silver").errors[0]).toMatch(/Try gold_ema_pullback/);
    // without a context the server takes the name as given
    expect(parseQuery("strategy:anything").filter.strategy).toBe("anything");
  });

  it("symbol: folds the broker-profile prefix and checks the instrument", () => {
    expect(one("symbol:xauusd").filter.symbol).toBe("XAUUSD");
    expect(one("symbol:ICM_S05:XAUUSD").filter.symbol).toBe("XAUUSD");
    expect(one("symbol:eur").filter.symbol).toBe("EURUSD");
    expect(one("symbol:BTCUSD").errors[0]).toMatch(/no instrument "BTCUSD" here\. Try/);
    expect(foldInstrument("ICMARKETS:xauusd")).toBe("XAUUSD");
  });

  it("side: long or short, with buy/sell aliases", () => {
    expect(one("side:long").filter.side).toBe("long");
    expect(one("side:sell").filter.side).toBe("short");
    expect(one("dir:short").chips[0]!.text).toBe("side:short");
    expect(one("side:up").errors).toEqual(['"side:up": side: long or short']);
  });

  it("pnl: comparisons, ranges and money shorthands", () => {
    expect(one("pnl:>50").filter.pnl).toEqual({ min: 50, minOpen: true });
    expect(one("pnl:<0").filter.pnl).toEqual({ max: 0, maxOpen: true });
    expect(one("pnl:>=1k").filter.pnl).toEqual({ min: 1000 });
    expect(one("pnl:<=-$20").filter.pnl).toEqual({ max: -20 });
    expect(one("pnl:-20..80").filter.pnl).toEqual({ min: -20, max: 80, maxOpen: false });
    expect(one("pnl:5").filter.pnl).toEqual({ min: 5, max: 5 });
    expect(one("pnl:lots").errors[0]).toMatch(/pnl: a money amount like >50/);
  });

  it("r: multiples of the initial risk", () => {
    expect(one("r:>=1").filter.r).toEqual({ min: 1 });
    expect(one("r:<0R").filter.r).toEqual({ max: 0, maxOpen: true });
    expect(one("r:-1..2").filter.r).toEqual({ min: -1, max: 2, maxOpen: false });
    expect(one("r:big").errors[0]).toMatch(/r: a multiple of the initial risk/);
  });

  it("held: durations, half-open ranges like the hold buckets", () => {
    expect(one("held:<1h").filter.held).toEqual({ max: H, maxOpen: true });
    expect(one("held:>=4h").filter.held).toEqual({ min: 4 * H });
    expect(one("held:1h..4h").filter.held).toEqual({ min: H, max: 4 * H, maxOpen: true });
    expect(one("held:1h30m").filter.held).toEqual({ min: 90 * 60_000, max: 90 * 60_000 });
    expect(one("held:long").errors[0]).toMatch(/held: a duration like <1h/);
    expect(parseDuration("2d")).toBe(2 * D);
    expect(parseDuration("1.5h")).toBe(1.5 * H);
    expect(parseDuration("soon")).toBeNull();
  });

  it("entry: and exit: UTC days, months, comparisons, spans and recent windows", () => {
    expect(one("entry:2026-10").filter.entry).toEqual({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1) });
    expect(one("exit:2026-10-21").filter.exit).toEqual({ from: Date.UTC(2026, 9, 21), to: Date.UTC(2026, 9, 22) });
    expect(one("exit:>=2026-10-15").filter.exit).toEqual({ from: Date.UTC(2026, 9, 15) });
    expect(one("exit:>2026-10-15").filter.exit).toEqual({ from: Date.UTC(2026, 9, 16) });
    expect(one("exit:<2026-10-01").filter.exit).toEqual({ to: Date.UTC(2026, 9, 1) });
    expect(one("entry:2026-10-01..2026-10-15").filter.entry).toEqual({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 16) });
    expect(one("exit:today").filter.exit).toEqual({ from: Date.UTC(2026, 9, 21), to: Date.UTC(2026, 9, 22) });
    expect(one("entry:7d").filter.entry).toEqual({ from: NOW - 7 * D });
    expect(one("exit:2026-02-31").errors[0]).toMatch(/exit: a UTC date or month/);
    // the backtester's exit:stop means how it ended; say so
    expect(one("exit:stop").errors[0]).toBe('"exit:stop": exit: takes a date. For how a trade ended use ended:stop');
    expect(parseWindow("yesterday", NOW)).toEqual({ from: Date.UTC(2026, 9, 20), to: Date.UTC(2026, 9, 21) });
  });

  it("ended: stop, tp, signal, venue or manual", () => {
    expect(one("ended:sl").filter.ended).toBe("stop");
    expect(one("ended:target").filter.ended).toBe("tp");
    expect(one("ended:signal").filter.ended).toBe("signal");
    expect(one("ended:stopout").filter.ended).toBe("venue");
    expect(one("ended:manual").filter.ended).toBe("manual");
    expect(one("ended:expiry").errors[0]).toMatch(/ended: stop, tp, signal, venue or manual/);
  });

  it("size: lot comparisons", () => {
    expect(one("size:>=0.5").filter.size).toEqual({ min: 0.5 });
    expect(one("qty:0.1..0.5").chips[0]!.text).toBe("size:0.1..0.5");
    expect(one("size:-1").errors[0]).toMatch(/size: lots like/);
  });

  it("#ticket and ticket:", () => {
    expect(one("#1000123456").filter.ticket).toBe("1000123456");
    expect(one("ticket:1000123456").chips[0]!.text).toBe("#1000123456");
    expect(one("#").errors[0]).toMatch(/ticket: needs a value/);
  });

  it("win / loss / open / closed / breakeven as bare words or outcome:", () => {
    expect(one("win").filter.outcome).toBe("win");
    expect(one("losers").filter.outcome).toBe("loss");
    expect(one("open").chips[0]!.text).toBe("open");
    expect(one("outcome:closed").filter.outcome).toBe("closed");
    expect(one("outcome:maybe").errors[0]).toMatch(/outcome: win, loss/);
  });

  it("level:, logger: and time: for Logs", () => {
    expect(one("level:error").filter.level).toBe("ERROR");
    expect(one("level:warning").chips[0]!.text).toBe("level:warn");
    expect(one("level:loud").errors[0]).toMatch(/level: error, warn, info or debug/);
    expect(one("logger:qkt.engine").filter.logger).toBe("qkt.engine");
    expect(one("time:1h").filter.time).toEqual({ from: NOW - H });
    expect(one("time:2026-10-20").filter.time).toEqual({ from: Date.UTC(2026, 9, 20), to: Date.UTC(2026, 9, 21) });
  });
});

describe("free text and bare words", () => {
  it("bare words name a filter when they can, else they are free text", () => {
    expect(one("long").filter.side).toBe("long");
    expect(one("stop").filter.ended).toBe("stop");
    expect(one("XAUUSD").filter.symbol).toBe("XAUUSD");
    expect(one("gold_ema_pullback").filter.strategy).toBe("gold_ema_pullback");
    expect(one("2026-10-21").filter.exit).toEqual({ from: Date.UTC(2026, 9, 21), to: Date.UTC(2026, 9, 22) });
    expect(one("rejected margin").filter.text).toEqual(["rejected", "margin"]);
    expect(one('"order rejected"').filter.text).toEqual(["order rejected"]);
    expect(one('"order rejected"').canonical).toBe('"order rejected"');
  });

  it("a broker-profile symbol is a symbol, an unknown key is a specific error", () => {
    expect(one("ICM_S05:XAUUSD").filter.symbol).toBe("XAUUSD");
    expect(one("colour:red").errors[0]).toMatch(/^Unknown filter "colour"\. Known: strategy:, symbol:/);
  });

  it("tokenize keeps quoted phrases and quoted values whole", () => {
    expect(tokenize('logger:"a b" "x y" z')).toEqual(['logger:"a b"', '"x y"', "z"]);
    expect(parseToken('logger:"qkt.engine"').text).toBe("logger:qkt.engine");
  });
});

describe("a whole line", () => {
  it("later tokens of a key replace earlier ones; free words accumulate", () => {
    const p = one("side:long pnl:>50 side:short foo pnl:<0 bar");
    expect(p.filter.side).toBe("short");
    expect(p.filter.pnl).toEqual({ max: 0, maxOpen: true });
    expect(p.filter.text).toEqual(["foo", "bar"]);
    expect(p.canonical).toBe("side:short foo pnl:<0 bar");
  });

  it("errors never block the valid tokens", () => {
    const p = one("side:short pnl:<0 held:forever");
    expect(p.filter).toMatchObject({ side: "short", pnl: { max: 0 } });
    expect(p.errors).toHaveLength(1);
    expect(p.canonical).toBe("side:short pnl:<0");
    expect(p.tokens).toHaveLength(3);
  });

  it("chips come with plain-word labels", () => {
    expect(one("held:<1h").chips[0]!.label).toBe("Held under 1h");
    expect(one("pnl:>=50").chips[0]!.label).toBe("P&L at least 50");
    expect(one("exit:2026-10-21").chips[0]!.label).toBe("Exited on 2026-10-21 (UTC)");
  });

  it("removes one chip, adds tokens, drops keys", () => {
    expect(withoutChip("side:short pnl:<0 foo", "pnl:<0", CTX)).toBe("side:short foo");
    expect(withTokens("side:short exit:2026-10-20", "exit:2026-10-21", CTX)).toBe("side:short exit:2026-10-21");
    expect(withoutKeys("side:short exit:2026-10-20 foo", ["exit"], CTX)).toBe("side:short foo");
  });

  it("an empty line is an empty filter", () => {
    expect(one("   ")).toMatchObject({ filter: { text: [] }, tokens: [], chips: [], errors: [], canonical: "" });
  });
});
