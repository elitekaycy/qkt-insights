# Venue reconciliation

Every night insights checks that what it stores matches the venue, using only what qkt already
sends (`state.account`, `state.positions`, `broker.deal`); it never calls a gateway. Health shows
the result per venue account: "Reconciled ✓ through 21 Oct · checked 02:00 UTC", or the days and
positions that differ. Accounts are grouped exactly as the account views group them (by the
opaque account id, else by labels that take turns).

## The three checks

- **Balance continuity per UTC day.** For each complete UTC day, the balance change between the
  last snapshots at or before the day's two midnights must equal the net (profit + commission +
  swap + fee) of the account's canonical deals between those snapshots, within half a minor unit
  per deal. The snapshots' own times bound the deals, so deals made while qkt was down across
  midnight count on the day the next snapshot lands in. A midnight is never cut at a snapshot a
  deal sits within a minute or two of (whether its balance holds that deal is unknown); the
  check steps back to an earlier one.
  - `diff`, no deal that day: the balance moved without a deal, which is a deposit, withdrawal
    or credit (qkt does not send the venue's balance operations), or a deal insights does not have.
  - `diff` with deals: they do not add up, which means a missing deal or money in or out the same day.
  - `incomplete`: no snapshot before the day began (the account's first day), or no balance that day.
- **Open positions now.** The venue's latest positions report (when under 5 minutes old, else
  `stale`) against insights' open round trips: positions at the venue with no open round trip,
  open round trips gone at the venue, and side or size mismatches. A position opened in the last
  two minutes is skipped (its deal may still be on the way).
- **Ledger.** The closed round trips' stored net equals the net of their positions' deals, all
  time. It guards the projections and should always be ok.

## When it runs

Two minutes after the server starts listening (the live state has heard the venue's positions by
then), then every night at 02:00 UTC, in `collect` and `run` modes: the process that takes ingest
holds the venue's live positions. A run is short steps with requests and ingest served in between,
and is incremental: it checks the days after the last one stored, the last 7 days again (a deal
replayed from qkt's journal arrives late), and every day that was not ok. A year of minute
rollups with 10,000 deals takes about 50 ms on a laptop; a nightly run a few tens of ms.

Results are stored in `reconciliations` (one row per account and day) and
`reconciliation_accounts` (counts and the latest positions and ledger results), migration
`040_reconciliations`. `GET /health/reconciliation?instance=<id>` (session required, ETag) reads
them as stored. They are never part of a shared link. Rolling back to a release without the
migration is safe: it never reads the two tables.
