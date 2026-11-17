# Vera Core — archivos portables

Estos archivos son la identidad y las reglas de Vera, separadas del runtime. OpenClaw los carga en su workspace; una interfaz propia puede cargar los mismos archivos o su equivalente.

| Archivo | Qué define | Runtime |
|---|---|---|
| `SOUL.md` | Voz, carácter y límites de personalidad | OpenClaw lo inyecta en sesiones normales |
| `AGENTS.md` | Reglas de operación, tools, aprobaciones, seguridad y canales | OpenClaw lo inyecta como instrucciones del agente |

## Cómo cargarlos en OpenClaw

En el VPS, el workspace del agente `vera` debe contener copias de estos archivos:

```bash
mkdir -p ~/.openclaw/workspace-vera
cp SOUL.md AGENTS.md ~/.openclaw/workspace-vera/
```

No copies secretos, `.env`, el repositorio completo ni el historial de clientes al workspace. El agente no necesita nada de eso: lee la verdad por el Agent Proxy MCP.

## Regla de portabilidad

Si OpenClaw se reemplaza por otro runtime o por una consola propia, `SOUL.md` y `AGENTS.md` deben seguir siendo la fuente de identidad y política. El runtime cambia; Vera no.

## Lo que no va aquí

- Tokens, claves o `service_role`.
- Datos de clientes.
- Lógica de dinero o stock: eso vive en RPCs deterministas, no en el prompt.
- Reglas que solo aplican a un canal y contradicen este contrato.
