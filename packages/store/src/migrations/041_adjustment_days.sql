-- Venue adjustments (broker.deal entry ADJUSTMENT: a stock CFD's dividend, a charge, a correction) are money in a
-- strategy's days and totals (strategyDaily.ts) but belong to no closed trade, so the closed_trades projection never
-- queues their days. A new one is queued as it is taken in (takeNewDeals); a changed or removed one by these
-- triggers, for its owner and day before and after, canonical copy changes included.
CREATE INDEX IF NOT EXISTS deals_adjustments ON deals (instance_id, strategy_id, ts) WHERE entry='ADJUSTMENT';

CREATE TRIGGER IF NOT EXISTS deals_adjustment_update AFTER UPDATE ON deals
WHEN OLD.entry='ADJUSTMENT' OR NEW.entry='ADJUSTMENT' BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT 'daily', q.instance_id, q.key FROM (
    SELECT OLD.instance_id instance_id, 'deal' || char(0) || OLD.strategy_id || char(0) || date(OLD.ts / 1000, 'unixepoch') key
     WHERE OLD.entry='ADJUSTMENT' AND OLD.strategy_id IS NOT NULL
    UNION SELECT NEW.instance_id, 'deal' || char(0) || NEW.strategy_id || char(0) || date(NEW.ts / 1000, 'unixepoch')
     WHERE NEW.entry='ADJUSTMENT' AND NEW.strategy_id IS NOT NULL
  ) q
  WHERE NOT EXISTS (SELECT 1 FROM projection_dirty d WHERE d.kind='daily' AND d.instance_id=q.instance_id AND d.key=q.key);
END;

CREATE TRIGGER IF NOT EXISTS deals_adjustment_delete AFTER DELETE ON deals
WHEN OLD.entry='ADJUSTMENT' AND OLD.strategy_id IS NOT NULL BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT 'daily', OLD.instance_id, k.key FROM (SELECT 'deal' || char(0) || OLD.strategy_id || char(0) || date(OLD.ts / 1000, 'unixepoch') key) k
  WHERE NOT EXISTS (SELECT 1 FROM projection_dirty d WHERE d.kind='daily' AND d.instance_id=OLD.instance_id AND d.key=k.key);
END;
