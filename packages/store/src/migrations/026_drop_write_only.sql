-- Indexes no query plans with: a prefix of idx_deals_position_ts and an unused lookup index.
-- The write-only tables ingest_observations and portfolio_exposure stay for now, empty and unused:
-- the previous release still writes them, so dropping them here would break its ingest if a
-- collector is rolled back onto an upgraded database. Drop them once that release is no longer a
-- rollback target. The *_decimal columns stay too (dropping a column rewrites its table at boot).
DROP INDEX IF EXISTS idx_deals_position;
DROP INDEX IF EXISTS idx_position_valuations_lookup;
