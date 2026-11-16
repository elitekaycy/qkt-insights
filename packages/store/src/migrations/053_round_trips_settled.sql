-- round_trips.ended 'settled': a position the venue settled at expiry (a dated future, an option, an event
-- contract), told apart from a stop-out or liquidation ('so'). Trips written before it carry 'so' for an expiry;
-- their stated close reason says which they were.
UPDATE round_trips SET ended = 'settled' WHERE ended = 'so' AND upper(close_reason) = 'EXPIRY';
