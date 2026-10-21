-- The venue account behind each account_equity row ("login@server"), when the state poller
-- reported it. One account is often stored under several broker labels over time (a profile
-- rename); the identity is what stitches them into one curve and keys its risk limits.
ALTER TABLE account_equity ADD COLUMN account TEXT;
