-- closed_trades.realized_exact: a closing leg's unrounded net, its share of the entry costs included.
-- `realized` stays at the account currency's minor unit for the row shown and classified; a total sums
-- this one and rounds once, so a venue booking sub-cent amounts totals what its deals total. NULL until
-- the closed_trades rebuild (version 9).
ALTER TABLE closed_trades ADD COLUMN realized_exact REAL;
