-- Operator-declared capital per strategy (STRATEGY_CAPITAL), the base for its return,
-- drawdown and equity curve. Kept apart from strategies so a strategy.started re-announce
-- or a stale-strategy prune never touches it; the server replaces it wholesale at boot.
CREATE TABLE IF NOT EXISTS strategy_capital (
  strategy_id TEXT PRIMARY KEY,
  capital REAL NOT NULL CHECK (capital > 0)
);
