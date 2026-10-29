-- The venue's folder for a deal's instrument, as qkt states it on `broker.deal.instrument.category` (contract 1.4.0):
-- `Stocks` for an MT5 stock CFD, which is what tells it from an FX or metal CFD. NULL when not stated.
ALTER TABLE deals ADD COLUMN instrument_category TEXT;
