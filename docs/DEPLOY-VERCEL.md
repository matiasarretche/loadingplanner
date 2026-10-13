# Publicar el Load Planner en Vercel + Neon

Guía paso a paso para poner la plataforma en **https://loadingplanner.vercel.app** con:

- **Vercel Hobby** (plan gratuito, Fluid compute, funciones en **São Paulo – gru1**, ya fijado en `vercel.json`);
- **Neon Postgres** en São Paulo, creado desde Vercel → Storage;
- **todos los datos actuales** copiados desde el Postgres local.

> Regla de oro: **nunca** pegar URLs de base de datos, contraseñas ni claves en el chat, en commits ni en la línea de comandos. Se escriben sólo en archivos ignorados por git (`.env`, `.env.neon`) o en la pantalla de variables de Vercel.

---

## 0. Antes de empezar

1. Aplicar en la base **local** todas las migraciones pendientes (por ejemplo, la `0037`, el índice de auditoría que usan los límites del login y del envío de e-mails), para que lo que se copie a Neon ya tenga el esquema final:

   ```powershell
   npm run db:migrate
   ```

2. Confirmar que git no va a subir nada sensible:

   ```powershell
   git check-ignore -v .env .env.neon backups/x .claude/x
   git status --short
   ```

   Cada archivo del primer comando tiene que mostrar la regla de `.gitignore` que lo ignora. En `git status` **no** deben aparecer `.env`, `.env.neon`, `backups/`, `.claude/`, `*.dump`, `*.xlsx` ni `*.csv`.

3. El repositorio de GitHub `matiasarretche/loadingplanner` tiene que ser **privado** (los scripts tienen listas de precios).

---

## 1. Crear la base Neon desde Vercel

1. En https://vercel.com → **Storage** → **Create Database** → **Neon** (Serverless Postgres) → **Continue**.
2. Opciones:
   - **Región:** *São Paulo, Brazil* (`aws-sa-east-1`). Si no aparece en la lista, crear el proyecto directamente en https://console.neon.tech con región **AWS São Paulo (sa-east-1)** y después conectarlo a Vercel desde la integración de Neon.
   - **Postgres:** versión **17**, igual a la local, si se puede elegir. Si sólo ofrece 18 también funciona. 16 o anterior **no** sirve, y el script de migración se niega a usarla.
   - **Plan:** Free.
   - **Nombre:** `loadingplanner-db`, por ejemplo.
3. Todavía **no** hace falta conectarla al proyecto. Eso se hace en el paso 4.

### Obtener la URL directa ("unpooled")

Neon da dos URLs:

| Variable | Host | Uso |
|---|---|---|
| `DATABASE_URL` | contiene `-pooler` | **la app en Vercel** (conexiones cortas por el pooler) |
| `DATABASE_URL_UNPOOLED` | **sin** `-pooler` | migraciones, copia de datos (`pg_restore`, `drizzle-kit`) |

Para copiar la *unpooled*: Vercel → Storage → la base → pestaña **.env.local** → **Show secret** → copiar el valor de `DATABASE_URL_UNPOOLED`. También se puede sacar de la consola de Neon: **Connect** → desactivar *Connection pooling* → copiar.

---

## 2. Crear `.env.neon` (sólo en esta PC)

En la raíz del proyecto, abrir el Bloc de notas:

```powershell
notepad .env.neon
```

Si pregunta si quiere crear el archivo, responder que sí. Pegar **una sola línea**, sin comillas:

```
NEON_DATABASE_URL_UNPOOLED=postgresql://...(la URL unpooled copiada)...
```

Guardar y cerrar. Después verificar que git lo ignora (`.env*` ya está en `.gitignore`):

```powershell
git check-ignore -v .env.neon
```

Conviene guardar este archivo para las migraciones futuras (paso 7). No se sube nunca.

---

## 3. Copiar todos los datos locales a Neon

El script `scripts/migrate-to-neon.ts` hace esto:

- toma la base local (`DATABASE_URL` del `.env`) con `pg_dump` de `C:/Program Files/PostgreSQL/17/bin`, en formato *custom*, `--no-owner --no-acl`. Copia todos los esquemas, incluida la tabla de migraciones `drizzle.__drizzle_migrations`;
- la restaura en Neon con `pg_restore` dentro de **una sola transacción**: si algo falla, Neon queda como estaba;
- **no muestra nunca las URLs**. Host y contraseña aparecen enmascarados, y la contraseña llega a `pg_dump`/`pg_restore` sólo por la variable `PGPASSWORD`;
- guarda el dump en una carpeta temporal y la borra al terminar, aunque haya un error o se cancele con Ctrl+C;
- **se niega a seguir si Neon ya tiene tablas**, salvo que se use `--force`;
- al final **desactiva el usuario de QA** (`QA_EMAIL` del `.env`), actualiza estadísticas (`ANALYZE`) y muestra la **cantidad de filas por tabla** en local y en Neon, una al lado de la otra.

Desde la raíz del proyecto:

```powershell
# 1) prueba en seco: verifica conexiones y versiones y cuenta filas, sin copiar nada
npx tsx scripts/migrate-to-neon.ts --check

# 2) copia real
npx tsx scripts/migrate-to-neon.ts
```

El resultado esperado termina en `Cópia concluída: todas as tabelas conferem.` Si alguna tabla aparece como `DIFERENTE` o `FALTA no Neon`, no publicar: revisar el mensaje.

- El servidor local puede seguir encendido. La copia toma una "foto" coherente de la base en un instante. Pero lo que se cargue **después** de la copia **no** pasa a Neon.
- `--force` (`npx tsx scripts/migrate-to-neon.ts --force`) borra y vuelve a crear en Neon las tablas que vienen del local. Sirve para repetir la copia **antes** del go-live. **Nunca** usarlo después de que la gente empiece a trabajar en producción, porque se perderían los datos cargados allí.
- Si los programas de PostgreSQL están en otra carpeta: `$env:PG_BIN = 'C:\ruta\a\bin'` antes de correr el script.

---

## 4. Crear el proyecto en Vercel desde GitHub

1. Subir el código a GitHub, a la rama `main` del repo `matiasarretche/loadingplanner`, después de revisar el paso 0.
2. Vercel → **Add New… → Project** → **Import Git Repository** → `matiasarretche/loadingplanner`. Si no aparece, usar **Adjust GitHub App Permissions** y dar acceso a ese repo.
3. Configuración:
   - **Project Name:** `loadingplanner` (da el dominio `loadingplanner.vercel.app`; si el nombre está tomado, Vercel agrega un sufijo y hay que ajustar `APP_URL`).
   - **Framework Preset:** Next.js.
   - **Root Directory:** `./`. **Build / Install / Output:** dejar los valores por defecto.
   - **Environment Variables:** cargarlas en este paso (ver el paso 5) o después.
4. **Deploy.** El build no necesita la base. Si se hace el deploy antes de conectar Neon, las páginas van a fallar hasta el paso 5.
5. Conectar la base: Vercel → **Storage** → la base Neon → **Connect Project** → `loadingplanner`:
   - Entornos: **Production**. Para Preview hay dos opciones: activar la creación de una *rama* de Neon por preview, para que los previews nunca escriban en los datos reales, o dejar Preview sin base.
   - Prefijo de variables: el **predeterminado**, para que la variable se llame exactamente `DATABASE_URL`.
   - Esto inyecta `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED` y otras `PG*`/`POSTGRES_*` que la app no usa.

### Ajustes del proyecto que conviene verificar

- **Settings → Functions → Function Region:** São Paulo (`gru1`). Viene de `vercel.json`, no hace falta tocarla.
- **Settings → Functions → Fluid Compute:** activado (es lo predeterminado en proyectos nuevos).
- **Settings → Build and Deployment → Node.js Version:** 24.x. `package.json` lo fija con `"engines": { "node": "24.x" }`.
- **Settings → Deployment Protection:** dejar *Standard Protection*, que deja los previews privados. Producción queda pública y protegida por el login de la app.

---

## 5. Variables de entorno en Vercel

Ir a **Settings → Environment Variables**, entorno **Production**. Aquí van sólo los **nombres**: los valores salen del `.env` local o se generan nuevos. Marcar como *Sensitive* las secretas.

| Variable | Valor |
|---|---|
| `DATABASE_URL` | **Pooled** de Neon (host con `-pooler`). La **inyecta la integración**, no cargarla a mano. |
| `SESSION_SECRET` | **Nuevo**, de 32 caracteres o más. **No** reutilizar el local. Ver el comando de abajo. |
| `APP_URL` | `https://loadingplanner.vercel.app` (es el link de los e-mails de redefinición de contraseña; la app sólo los manda cuando una cuenta se bloquea por contraseñas erradas, no hay botón "Esqueci minha senha") |
| `ANTHROPIC_API_KEY` | clave de la API de Anthropic |
| `AI_PROVIDER`, `AI_MODEL`, `AI_EFFORT`, `AI_RATE_PER_MIN`, `AI_RATE_PER_DAY` | iguales a las del `.env` local (sólo las que estén definidas) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | cuenta SMTP de la empresa (puerto 587 o 465; Vercel bloquea el 25) |

**No** cargar en Vercel: `NEXT_DIST_DIR`, `TEST_DATABASE_URL`, `PG_SUPERUSER_PASSWORD`, `ADMIN_*`, `QA_*`, `NEON_DATABASE_URL_UNPOOLED` ni `TZ` (Vercel lo reserva).

Si se habilita Preview, usar **otro** `SESSION_SECRET` para Preview.

### Generar `SESSION_SECRET` sin que aparezca en pantalla

Este comando escribe un secreto aleatorio de 64 caracteres en un archivo de la carpeta de usuario. No lo imprime y no sobrescribe un archivo existente:

```powershell
node -e "require('fs').writeFileSync(require('os').homedir() + '/pacifil-session-secret.txt', require('crypto').randomBytes(48).toString('base64url'), { flag: 'wx' })"
```

Después: `notepad $HOME\pacifil-session-secret.txt` → copiar el contenido → pegarlo en Vercel → cerrar → `Remove-Item $HOME\pacifil-session-secret.txt`.

> Las variables sólo se aplican a deploys **nuevos**. Después de cambiarlas: **Deployments → … → Redeploy**.

---

## 6. Deploy automático con `git push`

- **Push a `main`** → deploy de **producción** en https://loadingplanner.vercel.app (tarda unos minutos; se ve en **Deployments**).
- **Push a otra rama o pull request** → deploy de **preview** con URL propia, privada por la Deployment Protection.
- **Volver atrás:** Deployments → elegir un deploy anterior que funcionaba → **Instant Rollback** o **Promote to Production**.
- El deploy **no** corre migraciones de base. Ver el paso 7.

---

## 7. Cambios futuros de esquema (migraciones)

Las migraciones de Drizzle (`drizzle/*.sql`) se aplican a Neon **a mano**, con la URL **unpooled**. La tabla `drizzle.__drizzle_migrations` llegó con la copia, así que `drizzle-kit` sigue desde la última migración aplicada.

Orden recomendado para un cambio con migración:

1. Localmente: `npm run db:generate` y después `npm run db:migrate` (base local). Probar.
2. Aplicar la misma migración en Neon, desde la raíz (PowerShell o Git Bash, es igual):

   ```powershell
   npx tsx scripts/migrate-neon.ts
   ```

   El script lee la URL del `.env.neon` (acepta `NEON_DATABASE_URL_UNPOOLED` o `DATABASE_URL_UNPOOLED` tal como lo muestra Vercel, con o sin comillas) y **se niega a migrar** si falta, si no es de Neon (`neon.tech`), si es la *pooled* (`-pooler`) o si apunta a un banco local. La URL va sólo al proceso de `drizzle-kit`: no queda en la consola ni aparece en pantalla. Al final confirma cuántas migraciones tiene Neon contra las del proyecto y termina en `Tudo aplicado.`

   > **No** usar `npm run db:migrate` con una variable armada a mano: si la variable queda vacía, `drizzle.config.ts` toma el `DATABASE_URL` del `.env`, migra la base **local** y aun así muestra "migrations applied successfully!", mientras Neon queda sin migrar.
3. `git push` a `main`, que publica el código nuevo.

Si la migración sólo **agrega** cosas (columnas con default, tablas nuevas), aplicarla **antes** del push. Así el código nuevo encuentra el esquema listo y el código viejo sigue funcionando mientras tanto.

**Nunca** correr contra Neon `npm run db:seed`, `scripts/create-qa-user.ts` ni el resto de los scripts de carga.

---

## 8. Límites del plan Hobby (y de Neon Free)

- **Uso:** Vercel define Hobby para uso personal y **no comercial**. Si hace falta, pasar a **Pro** es un cambio en el panel, sin tocar el código.
- **Duración de funciones:** hasta **300 s** por request (Fluid compute). Una respuesta de la IA o un PDF que tarde más se corta.
- **Tamaño de request/response:** **4,5 MB** por función. Fotos, adjuntos de la IA, PDFs enviados por e-mail o PDFs con muchas fotos que pasen ese tamaño fallan con error **413**. La app limita los tamaños para quedar por debajo.
- **Región:** las funciones corren sólo en `gru1` (São Paulo), junto a la base.
- **Cuotas mensuales gratuitas** (invocaciones, CPU, transferencia) y un límite diario de deploys. Ver **Usage** en el panel y https://vercel.com/docs/limits. Si se superan, Vercel puede pausar el proyecto hasta que se renueve el período.
- **Neon Free:** 0,5 GB de almacenamiento (hoy la base ocupa unos 17 MB, casi todo fotos). La base se **suspende** tras unos minutos sin uso, así que la primera consulta después de un rato tarda un poco más. El historial de restauración es corto: conviene hacer copias propias de vez en cuando.
- La hora del servidor en Vercel es **UTC**. Las fechas que muestra la app se formatean con la zona `America/Sao_Paulo`.
- **Login expuesto a internet:** 4 contraseñas erradas en 15 minutos bloquean esa cuenta **sólo para esa red (IP)** por hasta 15 minutos, así que nadie puede dejar afuera a otro usuario errando su contraseña a propósito. La cuenta **entera** se bloquea 15 minutos sólo con 30 contraseñas erradas en 15 minutos sumando todas las redes (ataque distribuido), y aun así entra un navegador donde esa cuenta ya inició sesión en los últimos 30 días. Cada IP tiene como máximo 20 intentos sin éxito cada 15 minutos. En **Admin → Usuários** aparece sólo el bloqueo de la cuenta entera, con los minutos que faltan; redefinir la contraseña también lo levanta.

---

## 9. Checklist de go-live

- [ ] Repo privado; `git status` sin `.env`, `.env.neon`, `backups/`, `.claude/`, `*.dump`, `*.xlsx` ni `*.csv`.
- [ ] Base local con todas las migraciones aplicadas (`npm run db:migrate`) **antes** de copiar.
- [ ] Neon en São Paulo (`aws-sa-east-1`), Postgres 17 (o 18).
- [ ] `npx tsx scripts/migrate-to-neon.ts --check` sin errores; después la copia real, que termina con "todas as tabelas conferem".
- [ ] El usuario de QA quedó desactivado (lo informa el script) y hay al menos un ADMIN activo. Crear un **segundo ADMIN** de respaldo.
- [ ] En Vercel, `DATABASE_URL` es la **pooled** (host con `-pooler`) y está en Production.
- [ ] `SESSION_SECRET` nuevo, `APP_URL=https://loadingplanner.vercel.app`, `ANTHROPIC_API_KEY`, `AI_*` y `SMTP_*` cargados → **Redeploy**.
- [ ] Function Region `gru1`, Fluid Compute activo, Node 24.x.
- [ ] Encabezados: `curl -I https://loadingplanner.vercel.app/login` muestra `X-Frame-Options: DENY`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff` y **no** muestra `X-Powered-By`.
- [ ] Prueba de humo en producción:
  - [ ] login con el ADMIN; dashboard y lista de cargas;
  - [ ] PDF de una carga (proforma) con **logo y sello NXT**, y PDF de la lista de precios de exportación;
  - [ ] subir una foto desde el celular (cámara) y usar el dictado (micrófono);
  - [ ] asistente de IA e interpretación de un pedido;
  - [ ] bloqueo + e-mail de redefinición (la app **no** tiene botón "Esqueci minha senha"). Usar una cuenta de prueba no-ADMIN activa, o el segundo ADMIN de respaldo; **nunca** el ADMIN principal. Poner la contraseña equivocada 4 veces seguidas. La 4.ª bloquea esa cuenta **desde esa red** por 15 minutos y, con `SMTP_*` configurado, manda al e-mail de la cuenta un link que empieza con `https://loadingplanner.vercel.app/redefinir-senha?token=` (vale 1 hora, uso único; como máximo 3 links por cuenta cada 24 h). Comprobar:
    - (a) durante el bloqueo, ni la contraseña correcta deja entrar desde esa red;
    - (b) desde otra red (por ejemplo, el celular con datos móviles) la misma cuenta entra normalmente;
    - (c) abrir el link y definir una contraseña nueva desbloquea la cuenta en el acto y cierra sus sesiones; o, sin usar el link, se desbloquea sola a los 15 minutos.

    No pasar de 20 intentos fallidos desde la misma IP en 15 minutos: eso activa el límite por IP, que frena el login de **todas** las cuentas desde esa red.
  - [ ] fechas y horas en hora de São Paulo.
- [ ] Desde el go-live, **producción es la fuente de verdad**: no cargar datos reales en el sistema local ni volver a correr `migrate-to-neon.ts --force`.
