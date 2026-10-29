-- What each venue account is, so an account that stopped reporting keeps the name it had while live: the connector
-- and venue adapter qkt stated, the environment (demo, real) and the login masked to its last four characters. The
-- raw login and the server never reach the database (contract accountIdentity.ts).
ALTER TABLE account_currencies ADD COLUMN connector TEXT;
ALTER TABLE account_currencies ADD COLUMN adapter TEXT;
ALTER TABLE account_currencies ADD COLUMN trade_mode TEXT;
ALTER TABLE account_currencies ADD COLUMN login TEXT;

-- Accounts recorded before these columns: the venue their broker.connected and broker.disconnected events stated.
UPDATE account_currencies SET
  connector = (SELECT json_extract(e.payload, '$.venue.connector') FROM events e
    WHERE e.instance_id = account_currencies.instance_id AND e.type IN ('broker.connected', 'broker.disconnected')
      AND json_extract(e.payload, '$.accountId') = account_currencies.account
      AND json_extract(e.payload, '$.venue.connector') IS NOT NULL ORDER BY e.ts DESC LIMIT 1),
  adapter = (SELECT json_extract(e.payload, '$.venue.adapter') FROM events e
    WHERE e.instance_id = account_currencies.instance_id AND e.type IN ('broker.connected', 'broker.disconnected')
      AND json_extract(e.payload, '$.accountId') = account_currencies.account
      AND json_extract(e.payload, '$.venue.adapter') IS NOT NULL ORDER BY e.ts DESC LIMIT 1)
WHERE connector IS NULL AND adapter IS NULL;
