# SportBot

Consola web de operación y atención de SportBot, con frontend React/Vite, Supabase (PostgreSQL, RLS y Edge Functions) e integración prevista con Evolution.

## Alcance MVP

- Atención humana por conversación y controles de rol validados en servidor.
- Pagos manuales Nequi/Bre-B con decisión humana. Wompi y Twilio están fuera del MVP inicial; las rutas heredadas que permanezcan en el código no implican que estén habilitadas.
- Vera requiere identidad de usuario/JWT y alcance por invocación. No conectar Operator a un gateway con secreto compartido ni entregar credenciales de servicio al modelo.

## Desarrollo local

```sh
corepack pnpm install
corepack pnpm dev:admin
corepack pnpm test:admin
corepack pnpm typecheck:admin
corepack pnpm build:admin
```

Configura variables locales desde los archivos .env.example; nunca reemplaces placeholders con valores reales dentro de Git. Las migraciones requieren revisión y pruebas en un entorno aislado antes de producción.
En la migración inicial de roles, el owner seed quedó deliberadamente como owner@example.test; configura la identidad inicial por un procedimiento privado en cada entorno nuevo.

## Deploy

El build de Netlify está definido en netlify.toml. Enlaza sólo la rama canónica aprobada, verifica el SHA y completa UAT de roles con datos sintéticos antes de promover a producción.

## Snapshot público

Esta rama es un snapshot sanitizado: excluye informes operativos, handoffs, logs y outputs locales; contiene placeholders para identidad/configuración; las pruebas usan sólo números ficticios de la franja NANP 555-0100..0199. La revisión heurística no es garantía absoluta: mantiene valores reales sólo en un gestor de secretos y vuelve a escanear antes de cada publicación.
