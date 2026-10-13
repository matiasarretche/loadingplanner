# Pacifil Export Load Planner — MVP Fase 1

Next.js 16 + TypeScript + PostgreSQL 17 (Drizzle) + React Three Fiber + Zustand. Interfaz en portugués.

## Correr localmente

```bash
npm install
npm run db:migrate   # aplica drizzle/*.sql
npm run db:seed      # presets de referencia + usuario ADMIN de .env
npm run dev          # http://localhost:3000
```

Credenciales locales en `.env` (ignorado por git): `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_EMAIL`/`ADMIN_PASSWORD` (se pide cambiarla en el primer login).

## Estructura

- `src/domain/` — núcleo puro (geometría, pallets, carga, validaciones, zod). Sin React ni DB. Tests: `npm test`.
- `src/db/schema.ts` — esquema PostgreSQL. Migraciones: `npm run db:generate` + `npm run db:migrate`.
- `src/app/` — páginas: cargas (Nova carga = todos os tipos de envio), produtos, cadastros, admin/usuarios.
- `src/components/three/Scene3D.tsx` — visor/editor 3D (Z arriba, mm, origen en la pared frontal).

## Reglas clave

- Las cargas guardan snapshots de todos los catastros usados: editar un catastro no altera cargas guardadas.
- Una versión APPROVED es inmutable; editar = nueva versión V(n+1). No se aprueba con alertas CRÍTICAS (se revalida en el servidor).
- Límite efectivo = MIN(equipo, perfiles transportista/legal/ruta/operacional). Ningún límite legal está hardcodeado.
- Presets de contenedores/pallets/vehículos vienen marcados como ESTIMADO/NO VERIFICADO y generan alertas hasta confirmarlos.

## Asistente IA

- Panel **ASSISTENTE IA** en el editor de carga (solo versiones en borrador y usuarios con permiso de edición).
- Flujo: `AssistantPanel` → `askAssistantAction` (sesión + rol + validación zod) → `lib/ai/service.ts` (rate limit, conversación por usuario/versión, logs) → `AIProvider` (`lib/ai/anthropic.ts`) → tools (`lib/ai/tools.ts`) → motor determinístico (`domain/autoload.ts`, `validateLoad`).
- La IA solo arma un **borrador**: el usuario ve la vista previa, aplica y guarda con el botón normal (revalidado en el servidor). No hay tools que modifiquen catálogo, usuarios ni permisos.
- Configuración (servidor): `ANTHROPIC_API_KEY`, `AI_PROVIDER`, `AI_MODEL` (por defecto `claude-opus-5-5`), `AI_EFFORT`, `AI_RATE_PER_MIN`, `AI_RATE_PER_DAY`. Ver `.env.example`.
- Auditoría: tablas `ai_conversation` (borrador), `ai_message` (historial + tokens) y `ai_tool_call` (tool, parámetros, resultado, error, duración), más `audit_log`.
- Prueba de las tools sin IA: `npx tsx --conditions=react-server --env-file=.env scripts/ai-tools-smoke.ts`.
