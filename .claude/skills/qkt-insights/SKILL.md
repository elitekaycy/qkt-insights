---
name: qkt-insights
description: Use when working in the qkt-insights repository — the broker-truth trading dashboard (Fastify + SQLite backend, React/Vite frontend, pnpm monorepo). Covers the build/test incantations and their footguns, workspace layout, contract-alignment rule, migrations, and the deploy/env contract. Invoke at the start of any qkt-insights task.
---

# qkt-insights — repo mechanics

Broker-truth pipeline and dashboard for live qkt trading. Node ≥22,
`pnpm` workspaces, TypeScript strict ESM. Backend: Fastify 5 + better-sqlite3
+ zod + argon2. Frontend: React 18 + Vite 5 + Tailwind v4 + react-query +
ECharts. Tests: Vitest. The engineering constitution lives in `CLAUDE.md` /
`AGENTS.md` (kept in sync); this skill is the mechanical knowledge those
don't carry.

## 1. The incantations (footguns included)

- Node 22 comes from mise and is NOT always on PATH for spawned shells:

  ```bash
  PATH=/home/dickson/.local/share/mise/installs/node/22.22.1/bin:$PATH \
    pnpm build:all && pnpm test
  ```

- `better-sqlite3` is a native module; after a Node version change or fresh
  install, an ABI mismatch error means: `pnpm rebuild better-sqlite3`.
- Commands: `pnpm build:all` (packages + web), `pnpm test`, `pnpm lint`,
  `pnpm --filter @qkt-insights/web build` (web only).
- `pnpm build` copies `packages/store/src/migrations/*.sql` into `dist/` —
  a migration edit without a rebuild tests the OLD schema. Always rebuild
  before trusting a migration test.

## 2. Workspace layout and the alignment rule

```
src/server.ts            # root entry → dist/src/server.js (pnpm start)
packages/contract        # shared zod schemas + types — the source of truth
packages/collector       # ingest from the gateway/engine
packages/store           # SQLite + src/migrations/*.sql
packages/api             # Fastify routes
apps/web                 # React dashboard
```

**Contract-alignment rule:** a change to `packages/contract` is incomplete
until collector, store, api, and web are updated in the same change — the
compiler enforces types, but zod schemas and SQL columns drift silently.
Grep all four consumers for the changed field before calling it done.

## 3. Testing

Per the constitution: real SQLite (`:memory:` or temp file) and real HTTP in
e2e — never mocks. Each package has its own `test/` dir. Vitest runs from
root (`pnpm test`) or per package (`pnpm --filter <pkg> test`).

## 4. Deploy / env contract

- CI (`.github/workflows/ci.yml`): test → docker-smoke (boots the prod
  image, asserts `/healthz` returns `"ok":true`, exercises `/ingest` with a
  Bearer token expecting `"accepted":0`) → publish to GHCR
  (`ghcr.io/<repo>`, tags `sha-*`, `latest` on main, `v*`).
- App port **8420**. Required runtime env: `INSIGHTS_DB`, `INGEST_TOKEN`,
  `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET` (≥32 chars).
- A change to `/healthz` or `/ingest` response shapes breaks docker-smoke —
  update the workflow in the same PR.
- Root `insights.db` is a real local database — never commit it, never
  delete it casually.

## 5. Docs discipline

Dated design specs in `docs/specs/YYYY-MM-DD-<topic>-design.md`, plans in
`docs/plans/`, ops runbooks in `docs/operations/` (e.g.
`retention-backup-restore.md`). Same spec→plan→implement lifecycle as qkt.

## Living document

When this skill is wrong or incomplete, fix it in the same PR that proved it
wrong. Keep it mechanics-only — posture and style rules live in CLAUDE.md.
