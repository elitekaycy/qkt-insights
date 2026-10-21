# Retention, Backup, and Restore

qkt-insights stores trading observability in SQLite. Treat the database as production state.

## Files to Protect

- `INSIGHTS_DB`: main SQLite database.
- `INSIGHTS_DB-wal` and `INSIGHTS_DB-shm`: active WAL files when the server is running.
- External exports or compressed backups created from the database.

## Retention Policy

Recommended baseline:

- Raw events, orders, deals, risk events, position projections: retain for at least 1 year.
- Account equity and position valuation history: retain for at least 1 year, then archive by month if the DB grows beyond operational limits.
- Logs: retain 30-90 days unless needed for an incident.
- A redelivered envelope is acknowledged as `duplicate` in the ingest response; nothing is stored for it.
- Quarantined envelopes (`quarantined_events`): the weekly prune drops rows received more than 30 days ago.
  Export them first if a contract fix should replay older ones.

The built-in weekly prune follows this: it removes logs, non-trade events and marks of closed
positions older than 30 days. A strategy that stops reporting for 30 days (a swapped-out book)
leaves the active roster (Strategies shows it under "retired") and loses its logs and risk
snapshots, but its deals, closed trades, equity snapshots, risk events and trade fills are never
deleted, so all-time and account totals keep matching the venue.

Do not delete broker deals or order history until tax, audit, and strategy-review requirements are satisfied.

Deleted rows return their space to the filesystem only on a database with incremental auto-vacuum;
`storage-maintenance.md` covers checking and converting an older database.

## Online Backup

Use SQLite's online backup API or the `sqlite3` CLI `.backup` command. Do not copy only the main DB file while the server is running.

Example:

```bash
sqlite3 "$INSIGHTS_DB" ".backup '/backups/qkt-insights-$(date -u +%Y%m%dT%H%M%SZ).db'"
```

Compress and checksum:

```bash
gzip -9 "/backups/qkt-insights-YYYYMMDDTHHMMSSZ.db"
sha256sum "/backups/qkt-insights-YYYYMMDDTHHMMSSZ.db.gz" > "/backups/qkt-insights-YYYYMMDDTHHMMSSZ.db.gz.sha256"
```

## Restore Drill

1. Stop qkt-insights.
2. Move the current database aside.
3. Decompress the selected backup.
4. Start qkt-insights with `INSIGHTS_DB` pointed at the restored file.
5. Confirm `/healthz` returns `{"ok":true}`.
6. Open the UI and verify instances, strategies, trades, deals, equity, and health pages.

## Recovery Objectives

Recommended baseline:

- RPO: 15 minutes for active production systems.
- RTO: 30 minutes for a single-node restore.

Schedule backups accordingly and periodically restore into a throwaway environment to prove the files are usable.
