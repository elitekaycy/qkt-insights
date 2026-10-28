-- What a deal's instrument is, as qkt states it on `broker.deal.instrument`: its kind (cfd, equity, spot, perpetual,
-- future, option), its contract size, and the unit of `qty` when qkt names one (quantityUnit). NULL when not stated
-- (an older qkt, or an instrument neither qkt's registry nor the venue describes).
ALTER TABLE deals ADD COLUMN instrument_kind TEXT;
ALTER TABLE deals ADD COLUMN contract_size REAL;
ALTER TABLE deals ADD COLUMN quantity_unit TEXT;
