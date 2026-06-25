# Informe tecnico: factibilidad de agregar filtros como "Marca de auto"

## Respuesta corta

Si, es posible extender este proyecto para agregar filtros nuevos como `Marca de auto`.
La base tecnica ya existe: el sistema no solo hace scraping, sino que tambien persiste productos normalizados, expone un inventario consultable y ya filtra por varios atributos derivados del producto.

## Contexto del proyecto

Este repositorio ya trabaja con una arquitectura que separa:

- descubrimiento y extraccion por dominio,
- normalizacion de productos,
- persistencia del inventario,
- y consulta filtrada desde la API.

Eso es importante porque un filtro nuevo no exige rehacer el scraper completo.
En la practica, lo que haria falta es:

1. asegurar que el dato de marca exista con suficiente consistencia,
2. exponer ese atributo como filtro de consulta,
3. y, si corresponde, mostrarlo en la interfaz.

## Que ya permite el codigo actual

Hoy el modelo de producto ya contempla campos utiles para este caso:

- `brand`
- `category`
- `description`
- `compatibleBrands`
- `compatibleVehicles`

Ademas:

- el extractor ya intenta recuperar `brand` en varios dominios,
- el normalizador central conserva ese campo,
- y el inventario ya permite buscar por `brand`, `category` y `description` dentro del texto consultable.

En otras palabras: la infraestructura para filtrar por atributos de producto ya esta montada.

## Que significa realmente "Marca de auto"

Acá conviene separar dos casos distintos, porque no son lo mismo:

### 1. Marca del repuesto

Ejemplo:

- Bosch
- Monroe
- Valeo

Este caso es mas simple.
Si el producto trae `brand`, el filtro se puede agregar de forma directa.

### 2. Marca del vehiculo compatible

Ejemplo:

- Fiat
- Toyota
- Chevrolet

Este caso es mas exigente.
No siempre esta explicito en la ficha del producto.
Muchas veces aparece en:

- el titulo,
- la descripcion,
- atributos HTML,
- o estructuras JSON-LD.

Si el objetivo es filtrar por compatibilidad real del vehiculo, conviene usar `compatibleBrands` o construir un campo especifico de compatibilidad normalizada.

## Factibilidad real

### Alta factibilidad

Si el filtro es sobre `brand` del producto y la data ya viene cargada en el inventario.

### Factibilidad media

Si se quiere filtrar por marca del vehiculo, pero aceptando que algunos sitios no la expongan siempre de forma estructurada.

### Factibilidad alta pero con trabajo adicional

Si se quiere una experiencia solida tipo catalogo, con:

- listado de marcas disponibles,
- autocompletado,
- conteos por marca,
- y normalizacion entre alias como `VW`, `Volkswagen` o `V.W.`.

## Que habria que implementar

### Backend

- agregar un parametro de filtro como `brand` o `vehicleBrand`,
- normalizar el valor de entrada,
- ampliar la condicion SQL del inventario,
- y, si se quiere hacerlo bien, indexar o precomputar marcas normalizadas.

### Extraccion

- revisar por dominio si la marca se extrae correctamente,
- ampliar selectores o reglas de parsing cuando falte,
- y estandarizar aliases de marca.

### UI

- agregar un selector o buscador de marcas,
- cargar marcas disponibles desde el inventario,
- y mantener el value tecnico separado del label visible.

## Riesgos

- No todos los sitios publican la marca de forma uniforme.
- La misma marca puede aparecer con varios alias.
- Un filtro basado solo en texto puede ser util, pero no siempre exacto.
- Si se filtra por compatibilidad de vehiculo, la calidad depende mucho de la fuente.

## Recomendacion

La mejor secuencia seria esta:

1. Primero agregar un filtro simple por `brand` del producto.
2. Despues normalizar alias de marcas mas comunes.
3. Luego, si hace falta, sumar un filtro mas semantico por `compatibleBrands`.
4. Finalmente, construir un catalogo de marcas disponibles para la UI.

## Conclusion

Si, este mismo proyecto puede ampliarse para soportar filtros como `Marca de auto`.
La arquitectura actual ya tiene la base necesaria para hacerlo sin rehacer el sistema.

La clave no es tanto el filtro en si, sino la calidad y normalizacion del dato.
Si el objetivo es una primera version util, el camino mas corto es filtrar por `brand`.
Si el objetivo es un filtro robusto de compatibilidad real del vehiculo, hace falta una capa adicional de normalizacion y enriquecimiento de datos.
