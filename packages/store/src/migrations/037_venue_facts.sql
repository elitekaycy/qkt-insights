-- Facts qkt states on venue envelopes, stored beside the columns the projections read so a
-- round trip uses them in place of what was inferred from MT5 conventions (inferredVenueFacts.ts).
--   deals.account_id: the venue account (`mt5:<login>@<server>`, `vgp:<adapter>:<login>`).
--   deals.close_reason: why a closing deal closed (STOP, TAKE_PROFIT, SIGNAL, MANUAL, TIMED, STOP_OUT,
--     LIQUIDATION, EXPIRY). realized_source: who computed profit, 'venue' or 'engine'.
--   deals.attribution: how qkt knew the strategy ('order', 'position', 'comment', 'none').
--   deals.next_position_ticket: the position a reversing (INOUT) deal opened.
--   deals.tick_size / value_per_point: the instrument's price tick, and the account money one unit of
--     qty earns per point of price.
--   commission / swap / fee of a deal that sent typed costs[] are those costs, negative when paid.
ALTER TABLE deals ADD COLUMN account_id TEXT;
ALTER TABLE deals ADD COLUMN close_reason TEXT;
ALTER TABLE deals ADD COLUMN realized_source TEXT;
ALTER TABLE deals ADD COLUMN attribution TEXT;
ALTER TABLE deals ADD COLUMN next_position_ticket TEXT;
ALTER TABLE deals ADD COLUMN tick_size REAL;
ALTER TABLE deals ADD COLUMN value_per_point REAL;
-- Whether a broker label has deals: an engine close is a round trip only while neither its strategy
-- nor its broker has any (roundTrips.ts ledgerCovered).
CREATE INDEX IF NOT EXISTS idx_deals_broker ON deals (instance_id, broker);

-- round_trips.close_reason: the closing deal's (or engine close's) stated reason; risk_amount: the
-- entry's stated money at risk to its initial stop, in account currency.
ALTER TABLE round_trips ADD COLUMN close_reason TEXT;
ALTER TABLE round_trips ADD COLUMN risk_amount REAL;
ALTER TABLE trade_closes ADD COLUMN close_reason TEXT;

-- Account identities are qkt's account ids. Every identity stored before was an MT5 "login@server"
-- (only MT5 reported account state), which qkt names "mt5:login@server". The account projection is
-- rebuilt from these rows (its version moved), so the rewrite skips its change trigger.
DROP TRIGGER IF EXISTS account_equity_projection_update;
UPDATE account_equity SET account = 'mt5:' || account
  WHERE account IS NOT NULL AND account NOT LIKE 'mt5:%' AND account NOT LIKE 'vgp:%' AND account NOT LIKE 'paper:%';
CREATE TRIGGER IF NOT EXISTS account_equity_projection_update AFTER UPDATE ON account_equity BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT 'account', q.instance_id, q.key FROM (
    SELECT OLD.instance_id instance_id, OLD.broker || char(0) || OLD.minute_ts key
    UNION SELECT NEW.instance_id, NEW.broker || char(0) || NEW.minute_ts
  ) q
  WHERE NOT EXISTS (SELECT 1 FROM projection_dirty d WHERE d.kind='account' AND d.instance_id=q.instance_id AND d.key=q.key);
END;
