-- The part of a deal's swap that is perpetual funding (its typed costs of kind FUNDING), negative when paid. swap keeps
-- it, so every net that sums profit + commission + swap + fee is unchanged; a read that shows costs by kind shows swap
-- less funding as swap and this as funding. NULL on rows stored before it was kept: funding unknown, none shown.
ALTER TABLE deals ADD COLUMN funding REAL;
