# Features and architecture

## Features

- **Health** — every reporting instance, last-event age, sequence position, sink counters, journal backlog, quarantined envelopes by type, live/idle status.
- **Reconciliation** — every night, per venue account: each UTC day's balance change against the account's deals, the venue's open positions against the open round trips, and the round trips against their deals; Health says how far the books are reconciled or lists what differs ([operations/reconciliation.md](operations/reconciliation.md)).
- **Uptime** — a heartbeat monitor per daemon and HTTP probes for anything else on the box (the MT5 gateway, with `mt5_status: connected` asserted); 24h strip, uptime %, incident timeline, and a Telegram/webhook alert on every down and recovery. A dead-man ping tells an outside service the collector itself is alive.
- **Strategies** — every strategy in one sortable table, and per strategy the journal's sections (Overview, Calendar, Daily, Monthly, Trades, Time & risk, Logs) over its round trips, with net and return on the strategy's own capital, its halt, and the deploy's runtime details.
- **Trades** — every round trip (one row per position, entry to exit, P&L after costs), searchable with the query bar,
  sortable, exported as CSV, each one opening a drawer with its timeline from signal to close.
- **Logs** — engine logs shipped from qkt, searched with the same query bar (`level:`, `strategy:`, `logger:`, `time:`,
  free text), and a live tail.
- **Home** — where each venue account stands now; several accounts get a one-line switcher (All accounts as one table, then one tab per account, held in the URL's `account`), shared with Equity & risk.
- **Equity** — all strategies on one normalized comparison chart; drawdown periods shaded on the focused curve.
- **Edge** — when a strategy makes money: day-of-week × hour P&L heatmap (UTC), weekday/hour bars with per-bucket n and ±SE, rolling Sharpe/win-rate stability, strategy-comparison radar. Buckets under 30 trades render greyed — thin slices are noise, and the UI says so.
- **Single-admin auth** — username + password from env, hashed with argon2 at startup, signed httpOnly session cookie; ingest guarded by a bearer token.

See [Screens](PAGES.md) for a screenshot of every page.

## Architecture

A pnpm workspace of small, single-purpose packages:

| package | responsibility |
|---|---|
| `packages/contract` | the wire truth — Zod schemas for every envelope type; validation at the boundary, types everywhere else |
| `packages/store` | the only SQLite writer — WAL, FTS5, forward-only migrations, order-state folding, stats (Sharpe, drawdown, win rate) |
| `packages/collector` | `POST /ingest` — bearer auth, Zod-validated per envelope, idempotent on event id, quarantines what it cannot read, timestamp/seq-aware order folding |
| `packages/api` | REST + WS `/live` behind the session guard |
| `apps/web` | React + Vite + Tailwind dashboard |
| `src/server.ts` | one entry, boots subsystems by mode |

## Ingest contract

`POST /ingest` takes `{instanceId, events: [...]}` with `Authorization: Bearer <INGEST_TOKEN>`. The batch is checked
only for that shape; each envelope is then checked on its own, so one envelope the collector cannot read never
costs the rest of the batch (qkt's journal retries a rejected batch forever, which would freeze that bot's telemetry).

Each envelope goes through, in order:

1. **Envelope base** — `v` (integer), `instanceId`, `id`, `seq` (integer ≥ 0), `ts` (integer ms), `type` (string),
   optional `strategyId`, and a `payload`.
2. **Major version** — `v` must be a supported major (`SUPPORTED_MAJORS`, today `1`; see Contract versions).
3. **Type and payload** — `type` must be in `packages/contract/src/payloads.ts` and the payload must match its schema.
   Payload objects are passthrough: a field the contract does not know is kept in the stored JSON.

An envelope that passes is stored exactly as before. One that fails any step is **quarantined**: stored raw in
`quarantined_events` (keyed by instance and envelope id, so redelivery writes one row; an envelope with no id is
keyed `sha256:<hex>` of its JSON) with the reason, acknowledged with 200, and counted per type and major on Health
(`quarantined` on `GET /health/instances`).

| change from qkt | result |
|---|---|
| new payload field | accepted, kept in the payload JSON |
| unknown type | quarantined, the rest of the batch is stored |
| `v` other than 1 | quarantined |
| renamed required field, numeric sent as a string | quarantined (projections need the typed field) |
| unknown `side` (e.g. `SHORT`) | quarantined: side sets the sign of P&L, so it is never guessed |
| unknown log `level` (e.g. `TRACE`) | accepted as sent: logs are display-only |

The response is 400 only for a body that is not JSON or not a batch (`invalid batch`) and for an envelope whose
`instanceId` differs from the batch's (`instance mismatch`); 401/429 cover auth. A 200 response:

```json
{
  "accepted": 1,
  "quarantined": 1,
  "envelopes": [
    { "id": "t1", "status": "accepted" },
    { "id": "f1", "status": "quarantined", "reason": "unknown type \"signal.future\"" }
  ],
  "ack": { "instanceId": "demo", "lastSeq": 1, "observations": [], "received": 2, "acknowledgedIds": ["t1", "f1"] }
}
```

`status` is `accepted`, `duplicate` (the id was already stored) or `quarantined`; a redelivered quarantined envelope
is reported `quarantined` again. `accepted`, `ack` and `acknowledgedIds` keep their earlier meaning; every envelope
in a 200 batch is acknowledged. `ack.observations` is always empty: duplicates are reported per envelope instead.
A `snapshot.equity` already stored for its strategy at the same `ts` is a `duplicate`; one that repeats the
strategy's previous snapshot is acknowledged but stored only once per 5-minute heartbeat.

### Contract versions

`packages/contract` states the contract it implements as `CONTRACT_VERSION` (semver, `payloads.ts`), the envelope
majors it reads as `SUPPORTED_MAJORS` (`envelope.ts`, the set `classifyEnvelope` checks `v` against), and for every
type in `payloadByType` an entry in `eventTypeMeta`: the version that first accepted it (`since`) and, for a type on
its way out, what to send instead (`deprecated`). A type without an entry fails the build and the contract tests.

- **Minor** (`1.0.0` to `1.1.0`): a new type or a new optional field. Older producers keep working; the new type gets
  `since` set to the new version.
- **Major** (`1.x` to `2.0.0`): a rename, a removal, a new required field or a change of meaning. It also takes a new
  envelope `v`, so a producer opts in by sending it; until a collector lists that `v` in `SUPPORTED_MAJORS` it
  quarantines those envelopes (counted on Health) rather than misreading them.
- **Patch**: a correction that accepts nothing new, such as a fixed schema comment.

`pnpm contract:generate` writes two artifacts from the contract, and a test fails while they are stale:

- `packages/contract/generated/insights-contract.schema.json`: JSON Schema (draft 2020-12) of the envelope and
  every type's payload, with `x-contract-version`, `x-envelope-majors`, per type `x-since` and `deprecated`.
- `packages/contract/generated/insights-contract-types.txt`: the sorted type list in the format qkt pins as
  `src/test/resources/insights-contract-types.txt`, which its build checks every emitted type against.

`GET /ingest/capabilities` answers the same facts to a producer at run time, with the same bearer token as
`/ingest` (and the same bad-token budget):

```json
{
  "contractVersion": "1.5.0",
  "majors": [1],
  "types": [{ "type": "balances.updated", "since": "1.0.0" }, "..."],
  "maxBatch": null,
  "maxBodyBytes": 1048576
}
```

`maxBodyBytes` is the body limit `/ingest` enforces (larger bodies get 413); `maxBatch` is null because no envelope
count is enforced beyond it. The body is fixed for the process and carries an `ETag`, so a producer can revalidate
with `If-None-Match` and get 304. Health shows the version beside Runtime health (`GET /health/contract`).

### Account identity

An account is named by an opaque id, never by its credentials. qkt (`com.qkt.broker.VenueAccountId`) and the
collector (`packages/contract/src/accountIdentity.ts`) compute it the same way:

| connector | `accountId` |
|---|---|
| MT5 | `mt5:` + the first 16 hex characters of `sha256("<login>@<server>")` |
| gateway (VGP) | `vgp:` + the first 16 hex characters of `sha256("<adapter>:<account login>")` |
| paper | `paper:local` |

The collector rewrites every envelope before anything keeps, stores or pushes it: an `accountId` in an older
form (`mt5:<login>@<server>`, `vgp:<adapter>:<login>`) becomes the opaque id, an envelope that states none but
carries `login` and `server` gets the id they hash to, `login` is masked to its last four characters
(`•••9381`), `server` is dropped, and `login=` / `server=` values in log text are redacted. This holds at any
depth of a payload and for quarantined envelopes too, so the database (tables, stored payload JSON, logs and
their search index) never holds a raw login or server. Migration `039_opaque_account_identity` rewrites what
an earlier release stored; see docs/operations/storage-maintenance.md for the bytes it cannot reach.

### Venue facts

qkt states what the collector would otherwise infer from MT5 conventions; every field is optional, and an
envelope without it is read the way older qkt releases need (`packages/store/src/inferredVenueFacts.ts`, which
counts each inference and logs its first use and every thousandth: `venue fact inferred from MT5 conventions`).

| stated fact | where | used for | inferred when absent from |
|---|---|---|---|
| `venue{connector,adapter,label}`, `accountId` | every venue envelope | one account per `accountId`, its card titled by the venue, `venue.tradeMode` and the masked login (web `accounts.ts` `accountTitle`), with every label that reported it counted as its profiles | `login` + `server` (hashed to the opaque `mt5:` id), the label without its `_S<n>` profile suffix |
| `instrument.category` (1.4.0) | deals, positions, `strategy.started` streams | the type badge, with a stock CFD apart from an FX or metal CFD (`kind: cfd, category: Stocks`); `type:` in the query language; kept as `deals.instrument_category` | no stock CFD: a CFD reads as a CFD |
| `instrument.root`, `expiry`, `strike`, `optionRight`, `underlying` (1.4.0) | deals, positions, `strategy.started` streams | a strategy's legs in words: "Option · BTC 70000 call, 29 Nov · Deribit" | the venue symbol |
| `venue.tradeMode` (1.3.0) | every venue envelope | the account's environment in its title: `demo`, `real`, `contest` | not shown |
| `strategyId` + `attribution` | deals, positions, orders, fills | the strategy of a deal | a `dsl-<strategy>` deal comment |
| `positionId`, `legEntry`, `nextPositionId` | deals, fills, `trade.closed` | round-trip identity and leg | `positionTicket`, `entry`; the entry order by its broker ticket |
| `closeReason` | closing deals, fills, `trade.closed` | `ended`: STOP stop, TAKE_PROFIT tp, STOP_OUT/LIQUIDATION/EXPIRY venue, MANUAL manual, SIGNAL/TIMED signal | `[sl` / `[tp` / `[so` deal comments, then `qkt bot close` and close orders near the exit |
| `costs[]` | deals | commission, swap (funding, borrow), fee (the rest): the deal's costs, once; the FUNDING part is also kept as `deals.funding`, so reads show swap without funding and perpetual funding apart (nets unchanged) | the `commission` / `swap` / `fee` scalars, which repeat them when `costs` is sent; no funding is known then |
| `realizedSource` | deals | kept per leg: `venue`, or `engine` for a venue that reports no P&L | |
| `initialStop`, `initialTarget`, `riskAmount` | entry fills, positions | a round trip's stop, target, risk and R | the entry order's submitted bracket; risk from the venue's gross over the move |
| `instrument.tickSize`, `instrument.valuePerPoint` | deals, fills, positions | price precision; slippage in money | the decimals of observed prices and metal/FX names; the gross over the move |
| `instrument.kind`, `instrument.contractSize`, `instrument.quantityUnit` (1.1.0; qkt does not send `quantityUnit` yet) | deals, positions | what a position is (CFD, share, spot coin, perpetual, dated future, option) and the unit of its size, on round trips and open positions (`packages/store/src/instrumentKind.ts`) | the unit from the kind: `cfd` lots, `equity` shares, `spot` coins, `perpetual`/`future`/`option` contracts; no kind, no unit |

**Retired strategies.** qkt attributes a venue deal only to strategies it runs now, so a deal re-sent from
history whose strategy was retired since arrives with `attribution: "none"`. When its opening deal carries a
complete qkt order comment, `dsl-<strategy>--<sequence>` (the venue may cut the sequence; the `--` shows the name
is whole), the collector files the position under that strategy and registers it, so it lists as a retired
strategy instead of "Unattributed" (`packages/store/src/retiredStrategies.ts`; migration
`041_retired_strategy_attribution` applies the same rule to stored history once). A comment cut inside the name
names nothing and the deal stays unattributed. One account traded by two qkt instances would file the other
instance's unattributable deals under that instance's strategy names here too, exactly where they are stored as
unattributed today, unless the other instance's magic numbers are listed in `INSIGHTS_IGNORE_MAGICS`
(docs/CONFIGURATION.md): its deals then go to `ignored_deals`, which only the balance continuity check and the
Reconciliation card's count read, and its positions and pending orders are dropped from the live state
(`packages/store/src/ignoredMagics.ts`).

**Several venues on one instance.** Every broker profile polling an account sends the account's deals, so one
venue deal can be stored once per profile; only the first copy counts (`deals.canonical`). Copies are rows with
the same deal ticket **on the same account** (`accountId`; a copy that states none matches any): two accounts can
number their deals alike (each gateway paper account counts `paper-1`, `paper-2`, ...), and neither is then a copy
of the other (`closedTrades.ts` `SAME_DEAL`, migration `043_deal_copies_per_account`). A strategy is recovered from
a copy of the same deal only on its own account. An instrument the instance trades on more than one account (an
`EXNESS_S01:AAPL` stock CFD beside an `ALPACA:AAPL` share) is two instruments to the journal: each round trip
names its venue (`venue`, the symbol's broker prefix without a profile suffix), shown as `ALPACA:AAPL`, and the
by-instrument aggregates keep one bucket per venue. Two accounts reporting the same `accountId` (two gateway paper
accounts left on the default login `paper`) are one account to the collector: give each its own login.

**Accounts in different currencies.** Each venue account's currency is kept as its `state.account` reports it
(`account_currencies`, `packages/store/src/currencies.ts`), and each round trip takes its account's (`currency`).
Money is still rounded at the instance currency's minor unit. When an instance's accounts report more than one
currency, the round-trip totals and the journal aggregates also return `currencies` (net and count per currency).
The Trades and strategy trade lists then show each currency's net instead of one sum, and every page carries a
note that a figure spanning accounts (a strategy's or the account's total, a book) adds them 1:1 with no
conversion. No exchange rate is applied anywhere.

An engine close (`trade.closed`) is a round trip of its own only while neither its strategy nor its broker (the
symbol's `LABEL:` prefix) has stored a venue deal, so an instance that trades an MT5 account and a venue that sends
no deals shows both.

### Strategy code

`strategy.started` carries the strategy file's text (`sourceText`, 1.2.0) beside `sourcePath` and `sourceSha256`.
qkt cuts it to 64 KiB (`sourceTruncated`; the sha covers the whole file) and sends it once per qkt process,
strategy and sha: a later start at that sha says `sourceTextOmitted: true` instead. The collector keeps each
`(instance, strategy, sha)` once in `strategy_sources` (`packages/store/src/strategySources.ts`): the text the first
time it arrives, the first and last start, and a count of starts, so a restart over unchanged code moves only
`last_seen`. The text is never written to `events`, `strategies.metadata` or the live bus, and no `/public` route
reads the table. A version with no text says why: qkt sent none (`not-sent`, a qkt before 1.2.0's fields), or it
left the text out after sending it at an earlier start this collector does not hold (`not-received`, e.g. after a
database reset; the next qkt restart sends it again). `GET /strategy-source` lists the versions without text and
`GET /strategy-source/text?sha=` answers one, both behind the session.

### Strategy configuration

`strategy.started` also carries what the strategy runs on (`effectiveConfig`, 1.5.0): an allow-list qkt builds from
named, resolved settings (account, risk limits, orders, market data, its book), never its config file, each with
where its value came from. `effectiveConfigSha256` names it, and like the source it is sent once per qkt process,
strategy and sha (`effectiveConfigOmitted: true` on a repeat). The collector keeps each `(instance, strategy, sha)` once
in `strategy_configs` (`packages/store/src/strategyConfigs.ts`), through its own allow-list (`EffectiveConfigSchema`):
a field the contract does not name is not stored, and a field that does not fit is dropped alone, so a malformed
config never quarantines its start. The config is never written to `events`, `strategies.metadata` or the live bus.
`GET /strategy-config` answers the running sha and every version behind the session; no `/public` route reads the
table and `publicView.ts` does not list it. A collector must accept the field before a qkt sends it: an older collector
keeps an unknown payload field in `events` and metadata (the payload schemas pass unknown fields through).

## Reads

Every JSON and static response is compressed (brotli, else gzip) when the client accepts it. The heavier reads
(`/performance`, `/equity`, `/deals`, `/trades`, `/account/equity`, `/account/drawdown`, `/account/summary`) carry
a weak `ETag` derived from a version of the rows they read, with `Cache-Control: private, no-cache`; a browser
revalidates with `If-None-Match` and gets `304` with no body until those rows change. `/account/equity` returns at
most 2,000 points by default (the last stored minute of each time bucket), `?points=N` up to 20,000, and
`?resolution=full` for every minute. `/account/summary?account=` (an account id or broker label) keeps one venue
account's closes when the instance reports several (404 for an account it does not know), and `/account/risk` counts
each account's own closes in its realized today.

### Round trips and the query language

`/round-trips` serves one row per position from the `round_trips` projection (see
[operations/projections.md](operations/projections.md)), read through `store/src/tripQueries.ts`, so a read is an index
range scan, never a rebuild of history. Prices print at the instrument's precision, read from the decimals of its venue
deals. The query text `q` is parsed by the same code as the
web bar (`@qkt-insights/contract/query`) and compiled to bound SQL; tokens it cannot read come back in
`query.errors` while the rest still apply.

| Route | Answers |
|---|---|
| `GET /round-trips?instance&q&strategy&from&sort&dir&limit&cursor` | a page (keyset cursor, up to 500 rows) and, on the first page, `totals` of the whole match: matched, total in scope, net, wins, losses, win rate, average, best, worst |
| `GET /round-trips/analytics?instance&q&strategy&from` | the journal aggregates of the same match (a strategy page's sections): counts, P&L, win rate, profit factor, payoff, expectancy, R, max drawdown, streaks, after-N-losses, the per-trade series, UTC exit days and months, and buckets by side, how it ended, hold time, instrument, UTC entry weekday and hour, each with the query token that lists its trades |
| `GET /round-trips/facets?instance&strategy` | strategies, instruments, exit days and common sizes, for completions |
| `GET /round-trips/export?…` | the whole match as CSV, streamed page by page |
| `GET /round-trips/:ticket?instance` | the trade drawer: legs, timeline with latencies, slippage, MAE/MFE, raw events |
| `GET /round-trips/:ticket/path?instance&bucket` | the drawer's position map: the position's venue marks between entry and exit as UTC candles (`bucket` ms, one of 1m 5m 15m 30m 1h 4h 1d; automatic when absent), the P&L line keeping each bucket's first, lowest, highest and last mark, the best, worst and latest marks, and the stretches without marks or without a price change |
| `GET /public/:token/round-trips`, `…/analytics`, `…/facets` | a shared link's closed round trips and their aggregates, without tickets, profiles or stops |

`/logs` takes `level` as one level or several (`level=WARN,ERROR`), and `orLogger` (logger last names, comma-separated)
to add those loggers' lines at any level beside them: the Logs pages' default, warnings and the order flow, is
`level=WARN,ERROR&orLogger=OrderManager,TradingPipeline,trade` (contract `LOG_ATTENTION`).
It also takes `logger` (part of the name), `from` and `to` (ms); `q` is words, each matched literally through the FTS
index (quoted, so `mt5-gateway`, `ICMARKETS:XAUUSD` or `0.1004` are words, not syntax; a trailing `*` is a prefix).
`GET /logs/page` takes the same filters plus `cursor` and answers `{rows, nextCursor, total}`: newest first by
(ts, arrival), keyset pages up to 1000 lines, and on the first page the number of lines the whole query matches.

Design notes live in [`specs/`](specs/) and the implementation plans in [`plans/`](plans/).

## Development

```bash
pnpm install
pnpm test            # vitest — real SQLite, real HTTP, no mocks
pnpm build:all       # tsc project references + vite web build
pnpm --filter @qkt-insights/web dev    # web dev server proxying to :8420
node dist/src/server.js serve          # backend against ./insights.db
```

Conventions: TypeScript strict, smallest reasonable change, no mocks in e2e tests,
commit subjects only. CI runs the full suite on every push and PR; merges to `main`
publish `ghcr.io/elitekaycy/qkt-insights:latest`.
