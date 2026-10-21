-- Sampled excursion of each closed trade: the lowest and highest marked P&L of its position inside
-- the trade's held window (entry to this close), and how many marks fell in it. One row per
-- closed_trades row that has an entry and a position ticket. A new mark updates the rows whose
-- window holds it (O(1) per valuation); a removed mark queues its ticket for a recompute.
CREATE TABLE IF NOT EXISTS position_excursions (
  deal_rowid INTEGER PRIMARY KEY,
  instance_id TEXT NOT NULL,
  ticket TEXT NOT NULL,
  strategy_id TEXT,
  lo INTEGER NOT NULL,
  hi INTEGER NOT NULL,
  lowest REAL,
  highest REAL,
  marks INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_position_excursions_ticket ON position_excursions (instance_id, ticket, lo);

CREATE TRIGGER IF NOT EXISTS position_valuations_excursion_insert AFTER INSERT ON position_valuations WHEN NEW.profit IS NOT NULL BEGIN
  UPDATE position_excursions SET
    lowest = CASE WHEN lowest IS NULL OR NEW.profit < lowest THEN NEW.profit ELSE lowest END,
    highest = CASE WHEN highest IS NULL OR NEW.profit > highest THEN NEW.profit ELSE highest END,
    marks = marks + 1
  WHERE instance_id=NEW.instance_id AND ticket=NEW.ticket AND lo<=NEW.ts AND hi>=NEW.ts
    AND (strategy_id=NEW.strategy_id OR NEW.strategy_id IS NULL);
END;

CREATE TRIGGER IF NOT EXISTS position_valuations_excursion_delete AFTER DELETE ON position_valuations WHEN OLD.profit IS NOT NULL BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT 'excursion', OLD.instance_id, OLD.ticket
  WHERE EXISTS (SELECT 1 FROM position_excursions pe WHERE pe.instance_id=OLD.instance_id AND pe.ticket=OLD.ticket AND pe.lo<=OLD.ts AND pe.hi>=OLD.ts)
    AND NOT EXISTS (SELECT 1 FROM projection_dirty d WHERE d.kind='excursion' AND d.instance_id=OLD.instance_id AND d.key=OLD.ticket);
END;

CREATE TRIGGER IF NOT EXISTS position_valuations_excursion_update AFTER UPDATE ON position_valuations BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT 'excursion', q.instance_id, q.ticket FROM (
    SELECT OLD.instance_id instance_id, OLD.ticket ticket UNION SELECT NEW.instance_id, NEW.ticket
  ) q
  WHERE NOT EXISTS (SELECT 1 FROM projection_dirty d WHERE d.kind='excursion' AND d.instance_id=q.instance_id AND d.key=q.ticket);
END;

INSERT OR IGNORE INTO projections (name, version) VALUES ('position_excursions', 0);
