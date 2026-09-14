# Public sharing

Share a read-only view of an instance's overview, a portfolio, or a single
strategy with anyone holding a link: people following the account, investors, and
buyers checking a strategy's live record before purchase.

## What the operator does

- **Overview:** an eye toggle in the Overview header makes the instance's overview
  public or private. A copy icon appears only while it is public.
- **Portfolio:** the same toggle and copy icon on a portfolio's page.
- **Strategy:** the same toggle and copy icon beside the tabs of a strategy's page.
  This covers standalone strategies and portfolio children alike.
- **Regenerate:** beside the copy icon. The old link stops working immediately.
- **Default:** everything is private.

## Visibility resolution

A strategy is public when the first explicit setting found says so, in this order:

1. its own setting,
2. its portfolio's setting (children only),
3. the instance overview's setting.

With nothing set anywhere it is private. Turning the overview public therefore
makes every strategy public except those set private themselves or through their
portfolio. A portfolio's effective visibility is its own setting, else the overview's.
Each explicit setting can be reset to inherit again.

## What a link shows

| Link | Layout | Content |
|---|---|---|
| Overview | Sidebar with only **All strategies** (Overview, Equity) and **Performance** (Strategies, Edge, Trades) | Every public strategy of that instance, plus account balance, equity and drawdown |
| Portfolio | No sidebar | The portfolio page and its public children |
| Strategy | No sidebar | That strategy's page with its tabs and data |

Logs, health, search, instance switching, runtime details and sign-out are absent
from public views, and their endpoints have no public equivalent. Account-level
figures appear only on an overview link, because a portfolio or strategy link must
not reveal the rest of the account.

## Delay and open positions

Public data is cut off `PUBLIC_DELAY_MINUTES` (default 15) before now, consistently
across trades, closes, deals, equity, statistics, performance and account equity. A
live equity curve beside delayed trades would reveal entries, so nothing is exempt.

A position counts as closed only when its whole volume was closed by the cutoff.
Every close-derived figure (closes, trade and deal lists, report, daily nets,
breakdowns, contribution, costs, excursions, equity curve, statistics) uses closed
positions only, through the store's `closedPositionsOnly` filter. A partial close, or
the entry of a position still open, therefore changes nothing public. Reversal
(INOUT) positions never qualify. Engine `trade.closed` rows and equity snapshots are
never used under the filter: the rows carry no position identity, and snapshots carry
unrealized P&L. Public figures therefore come from broker deals only, and a
strategy without polled deals shows no trades publicly.

Open positions appear only on overview links, as a count and their total unrealized
P&L taken from the last stored mark at the cutoff. Nothing is reported per position or
per strategy, because any single position's or strategy's open P&L moves with price
across polls and would reveal direction and size. For the same reason the total is
withheld while fewer than two public positions are open. Strategy and portfolio pages show realized figures only. Side, symbol,
size, entry, stops and tickets are never public, so a multi-day hold cannot be copied
while it is open.

Also absent from public performance data: execution quality, whose order latency and
fill counts cover orders of positions that may be open, and planned risk-reward, which
comes from every bracket submitted. A paper strategy's snapshot equity and engine
fill counts include unrealized positions, so public statistics and equity curves come
from closes alone. A strategy first seen inside the delay window is not listed yet.
Public views receive no WebSocket stream; they poll.

## Data minimisation

Public endpoints build every response from an allow-list, never by filtering admin
output:

- **Strategy metadata:** only the display name, portfolio name and alias, weight,
  allocated capital, symbols and the two drawdown caps. Parameters, source path, source
  hash, broker profiles, streams and the rest of the risk configuration are dropped.
- **Symbols** lose their broker profile prefix (`EXNESS_P549:GBPUSD` becomes `GBPUSD`).
- **Tickets and order ids** become opaque per-process HMACs, consistent within a
  response set so tables still join. Magic numbers, comments and broker labels are
  removed.
- **Accounts** carry no login, server, holder name or margin figures, and are labelled
  `Account`.

## Links and endpoints

- **Link format:** `/p/<token>`, where the token is 24 random bytes (base64url),
  stored per share row. Regenerating replaces the token. A token shown to the admin
  while its subject was public is marked exposed. Whenever an exposed subject is no
  longer public, its token is replaced. This runs after every admin change, when a
  shared link resolves to nothing, and on a one-minute sweep, so it also covers
  strategies that deploy metadata moves into a private portfolio. A revoked link
  therefore stays dead even if its subject is public again. An unknown token and a
  private one get the same 404.
- **Admin endpoints** (session required, same-origin writes): `GET /shares`,
  `PUT /shares`, `POST /shares/rotate`.
- **Public endpoints:** `GET /public/:token/{meta,strategies,stats,equity,performance,trades,deals,live/state,account/equity,account/drawdown}`.
  Each ignores the client's `instance` parameter and scopes to the token. A
  `strategy` parameter outside the token's public set gets 404.
- **Protection:** each route reduces its query to the few values that change the
  answer, and only those form the cache key. `from` snaps to the 24h, 7d or 30d presets
  or all time, `window` to 30, 60 or 90, and `limit` to 100, 500 or 1000. `include` only
  selects keys from the cached full bundle. Unknown and repeated parameters are
  ignored, so junk querystrings cannot force recomputation. Responses are cached for
  a minute. Uncached computations are budgeted per link (120 a minute) and per client
  IP (60 a minute), so one busy viewer cannot starve other links. Over budget, the last
  cached value is served even if expired, and 503 only when there is none. Computation
  time is budgeted too: 30 seconds a minute per link and 15 per IP. `/meta` is never
  budgeted, so a busy link still loads. Cached answers are keyed by the link's scope,
  meaning what it covers. A share change or revocation drops only the scope entries, so
  a link whose coverage changed can never get its old answers, fresh or stale, while
  other links keep serving theirs. Deal pairing uses the
  `(instance_id, position_ticket, ts)` index, and the fully-closed check reads only the
  position's own legs through it, which keeps closed-trade analytics linear in the deal
  count. A strict bundle takes about 0.5 seconds at 50,000 deals. Public requests have their own budget of 240 a minute per IP on top of
  the global one, and `X-Robots-Tag: noindex` is sent on `/p/` and `/public/`.
