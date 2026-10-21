# Storage maintenance

What the collector does to keep its SQLite file small, and the one-off step an operator takes
to bring an older database onto the same footing.

## What runs on its own

- **WAL checkpoint** every 10 minutes (`wal_checkpoint(TRUNCATE)`, WAL capped at 64 MiB).
- **Retention prune** 5 minutes after the server starts listening, then weekly
  (`retention-backup-restore.md` lists what it removes). Nothing heavy runs before the server
  listens, so a restart starts taking ingest at once.
- **Returning free pages.** After each prune the collector runs `PRAGMA incremental_vacuum` in
  small steps, yielding to requests between steps, until no free page is left. This only does
  anything on a database created with `auto_vacuum=INCREMENTAL`.

A database created by this version or later is created with `auto_vacuum=INCREMENTAL`. An older
one keeps `auto_vacuum=NONE`: its deletes go to SQLite's free list, the file never shrinks, and
it stays at its largest size ever. Check which one you have:

```bash
docker exec qkt-insights node -e '
  const db = new (require("better-sqlite3"))(process.env.INSIGHTS_DB, { readonly: true });
  const page = db.pragma("page_size", { simple: true });
  console.log({
    autoVacuum: db.pragma("auto_vacuum", { simple: true }),   // 0 = NONE, 2 = INCREMENTAL
    fileMiB: Math.round(db.pragma("page_count", { simple: true }) * page / 2 ** 20),
    freeMiB: Math.round(db.pragma("freelist_count", { simple: true }) * page / 2 ** 20),
  });'
```

`freeMiB` is what a conversion gives back at once; later prunes keep returning their pages.

## Converting an existing database (maintenance window)

The conversion rewrites the whole file with `VACUUM INTO`. It is offline: the collector must be
stopped, and it is never run automatically. Plan for the time it takes SQLite to copy the live
data (minutes for a few GB) and for free disk at least the size of the live data
(`fileMiB - freeMiB`).

qkt keeps journaling envelopes while the collector is down and replays them when it is back, so
nothing is lost; only the dashboard is unavailable.

1. **Back up first** (`retention-backup-restore.md`, Online Backup).
2. **Stop only the insights container**: `docker stop qkt-insights`.
3. **Write the compacted copy** next to the live file, with the new mode set on the same
   connection (the copy takes the mode of the connection that writes it):

   ```bash
   docker run --rm -v <insights-data-volume>:/data -w /app --entrypoint node <insights-image> -e '
     const db = new (require("better-sqlite3"))("/data/insights.db");
     db.pragma("wal_checkpoint(TRUNCATE)");
     db.pragma("auto_vacuum = INCREMENTAL");
     db.prepare("VACUUM INTO ?").run("/data/insights.compact.db");
     db.close();'
   ```

4. **Verify the copy before swapping.** Two full-text indexes point at rows by their implicit
   rowid (`events_fts.event_rowid`, `logs_fts.log_rowid`). SQLite documents that `VACUUM` may
   renumber implicit rowids; it does not in practice for these tables, but check, because a
   renumbered rowid makes search return the wrong rows:

   ```bash
   docker run --rm -v <insights-data-volume>:/data -w /app --entrypoint node <insights-image> -e '
     const D = require("better-sqlite3");
     const src = new D("/data/insights.db", { readonly: true });
     const dst = new D("/data/insights.compact.db", { readonly: true });
     const q = (db, sql) => db.prepare(sql).pluck().get();
     const checks = {
       integrity: q(dst, "PRAGMA integrity_check"),
       autoVacuum: q(dst, "PRAGMA auto_vacuum"),
       eventsOrphanFts: q(dst, "SELECT COUNT(*) FROM events_fts f LEFT JOIN events e ON e.rowid = f.event_rowid WHERE e.rowid IS NULL"),
       logsOrphanFts: q(dst, "SELECT COUNT(*) FROM logs_fts f LEFT JOIN logs l ON l.rowid = f.log_rowid WHERE l.rowid IS NULL"),
     };
     for (const t of ["events", "logs", "deals", "trade_closes", "equity_snapshots", "account_equity", "position_valuations"])
       checks[t] = q(src, `SELECT COUNT(*) FROM ${t}`) === q(dst, `SELECT COUNT(*) FROM ${t}`);
     checks.eventsRowids = q(src, "SELECT group_concat(rowid) FROM (SELECT rowid FROM events ORDER BY rowid DESC LIMIT 1000)")
       === q(dst, "SELECT group_concat(rowid) FROM (SELECT rowid FROM events ORDER BY rowid DESC LIMIT 1000)");
     checks.logsRowids = q(src, "SELECT group_concat(rowid) FROM (SELECT rowid FROM logs ORDER BY rowid DESC LIMIT 1000)")
       === q(dst, "SELECT group_concat(rowid) FROM (SELECT rowid FROM logs ORDER BY rowid DESC LIMIT 1000)");
     checks.dealsRowids = q(src, "SELECT group_concat(rowid) FROM deals") === q(dst, "SELECT group_concat(rowid) FROM deals");
     console.log(checks);'
   ```

   Expect `integrity: "ok"`, `autoVacuum: 2`, both orphan counts `0` and every other check
   `true`. If any check fails, delete the copy and keep the original; do not swap. The one
   exception is `dealsRowids`: the closed-trade projections point at deals by rowid, so if it is
   `false`, swap and run `rebuild all` before starting the container (`projections.md`).

5. **Swap**, keeping the original until the dashboard is confirmed:

   ```bash
   docker run --rm -v <insights-data-volume>:/data --entrypoint sh <insights-image> -c '
     cd /data && mv insights.db insights.pre-compact.db && rm -f insights.db-wal insights.db-shm &&
     mv insights.compact.db insights.db'
   ```

   Remove `insights.db-wal`/`-shm` only after step 3 checkpointed them into the copy; never
   while the collector runs.

6. **Start** the container, confirm `/healthz`, that ingest resumes (Health page: instance
   heard within a minute) and that search finds a recent log line. Then delete
   `insights.pre-compact.db`.

The market-data monitor folds `events` by rowid in memory only; it starts over on the restart in
step 6, so it needs no step of its own.

## Columns that are no longer written

The `*_decimal` columns (added by migration 011) are no longer written; new rows hold NULL there.
They are left in place because dropping a column rewrites its whole table, which would make the
first boot after an upgrade take minutes on a large file. The values in older rows are copies
of the REAL column beside them and are never read.
