-- Write-time projections: tables the read paths answer from instead of rebuilding figures out of
-- the source tables on every request. Each is maintained from its sources as they change and can
-- be rebuilt from them at any time (projections.ts, `rebuild <projection>`).
--
-- projections: one row per projection with the reducer version it was built by. A version the
-- code does not match is rebuilt at open; `cursor` is the progress of a rebuild in batches, so an
-- interrupted one resumes where it stopped; `rebuilt_at` is set once it completed.
CREATE TABLE IF NOT EXISTS projections (
  name TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  cursor TEXT,
  rebuilt_at INTEGER
);

-- What changed since the projections were last brought up to date: one row per affected key,
-- written by the triggers below (so every writer, ingest or plain SQL, is covered) and drained by
-- refreshProjections in the writer's transaction, or by the next read.
CREATE TABLE IF NOT EXISTS projection_dirty (
  kind TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (kind, instance_id, key)
) WITHOUT ROWID;

-- The first-stored copy of each venue deal (see canonicalDeal): every broker profile polling one
-- account stores the account's deals, and only the first copy counts. Deals are never deleted, so
-- the flag set at insert stays right.
ALTER TABLE deals ADD COLUMN canonical INTEGER NOT NULL DEFAULT 1;
UPDATE deals SET canonical = 0
WHERE rowid <> (SELECT MIN(dd.rowid) FROM deals dd WHERE dd.instance_id=deals.instance_id AND dd.deal_ticket=deals.deal_ticket);

-- One row per canonical closing leg (OUT, INOUT, OUT_BY), paired with its position's first IN leg
-- exactly as dealClosedTrades describes. Keyed by the closing deal's rowid, which also orders
-- closes that share a timestamp the way the deals index did.
CREATE TABLE IF NOT EXISTS closed_trades (
  deal_rowid INTEGER PRIMARY KEY,
  instance_id TEXT NOT NULL,
  strategy_id TEXT,
  position_ticket TEXT,
  ts INTEGER NOT NULL,
  symbol TEXT,
  out_side TEXT,
  in_side TEXT,
  qty REAL,
  entry_price REAL,
  exit_price REAL,
  entry_ts INTEGER,
  realized REAL,
  entry_order_ticket TEXT,
  exit_order_ticket TEXT
);
CREATE INDEX IF NOT EXISTS idx_closed_trades_strategy ON closed_trades (instance_id, strategy_id, ts);
CREATE INDEX IF NOT EXISTS idx_closed_trades_ts ON closed_trades (instance_id, ts);
CREATE INDEX IF NOT EXISTS idx_closed_trades_position ON closed_trades (instance_id, position_ticket);

-- The time ranges in which a position counts as fully closed (fullyClosedPosition): from the
-- leg that closed it until the leg that reopened it (NULL: still closed).
CREATE TABLE IF NOT EXISTS position_closures (
  instance_id TEXT NOT NULL,
  position_ticket TEXT NOT NULL,
  from_ts INTEGER NOT NULL,
  until_ts INTEGER,
  PRIMARY KEY (instance_id, position_ticket, from_ts)
) WITHOUT ROWID;

-- New deals are found by rowid, not by an insert trigger (one fires even for an ignored
-- redelivery, the commonest deal write): refreshProjections sets the canonical flag and queues the
-- positions of rows past the watermark. A deleted row lowers it so a reused rowid is seen again.
CREATE TABLE IF NOT EXISTS projection_watermarks (
  source TEXT PRIMARY KEY,
  last_rowid INTEGER NOT NULL
);
INSERT OR IGNORE INTO projection_watermarks (source, last_rowid) SELECT 'deals', COALESCE(MAX(rowid), 0) FROM deals;

-- Trigger inserts skip keys already queued with NOT EXISTS rather than OR IGNORE: inside a trigger
-- the outer statement's conflict policy (an upsert's, say) replaces the trigger's own.
CREATE TRIGGER IF NOT EXISTS deals_projection_update
AFTER UPDATE OF instance_id, deal_ticket, position_ticket, order_ticket, symbol, side, entry, qty, price, profit,
  commission, swap, fee, strategy_id, ts ON deals BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT q.kind, q.instance_id, q.key FROM (
    SELECT 'position' kind, OLD.instance_id instance_id, COALESCE('p:' || OLD.position_ticket, 'd:' || OLD.rowid) key
    UNION SELECT 'position', NEW.instance_id, COALESCE('p:' || NEW.position_ticket, 'd:' || NEW.rowid)
    UNION SELECT 'ticket', OLD.instance_id, OLD.deal_ticket WHERE OLD.deal_ticket IS NOT NEW.deal_ticket OR OLD.instance_id IS NOT NEW.instance_id
    UNION SELECT 'ticket', NEW.instance_id, NEW.deal_ticket WHERE OLD.deal_ticket IS NOT NEW.deal_ticket OR OLD.instance_id IS NOT NEW.instance_id
  ) q
  WHERE NOT EXISTS (SELECT 1 FROM projection_dirty d WHERE d.kind=q.kind AND d.instance_id=q.instance_id AND d.key=q.key);
END;

CREATE TRIGGER IF NOT EXISTS deals_projection_delete AFTER DELETE ON deals BEGIN
  UPDATE projection_watermarks SET last_rowid = min(last_rowid, OLD.rowid - 1) WHERE source='deals';
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT q.kind, q.instance_id, q.key FROM (
    SELECT 'position' kind, OLD.instance_id instance_id, COALESCE('p:' || OLD.position_ticket, 'd:' || OLD.rowid) key
    UNION SELECT 'ticket', OLD.instance_id, OLD.deal_ticket
  ) q
  WHERE NOT EXISTS (SELECT 1 FROM projection_dirty d WHERE d.kind=q.kind AND d.instance_id=q.instance_id AND d.key=q.key);
END;

INSERT OR IGNORE INTO projections (name, version) VALUES ('closed_trades', 0);
