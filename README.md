# Scrapping-Repuestos-UY-API

API en NestJS para scraping de catalogos de repuestos con arquitectura hibrida por dominio.

## Alcance actual

El alcance funcional de esta fase esta limitado a estos sitios:

- [Taxitor](https://taxitor.uy/)
- [Acesur](https://acesur.uy/escritorio/ofertas/INTERNET)
- [Chaparei](https://www.chaparei.com/)
- [Selvir](https://www.selvir.com.uy/productos/)

`centrorepuestos.com.uy` fue removido del alcance.
`feyvi.com.uy` quedo pausado fuera del flujo por defecto.

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

## Reglas de negocio activas

- Solo se devuelven productos con precio usable.
- Productos con precio `0` o `0,00` se descartan.
- Productos marcados como `agotado`, `sin stock`, `out of stock` o equivalente se descartan.
- Se rechazan paginas 404, nombres basura y URLs que no parezcan de producto.
- El archivo de salida y el inventario solo reciben productos aprobados por el quality gate.

## Requisitos

- Node.js 18+

## Instalacion

```bash
npm install
npm run start:dev
```

## Variables de entorno

- `PORT=3000`
- `CUSTOM_PROVIDER_DOMAINS=dominio1.com,dominio2.com` opcional

## Endpoints

### Health

- `GET /health`

### Scrape individual

- `POST /scraping/scrape`
- `POST /scraping/crawl`
- `POST /scraping/extract`

Query opcional:

- `provider=domain|playwright|custom`
- `async=true|false`

### Batch catalogo

- `POST /scraping/catalog/run`
- `POST /start-scrapping-uy`

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

### Jobs asincronos

- `GET /scraping/jobs/:id`

## Salida

Los endpoints sync devuelven:

- `provider`
- `task`
- `requestedAt`
- `raw`
- `normalizedProducts`

Los catalogos archivados se escriben en:

- `output/catalog/<hostname>.json`

Las imagenes descargadas se escriben en:

- `output/images/<hostname>/`

## Estado de esta fase

- Persistencia real en DB: pendiente.
- Cola externa: pendiente.
- Observabilidad y hardening operativo: pendiente.
- El sistema sigue en estado de preproduccion operativa hasta terminar esas fases.
