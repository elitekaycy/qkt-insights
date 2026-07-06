# Contributing

## Development

- Use Node 22 and pnpm.
- Run `pnpm install` before local development.
- Run `pnpm vitest run` for tests.
- Run `pnpm build:all` before opening a production-facing pull request.

## Pull Requests

- Keep changes scoped to one behavior or operational concern.
- Include tests for ingestion, storage, contract, or UI behavior when those surfaces change.
- Update docs when event contracts, environment variables, deployment behavior, or database migrations change.
- Do not commit secrets, production databases, or generated local state.

## Database Migrations

- Add new SQL files under `packages/store/src/migrations/` using the next zero-padded number.
- Migrations must be forward-only and safe to run once on an existing production database.
- Keep old columns until all readers have moved off them.
