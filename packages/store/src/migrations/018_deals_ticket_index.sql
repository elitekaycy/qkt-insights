-- Every deals-based analytics query keeps ONE copy of a broker deal through the
-- correlated predicate  o.rowid = (SELECT MIN(rowid) FROM deals WHERE instance_id=? AND deal_ticket=?)
-- (analytics.ts canonicalDeal). Without an index on (instance_id, deal_ticket) that
-- subquery walks every deal of the instance once per candidate row: on bot1's
-- qkt-quant-live DB (4.8k deals) a single strategy's close count took 2.9 s and one
-- /performance request 7-54 s, long enough to starve /ingest and time the sink out.
-- With the index the same count takes 4 ms.
CREATE INDEX IF NOT EXISTS idx_deals_ticket ON deals (instance_id, deal_ticket);
