-- The currency each venue account books in, as its state.account reports it: one row per account (its stated
-- accountId, else its label), with the label it last reported under. An instance trading accounts in several
-- currencies (USD, USDC, USDT) has its money split by currency here, never added into one total.
CREATE TABLE IF NOT EXISTS account_currencies (
  instance_id TEXT NOT NULL,
  account TEXT NOT NULL,
  label TEXT NOT NULL,
  currency TEXT NOT NULL,
  PRIMARY KEY (instance_id, account)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_account_currencies_label ON account_currencies (instance_id, label);
