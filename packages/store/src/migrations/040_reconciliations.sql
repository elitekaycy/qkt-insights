-- Venue reconciliation (reconciliation.ts): per venue account and complete UTC day, whether the
-- balance change between the snapshots around the day's two midnights equals the net of the
-- account's deals between them.
--   account: the account's key as the account views name it (the opaque venue id, else its label).
--   day: 'YYYY-MM-DD' (UTC). start_ts / end_ts: the minutes of the two balance snapshots compared
--   (the deals counted are those in (start_ts, end_ts]). deal_net: their profit + commission + swap
--   + fee; diff: the balance change minus deal_net. status: 'ok'; 'external' (the balance moved with
--   no deal in the window: a deposit, withdrawal or credit, which qkt does not send, or a deal
--   insights does not have); 'diff' (deals were stored and do not add up); 'incomplete'. reason says
--   why a day is not ok ('no-deals', 'deals-differ', 'no-prior-balance', 'no-balance').
-- Only new tables: a release without them boots, ingests and never reads them.
CREATE TABLE IF NOT EXISTS reconciliations (
  instance_id TEXT NOT NULL,
  account TEXT NOT NULL,
  day TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  start_ts INTEGER,
  end_ts INTEGER,
  start_balance REAL,
  end_balance REAL,
  deal_net REAL,
  diff REAL,
  deals INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, account, day)
) WITHOUT ROWID;
-- The days a run checks again, and the ones Health lists: everything not ok.
CREATE INDEX IF NOT EXISTS idx_reconciliations_open ON reconciliations (instance_id, account, day) WHERE status <> 'ok';

-- One row per venue account: the day counts, the day through which no checked day differs, and
-- the latest open-positions and ledger results (JSON), so Health reads one row per account.
CREATE TABLE IF NOT EXISTS reconciliation_accounts (
  instance_id TEXT NOT NULL,
  account TEXT NOT NULL,
  label TEXT NOT NULL,
  first_day TEXT,
  last_day TEXT,
  through_day TEXT,
  days_ok INTEGER NOT NULL,
  days_diff INTEGER NOT NULL,
  days_external INTEGER NOT NULL,
  days_incomplete INTEGER NOT NULL,
  positions TEXT NOT NULL,
  ledger TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, account)
) WITHOUT ROWID;

-- One row per instance: its latest run, and the canonical deals that run could give to no account
-- (unassigned_labels: JSON [{broker, deals}]), so they are reported rather than dropped.
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  instance_id TEXT PRIMARY KEY,
  checked_at INTEGER NOT NULL,
  unassigned_deals INTEGER NOT NULL,
  unassigned_labels TEXT NOT NULL
) WITHOUT ROWID;

-- The positions check reads an instance's open round trips.
CREATE INDEX IF NOT EXISTS idx_round_trips_open ON round_trips (instance_id) WHERE open = 1;
