# Repository instructions

## Database changes

Every database schema or data transformation must be implemented as a versioned migration in `migrations/` using `node-pg-migrate`.

- Do not add `ALTER`, destructive `DELETE`, backfills, constraints, or indexes to application startup hooks or `PostgresService.ensure*` methods.
- Treat the existing `ensure*` schema setup as legacy compatibility code; do not extend that pattern.
- Migrations must be deterministic, transactional when supported, safe to run before a Railway deployment, and include an explicit `down` migration when rollback is technically possible.
- Validate migrations against a temporary PostgreSQL instance before publishing.
- Run `pnpm run db:migrate` locally after starting PostgreSQL.
- Railway runs pending migrations through the configured `preDeployCommand` before activating the new deployment.

Follow [docs/database-migrations.md](docs/database-migrations.md) for the required workflow and review checklist.
