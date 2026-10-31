# Encuestas de fecha · Comisión de Fiestas de Jorcas 2027

Web de votación de fechas tipo Doodle. Cada invitado entra con un enlace personal
(`/e/<id>?t=<token>`), marca qué fechas le van bien y puede cambiarlo hasta el cierre.

Producción: https://comisionjorcas2027.vercel.app (cada push a `main` despliega).

## Stack

| Pieza | Versión |
|---|---|
| Next.js (App Router, Turbopack) | 16.4.3 |
| React / React DOM | 19.3.1 |
| @supabase/supabase-js | 2.118.0 (solo servidor) |
| TypeScript | 5.9.3 |
| Node.js | 24.x (fijado en `engines`; supabase-js exige ≥ 22) |

Sin librerías de UI: CSS propio en `app/globals.css`.

## Variables de entorno

| Variable | Valor | Notas |
|---|---|---|
| `SUPABASE_URL` | `https://mtszpwcyugljmmyyqhqo.supabase.co` | |
| `SUPABASE_SERVICE_ROLE_KEY` | secret key `sb_secret_...` o service_role legacy (JWT) | Funcionan ambas. Nunca en el navegador. |

No hay ninguna variable `NEXT_PUBLIC_*`. El cliente de Supabase vive en `lib/supabase.ts`
con `import "server-only"`. Si falta alguna variable, el log del servidor muestra
`[config] Faltan variables de entorno: ...` y el usuario ve una página genérica "No disponible".

## Base de datos

### Migraciones

| Fichero | Qué hace |
|---|---|
| `supabase/migrations/0001_esquema.sql` | Crea `encuestas`, `opciones`, `invitados`, `votos` con RLS activo y sin políticas. **Solo crea las tablas que no existen**: si el artifact de actas ya las creó, no toca nada (ni columnas ni RLS). |
| `supabase/migrations/0002_registrar_votos.sql` | Función `registrar_votos(p_encuesta, p_token, p_votos)`: `security definer`, ejecutable solo por `service_role`. |
| `supabase/migrations/0003_invitado_por_token.sql` | Función `invitado_por_token(p_encuesta, p_token)` → `(id, nombre)`: `security definer`, solo `service_role`. La app busca al invitado por RPC (POST) para que el token no aparezca en la URL ni en los logs del gateway de Supabase. |
| `supabase/checks/verificar.sql` | Solo lectura: estado de RLS, políticas y permisos de la función. |

### Aplicarlas en Supabase (SQL Editor)

1. Supabase → proyecto `mtszpwcyugljmmyyqhqo` → **SQL Editor** → **New query**.
2. Pega el contenido de `0001_esquema.sql` → **Run**.
3. Nueva query con `0002_registrar_votos.sql` → **Run**.
4. Nueva query con `0003_invitado_por_token.sql` → **Run**.
5. Nueva query con `supabase/checks/verificar.sql` → **Run**. Esperado:
   - `rls = true` en las 4 tablas.
   - Ninguna política para `anon`/`authenticated`.
   - `registrar_votos` e `invitado_por_token`: `anon` y `authenticated` = `false`, `service_role` = `true`.

Todas las migraciones son re-ejecutables.

### Errores de `registrar_votos`

SQLSTATE `P0001`; el mensaje es el código. La API los traduce así:

| Mensaje | HTTP |
|---|---|
| `token_invalido` | 403 |
| `encuesta_cerrada` (estado ≠ `abierta` o `now() >= cierre`) | 409 |
| `votos_invalidos` / `opcion_invalida` | 400 |

`p_votos` es un array JSON: `[{"opcion_id": "<uuid>", "disponible": true}, ...]`.

## Rutas

| Ruta | Tipo | Comportamiento |
|---|---|---|
| `/` | estática | Página neutra, no lista encuestas. |
| `/e/<id>?t=<token>` | rewrite → `app/e/[id]/acceso/route.ts` | Valida el token, lo guarda en cookie `jorcas_t` (httpOnly, Secure, SameSite=Lax, Path=`/e/<id>`) y redirige (303) a `/e/<id>`. Token inválido → `/enlace-no-valido`. |
| `/e/<id>` | dinámica | Página de votación. Sin cookie válida → "Enlace no válido". |
| `POST /e/<id>/votar` | Route Handler | Lee el token **solo** de la cookie y llama a `registrar_votos`. |
| `/robots.txt` | estática | `Disallow: /` |

> **Por qué `POST /e/<id>/votar` y no `/api/votar`:** la cookie tiene `Path=/e/<id>`, así que el
> navegador no la enviaría a `/api/votar`. Mover la API bajo `/e/<id>` mantiene la cookie
> limitada a su encuesta y el token fuera del body.

El rewrite de `/e/<id>?t=` está en `next.config.ts` (`beforeFiles`, condicionado a que exista `t`).

## Seguridad

- Cabeceras globales: `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`,
  `X-Content-Type-Options: nosniff`, `Content-Security-Policy: frame-ancestors 'none'; ...`,
  `X-Frame-Options: DENY`. `/e/*` con `Cache-Control: private, no-store`.
- Las consultas nunca seleccionan `email` ni `token` de nadie; la tabla muestra `nombre`
  o "Participante N".
- El token solo viaja en el body de las RPC (`invitado_por_token`, `registrar_votos`), nunca en
  query strings hacia Supabase, así que no queda en los logs del gateway.
- `POST /e/<id>/votar`: exige `Content-Type: application/json`, rechaza `Origin`/`Sec-Fetch-Site`
  de otro origen, limita el body a 32 KB y valida uuids, booleanos y duplicados antes de la RPC
  (que vuelve a validarlo todo en la BD).
- Los logs solo registran códigos de error, nunca tokens ni emails.

## Desarrollo local

```bash
npm install
cat > .env.local <<'EOF'
SUPABASE_URL=https://mtszpwcyugljmmyyqhqo.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
EOF
npm run dev            # http://localhost:3000
npm run build          # compilación de producción
```

`.env*` está en `.gitignore`. Ojo: con estas variables trabajas contra la BD de producción.

### Probar una encuesta

En el SQL Editor:

```sql
with e as (
  insert into encuestas (titulo, descripcion, cierre)
  values ('Prueba', 'Encuesta de prueba', now() + interval '7 days')
  returning id
), o as (
  insert into opciones (encuesta_id, inicio, fin, orden)
  select id, x.inicio, x.fin, x.orden from e,
  (values ('2026-11-14 18:00+01'::timestamptz, '2026-11-14 20:00+01'::timestamptz, 1),
          ('2026-11-15 11:00+01', '2026-11-15 13:00+01', 2)) as x(inicio, fin, orden)
)
insert into invitados (encuesta_id, email, nombre)
select id, 'rauldolz@outlook.com', 'Raúl' from e
returning encuesta_id, token;
```

Abre `http://localhost:3000/e/<encuesta_id>?t=<token>` (o la URL de producción).
Para cerrarla: `update encuestas set estado = 'cerrada' where id = '<encuesta_id>';`
Para borrarla (cascada a opciones, invitados y votos): `delete from encuestas where id = '<encuesta_id>';`
