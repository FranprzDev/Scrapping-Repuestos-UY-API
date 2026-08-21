# Repuestos Avenida image backfill

This command repairs existing Repuestos Avenida inventory rows whose stored image points to the store logo.

It is intentionally scoped to existing rows where `source_url` starts with:

```text
https://repuestosavenida.com.uy/producto/
```

It never inserts products and only prepares or applies updates to these JSON fields:

- `product.imageUrl`
- `product.imageUrls`

## Dry-run

Dry-run is the default and does not write to the database:

```bash
pnpm run repuestosavenida:images:backfill -- --limit=20
```

The JSON summary reports:

- `totalCandidates`
- `currentLogoOrPlaceholder`
- `newValidImage`
- `withoutValidImage`
- `wouldUpdate`
- `updated`
- `errors`

## Apply

Only run apply after reviewing a dry-run:

```bash
pnpm run repuestosavenida:images:backfill -- --limit=20 --apply
```

For the full correction pass, run without `--limit` only after a limited dry-run and limited apply have both been reviewed:

```bash
pnpm run repuestosavenida:images:backfill -- --apply
```

Do not use this command for other sites. It is deliberately Repuestos Avenida-only.
