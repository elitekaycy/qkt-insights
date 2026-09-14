# Sharing dashboards publicly

Anyone with a link can see a read-only view of an instance overview, a portfolio, or a
single strategy. Nothing is shared until you switch it on. Design:
`docs/specs/2026-09-15-public-sharing-design.md`.

## Sharing something

1. Open the Overview, a portfolio, or a strategy (the control sits beside the strategy tabs).
2. Click **Private** to make it **Public**.
3. Click the copy icon and send the link. It looks like `https://<your-host>/p/<token>`.

| Control | Effect |
|---|---|
| Eye (Public / Private) | Flips this subject's visibility |
| Copy | Copies the link; shown only while public |
| Regenerate | Issues a new link; the old one stops working immediately |
| Reset (arrow) | Drops this subject's own setting so it follows its portfolio or the overview again |

## What follows what

A strategy uses its own setting if it has one, else its portfolio's, else the overview's.
Making the overview public therefore publishes every strategy you have not set private
yourself. To publish just one strategy for a buyer, leave the overview private and switch
that strategy on.

## What viewers get

| Link | They see | They never see |
|---|---|---|
| Overview | Overview, Equity, Strategies, Edge, Trades for public strategies; account balance, equity, drawdown | Logs, health, search, private strategies, other instances |
| Portfolio | The portfolio page and its public children | Account balance and equity, other strategies |
| Strategy | That strategy's page and tabs | Everything else |

Every figure runs `PUBLIC_DELAY_MINUTES` behind (default 15). Open positions appear only
on overview links, as a count and their total unrealized P&L at that same delayed moment,
never split by strategy. The total is hidden while only one position is open. A position counts only once its whole volume has closed; until
then its trades, deals and any partial close stay out of every figure. Strategy parameters, source files, broker names, account
numbers, tickets, magic numbers and order comments are never included.

Public figures come from broker deals. A strategy whose trades reach insights only as
engine events (a paper or backtest run without broker deal polling) shows no trades on
a shared link.

## Revoking

- **Stop sharing:** switch the subject to Private. Its link answers "not available" at once and
  is replaced, so making it public again gives a new link rather than reviving the old one.
- **Keep sharing, cut off current holders:** regenerate. Send the new link to whoever should keep access.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_DELAY_MINUTES` | 15 | Whole minutes, 0 to 1440 |

Shared links obey the same internet-facing protections as the dashboard
(`docs/operations/internet-exposure.md`), plus 240 requests a minute per IP and
`noindex` so search engines skip them.
