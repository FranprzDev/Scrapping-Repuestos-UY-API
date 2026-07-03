# Migraciones de base de datos

## Regla del proyecto

Todo cambio de estructura o transformación persistente de datos debe realizarse mediante una migración versionada en `migrations/` con `node-pg-migrate`.

Esto incluye:

- crear, modificar o eliminar tablas y columnas;
- agregar índices, claves foráneas o restricciones `UNIQUE`;
- normalizar, completar, deduplicar o eliminar datos existentes;
- cambiar valores que deban persistir entre despliegues.

No se deben colocar migraciones dentro de `PostgresService`, `onModuleInit`, el arranque de NestJS, schedulers ni endpoints. Los métodos `ensure*` existentes son compatibilidad histórica y no deben ampliarse con nuevas evoluciones del esquema.

## Crear una migración

Desde la raíz del proyecto:

```bash
pnpm exec node-pg-migrate create nombre_descriptivo
```

La migración debe implementar `up` y, cuando sea técnicamente posible, `down`.

```js
exports.up = (pgm) => {
  pgm.addColumn('tabla', {
    nueva_columna: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('tabla', 'nueva_columna');
};
```

Para transformaciones complejas se puede usar `pgm.sql(...)`. La migración debe ser determinista y debe conservar una regla clara para decidir qué datos permanecen.

## Ejecutar localmente

```bash
pnpm run db:up
pnpm run db:migrate
```

El comando `pnpm run dev:local` también inicia PostgreSQL, ejecuta las migraciones pendientes y luego levanta la aplicación.

`node-pg-migrate` registra cada ejecución en `pgmigrations`. Una migración aplicada no vuelve a ejecutarse.

## Despliegue en Railway

Railway ejecuta este paso antes de activar una nueva versión:

```bash
pnpm run db:migrate
```

El comando está definido como `preDeployCommand` en `railway.json`. Si una migración falla, el deploy debe detenerse antes de iniciar el nuevo código.

Las migraciones deben asumir que la versión anterior de la aplicación puede seguir atendiendo tráfico durante el pre-deploy. Cuando una transformación necesite bloquear escrituras, debe usar el nivel mínimo de bloqueo que mantenga la consistencia y permita lecturas siempre que sea posible.

## Validación obligatoria

Antes de publicar un cambio de base de datos:

1. Ejecutar la migración sobre un PostgreSQL temporal con datos representativos.
2. Comprobar el estado final de tablas, restricciones e índices.
3. Ejecutar nuevamente `pnpm run db:migrate` y confirmar que no quedan migraciones pendientes.
4. Ejecutar `pnpm test` y `pnpm run lint`.
5. Construir la imagen Docker cuando el cambio afecte el proceso de despliegue.
6. Documentar en el pull request el impacto esperado, bloqueos, pérdida de datos y estrategia de rollback.

## Criterios de seguridad

- Respaldar o medir los datos antes de una eliminación masiva.
- Evitar cambios destructivos sin una consulta previa que cuantifique el impacto.
- No editar una migración que ya fue aplicada en producción; crear una migración nueva.
- No depender de que una migración se ejecute desde una petición HTTP.
- No usar `DROP`, `TRUNCATE` o un `DELETE` amplio sin condiciones verificables.
- Hacer explícito cuando un rollback de esquema no puede recuperar datos eliminados.
