# Diagnostico de produccion: inventario incompleto y faltantes de Chaparei

## Contexto

En produccion se observa un inventario de alrededor de `550` items y faltantes visibles en Chaparei y otros sitios.  
Este documento resume el diagnostico inicial usando una lectura SDD:

- `S` = Sintoma
- `D` = Diagnostico
- `D` = Decision / siguiente paso

> Alcance: este diagnostico esta hecho desde el codigo del repo y la estructura publica actual del sitio.  
> No incluye acceso directo a la base de datos de produccion.

## Sintoma

- El inventario persistido en produccion se queda en un numero cercano a `550`.
- Chaparei no aparece completo.
- El sistema si esta escribiendo inventario en PostgreSQL, pero el total final es bajo para el alcance declarado.

## Diagnostico

### 1) Hay un techo duro por sitio que puede explicar que el total se quede cerca de 550

En el flujo batch, el sistema usa por defecto:

- `maxPagesPerSite = 30`
- `maxProductsPerSite = 150`
- `siteConcurrency = 2`

Eso esta en `scrapeCatalogWithPrices()`. Si el job se ejecuta sin body o con body vacio, el pipeline cae en esos defaults.

Ademas, el flujo batch recorre `DEFAULT_CATALOG_SITES`, que hoy son solo 4 sitios.

Interpretacion:

- Con `150` productos maximos por sitio, el techo teorico es aprox. `600`.
- Ver un total de `550` en produccion es coherente con un sistema que ya esta muy cerca de ese limite.
- Por eso el numero no sugiere "la DB esta fallando"; sugiere "el pipeline esta truncando el universo temprano".

### 2) Chaparei esta desalineado con la estructura publica actual del sitio

La regla actual de Chaparei en codigo espera:

- seed: `https://www.chaparei.com/productos/?m=171`
- productos: URLs que hagan match con `/catalogo/.+-[a-z]\d{7}/?`
- categorias: URLs que hagan match con `/productos/?m=`, `/catalogo/`, `/ofertas/`, `/outlet/`

El problema es que la web publica de Chaparei hoy expone URLs como:

- `https://www.chaparei.com/productos/?c=4488&m=171`
- `https://www.chaparei.com/productos/productos.php?c=3822&m=171`

Esas URLs no matchean la regla actual:

- no cumplen el patron de producto `/catalogo/...`
- la categoria esperada `/productos/?m=` no coincide con `?c=...&m=171`

Consecuencia tecnica:

- `extractCandidateLinks()` solo toma links que matchean `productUrlPatterns` o `categoryUrlPatterns`.
- `extractListProducts()` solo arma productos desde anchors que matchean `productUrlPatterns`.
- `extractDetailProduct()` solo corre si la pagina tambien matchea `productUrlPatterns`.

Resultado:

- Chaparei puede quedar casi invisible para el crawler/extractor actual.
- Si el sitio dejo de usar los patrones que el scraper espera, la cobertura cae drasticamente aunque el sitio siga teniendo muchos productos.

### 3) El filtro de calidad puede bajar aun mas el conteo

Despues de extraer, el sistema aplica `qualityGate()`.

Ese filtro elimina productos que:

- no tienen precio usable
- tienen precio `0`
- se consideran no vendibles
- son marcados como `agotado`, `sin stock`, `out of stock`, `no disponible`, etc.
- no pasan reglas de URL o de disponibilidad

Entonces el numero final en inventario no es "todo lo que se descubrio", sino solo lo que sobrevivio al filtrado.

Esto no explica por si solo la ausencia de Chaparei, pero si puede recortar aun mas el total.

### 4) El inventario guarda solo lo que se deduplica y persiste

La tabla `scraping_inventory` se llena por upsert con una clave construida como:

- `site|url|sourceUrl`
- o `site|sku|sku`
- o `site|name|productName|brand`

Si dos items quedan con la misma clave, se consolidan.

Por lo tanto:

- el conteo de produccion es conteo de filas persistidas, no de hallazgos brutos
- duplicados o variantes pobres de URL/SKU pueden colapsar en una sola fila

## Evidencia en el codigo

- Defaults del batch: `src/scraping/catalog-scraping.service.ts`
- Sitios por defecto: `src/scraping/dto/catalog-request.dto.ts`
- Reglas de Chaparei: `src/scraping/domain/domain-rules.ts`
- Discovery y extraccion por URL: `src/scraping/domain/domain-html.ts`
- Filtro de calidad: `src/scraping/domain/product-quality.ts`
- Conteo y upsert de inventario: `src/scraping/inventory/inventory-store.service.ts`

## Decision

### Hipotesis principal

El inventario en produccion se queda en ~`550` por una combinacion de:

1. limite por sitio demasiado bajo para el alcance real
2. regla de Chaparei desactualizada respecto del sitio actual
3. filtrado de calidad que reduce aun mas el resultado final

### Priorizacion

1. **Alta prioridad**: corregir Chaparei para que descubra y extraiga las URLs reales del sitio actual.
2. **Alta prioridad**: revisar si `maxProductsPerSite = 150` sigue siendo un limite aceptable para produccion.
3. **Media prioridad**: auditar cuantos productos quedan fuera por `qualityGate()` y por deduplicacion.

## Siguiente validacion recomendada

1. Correr un `quick-run` solo contra Chaparei y revisar cuantas URLs descubre y cuantos productos persiste.
2. Comparar `scraping/runs/:runId` para ver:
   - `pagesUsedForExtract`
   - `normalizedProducts`
   - `inventorySize`
3. Ajustar la regla de Chaparei para contemplar las URLs reales (`/productos/?c=...&m=171` y `/productos/productos.php?...`).
4. Repetir la corrida completa y verificar si el total sube claramente por encima de `550`.

## Nota final

Este diagnostico no afirma un bug de base de datos.  
El patron encaja mejor con un scraper que:

- descubre menos de lo que el sitio realmente tiene
- filtra agresivamente
- y ademas tiene un tope por sitio que puede estar quedando corto

## Estado de la correccion

Se corrigieron tres puntos principales:

- el filtrado dejo de expulsar productos por stock o por precio cero y ahora solo anota warnings
- Chaparei paso a usar discovery y extraccion semantica para enlaces y paginas que no coinciden exactamente con un regex rigido
- los sitios por defecto quedaron alineados con los seeds reales de cada dominio
- los limites por defecto subieron para no truncar por accidente el batch completo

Validacion local ejecutada sobre el build actual:

- Chaparei en vivo: `crawl` descubrio `300` URLs y `extract` llego a `146` productos al procesar todas las URLs descubiertas
- batch completo in-memory sobre los 4 sitios por defecto: `5533` productos unicos en total, con todos los sitios procesados con exito

Esto mejora de forma real la cobertura y supera ampliamente el umbral anterior de ~`550`, aunque sigue siendo una base de trabajo y no una demostracion matematica de exhaustividad absoluta sobre cada sitio.
