ALTER TABLE orders ADD COLUMN qty_decimal TEXT;
ALTER TABLE orders ADD COLUMN cum_qty_decimal TEXT;
ALTER TABLE orders ADD COLUMN avg_price_decimal TEXT;

ALTER TABLE equity_snapshots ADD COLUMN realized_decimal TEXT;
ALTER TABLE equity_snapshots ADD COLUMN unrealized_decimal TEXT;
ALTER TABLE equity_snapshots ADD COLUMN equity_decimal TEXT;

ALTER TABLE deals ADD COLUMN qty_decimal TEXT;
ALTER TABLE deals ADD COLUMN price_decimal TEXT;
ALTER TABLE deals ADD COLUMN profit_decimal TEXT;
ALTER TABLE deals ADD COLUMN commission_decimal TEXT;
ALTER TABLE deals ADD COLUMN swap_decimal TEXT;

ALTER TABLE account_equity ADD COLUMN balance_decimal TEXT;
ALTER TABLE account_equity ADD COLUMN equity_decimal TEXT;
ALTER TABLE account_equity ADD COLUMN open_profit_decimal TEXT;

ALTER TABLE positions_current ADD COLUMN qty_decimal TEXT;
ALTER TABLE positions_current ADD COLUMN entry_price_decimal TEXT;
ALTER TABLE positions_current ADD COLUMN current_price_decimal TEXT;
ALTER TABLE positions_current ADD COLUMN profit_decimal TEXT;
ALTER TABLE positions_current ADD COLUMN swap_decimal TEXT;

ALTER TABLE position_valuations ADD COLUMN qty_decimal TEXT;
ALTER TABLE position_valuations ADD COLUMN entry_price_decimal TEXT;
ALTER TABLE position_valuations ADD COLUMN current_price_decimal TEXT;
ALTER TABLE position_valuations ADD COLUMN profit_decimal TEXT;
ALTER TABLE position_valuations ADD COLUMN swap_decimal TEXT;

ALTER TABLE position_reconciliations ADD COLUMN old_qty_decimal TEXT;
ALTER TABLE position_reconciliations ADD COLUMN new_qty_decimal TEXT;
ALTER TABLE position_reconciliations ADD COLUMN old_avg_px_decimal TEXT;
ALTER TABLE position_reconciliations ADD COLUMN new_avg_px_decimal TEXT;

ALTER TABLE risk_events ADD COLUMN qty_decimal TEXT;

ALTER TABLE portfolio_equity ADD COLUMN equity_decimal TEXT;
ALTER TABLE portfolio_equity ADD COLUMN realized_decimal TEXT;
ALTER TABLE portfolio_equity ADD COLUMN unrealized_decimal TEXT;
