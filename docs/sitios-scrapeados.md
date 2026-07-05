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

## Pendientes

- `Autopartes Gil`
  - Se mantiene fuera del refresh hasta que el sitio vuelva a responder de forma estable.

## Uso recomendado

- Tomar estos sitios como referencia cuando se ajuste el parser compartido.
- Usar estos flujos como regresión base antes de tocar nuevos sitios.
- No reabrir estos casos salvo que cambie el HTML real o aparezca una regresion concreta.
