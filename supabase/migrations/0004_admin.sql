-- 0004_admin.sql
-- Funciones de administración para el servidor MCP (/api/mcp) que usa el
-- artifact de actas. No cambia el esquema de ninguna tabla.
--
-- Todas: security definer, search_path fijo, ejecutables SOLO por service_role.
-- Re-ejecutable (create or replace + revoke/grant).
--
-- Errores: SQLSTATE P0001, el texto del mensaje es el código.
--   titulo_invalido, descripcion_invalida, cierre_invalido,
--   opciones_invalidas, invitados_invalidos, encuesta_no_encontrada,
--   opcion_invalida, encuesta_abierta, evento_invalido

-- ---------------------------------------------------------------------------
-- admin_crear_encuesta: encuesta + opciones + invitados en UNA transacción.
--
-- p_opciones:  [{"inicio": "<ISO 8601 con offset>", "fin": "<idem>"}, ...]  (1..50)
-- p_invitados: [{"email": "...", "nombre": "..." | null}, ...]               (1..200)
--
-- Devuelve jsonb:
--   {"id": uuid,
--    "opciones":  [{"id","inicio","fin","orden"}],
--    "invitados": [{"id","nombre","email","token"}]}
-- Los emails se guardan en minúsculas y sin espacios.
-- ---------------------------------------------------------------------------
create or replace function public.admin_crear_encuesta(
  p_titulo      text,
  p_descripcion text,
  p_cierre      timestamptz,
  p_opciones    jsonb,
  p_invitados   jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_iso   constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$';
  c_email constant text := '^[^\s@<>(),;:"\[\]]+@[^\s@<>(),;:"\[\]]+\.[A-Za-z]{2,}$';
  v_titulo    text := btrim(coalesce(p_titulo, ''));
  v_desc      text := nullif(btrim(coalesce(p_descripcion, '')), '');
  v_id        uuid;
  v_n         int;
  v_res_opc   jsonb;
  v_res_inv   jsonb;
begin
  if v_titulo = '' or char_length(v_titulo) > 200 then
    raise exception using message = 'titulo_invalido', errcode = 'P0001';
  end if;
  if v_desc is not null and char_length(v_desc) > 2000 then
    raise exception using message = 'descripcion_invalida', errcode = 'P0001';
  end if;
  if p_cierre is null or p_cierre <= now() then
    raise exception using message = 'cierre_invalido', errcode = 'P0001';
  end if;

  -- Opciones: forma, fechas ISO con offset, fin > inicio, inicio futuro, sin repetidas.
  if p_opciones is null or jsonb_typeof(p_opciones) <> 'array'
     or jsonb_array_length(p_opciones) not between 1 and 50 then
    raise exception using message = 'opciones_invalidas', errcode = 'P0001';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_opciones) o
     where jsonb_typeof(o) <> 'object'
        or jsonb_typeof(o -> 'inicio') is distinct from 'string'
        or jsonb_typeof(o -> 'fin') is distinct from 'string'
        or (o ->> 'inicio') !~ c_iso
        or (o ->> 'fin') !~ c_iso
        or (select count(*) from jsonb_object_keys(o) k where k not in ('inicio', 'fin')) > 0
  ) then
    raise exception using message = 'opciones_invalidas', errcode = 'P0001';
  end if;

  begin
    if exists (
      select 1 from jsonb_array_elements(p_opciones) o
       where (o ->> 'fin')::timestamptz <= (o ->> 'inicio')::timestamptz
          or (o ->> 'inicio')::timestamptz <= now()
    ) then
      raise exception using message = 'opciones_invalidas', errcode = 'P0001';
    end if;
    select count(*) - count(distinct ((o ->> 'inicio')::timestamptz, (o ->> 'fin')::timestamptz))
      into v_n
      from jsonb_array_elements(p_opciones) o;
  exception
    when invalid_datetime_format or datetime_field_overflow then
      raise exception using message = 'opciones_invalidas', errcode = 'P0001';
  end;
  if v_n > 0 then
    raise exception using message = 'opciones_invalidas', errcode = 'P0001';
  end if;

  -- Invitados: forma, email válido, nombre opcional <= 100, sin emails repetidos.
  if p_invitados is null or jsonb_typeof(p_invitados) <> 'array'
     or jsonb_array_length(p_invitados) not between 1 and 200 then
    raise exception using message = 'invitados_invalidos', errcode = 'P0001';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_invitados) i
     where jsonb_typeof(i) <> 'object'
        or jsonb_typeof(i -> 'email') is distinct from 'string'
        or char_length(i ->> 'email') > 254
        or lower(btrim(i ->> 'email')) !~ c_email
        or (i ? 'nombre' and jsonb_typeof(i -> 'nombre') not in ('string', 'null'))
        or char_length(coalesce(i ->> 'nombre', '')) > 100
        or (select count(*) from jsonb_object_keys(i) k where k not in ('email', 'nombre')) > 0
  ) then
    raise exception using message = 'invitados_invalidos', errcode = 'P0001';
  end if;
  select count(*) - count(distinct lower(btrim(i ->> 'email')))
    into v_n
    from jsonb_array_elements(p_invitados) i;
  if v_n > 0 then
    raise exception using message = 'invitados_invalidos', errcode = 'P0001';
  end if;

  insert into public.encuestas (titulo, descripcion, cierre, estado)
  values (v_titulo, v_desc, p_cierre, 'abierta')
  returning id into v_id;

  with ins as (
    insert into public.opciones (encuesta_id, inicio, fin, orden)
    select v_id, (o ->> 'inicio')::timestamptz, (o ->> 'fin')::timestamptz, ord::int
      from jsonb_array_elements(p_opciones) with ordinality as x(o, ord)
    returning id, inicio, fin, orden
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'inicio', inicio, 'fin', fin, 'orden', orden) order by orden), '[]'::jsonb)
    into v_res_opc
    from ins;

  with ins as (
    insert into public.invitados (encuesta_id, email, nombre)
    select v_id,
           lower(btrim(i ->> 'email')),
           nullif(btrim(coalesce(i ->> 'nombre', '')), '')
      from jsonb_array_elements(p_invitados) with ordinality as x(i, ord)
     order by ord
    returning id, nombre, email, token
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nombre', nombre, 'email', email, 'token', token) order by email), '[]'::jsonb)
    into v_res_inv
    from ins;

  return jsonb_build_object('id', v_id, 'opciones', v_res_opc, 'invitados', v_res_inv);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_cerrar_encuesta: abierta -> cerrada. Idempotente: si ya está cerrada o
-- convocada no cambia nada. Devuelve el estado final.
-- ---------------------------------------------------------------------------
create or replace function public.admin_cerrar_encuesta(
  p_encuesta uuid
) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_estado text;
begin
  select estado into v_estado from public.encuestas where id = p_encuesta for update;
  if not found then
    raise exception using message = 'encuesta_no_encontrada', errcode = 'P0001';
  end if;
  if v_estado = 'abierta' then
    update public.encuestas set estado = 'cerrada' where id = p_encuesta;
    v_estado := 'cerrada';
  end if;
  return v_estado;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_convocar_encuesta: cerrada|convocada -> convocada, con la opción
-- ganadora (debe ser de esa encuesta) y, opcionalmente, el id del evento de
-- Outlook. Una encuesta abierta hay que cerrarla antes.
-- ---------------------------------------------------------------------------
create or replace function public.admin_convocar_encuesta(
  p_encuesta uuid,
  p_opcion   uuid,
  p_evento   text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_estado text;
begin
  select estado into v_estado from public.encuestas where id = p_encuesta for update;
  if not found then
    raise exception using message = 'encuesta_no_encontrada', errcode = 'P0001';
  end if;
  if v_estado = 'abierta' then
    raise exception using message = 'encuesta_abierta', errcode = 'P0001';
  end if;
  if p_opcion is null or not exists (
    select 1 from public.opciones where id = p_opcion and encuesta_id = p_encuesta
  ) then
    raise exception using message = 'opcion_invalida', errcode = 'P0001';
  end if;
  if p_evento is not null and (char_length(p_evento) not between 1 and 512 or p_evento !~ '^[A-Za-z0-9+/=_-]+$') then
    raise exception using message = 'evento_invalido', errcode = 'P0001';
  end if;

  update public.encuestas
     set estado = 'convocada',
         ganadora_opcion_id = p_opcion,
         evento_outlook_id = p_evento
   where id = p_encuesta;
end;
$$;

revoke all on function public.admin_crear_encuesta(text, text, timestamptz, jsonb, jsonb) from public;
revoke all on function public.admin_crear_encuesta(text, text, timestamptz, jsonb, jsonb) from anon, authenticated;
grant execute on function public.admin_crear_encuesta(text, text, timestamptz, jsonb, jsonb) to service_role;

revoke all on function public.admin_cerrar_encuesta(uuid) from public;
revoke all on function public.admin_cerrar_encuesta(uuid) from anon, authenticated;
grant execute on function public.admin_cerrar_encuesta(uuid) to service_role;

revoke all on function public.admin_convocar_encuesta(uuid, uuid, text) from public;
revoke all on function public.admin_convocar_encuesta(uuid, uuid, text) from anon, authenticated;
grant execute on function public.admin_convocar_encuesta(uuid, uuid, text) to service_role;
