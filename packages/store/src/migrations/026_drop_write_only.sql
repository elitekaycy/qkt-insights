-- Write-only storage no reader ever used. ingest_observations held one row per duplicate delivery
-- for an ack qkt never reads; portfolio_exposure folded a type qkt does not emit; the two indexes
-- are a prefix of idx_deals_position_ts and an index no query plans with.
-- The *_decimal columns stay (dropping a column rewrites its table at boot); nothing writes them.
DROP TABLE IF EXISTS ingest_observations;
DROP TABLE IF EXISTS portfolio_exposure;
DROP INDEX IF EXISTS idx_deals_position;
DROP INDEX IF EXISTS idx_position_valuations_lookup;
