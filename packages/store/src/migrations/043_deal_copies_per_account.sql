-- A venue deal's copies are the rows with its ticket on the same account (closedTrades.ts SAME_DEAL), not every row
-- with its ticket: two accounts can number their deals alike (gateway paper accounts count paper-1, paper-2, ...),
-- and the second account's deal was stored as a copy of the first and left out of every figure. The rule only
-- narrows what a copy is, so a canonical row stays canonical; a row it frees becomes canonical and its position
-- is queued to be rebuilt.
INSERT OR IGNORE INTO projection_dirty (kind, instance_id, key)
SELECT 'position', n.instance_id, COALESCE('p:' || n.position_ticket, 'd:' || n.rowid) FROM deals n
WHERE n.canonical = 0 AND NOT EXISTS (
  SELECT 1 FROM deals d WHERE d.instance_id=n.instance_id AND d.deal_ticket=n.deal_ticket AND d.rowid<n.rowid
    AND (d.account_id IS NULL OR n.account_id IS NULL OR d.account_id=n.account_id));

UPDATE deals SET canonical = 1
WHERE canonical = 0 AND NOT EXISTS (
  SELECT 1 FROM deals d WHERE d.instance_id=deals.instance_id AND d.deal_ticket=deals.deal_ticket AND d.rowid<deals.rowid
    AND (d.account_id IS NULL OR deals.account_id IS NULL OR d.account_id=deals.account_id));
