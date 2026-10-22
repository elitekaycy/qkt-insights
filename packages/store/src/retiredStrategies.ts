import type { Db } from "./db.js";
import { statement } from "./statements.js";
import { bumpStrategy } from "./versions.js";

/*
 * Deals of strategies that no longer run. qkt attributes a venue deal to the strategies it runs now
 * (by order, ticket, or its order comment against that list), so a deal re-sent from history whose
 * strategy has since been retired comes with `attribution: "none"`. Its opening deal still carries
 * the order comment qkt wrote, `dsl-<strategy>--<sequence>`, which names that strategy exactly.
 */

/**
 * The strategy a complete qkt order comment names: `dsl-<strategy>--<sequence>` up to its `--`, e.g.
 * "dsl-gold_ema_pullback--86" -> "gold_ema_pullback". The venue may cut the sequence (MT5 keeps 29
 * characters), which leaves the name whole; a comment cut inside the name has no `--` and names
 * nothing, so it is never guessed from.
 */
export function strategyFromOrderComment(comment: string | null): string | null {
  if (comment == null || !comment.startsWith("dsl-")) return null;
  const end = comment.indexOf("--", 4);
  return end > 4 ? comment.slice(4, end) : null;
}

/**
 * Gives every unattributed position whose opening deal names a strategy in a complete qkt order
 * comment to that strategy, with a strategies row so it lists as a retired strategy. Idempotent:
 * only rows without a strategy change. Returns how many deals took an owner.
 */
export function attributeRetiredStrategies(db: Db): number {
  const named = statement(db,
    `SELECT instance_id i, position_ticket p, comment c FROM deals
     WHERE strategy_id IS NULL AND position_ticket IS NOT NULL AND comment LIKE 'dsl-%--%'
       AND NOT EXISTS (SELECT 1 FROM deals o WHERE o.instance_id = deals.instance_id
                         AND o.position_ticket = deals.position_ticket AND o.strategy_id IS NOT NULL)
     GROUP BY instance_id, position_ticket`,
  ).all() as Array<{ i: string; p: string; c: string }>;
  const adopt = statement(db, "UPDATE deals SET strategy_id=@s WHERE instance_id=@i AND position_ticket=@p AND strategy_id IS NULL");
  const span = statement(db, "SELECT min(ts) first, max(ts) last FROM deals WHERE instance_id=@i AND strategy_id=@s");
  const register = statement(db,
    `INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen) VALUES (@i,@s,@first,@last)
     ON CONFLICT(instance_id,strategy_id) DO UPDATE SET first_seen=min(first_seen,@first), last_seen=max(last_seen,@last)`,
  );
  let changed = 0;
  db.transaction(() => {
    const touched = new Set<string>();
    for (const r of named) {
      const s = strategyFromOrderComment(r.c);
      if (s == null) continue;
      changed += adopt.run({ s, i: r.i, p: r.p }).changes;
      touched.add(JSON.stringify([r.i, s]));
    }
    for (const key of touched) {
      const [i, s] = JSON.parse(key) as [string, string];
      const { first, last } = span.get({ i, s }) as { first: number; last: number };
      register.run({ i, s, first, last });
      bumpStrategy(db, i, s);
    }
  })();
  return changed;
}
