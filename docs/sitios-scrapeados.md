# Sitios ya validados

Estos son los sitios que hoy damos por bien scrapeados y que conviene reutilizar como base estable.

## Cerrados

- `Taxitor`
  - URL base: `https://taxitor.uy/`
  - Cobertura: listado HTML paginado, detalle de producto, `productName`, `sourceUrl`, `price`, `currency`

- `Selvir`
  - URL base: `https://www.selvir.com.uy/`
  - Cobertura: categorías HTML, detalle de producto, extracción de cards y paginacion del archive

- `Feyvi`
  - URL base: `https://www.feyvi.com.uy/`
  - Cobertura: categorias de repuestos, listado y detalle de producto

- `Europarts`
  - URL base: `https://www.europarts.com.uy/es/search?recordsize=100`
  - Cobertura: grilla completa de productos, total dinámico, nombre, precio y clasificación por marca vehicular

- `Multishop`
  - URL base: `https://www.multishop.com.uy/`
  - Cobertura: catálogo Shopify JSON paginado, variantes, precio, stock, SKU, imagen y categoría

- `Cymaco`
  - URL base: `https://cymaco.com.uy/catalogo`
  - Cobertura: 110 marcas compatibles, paginación Fenicio `js=1&pag=N`, productos únicos y relaciones producto-marca

- `Familcar`
  - URL base: `https://www.familcar.com/`
  - Cobertura: 26 marcas del menú, paginación Fenicio `js=1&pag=N`, precio, stock, SKU y marca compatible

- `Larrique`
  - URL base: `https://larrique.com.uy/repuestos-autopartes/1`
  - Cobertura: descubrimiento dinámico de 142 marcas, cálculo de página final acumulada, precio, SKU y relaciones producto-marca

- `GR Frenos`
  - URL base: `https://www.grfrenos.uy/home/`
  - Cobertura: descubrimiento de marcas, catálogo por marca, detalle de producto, precio, compatibilidad e imagen del producto
  - Imágenes: se toma la imagen real del bloque `.producto__imagenes` (o `section.producto`) y se normaliza a una URL absoluta. No se usa `og:image` como sustituto porque en este sitio puede apuntar a una imagen genérica o distinta del producto.

## Integrados pendientes de validación live

- `Yaguarón`
  - URL base: `https://www.yaguaron.com.uy/`
  - Integración Fenicio específica: menú de categorías/modelos, listado `aListProductos`, paginación AJAX `js=1&pag=N` y fichas `/catalogo/{slug}_{id1}_{id2}`.
  - Campos: título, Art./SKU, precio UYU, descripción, características, calidad, fabricante, referencias, imágenes, disponibilidad, stock, categoría y modelos compatibles.
  - Diagnóstico de catálogo: `pnpm run catalog:probe --site=yaguaron --max-pages=3 --max-products=20 --capture-html=true`.
  - Diagnóstico de ficha: `pnpm run catalog:probe --site=yaguaron --product-url=https://www.yaguaron.com.uy/catalogo/kit-de-distribucion-tensor-y-correa-varios-modelos_123251_123251 --capture-html=true`.
  - Ambos modos escriben `tmp/catalog-probe/yaguaron.json`; `--capture-har=true` guarda un HAR cuando se utiliza el fallback de Playwright.
  - Falta una corrida live exitosa desde un entorno con acceso al origen; no debe considerarse cerrado hasta comparar el total declarado, URLs únicas, guardados y rechazados.

- `Italur` y `Mirvic`
  - Permanecen sin adaptador específico y pendientes de implementación/validación live.

## Pendientes

- `Autopartes Gil`
  - Se mantiene fuera del refresh hasta que el sitio vuelva a responder de forma estable.

## Uso recomendado

- Tomar estos sitios como referencia cuando se ajuste el parser compartido.
- Usar estos flujos como regresión base antes de tocar nuevos sitios.
- No reabrir estos casos salvo que cambie el HTML real o aparezca una regresion concreta.
