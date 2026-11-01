# MAEJ INOUT

Aplicación local para registrar ingresos, gastos, equipos y saldos mensuales de inversión. El servidor usa Express, GraphQL y MongoDB; la interfaz se sirve desde el mismo servidor.

## Ejecutar

Requiere Node.js 22.5 o superior.

```sh
npm install
npm start
```

Abre `http://localhost:3000`. Para desarrollo con reinicio automático usa `npm run dev`. Las pruebas de integración se ejecutan con `npm test`.

Los datos se guardan en la base MongoDB `maej_inout_test` y la colección `maej_test` por defecto. La conexión se configura con `MONGODB_URI`; `MONGODB_DB` y `MONGODB_COLLECTION` permiten cambiar la base y colección. `PORT` cambia el puerto web. Copia `.env.example` a `.env` si quieres configurar estas opciones localmente; `.env` está excluido de Git.

MongoDB Community debe estar ejecutándose. Para la instalación local por defecto, la aplicación se conecta a `mongodb://127.0.0.1:27017/maej_inout_test`.

## GraphQL y Postman

La API GraphQL recibe solicitudes `POST` en `http://localhost:3000/graphql`. La colección lista para importar está en `postman/MAEJ-INOUT.postman_collection.json`.

Para analizar la API desde Postman:

1. Inicia el servidor con `npm start`.
2. En Postman importa la colección anterior. Si el servidor usa otro puerto, cambia la variable de colección `baseUrl`.
3. Envía primero **Salud** para confirmar que la API y MongoDB responden.
4. Usa **Crear ingreso**, **Editar ingreso guardado** y **Eliminar movimiento guardado** en ese orden para probar las mutaciones de movimientos.
5. Usa **Crear equipo planeado** y luego **Marcar comprado (crea gasto)**. Al comprarlo se genera un gasto vinculado y el identificador aparece en `expenseTransactionId`.
6. Prueba **Panel mensual**, **Resumen anual** y **Actualizar fondo de inversión** para consultar y modificar los reportes.

Las operaciones usan variables GraphQL; sus respuestas muestran `data` cuando tienen éxito y `errors` cuando falla la validación o una mutación. Para inspeccionar otros campos, edita la selección de campos del cuerpo GraphQL de la solicitud.

### Operaciones disponibles

- Consultas: `health`, `transactions`, `transaction`, `equipment`, `investmentFund`, `dashboard`, `monthlySummary`.
- Mutaciones: `createTransaction`, `updateTransaction`, `deleteTransaction`, `createEquipment`, `updateEquipment`, `deleteEquipment`, `setInvestmentFund`.

## Reglas de negocio

- La instalación está configurada para una sola empresa (`default`, “Mi empresa”). No hay usuarios, autenticación ni aislamiento multiempresa; debe usarse solo en un entorno local o de confianza y no exponerse directamente a Internet.
- Los equipos en estado `Planeado` no se contabilizan como gasto. Al crearse o cambiarse a `Comprado`, `En uso` o `En mantenimiento`, se registra automáticamente un gasto de categoría `Equipo`. Las modificaciones posteriores del equipo actualizan ese mismo gasto, no crean otro. Eliminar el equipo elimina también el gasto vinculado.
- El fondo de inversión continúa siendo un saldo mensual capturado manualmente; no se deriva de movimientos financieros.
- Los datos de prueba anteriores de SQLite no se importan. La aplicación inicia con la colección MongoDB vacía.
- Para mantener simple la ejecución en MongoDB Community sin replica set, cada documento de equipo guarda embebido su gasto generado. Las consultas GraphQL lo presentan como movimiento, pero no se duplica como documento separado.
- Los documentos usan `recordType` para distinguir `transaction`, `equipment` e `investmentFund` dentro de la colección elegida. La aplicación crea la colección e índices al arrancar; no es necesario insertar documentos manualmente en Compass.
