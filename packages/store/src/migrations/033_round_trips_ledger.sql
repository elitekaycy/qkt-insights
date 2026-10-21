-- Round trips of an instance without broker deals (paper, or an engine that polls none) come from
-- its engine ledger: one row per trade.closed close (trade_closes), keyed by the close id.
--   source: 'deal' (a venue position, from its deals) or 'ledger' (one engine close). A ledger row
--   has no entry price, stop or cost split: realized is the engine's net and gross equals it.
-- An instance's ledger rows are dropped once its first deal is stored (closedTrades.ts takeNewDeals).
ALTER TABLE round_trips ADD COLUMN source TEXT NOT NULL DEFAULT 'deal';

CREATE TRIGGER IF NOT EXISTS trade_closes_round_trip_insert AFTER INSERT ON trade_closes BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT 'position', NEW.instance_id, 'l:' || NEW.id
  WHERE NOT EXISTS (SELECT 1 FROM projection_dirty d WHERE d.kind='position' AND d.instance_id=NEW.instance_id AND d.key='l:' || NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS trade_closes_round_trip_update AFTER UPDATE ON trade_closes BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT 'position', q.instance_id, q.key FROM (
    SELECT OLD.instance_id instance_id, 'l:' || OLD.id key UNION SELECT NEW.instance_id, 'l:' || NEW.id
  ) q
  WHERE NOT EXISTS (SELECT 1 FROM projection_dirty d WHERE d.kind='position' AND d.instance_id=q.instance_id AND d.key=q.key);
END;

CREATE TRIGGER IF NOT EXISTS trade_closes_round_trip_delete AFTER DELETE ON trade_closes BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT 'position', OLD.instance_id, 'l:' || OLD.id
  WHERE NOT EXISTS (SELECT 1 FROM projection_dirty d WHERE d.kind='position' AND d.instance_id=OLD.instance_id AND d.key='l:' || OLD.id);
END;
