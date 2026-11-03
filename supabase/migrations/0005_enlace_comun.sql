-- 0005_enlace_comun.sql
-- Enlace común por encuesta: quien lo abre elige su nombre en la lista o se
-- añade. Solo funciones nuevas; no cambia ninguna tabla.
--
-- Todas: security definer, search_path fijo, ejecutables SOLO por service_role.
-- Re-ejecutable (create or replace + revoke/grant).
--
-- Errores: SQLSTATE P0001, el texto del mensaje es el código.
--   nombre_invalido, nombre_repetido, encuesta_no_encontrada,
--   encuesta_cerrada, demasiados_invitados

-- Clave de comparación de nombres: sin espacios sobrantes, minúsculas y sin
-- tildes (la ñ se conserva: «Peña» y «Pena» son personas distintas).
create or replace function public.clave_nombre(p text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select translate(
           lower(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g')),
           'áàâäéèêëíìîïóòôöúùûü',
           'aaaaeeeeiiiioooouuuu'
         );
$$;

-- ---------------------------------------------------------------------------
-- token_de_invitado: token del invitado si pertenece a esa encuesta (null si no).
-- Lo usa la entrada por enlace común después de comprobar el código de la URL.
-- ---------------------------------------------------------------------------
create or replace function public.token_de_invitado(
  p_encuesta uuid,
  p_invitado uuid
) returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select token from public.invitados where id = p_invitado and encuesta_id = p_encuesta;
$$;

-- ---------------------------------------------------------------------------
-- alta_invitado_comun: añade a alguien que no estaba en la lista.
-- Solo con la votación abierta y antes del cierre; máximo 200 invitados;
-- el nombre no puede repetir otro de la encuesta (comparación por clave_nombre).
-- El email es ficticio (la columna es NOT NULL y única por encuesta):
--   sin-email-<16 hex>@jorcas.invalid
-- Devuelve (id, token).
-- ---------------------------------------------------------------------------
create or replace function public.alta_invitado_comun(
  p_encuesta uuid,
  p_nombre   text
) returns table (id uuid, token text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_nombre text := regexp_replace(btrim(coalesce(p_nombre, '')), '\s+', ' ', 'g');
  v_estado text;
  v_cierre timestamptz;
begin
  if v_nombre = '' or char_length(v_nombre) > 100 then
    raise exception using message = 'nombre_invalido', errcode = 'P0001';
  end if;

  -- Bloquea la encuesta: dos altas simultáneas con el mismo nombre se serializan.
  select e.estado, e.cierre into v_estado, v_cierre
    from public.encuestas e where e.id = p_encuesta for update;
  if not found then
    raise exception using message = 'encuesta_no_encontrada', errcode = 'P0001';
  end if;
  if v_estado <> 'abierta' or v_cierre <= now() then
    raise exception using message = 'encuesta_cerrada', errcode = 'P0001';
  end if;
  if (select count(*) from public.invitados i where i.encuesta_id = p_encuesta) >= 200 then
    raise exception using message = 'demasiados_invitados', errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.invitados i
     where i.encuesta_id = p_encuesta
       and i.nombre is not null
       and public.clave_nombre(i.nombre) = public.clave_nombre(v_nombre)
  ) then
    raise exception using message = 'nombre_repetido', errcode = 'P0001';
  end if;

  return query
    insert into public.invitados as i (encuesta_id, email, nombre)
    values (
      p_encuesta,
      'sin-email-' || encode(extensions.gen_random_bytes(8), 'hex') || '@jorcas.invalid',
      v_nombre
    )
    returning i.id, i.token;
end;
$$;

revoke all on function public.clave_nombre(text) from public, anon, authenticated;
revoke all on function public.token_de_invitado(uuid, uuid) from public, anon, authenticated;
revoke all on function public.alta_invitado_comun(uuid, text) from public, anon, authenticated;
grant execute on function public.clave_nombre(text) to service_role;
grant execute on function public.token_de_invitado(uuid, uuid) to service_role;
grant execute on function public.alta_invitado_comun(uuid, text) to service_role;
