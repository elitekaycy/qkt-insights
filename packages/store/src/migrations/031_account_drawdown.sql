-- Account equity read without scanning every stored minute.
--
-- account_drawdown_state: the drawdown walk accountDrawdown does, stored at every minute so any
-- cutoff is one seek. `scope` is the broker label for that label's own walk, or '' for the TOTAL
-- walk over the labels grouped into accounts (the grouping it was built with is account_groups).
-- `points` counts the minutes walked; for TOTAL that is the distinct minutes of the instance.
CREATE TABLE IF NOT EXISTS account_drawdown_state (
  instance_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  equity REAL NOT NULL,
  peak REAL NOT NULL,
  peak_ts INTEGER NOT NULL,
  max_dd REAL,
  points INTEGER NOT NULL,
  PRIMARY KEY (instance_id, scope, minute_ts)
) WITHOUT ROWID;

-- Per broker label: its first minute and the venue account ("login@server") it first reported.
CREATE TABLE IF NOT EXISTS account_labels (
  instance_id TEXT NOT NULL,
  broker TEXT NOT NULL,
  first_ts INTEGER NOT NULL,
  identity TEXT,
  identity_ts INTEGER,
  PRIMARY KEY (instance_id, broker)
) WITHOUT ROWID;

-- Minutes reported by two or more labels (JSON array of the labels), and per pair of labels how
-- many minutes they share: the inputs of the "labels that take turns are one account" grouping.
CREATE TABLE IF NOT EXISTS account_minute_labels (
  instance_id TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  labels TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (instance_id, minute_ts)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_account_minute_labels_three ON account_minute_labels (instance_id, minute_ts) WHERE n >= 3;

CREATE TABLE IF NOT EXISTS account_label_pairs (
  instance_id TEXT NOT NULL,
  label_a TEXT NOT NULL,
  label_b TEXT NOT NULL,
  shared INTEGER NOT NULL,
  last_shared INTEGER NOT NULL,
  PRIMARY KEY (instance_id, label_a, label_b)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS account_groups (
  instance_id TEXT PRIMARY KEY,
  chains TEXT NOT NULL
);

-- A row without equity is outside every walk; the readers fall back to the full scan while one exists.
CREATE INDEX IF NOT EXISTS idx_account_equity_no_equity ON account_equity (instance_id) WHERE equity IS NULL;

CREATE TRIGGER IF NOT EXISTS account_equity_projection_insert AFTER INSERT ON account_equity BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT 'account', NEW.instance_id, k.key FROM (SELECT NEW.broker || char(0) || NEW.minute_ts key) k
  WHERE NOT EXISTS (SELECT 1 FROM projection_dirty d WHERE d.kind='account' AND d.instance_id=NEW.instance_id AND d.key=k.key);
END;

CREATE TRIGGER IF NOT EXISTS account_equity_projection_update AFTER UPDATE ON account_equity BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT 'account', q.instance_id, q.key FROM (
    SELECT OLD.instance_id instance_id, OLD.broker || char(0) || OLD.minute_ts key
    UNION SELECT NEW.instance_id, NEW.broker || char(0) || NEW.minute_ts
  ) q
  WHERE NOT EXISTS (SELECT 1 FROM projection_dirty d WHERE d.kind='account' AND d.instance_id=q.instance_id AND d.key=q.key);
END;

CREATE TRIGGER IF NOT EXISTS account_equity_projection_delete AFTER DELETE ON account_equity BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT 'account', OLD.instance_id, k.key FROM (SELECT OLD.broker || char(0) || OLD.minute_ts key) k
  WHERE NOT EXISTS (SELECT 1 FROM projection_dirty d WHERE d.kind='account' AND d.instance_id=OLD.instance_id AND d.key=k.key);
END;

INSERT OR IGNORE INTO projections (name, version) VALUES ('account_drawdown', 0);
