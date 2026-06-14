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

## Uso recomendado

- Tomar estos sitios como referencia cuando se ajuste el parser compartido.
- Usar estos flujos como regresión base antes de tocar nuevos sitios.
- No reabrir estos casos salvo que cambie el HTML real o aparezca una regresion concreta.
