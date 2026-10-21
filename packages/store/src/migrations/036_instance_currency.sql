-- The account currency the instance's broker state reports (state.account), which sets the minor
-- unit its money is stored and compared at (2 decimals when unknown). NULL until the first poll.
ALTER TABLE instances ADD COLUMN currency TEXT;
