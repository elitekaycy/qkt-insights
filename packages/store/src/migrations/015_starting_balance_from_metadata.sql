-- Backfill starting_balance from the stored strategy.started provenance for rows that
-- never received a snapshot.equity (qkt retired that event).
UPDATE strategies
SET starting_balance = CAST(json_extract(metadata, '$.risk.startingBalance') AS REAL)
WHERE starting_balance IS NULL
  AND metadata IS NOT NULL
  AND json_extract(metadata, '$.risk.startingBalance') IS NOT NULL
  AND CAST(json_extract(metadata, '$.risk.startingBalance') AS REAL) > 0;
