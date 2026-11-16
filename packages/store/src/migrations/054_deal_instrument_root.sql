-- The contract family of a deal's instrument, as qkt states it on `broker.deal.instrument.root` (`CME:ES`,
-- `DERIBIT:BTC`, `KALSHI:KXINXU`): a dated future's, an option's or an event contract's history groups under it
-- (instrumentFamily.ts). NULL for an instrument with no family, or an older qkt that does not send it.
ALTER TABLE deals ADD COLUMN instrument_root TEXT;
