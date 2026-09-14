-- Pairing a close with its position's IN leg and first close orders by ts within one position.
-- Without ts in the position index the planner walks every deal of the instance per close
-- (idx_deals_lookup), which made closed-trade analytics quadratic in the deal count.
CREATE INDEX IF NOT EXISTS idx_deals_position_ts ON deals (instance_id, position_ticket, ts);
