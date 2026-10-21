-- Indexes the read paths plan with:
-- logs (instance_id, ts): the instance's newest log lines without sorting every retained line.
-- position_valuations (instance_id, ts): marks around one moment (openPositionsAt) without
--   walking every mark of the instance.
-- position_valuations (instance_id, ticket, ts, strategy_id, profit): replaces the ticket index;
--   covers the excursion read, so it never touches the table.
-- account_equity (instance_id, minute_ts, broker): the account series in time order across
--   labels (the primary key leads with the label), and its newest minute in one seek.
CREATE INDEX IF NOT EXISTS idx_logs_instance_ts ON logs (instance_id, ts);
CREATE INDEX IF NOT EXISTS idx_position_valuations_instance_ts ON position_valuations (instance_id, ts);
CREATE INDEX IF NOT EXISTS idx_position_valuations_marks ON position_valuations (instance_id, ticket, ts, strategy_id, profit);
DROP INDEX IF EXISTS idx_position_valuations_ticket;
CREATE INDEX IF NOT EXISTS idx_account_equity_minute ON account_equity (instance_id, minute_ts, broker);
