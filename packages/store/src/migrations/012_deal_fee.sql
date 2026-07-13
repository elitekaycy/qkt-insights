-- Per-deal broker fee (distinct from commission/swap). qkt >= the egress-fields
-- release sends it on broker.deal; older deals stay NULL, which analytics treat
-- as zero.
ALTER TABLE deals ADD COLUMN fee REAL;
ALTER TABLE deals ADD COLUMN fee_decimal TEXT;
