# Scrapping-Repuestos-UY-API

API en NestJS para scraping de catalogos de repuestos con arquitectura hibrida por dominio.

## Alcance actual

El alcance funcional de esta fase esta limitado a estos sitios:

- [Taxitor](https://taxitor.uy/)
- [Acesur](https://acesur.uy/escritorio/ofertas/INTERNET)
- [Chaparei](https://www.chaparei.com/)
- [Selvir](https://www.selvir.com.uy/productos/)
- [Feyvi](https://www.feyvi.com.uy/repuestos/)

`centrorepuestos.com.uy` fue removido del alcance.
`feyvi.com.uy` queda incluido por categorias fijas con paginacion dinamica.

## Arquitectura actual

La estrategia ya no es Playwright-first.

El pipeline actual funciona asi:

1. Descubrimiento por dominio.
2. Extraccion por `HTTP + parseo HTML/JSON-LD` o por API nativa cuando existe.
3. Filtro central de calidad y disponibilidad.
4. Fallback a Playwright solo cuando el sitio no expone datos suficientes por HTTP.
5. Archivo JSON en disco + inventario temporal en memoria.

### Estrategias por sitio

- `acesur.uy`: API directa paginada sobre `app_obtener_productos.php`.
- `taxitor.uy`: HTML server-rendered.
- `chaparei.com`: HTML server-rendered.
- `selvir.com.uy`: HTML + JSON-LD.
- `feyvi.com.uy`: HTML paginado por categoria con discovery dinamico de paginas.

## Reglas de negocio activas

- Solo se devuelven productos con precio usable.
- Productos con precio `0` o `0,00` se descartan.
- Productos marcados como `agotado`, `sin stock`, `out of stock` o equivalente se descartan.
- Se rechazan paginas 404, nombres basura y URLs que no parezcan de producto.
- El archivo de salida y el inventario solo reciben productos aprobados por el quality gate.

## Base de datos

Los cambios de esquema y las transformaciones persistentes se realizan exclusivamente mediante migraciones versionadas. Consulta [docs/database-migrations.md](docs/database-migrations.md) antes de modificar la base de datos.

## Requisitos

- Node.js 20.11+

## Instalacion

```bash
npm install
npm run start:dev
```

## Variables de entorno

- `PORT=3000`
- `CUSTOM_PROVIDER_DOMAINS=dominio1.com,dominio2.com` opcional
- `DOMAIN_EXTRACT_CONCURRENCY=4` concurrencia interna de extract por dominio
- `AUTO_SCRAPE_ENABLED=false` activa scheduler automatico
- `SCRAPE_CRON=0 0 3 * * *` cron (segundos minutos horas dia mes diaSemana)
- `SCRAPE_TIMEZONE=America/Argentina/Buenos_Aires` timezone del cron

## Endpoints

### Health

- `GET /health`

### Home

- `GET /`
- Landing ligera para operacion y acceso rapido a los endpoints principales.

### Scrape individual

- `POST /scraping/scrape`
- `POST /scraping/crawl`
- `POST /scraping/extract`

Query opcional:

- `provider=domain|playwright|custom`
- `async=true|false`

### Batch catalogo

- `POST /scraping/catalog/run`
- `POST /scraping/inventory/refresh`
- `POST /start-scrapping-uy`

`POST /scraping/catalog/run` encola un job y responde `202 Accepted` con `jobId`.
Los endpoints de refresh aceptan `exclude_sites` en query string para omitir casas por `id`, hostname o label, por ejemplo `?exclude_sites=feyvi,selvir`.

Body opcional:

```json
{
  "urls": [
    "https://acesur.uy/escritorio/ofertas/INTERNET",
    "https://taxitor.uy/"
  ],
  "maxPagesPerSite": 30,
  "maxProductsPerSite": 150
}
```

### Inventario temporal

- `GET /scraping/inventory`
- `GET /scraping/inventory?site=https://taxitor.uy/`

### Refresh completo

- `POST /scraping/inventory/refresh`
- Fuerza el scraping del set validado de sitios activos.

### Jobs asincronos

- `GET /scraping/jobs/:id`
- `GET /scraping/runs`
- `GET /scraping/runs/:runId`

## Automatizacion diaria (cada 24h)

Este proyecto usa `@nestjs/schedule` para ejecutar scraping automatico.

1. Configura en `.env`:
   - `AUTO_SCRAPE_ENABLED=true`
   - `SCRAPE_CRON=0 0 3 * * *` (03:00 todos los dias)
   - `SCRAPE_TIMEZONE=America/Argentina/Buenos_Aires`
2. Levanta la app normalmente (`docker compose up -d --build`).
3. La corrida diaria dispara internamente `scraping/catalog/run` para todos los sitios por defecto.

Para disparo manual desde consola:

```bash
npm run scrape:daily
```

## Salida

Los endpoints sync devuelven:

- `provider`
- `task`
- `requestedAt`
- `raw`
- `normalizedProducts`

Los catalogos archivados se escriben en:

- `output/catalog/<site-key>.json`

## Estado de esta fase

- Persistencia real en DB: pendiente.
- Cola externa: pendiente.
- Observabilidad y hardening operativo: pendiente.
- El sistema sigue en estado de preproduccion operativa hasta terminar esas fases.
