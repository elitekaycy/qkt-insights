-- MT5 magic ranges whose venue deals and holdings an instance ignores (INSIGHTS_IGNORE_MAGICS): another
-- system's trades on an account the instance shares. Replaced wholesale at boot.
CREATE TABLE IF NOT EXISTS ignored_magic_ranges (
  instance_id TEXT NOT NULL,
  lo INTEGER NOT NULL,
  hi INTEGER NOT NULL,
  CHECK (lo <= hi),
  PRIMARY KEY (instance_id, lo, hi)
) WITHOUT ROWID;

-- One row per venue deal an ignored range kept out of `deals`, the first copy of it taken in (every broker
-- profile on the account sends the same deal). Never in a strategy, round trip or account total: only in the
-- account's balance continuity check, since the deal moved the balance, and in the count the dashboard shows.
-- Net = profit + commission + swap + fee, as on deals.
CREATE TABLE IF NOT EXISTS ignored_deals (
  instance_id TEXT NOT NULL,
  deal_ticket TEXT NOT NULL,
  broker TEXT NOT NULL,
  account_id TEXT,
  magic INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  profit REAL,
  commission REAL,
  swap REAL,
  fee REAL,
  PRIMARY KEY (instance_id, deal_ticket)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_ignored_deals_ts ON ignored_deals (instance_id, ts);
