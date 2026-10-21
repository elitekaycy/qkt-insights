-- round_trips.realized_exact: the unrounded sum of a position's legs incl. costs (an engine close:
-- the engine's realized as sent). `realized` stays at the account currency's minor unit for money
-- shown, filtered and classified; R divides this one by the stated risk, so a trip far smaller than
-- a cent of risk keeps its true R. NULL until the round_trips rebuild (closed_trades version 7).
ALTER TABLE round_trips ADD COLUMN realized_exact REAL;
