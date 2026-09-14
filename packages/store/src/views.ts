import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

/** A repeat of the same page by the same visitor inside this window counts once. */
export const VIEW_DEDUPE_MS = 30 * 60_000;
export const VIEW_RETENTION_DAYS = 90;
/** Upper bound on stored views per shared subject per UTC day, so a flood cannot grow the table without limit. */
export const VIEW_DAILY_CAP = 20_000;

export interface ClientAgent { browser: string | null; os: string | null; device: "desktop" | "mobile" | "tablet" | null; bot: boolean }

const BOT_PATTERN = /bot|crawl|spider|slurp|preview|fetch|monitor|headless|lighthouse|curl|wget|python|java\/|go-http|axios|node-fetch|okhttp|facebookexternalhit|embedly|whatsapp|telegram/i;

/** Browser, system and device class from a user agent. Coarse on purpose: enough to group, too little to fingerprint. */
export function parseUserAgent(ua: string): ClientAgent {
  if (!ua || BOT_PATTERN.test(ua)) return { browser: null, os: null, device: null, bot: true };
  const browser =
    /Edg(e|A|iOS)?\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /SamsungBrowser\//.test(ua) ? "Samsung Internet"
    : /Firefox\/|FxiOS\//.test(ua) ? "Firefox"
    : /Chrome\/|CriOS\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Other";
  const os =
    /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "Other";
  const device = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? "tablet" : /Mobi|iPhone|iPod/.test(ua) ? "mobile" : "desktop";
  return { browser, os, device, bot: false };
}

export interface ViewInput {
  instanceId: string;
  kind: "overview" | "portfolio" | "strategy";
  subject: string;
  page: string;
  strategyId: string | null;
  ip: string;
  userAgent: string;
  country: string | null;
  referrer: string | null;
  language: string | null;
}

export interface ViewRow {
  ts: number; kind: string; subject: string; page: string; strategyId: string | null; visitor: string;
  browser: string | null; os: string | null; device: string | null; country: string | null; referrer: string | null; language: string | null;
}

export interface Breakdown { key: string | null; views: number }

export interface ViewSummary {
  views: number;
  visitors: number;
  links: Array<{ kind: string; subject: string; views: number; visitors: number }>;
  pages: Breakdown[];
  strategies: Breakdown[];
  browsers: Breakdown[];
  os: Breakdown[];
  devices: Breakdown[];
  countries: Breakdown[];
  referrers: Breakdown[];
  languages: Breakdown[];
  /** Per UTC day. Visitors are unique within a day only: ids do not survive the daily salt. */
  daily: Array<{ day: string; views: number; visitors: number }>;
}

interface Filter { instanceId: string; from: number; to: number; kind?: string; subject?: string }

const DAY_MS = 86_400_000;

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export class Views {
  constructor(private readonly db: Db) {}

  /** Records a view; false when it was a bot, a repeat inside the dedupe window, or over the daily cap. */
  record(input: ViewInput, now = Date.now()): boolean {
    const agent = parseUserAgent(input.userAgent);
    if (agent.bot) return false;
    const visitor = createHash("sha256").update(`${this.saltFor(now)}|${input.ip}|${input.userAgent}`).digest("hex").slice(0, 16);
    const repeat = this.db.prepare(
      `SELECT 1 FROM share_views WHERE visitor=? AND kind=? AND subject=? AND page=? AND COALESCE(strategy_id,'')=? AND ts>? LIMIT 1`,
    ).get(visitor, input.kind, input.subject, input.page, input.strategyId ?? "", now - VIEW_DEDUPE_MS);
    if (repeat) return false;
    const today = this.db.prepare(
      "SELECT COUNT(*) n FROM share_views WHERE instance_id=? AND kind=? AND subject=? AND ts>=?",
    ).get(input.instanceId, input.kind, input.subject, now - (now % DAY_MS)) as { n: number };
    if (today.n >= VIEW_DAILY_CAP) return false;
    this.db.prepare(
      `INSERT INTO share_views (ts, instance_id, kind, subject, page, strategy_id, visitor, browser, os, device, country, referrer, language)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(now, input.instanceId, input.kind, input.subject, input.page, input.strategyId, visitor, agent.browser, agent.os, agent.device, input.country, input.referrer, input.language);
    return true;
  }

  summary(f: Filter): ViewSummary {
    const cl = ["instance_id=@instanceId", "ts>=@from", "ts<@to"];
    if (f.kind != null) cl.push("kind=@kind");
    if (f.subject != null) cl.push("subject=@subject");
    const where = cl.join(" AND ");
    const params = { instanceId: f.instanceId, from: f.from, to: f.to, kind: f.kind, subject: f.subject };
    const totals = this.db.prepare(`SELECT COUNT(*) views, COUNT(DISTINCT visitor || substr(datetime(ts/1000,'unixepoch'),1,10)) visitors FROM share_views WHERE ${where}`).get(params) as { views: number; visitors: number };
    const by = (column: string): Breakdown[] =>
      this.db.prepare(`SELECT ${column} key, COUNT(*) views FROM share_views WHERE ${where} GROUP BY ${column} ORDER BY views DESC, key IS NULL, key ASC LIMIT 50`).all(params) as Breakdown[];
    return {
      views: totals.views,
      visitors: totals.visitors,
      links: this.db.prepare(
        `SELECT kind, subject, COUNT(*) views, COUNT(DISTINCT visitor || substr(datetime(ts/1000,'unixepoch'),1,10)) visitors
         FROM share_views WHERE ${where} GROUP BY kind, subject ORDER BY views DESC, kind ASC, subject ASC`,
      ).all(params) as ViewSummary["links"],
      pages: by("page"),
      strategies: by("strategy_id"),
      browsers: by("browser"),
      os: by("os"),
      devices: by("device"),
      countries: by("country"),
      referrers: by("referrer"),
      languages: by("language"),
      daily: this.db.prepare(
        `SELECT substr(datetime(ts/1000,'unixepoch'),1,10) day, COUNT(*) views, COUNT(DISTINCT visitor) visitors
         FROM share_views WHERE ${where} GROUP BY day ORDER BY day ASC`,
      ).all(params) as ViewSummary["daily"],
    };
  }

  list(f: { instanceId: string; limit: number; q?: string; kind?: string; subject?: string; before?: number }): ViewRow[] {
    const cl = ["instance_id=@instanceId"];
    if (f.before != null) cl.push("ts<@before");
    if (f.kind != null) cl.push("kind=@kind");
    if (f.subject != null) cl.push("subject=@subject");
    let like: string | undefined;
    if (f.q) {
      like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      cl.push(`(${["subject", "page", "strategy_id", "browser", "os", "device", "country", "referrer", "language"].map((c) => `COALESCE(${c},'') LIKE @like ESCAPE '\\'`).join(" OR ")})`);
    }
    return this.db.prepare(
      `SELECT ts, kind, subject, page, strategy_id strategyId, visitor, browser, os, device, country, referrer, language
       FROM share_views WHERE ${cl.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT @limit`,
    ).all({ instanceId: f.instanceId, before: f.before, kind: f.kind, subject: f.subject, like, limit: Math.min(Math.max(1, f.limit), 1000) }) as ViewRow[];
  }

  /** "kind:subject" -> views within the retention window. */
  countsBySubject(instanceId: string): Map<string, number> {
    const rows = this.db.prepare("SELECT kind || ':' || subject k, COUNT(*) n FROM share_views WHERE instance_id=? GROUP BY kind, subject").all(instanceId) as Array<{ k: string; n: number }>;
    return new Map(rows.map((r) => [r.k, r.n]));
  }

  /** Today's salt, created on first use; earlier days' salts are deleted so their visitor ids cannot be recomputed. */
  private saltFor(now: number): string {
    const day = utcDay(now);
    const row = this.db.prepare("SELECT salt FROM view_salts WHERE day=?").get(day) as { salt: string } | undefined;
    if (row) return row.salt;
    const salt = randomBytes(32).toString("hex");
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM view_salts WHERE day<>?").run(day);
      this.db.prepare("INSERT OR IGNORE INTO view_salts (day, salt) VALUES (?, ?)").run(day, salt);
    })();
    return (this.db.prepare("SELECT salt FROM view_salts WHERE day=?").get(day) as { salt: string }).salt;
  }
}
