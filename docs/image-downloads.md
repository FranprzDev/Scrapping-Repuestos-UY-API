# Copias propias de imágenes

El descargador se ejecuta dentro de la API y guarda los archivos en el volumen persistente
`IMAGE_STORAGE_ROOT` (`/data/images`). PostgreSQL registra el origen, tamaño y SHA-256.
Las imágenes se sirven por `/api/image-assets/:id`.

## Activación

- `IMAGE_RELAY_ENABLED=true`
- `IMAGE_RELAY_ALLOWED_SITES=*` permite todos los proveedores admitidos por el catálogo.
- `IMAGE_DOWNLOAD_WORKER_ENABLED=true`
- `IMAGE_WORKER_TOKEN` debe contener el token privado ya usado por el relay.
- Montar el volumen persistente en `/data/images`.

La migración `1792080000000_all_provider_image_downloads` encola las URL HTTP/HTTPS
del inventario existente sin duplicar trabajos. Los scrapeos siguientes encolan las fotos nuevas.
No descarga imágenes dentro de la migración ni de los métodos legacy `ensure*`.

El worker procesa una imagen a la vez, espera un segundo entre trabajos y pausa un host
cinco minutos si falla. Reintenta los fallos hasta tres veces, con espera creciente.
Reanuda la cola al reiniciar. Cada archivo admite hasta 10 MiB y se reservan 2 GiB libres;
al alcanzar esa reserva, la descarga pausa sin borrar archivos. Estos límites son configurables.
Los proveedores que no permitan descargar sus fotos quedan registrados como fallidos;
sus URL originales siguen disponibles. Las galerías conservan también los originales pendientes.

Consultar `GET /api/image-downloads/status` para ver archivos, bytes y estados por proveedor.
`completed` significa que el archivo fue escrito y registrado, no solamente descubierto.

## Migración y rollback

La migración es transaccional. Agrega una columna de planificación y dos índices,
y recorre el inventario para insertar trabajos, conservando los existentes por su clave única.
No modifica productos ni descarga fotos durante el pre-deploy. Puede bloquear brevemente
escrituras de la cola mientras agrega la columna; las lecturas del inventario continúan.

Para pausar, configurar `IMAGE_DOWNLOAD_WORKER_ENABLED=false` y desplegar.
Antes de revertir la migración, desplegar código compatible con el esquema anterior.
`down` elimina exclusivamente los trabajos creados por esta migración que nunca se intentaron;
conserva archivos, assets y trabajos ya procesados. No revierte las descargas terminadas.

## Validación de esta implementación

- PostgreSQL 18 temporal: up, down, segunda ejecución sin pendientes, y reaplicación.
- Datos de prueba con fotos repetidas, valores nulos, arrays malformados y URL propias.
- Cola: exclusión temporal de hosts y espera de reintentos.
- Prueba completa con servidor HTTP local: descarga, archivo, SHA-256, registro y lectura.
- Compilación y lint correctos; pruebas del descargador y de inventario correctas.
- La suite general reproduce 16 fallos anteriores de Selvir/Taxitor en `domain-quality.test.ts`,
  también comprobados contra el código anterior sin esta implementación.
