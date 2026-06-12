CREATE INDEX IF NOT EXISTS idx_deals_position ON deals (instance_id, position_ticket);

-- Repair deals stored without a strategy. MT5 rewrites the close-leg comment when
-- SL/TP fires (e.g. "[tp 4332.689]"), so those legs can never be attributed from
-- their own comment; ingest now resolves new deals the same way these passes do.

-- Pass 1: a "dsl-<strategy>" comment names its strategy directly. Prefix-match in
-- both directions because MT5 truncates comments to 31 chars; only a unique match
-- across the instance's strategies wins. 'dsl-_%' requires at least one tag char.
UPDATE deals SET strategy_id = (
  SELECT s.strategy_id FROM strategies s
  WHERE s.instance_id = deals.instance_id
    AND (s.strategy_id LIKE substr(deals.comment, 5) || '%' OR substr(deals.comment, 5) LIKE s.strategy_id || '%')
)
WHERE strategy_id IS NULL AND comment LIKE 'dsl-_%'
  AND (
    SELECT COUNT(*) FROM strategies s
    WHERE s.instance_id = deals.instance_id
      AND (s.strategy_id LIKE substr(deals.comment, 5) || '%' OR substr(deals.comment, 5) LIKE s.strategy_id || '%')
  ) = 1;

-- Pass 2: every leg of a position belongs to the position's strategy; copy the
-- attribution from any attributed sibling. Runs after pass 1 so comment-repaired
-- IN legs propagate to their venue-closed OUT legs.
UPDATE deals SET strategy_id = (
  SELECT i.strategy_id FROM deals i
  WHERE i.instance_id = deals.instance_id AND i.position_ticket = deals.position_ticket
    AND i.strategy_id IS NOT NULL
  LIMIT 1
)
WHERE strategy_id IS NULL AND position_ticket IS NOT NULL;
