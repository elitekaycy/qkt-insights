import { duration, signedMoney, toneClass } from "../format";
import type { PositionPath } from "./data";
import { px, rMultiple } from "./format";
import { planFigures, stopStyleWords, type Distance, type PlanFigures } from "./tradePlan";

/*
 * The plan under the position map: one bar from the stop to the target with the entry, the best mark and the price
 * now (or the exit) on it, the two levels with what each pays, and one quiet line of what is left or how it ended.
 * Nothing is drawn that the trade did not state: no stop and no target is one sentence, not an empty bar.
 */

const pctText = (v: number) => `${v < 0.01 ? "<0.01" : v.toFixed(2)}%`;

export function PlanStrip({ path, digits, realized }: { path: PositionPath; digits: number; realized: number | null }) {
  const f = planFigures(path, realized);
  if (!f) return null;
  const notes = planNotes(f, digits);
  if (f.stop == null && f.target == null && f.initialStop == null) {
    return (
      <div className="rounded-lg border border-line px-3 py-2.5 text-xs text-muted" aria-label="Trade plan">
        No stop or target on record for this trade.
        {notes.length > 0 && <span> {notes.join(" · ")}.</span>}
      </div>
    );
  }
  const risk = f.riskMoney;
  const rOf = (money: number | null) => (money != null && risk != null && risk < 0 ? money / -risk : null);
  return (
    <div className="rounded-lg border border-line px-3 pb-2.5 pt-3" aria-label="Trade plan">
      <div className="flex items-start justify-between gap-3 text-xs">
        <Level side="left" label={f.stop != null && f.initialStop != null && f.stop !== f.initialStop ? "Stop now" : "Stop"} price={f.stop ?? f.initialStop} digits={digits}
          money={f.stopMoney} r={rOf(f.stopMoney)} />
        {f.target != null ? (
          <Level side="right" label="Target" price={f.target} digits={digits} money={f.rewardMoney} r={f.rewardRisk} />
        ) : (
          <div className="text-right text-muted">
            <div>No target</div>
            <div className="mt-0.5">{f.placeholderTarget != null ? "exits on its own signal" : "exits on signal or stop"}</div>
          </div>
        )}
      </div>
      {f.scale && <Bar f={f} />}
      <p className="mt-2 text-xs leading-5 text-muted">{summary(f, digits)}</p>
      {notes.length > 0 && <p className="text-xs leading-5 text-muted">{notes.join(" · ")}</p>}
    </div>
  );
}

function Level({ side, label, price, digits, money, r }: { side: "left" | "right"; label: string; price: number | null; digits: number; money: number | null; r: number | null }) {
  return (
    <div className={side === "right" ? "text-right" : ""}>
      <div className="text-muted">{label} <span className="tabular-nums text-bright">{px(price, digits)}</span></div>
      {money != null && (
        <div className={`mt-0.5 tabular-nums ${toneClass(money)}`}>
          {signedMoney(money)}{r != null && <span className="ml-1.5 text-muted">{rMultiple(r)}</span>}
        </div>
      )}
    </div>
  );
}

/** The stop → target bar: the loss side tinted to the entry, the move from the entry filled, the price as a dot. */
function Bar({ f }: { f: PlanFigures }) {
  const s = f.scale!;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const e = clamp(s.entry), a = s.at != null ? clamp(s.at) : null, b = s.best != null ? clamp(s.best) : null;
  const pctOf = (v: number) => `${(v * 100).toFixed(2)}%`;
  const fillFrom = a == null ? e : Math.min(e, a), fillTo = a == null ? e : Math.max(e, a);
  const gain = a != null && a >= e;
  // a trailed stop sits inside the bar
  const trailed = f.stop != null && f.initialStop != null && f.stop !== f.initialStop && f.target != null
    ? clamp((f.stop - f.initialStop) / (f.target - f.initialStop)) : null;
  const where = a == null ? null : Math.round(a * 100);
  return (
    <div className="relative mt-3 h-4" role="img" aria-label={`Price ${where == null ? "unknown" : `${where}% of the way from the stop to the target`}; entry at ${Math.round(e * 100)}%`}>
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-well" />
      <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-l-full bg-loss-fill/15" style={{ left: 0, width: pctOf(e) }} />
      {a != null && fillTo > fillFrom && (
        <div className={`absolute top-1/2 h-1.5 -translate-y-1/2 ${gain ? "bg-gain-fill/70" : "bg-loss-fill/70"}`} style={{ left: pctOf(fillFrom), width: pctOf(fillTo - fillFrom) }} />
      )}
      {trailed != null && <span aria-hidden className="absolute top-0 h-4 w-px bg-loss-fill" style={{ left: pctOf(trailed) }} title="the stop now" />}
      {b != null && b > e && <span aria-hidden className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-gain-fill" style={{ left: pctOf(b) }} title="the best mark" />}
      <span aria-hidden className="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-hi" style={{ left: pctOf(e) }} title="entry" />
      {a != null && (
        <span aria-hidden className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 border-2 border-panel bg-bright ${f.at?.kind === "exit" ? "rounded-[2px]" : "rounded-full"}`} style={{ left: pctOf(a) }} />
      )}
    </div>
  );
}

const room = (d: Distance, digits: number) => `${px(Math.abs(d.points), digits)} (${pctText(d.pct)})`;

/** One line: what is left (open) or where it ended against the plan (closed). */
function summary(f: PlanFigures, digits: number): string {
  const parts: string[] = [];
  const way = f.scale?.at != null ? Math.round(f.scale.at * 100) : null;
  if (f.at?.kind === "now") {
    if (f.toStop) parts.push(f.toStop.points > 0 ? `${room(f.toStop, digits)} ${f.side === "long" ? "above" : "below"} the stop` : "past the stop");
    if (f.toTarget) parts.push(f.toTarget.points > 0 ? `${room(f.toTarget, digits)} to the target` : "past the target");
    if (way != null && f.toTarget && f.toTarget.points > 0 && way >= 0) parts.push(`${way}% of the way`);
  } else if (f.at?.kind === "exit") {
    if (way != null) parts.push(way >= 100 ? "exited at the target" : way <= 0 ? "exited at the stop" : `exited ${way}% of the way to the target`);
    if (f.bestToTarget && (way == null || way < 100)) parts.push(f.bestToTarget.points <= 0 ? "the best mark reached the target" : `best came within ${px(f.bestToTarget.points, digits)} (${pctText(f.bestToTarget.pct)}) of it`);
    if (f.kept != null) parts.push(`kept ${Math.round(f.kept * 100)}% of the best`);
  }
  if (parts.length === 0 && f.rewardRisk != null) parts.push(`reward ${f.rewardRisk.toFixed(1)}× the risk`);
  return parts.length > 0 ? capitalize(parts.join(" · ")) : "";
}

/** How the levels behave and where they come from, only when it is not the plain case. */
function planNotes(f: PlanFigures, digits: number): string[] {
  const out: string[] = [];
  const style = stopStyleWords(f.stopStyle, (v) => px(v, digits), duration);
  if (style) out.push(style);
  if (f.stopMoves > 0) out.push(`the venue moved the stop ${f.stopMoves} time${f.stopMoves === 1 ? "" : "s"}`);
  else if (f.stopStyle && f.stopStyle.kind !== "fixed" && f.levelSource !== "venue") out.push("its moves are drawn as the venue reports them");
  if (f.placeholderTarget != null) out.push(`target ${px(f.placeholderTarget, digits)} is a placeholder, far beyond reach`);
  if (f.levelSource === "venue") out.push("levels from the venue: no engine order is linked to this trade");
  return out;
}

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
