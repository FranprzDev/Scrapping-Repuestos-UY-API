# Scrapping-Repuestos-UY-API

API en NestJS para scraping de catálogos de repuestos con estrategia **híbrida**:
- `FirecrawlProvider` como proveedor principal.
- `CustomProvider` como fallback por dominio o override manual.

## Objetivo puntual (repuestos + precio)

El servicio está preparado para correr una estrategia sobre estos sitios:

- https://acesur.uy/escritorio/home
- https://www.chaparei.com/
- http://www.centrorepuestos.com.uy
- https://www.selvir.com.uy/productos/
- https://www.feyvi.com.uy/
- https://repuestos.uy/
- https://www.tnrepuestos.com.uy/inicio
- https://www.todobaterias.com.uy/
- https://www.familcar.com
- https://repuestosavenida.com.uy/
- https://www.multishop.com.uy/
- https://www.garage1600.com.uy/
- https://taxitor.uy/
- https://viatons.com.uy/

## Cómo lo haría (estrategia recomendada)

1. **Crawl por dominio** para descubrir páginas relevantes de productos/categorías.
2. **Extract con schema** para quedarnos con productos que tengan precio visible.
3. **Normalización** en formato común (`name`, `price`, `currency`, `brand`, `sku`, `productUrl`).
4. **Reintentos por dominio** si cobertura es baja.

Esto ya está modelado en el endpoint batch de catálogo.

## Requisitos

- Node.js 18+
- API key de Firecrawl

## Configuración

```bash
cp .env.example .env
npm install
npm run start:dev
```

## Variables de entorno

- `PORT=3000`
- `FIRECRAWL_API_KEY=fc-...`
- `FIRECRAWL_API_BASE_URL=https://api.firecrawl.dev/v1` (opcional)
- `CUSTOM_PROVIDER_DOMAINS=dominio1.com,dominio2.com` (opcional)

## Endpoints

### Health
- `GET /health`

### Scrape
- `POST /scraping/scrape`
- Query opcional:
  - `provider=firecrawl|custom`
  - `async=true|false`

### Crawl
- `POST /scraping/crawl`
- Query opcional:
  - `provider=firecrawl|custom`
  - `async=true|false`

### Extract
- `POST /scraping/extract`
- Query opcional:
  - `provider=firecrawl|custom`
  - `async=true|false`

### Batch catálogo (repuestos con precio)

#### Ver plan de ejecución
- `GET /scraping/catalog/plan`

#### Ejecutar sobre la lista por defecto
- `POST /scraping/catalog/run`
- `POST /start-scrapping-uy` (alias directo para correr todos los sitios UY de una sola vez)

El proceso hace **upsert de inventario**:
- si encuentra stock/disponibilidad nuevo, lo actualiza,
- si no llega stock en el último scrape, conserva el stock guardado previamente.

Body opcional para customizar límites:

```json
{
  "maxPagesPerSite": 30,
  "maxProductsPerSite": 150
}
```

Body opcional para subset de sitios:

```json
{
  "urls": [
    "https://repuestos.uy/",
    "https://www.todobaterias.com.uy/"
  ],
  "maxPagesPerSite": 20,
  "maxProductsPerSite": 100
}
```

### Estado de job asíncrono
- `GET /scraping/jobs/:id`

### Inventario persistido en memoria
- `GET /scraping/inventory`
- `GET /scraping/inventory?site=https://repuestos.uy/`

## Respuesta unificada

Los endpoints sync devuelven `provider`, `task`, `requestedAt`, `raw` y `normalizedProducts`.

`normalizedProducts` es la base para tu caso de uso (repuestos + precio), aunque conviene enriquecerla por dominio para mejorar precisión.

## Notas importantes

- La normalización actual es heurística; para producción conviene reglas por sitio.
- La cola es en memoria (MVP). Para producción usar Redis/BullMQ.
- Revisar siempre Términos de Uso/robots/políticas legales de cada dominio antes de scraping intensivo.
