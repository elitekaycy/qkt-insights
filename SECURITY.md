# Security Policy

## Reporting

Please report security issues privately to the repository owner. Do not open a public issue for vulnerabilities, leaked credentials, auth bypasses, or data exposure.

Include:

- affected version or commit
- reproduction steps
- expected impact
- any relevant logs with secrets removed

## Supported Deployment Baseline

- Run behind TLS in production.
- Set a long random `INGEST_TOKEN`.
- Set a long random `SESSION_SECRET`.
- Replace the default `ADMIN_PASSWORD`.
- Keep the SQLite database and backups outside the web root.
- Restrict access to database backups; they may contain trading history and account metadata.

## Secret Handling

Never commit `.env`, SQLite database files, exported backups, API tokens, broker credentials, or session secrets.
