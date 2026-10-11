# Feyvi: diagnóstico y recuperación segura

Base de trabajo: `FranprzDev/Scrapping-Repuestos-UY-API`, main `c8c6920`, rama `fix/feyvi-safe-recovery`. El commit `1453b22` del PR #91 ya está integrado; sus mejoras y fixture original se conservan. Mercado Libre y los otros extractores no se modifican.

## Hallazgos comprobados

- El backfill del PR #91 no incluía precio ni SKU en la extracción ni en el UPDATE. Reejecutarlo no podía recuperar esos campos.
- La ficha pública del ruleman publica precio **681 UYU**, SKU **55565098GMC** y disponibilidad `InStock`. El extractor anterior ya obtenía precio/SKU, pero devolvía `out_of_stock` por señales globales de la página. Por tanto, no se atribuye el “Consultar precio” reportado a una causa concreta en PostgreSQL/frontend sin observar esas capas.
- Los selectores de precio anteriores eran amplios y elegían el primer texto de precio; no vinculaban precio actual e identidad del producto. El fallback de SKU podía tomar el texto completo de body. La extracción especializada ahora prioriza precio actual por ID, microdatos y campos monetarios explícitos; ignora códigos, negativos, cero, valores malformados y productos recomendados.
- El inventario reemplazaba todo el JSON durante sincronización. Ahora las actualizaciones Feyvi preservan campos ausentes/vacíos, precios válidos frente a entradas inválidas, imágenes existentes válidas/locales y compatibilidades. Las relaciones históricas Feyvi se conservan; no se generan compatibilidades nuevas desde títulos/fabricante.
- El backfill anterior no actualizaba el texto materializado de búsqueda ni añadía las relaciones de marcas explícitamente publicadas. La recuperación nueva lo hace dentro de una función versionada por migración, con respaldo y control de concurrencia.
- La descripción anterior del ruleman provenía de publicidad de la tienda. Ahora solo se acepta descripción de producto explícita; si no existe, se preserva la anterior durante recuperación.

## Lo que no se puede afirmar sin acceso real

No hay conexión PostgreSQL/Railway configurada en este entorno. No se realizaron SELECT ni escrituras en producción. Los **1.062 sin precio** y **316 inferiores a $20** son cifras reportadas, no resultados de esta auditoría. Total real Feyvi, sin precio, sospechosos, SKU faltantes y recuperables quedan pendientes de ejecutar la auditoría completa.

Los archivos `feyvi-precio-20.txt` y `Markdown pegado.md` aún no estaban disponibles al realizar estas pruebas. Se incluyeron cinco fichas reales adicionales, sin limitar el backfill a ellas.

`adriandutra124/scrapping-rshop` devuelve Repository not found con el acceso Git disponible. No se modificó ni se validó el frontend, búsquedas/exportaciones del frontend o su sincronización. La conversión del backend de precio textual a número está verificada: el ruleman recuperado se devuelve como `681`, y `7,263` como `7263`.

## Alcance y garantías

- Dry-run por defecto: únicamente SELECT a la base y reporte local. No escribe checkpoints ni eventos en PostgreSQL.
- Selección de todas las fichas Feyvi por cursor estable `id`, lotes configurables (máximo 1.500) y procesamiento serial. La auditoría SQL incluye también URLs Feyvi antiguas/no válidas para inspección manual.
- Hasta dos reintentos adicionales de errores transitorios; no se reintentan 403 ni CAPTCHA. Respuestas no 200, redirecciones a otra ficha, HTML incompleto o discrepancia de SKU se registran y no se aplican.
- Escritura explícita con `--apply`, `--run-id` y `--limit` o `--all`. No hay aplicación automática al arrancar el servicio.
- Respaldo atómico del JSON anterior, texto de búsqueda, fecha de actualización y relaciones. Bloqueo por fila y comparación del JSON leído para evitar sobrescribir modificaciones concurrentes.
- Reanudación con la misma run-id: omite filas respaldadas/terminadas; vuelve a intentar las fallidas. Los eventos se conservan sin sobrescribir errores anteriores.
- Una nueva auditoría/actualización futura utiliza una nueva run-id. No reutilizar una run-id restaurada.
- Los importes menores a $20 se marcan para investigación; nunca se elevan a $20 por regla artificial. Solo se adopta el precio publicado en la ficha.
- No se eliminan duplicados automáticamente. Una discrepancia entre SKU histórico y ficha requiere revisión.
- Un URL de imagen válido no demuestra que la foto sea correcta ni otorga derechos. Se preservan fotos válidas existentes; las discrepancias visuales requieren revisión.

## Validación realizada

- 36 pruebas enfocadas en Feyvi e inventario aprobadas, incluyendo integración real con PostgreSQL local.
- Cinco fixtures reales: precios `681`, `71`, `7,263`, `194`, `94`; SKUs `55565098GMC`, `26278125GMC`, `22917172GMC`, `93397877GMC`, `96657229GMC`.
- PostgreSQL temporal `feyvi_validation`: dry-run, cinco actualizaciones con respaldo, reanudación sin repetición, búsqueda/API numérica, preservación de datos en sincronización posterior, rechazo de escritura concurrente y restauración exacta.
- Build y lint aprobados. Imagen Docker construida con la CA y el proxy de la sesión mediante un Dockerfile temporal (sin deshabilitar verificación); API del contenedor y Chromium comprobados.
- CLI contra cinco fichas públicas en una base exclusivamente local: dry-run 5 recuperables/0 escrituras, aplicación 5/5 sin errores, reanudación 0 candidatos y 0 cambios; restauración por CLI 5/5 sin errores.
- Suite general: 340 tests, 320 aprobados, 16 fallidos, 4 omitidos. Los 16 fallos son Taxitor/Selvir y se reprodujeron en el main original sin cambios (93 tests de domain-quality: 76 aprobados, 16 fallidos, 1 omitido). No se desactivaron ni cambiaron sus aserciones. Los omitidos incluyen pruebas live opcionales, Chromium no instalado y la integración PostgreSQL cuando no se habilita su variable de test.
- Cliente HTTP real: Feyvi responde HTTP 200 por el proxy del entorno con TLS verificado. Se eliminó el uso previo de `rejectUnauthorized:false`; no se deshabilita confianza TLS para hacer pasar una descarga.

La migración agrega funciones/tablas y no reescribe registros históricos por sí sola. El rollback de esquema conserva los respaldos/eventos; el código anterior debe restaurarse también si se eliminan las funciones que usa el código nuevo.

## Comandos para Railway

Ejecutar dentro del servicio **Scrapping-Repuestos-UY-API**, proyecto **amiable-reverence**, entorno **production**, desde `/app`. Usar la `DATABASE_URL` existente; no imprimirla ni sustituirla. Estos comandos están preparados, no ejecutados en producción.

### Auditoría de solo lectura

Después de publicar la versión que contiene el CLI (la publicación requiere autorización):

```sh
mkdir -p output/feyvi-recovery
node dist/scraping/backfills/feyvi-audit.cli.js > output/feyvi-recovery/audit-before.json
node dist/scraping/backfills/feyvi-product-backfill.cli.js --dry-run --batch-size=100 --report=output/feyvi-recovery/dry-run.json
```

Antes de publicar también se puede ejecutar `docs/sql/feyvi-audit.sql` directamente en el editor SQL conectado a la base. Contiene solo SELECT y cubre todo Feyvi. El dry-run no permite inferir recuperación real del catálogo hasta que termine sin bloqueos y se inspeccionen los errores y diferencias.

### Migraciones y piloto: solo tras aprobación

Railway tiene `preDeployCommand` de migración. Verificar que termine antes de activar la versión:

```sh
pnpm run db:migrate
node dist/scraping/backfills/feyvi-product-backfill.cli.js --apply --run-id=feyvi-pilot-20261011 --limit=5 --batch-size=5 --report=output/feyvi-recovery/pilot.json
node dist/scraping/backfills/feyvi-audit.cli.js > output/feyvi-recovery/audit-after-pilot.json
```

No ejecutar si apunta a la base equivocada. Revisar SKU, precio, fotos, relaciones y visualización en RepuestoShop del piloto antes de autorizar el catálogo completo.

### Recuperación completa: requiere autorización específica

```sh
node dist/scraping/backfills/feyvi-product-backfill.cli.js --apply --run-id=feyvi-recovery-20261011 --all --batch-size=100 --report=output/feyvi-recovery/recovery.json
node dist/scraping/backfills/feyvi-audit.cli.js > output/feyvi-recovery/audit-after.json
```

Para reanudar, repetir el comando con la misma run-id. Guardar/exportar reportes y respaldos antes de reiniciar o redeployar; el directorio `output` puede ser efímero si no tiene volumen persistente. Los respaldos y eventos de PostgreSQL permanecen en la base.

### Restauración de un lote: solo tras autorización

```sh
node dist/scraping/backfills/feyvi-product-backfill.cli.js --apply --restore-run=feyvi-recovery-20261011 --report=output/feyvi-recovery/restored.json
```

La restauración es transaccional y se bloquea si el producto o las relaciones cambiaron después de la recuperación; no pisa trabajo posterior. Conserva el archivo de respaldo. Tras restaurar, usar una run-id nueva si se quiere una recuperación nueva.

## Publicación pendiente

Revisar el cambio, obtener las cantidades reales con SELECT, incorporar las dos muestras, habilitar acceso al frontend y validar visualización/búsqueda/filtros/exportaciones. Resolver o aceptar explícitamente los fallos preexistentes de la suite. Autorizar merge/deploy y después el piloto; autorizar la actualización completa únicamente después de revisar su resultado. No se hizo ninguna publicación Mercado Libre.

## PR preparado

La rama `fix/feyvi-safe-recovery` está subida a `FranprzDev/Scrapping-Repuestos-UY-API`. GitHub bloqueó la creación automática con `Forbidden` en `api.github.com/graphql`; no existe un PR creado por esta intervención.

Abrirlo como **Draft** desde https://github.com/FranprzDev/Scrapping-Repuestos-UY-API/pull/new/fix/feyvi-safe-recovery, base `main`, título `fix: recuperar precios y SKU de Feyvi con backfill seguro`. La descripción debe indicar que el backfill anterior omitía precio/SKU, explicar el respaldo/reanudación y referenciar este informe con los resultados de pruebas y las verificaciones de producción/frontend pendientes.
