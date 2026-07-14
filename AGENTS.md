# Repository Instructions

This file is the root instruction file for automated coding work in this
repository. Keep it synchronized with `CLAUDE.md`; this file is the concise
always-read version.

## Working Style

- Be direct and pragmatic. Call out wrong assumptions or risky requests with
  reasons.
- Make the smallest reasonable change that actually solves the problem.
- Prefer simple, readable, maintainable code over clever code.
- Match surrounding style exactly.
- Fix bugs found while working when they are in scope.
- Do not rewrite or throw away existing implementations without explicit
  permission.

## Naming And Comments

- Names describe what something is, not how it was built or when it changed.
- Avoid names with temporal or transitional language such as `new`, `old`,
  `legacy`, `wrapper`, `unified`, or `enhanced`.
- Comments should explain what or why, never narrate obvious code.
- Do not add useless comments.
- Do not remove existing comments unless they are actively false.
- No emoji in code, docs, commits, or templates.

## Project Shape

- Node project using `pnpm`.
- TypeScript strict mode.
- Tests use Vitest.
- SQLite uses `better-sqlite3`.
- The app is a qkt observability dashboard with contract, collector, store, API,
  web UI, and server modes.
- Before adding or materially changing a chart, dashboard widget, metric card,
  or visualization layout, read and follow
  `.claude/skills/qkt-insights-chart-design/SKILL.md`.

## TypeScript Rules

- No `any` in exported signatures.
- Prefer schema-backed payload validation at boundaries.
- Keep contract, collector, store, API, and UI types aligned.
- Use real SQLite and real HTTP paths in integration-style tests.
- Do not test mocked behavior for end-to-end flows.

## Testing

- All test failures are the current work's responsibility until understood.
- Never delete a failing test to make a run green.
- Use real data paths and real APIs in end-to-end tests.
- Captured errors should be asserted or avoided; test output should stay clean.
- Run focused tests while iterating, then run:

```bash
pnpm build:all
pnpm test
```

Use Node 22 for local verification, matching CI:

```bash
PATH=/home/dickson/.local/share/mise/installs/node/22.22.1/bin:$PATH pnpm build:all
PATH=/home/dickson/.local/share/mise/installs/node/22.22.1/bin:$PATH pnpm test
```

If `better-sqlite3` reports a native ABI mismatch, rebuild it under Node 22:

```bash
PATH=/home/dickson/.local/share/mise/installs/node/22.22.1/bin:$PATH pnpm rebuild better-sqlite3
```

## Version Control

- Ask before committing unless the user explicitly requests commit/PR/push work.
- Always inspect `git status` before staging.
- Do not use `git add -A` unless the intended scope is the whole repo and status
  has been reviewed.
- Do not skip, evade, or disable hooks.
- Commit subject only. No body, footer, attribution, or emoji.

## CI And Docker Expectations

- CI must run build/test before Docker publish.
- Docker smoke should boot the image, verify `/healthz`, and exercise ingest.
- Main branch publish should push GHCR tags with immutable `sha-*` tags and
  `latest` when appropriate.
- Production images should include health checks and read runtime configuration
  from environment variables.

## Local Hygiene

- Use `rg` for search.
- Do not revert unrelated local changes.
- Do not stage unrelated files.
- Keep docs and examples aligned with code behavior when payloads, env vars,
  migrations, or API routes change.
