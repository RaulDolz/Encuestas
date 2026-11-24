-- 0006_editar_encuesta.sql
-- Editar una encuesta ya creada desde el artifact (vía /api/mcp). Solo una función
-- nueva; no cambia ninguna tabla.
--
-- security definer, search_path fijo, ejecutable SOLO por service_role. Re-ejecutable.
--
-- admin_editar_encuesta(p_encuesta, p_cambios) aplica TODO o NADA (una transacción).
-- p_cambios (todas las claves opcionales; cualquier otra clave -> cambios_invalidos):
--   titulo            text (1..200)
--   descripcion       text | null (<= 2000)
--   cierre            ISO 8601 con offset, futuro
--   reabrir           boolean: si la encuesta está cerrada, vuelve a abierta (el cierre debe ser futuro)
--   opciones_nuevas   [{inicio, fin}]  ISO con offset, inicio futuro, fin > inicio
--   opciones_quitar   [uuid]           (sus votos se borran en cascada)
--   invitados_nuevos  [{nombre?, email?}]  nombre o email; sin email se guarda uno ficticio
--   invitados_editar  [{id, nombre?, email?}]  email "" o null -> ficticio
--   invitados_quitar  [uuid]           (sus votos se borran en cascada)
-- Al final debe quedar: 1..50 opciones sin repetir, 1..200 invitados, emails únicos y
-- nombres sin repetir (public.clave_nombre, de 0005).
-- Una encuesta convocada no se puede editar.
--
-- Errores (SQLSTATE P0001, mensaje = código): encuesta_no_encontrada, encuesta_convocada,
--   cambios_invalidos, titulo_invalido, descripcion_invalida, cierre_invalido,
--   opciones_invalidas, opcion_invalida, invitados_invalidos, invitado_invalido,
--   nombres_repetidos
-- Devuelve jsonb {id, estado}.

create or replace function public.admin_editar_encuesta(
  p_encuesta uuid,
  p_cambios  jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_iso   constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$';
  c_email constant text := '^[^\s@<>(),;:"\[\]]+@[^\s@<>(),;:"\[\]]+\.[A-Za-z]{2,}$';
  c_uuid  constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  c       jsonb := coalesce(p_cambios, '{}'::jsonb);
  v_estado text;
  v_cierre timestamptz;
  v_txt    text;
  v_n      int;
  v_orden  int;
  x        jsonb;
begin
  if jsonb_typeof(c) <> 'object'
     or exists (select 1 from jsonb_object_keys(c) k where k not in (
          'titulo', 'descripcion', 'cierre', 'reabrir', 'opciones_nuevas', 'opciones_quitar',
          'invitados_nuevos', 'invitados_editar', 'invitados_quitar')) then
    raise exception using message = 'cambios_invalidos', errcode = 'P0001';
  end if;

  select e.estado, e.cierre into v_estado, v_cierre from public.encuestas e where e.id = p_encuesta for update;
  if not found then
    raise exception using message = 'encuesta_no_encontrada', errcode = 'P0001';
  end if;
  if v_estado = 'convocada' then
    raise exception using message = 'encuesta_convocada', errcode = 'P0001';
  end if;

  -- Arrays: si vienen, deben ser arrays.
  if exists (select 1 from unnest(array['opciones_nuevas', 'opciones_quitar', 'invitados_nuevos', 'invitados_editar', 'invitados_quitar']) k
              where c ? k and jsonb_typeof(c -> k) <> 'array') then
    raise exception using message = 'cambios_invalidos', errcode = 'P0001';
  end if;

  -- ---- Datos generales ----
  if c ? 'titulo' then
    v_txt := btrim(coalesce(c ->> 'titulo', ''));
    if jsonb_typeof(c -> 'titulo') <> 'string' or v_txt = '' or char_length(v_txt) > 200 then
      raise exception using message = 'titulo_invalido', errcode = 'P0001';
    end if;
    update public.encuestas set titulo = v_txt where id = p_encuesta;
  end if;
  if c ? 'descripcion' then
    if jsonb_typeof(c -> 'descripcion') not in ('string', 'null') then
      raise exception using message = 'descripcion_invalida', errcode = 'P0001';
    end if;
    v_txt := nullif(btrim(coalesce(c ->> 'descripcion', '')), '');
    if v_txt is not null and char_length(v_txt) > 2000 then
      raise exception using message = 'descripcion_invalida', errcode = 'P0001';
    end if;
    update public.encuestas set descripcion = v_txt where id = p_encuesta;
  end if;
  if c ? 'cierre' then
    if jsonb_typeof(c -> 'cierre') <> 'string' or (c ->> 'cierre') !~ c_iso then
      raise exception using message = 'cierre_invalido', errcode = 'P0001';
    end if;
    begin
      v_cierre := (c ->> 'cierre')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using message = 'cierre_invalido', errcode = 'P0001';
    end;
    if v_cierre <= now() then
      raise exception using message = 'cierre_invalido', errcode = 'P0001';
    end if;
    update public.encuestas set cierre = v_cierre where id = p_encuesta;
  end if;
  if c ? 'reabrir' then
    if jsonb_typeof(c -> 'reabrir') <> 'boolean' then
      raise exception using message = 'cambios_invalidos', errcode = 'P0001';
    end if;
    if (c ->> 'reabrir')::boolean and v_estado = 'cerrada' then
      if v_cierre <= now() then
        raise exception using message = 'cierre_invalido', errcode = 'P0001';
      end if;
      update public.encuestas set estado = 'abierta' where id = p_encuesta;
      v_estado := 'abierta';
    end if;
  end if;

  -- ---- Opciones ----
  if c ? 'opciones_quitar' then
    if exists (select 1 from jsonb_array_elements(c -> 'opciones_quitar') q
                where jsonb_typeof(q) <> 'string' or (q #>> '{}') !~ c_uuid
                   or not exists (select 1 from public.opciones o where o.id = (q #>> '{}')::uuid and o.encuesta_id = p_encuesta)) then
      raise exception using message = 'opcion_invalida', errcode = 'P0001';
    end if;
    delete from public.opciones o
     where o.encuesta_id = p_encuesta
       and o.id in (select (q #>> '{}')::uuid from jsonb_array_elements(c -> 'opciones_quitar') q);
  end if;

  if c ? 'opciones_nuevas' then
    if exists (
      select 1 from jsonb_array_elements(c -> 'opciones_nuevas') o
       where jsonb_typeof(o) <> 'object'
          or jsonb_typeof(o -> 'inicio') is distinct from 'string'
          or jsonb_typeof(o -> 'fin') is distinct from 'string'
          or (o ->> 'inicio') !~ c_iso or (o ->> 'fin') !~ c_iso
          or (select count(*) from jsonb_object_keys(o) k where k not in ('inicio', 'fin')) > 0
    ) then
      raise exception using message = 'opciones_invalidas', errcode = 'P0001';
    end if;
    begin
      if exists (select 1 from jsonb_array_elements(c -> 'opciones_nuevas') o
                  where (o ->> 'fin')::timestamptz <= (o ->> 'inicio')::timestamptz
                     or (o ->> 'inicio')::timestamptz <= now()) then
        raise exception using message = 'opciones_invalidas', errcode = 'P0001';
      end if;
      select coalesce(max(orden), 0) into v_orden from public.opciones where encuesta_id = p_encuesta;
      insert into public.opciones (encuesta_id, inicio, fin, orden)
      select p_encuesta, (o ->> 'inicio')::timestamptz, (o ->> 'fin')::timestamptz, v_orden + ord::int
        from jsonb_array_elements(c -> 'opciones_nuevas') with ordinality as t(o, ord);
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using message = 'opciones_invalidas', errcode = 'P0001';
    end;
  end if;

  select count(*), count(*) - count(distinct (inicio, fin)) into v_orden, v_n
    from public.opciones where encuesta_id = p_encuesta;
  if v_orden not between 1 and 50 or v_n > 0 then
    raise exception using message = 'opciones_invalidas', errcode = 'P0001';
  end if;

  -- ---- Invitados ----
  if c ? 'invitados_quitar' then
    if exists (select 1 from jsonb_array_elements(c -> 'invitados_quitar') q
                where jsonb_typeof(q) <> 'string' or (q #>> '{}') !~ c_uuid
                   or not exists (select 1 from public.invitados i where i.id = (q #>> '{}')::uuid and i.encuesta_id = p_encuesta)) then
      raise exception using message = 'invitado_invalido', errcode = 'P0001';
    end if;
    delete from public.invitados i
     where i.encuesta_id = p_encuesta
       and i.id in (select (q #>> '{}')::uuid from jsonb_array_elements(c -> 'invitados_quitar') q);
  end if;

  begin
    if c ? 'invitados_editar' then
      for x in select * from jsonb_array_elements(c -> 'invitados_editar') loop
        if jsonb_typeof(x) <> 'object'
           or jsonb_typeof(x -> 'id') is distinct from 'string' or (x ->> 'id') !~ c_uuid
           or (select count(*) from jsonb_object_keys(x) k where k not in ('id', 'nombre', 'email')) > 0
           or (x ? 'nombre' and jsonb_typeof(x -> 'nombre') not in ('string', 'null'))
           or (x ? 'email' and jsonb_typeof(x -> 'email') not in ('string', 'null'))
           or char_length(coalesce(x ->> 'nombre', '')) > 100
           or char_length(coalesce(x ->> 'email', '')) > 254 then
          raise exception using message = 'invitados_invalidos', errcode = 'P0001';
        end if;
        if not exists (select 1 from public.invitados i where i.id = (x ->> 'id')::uuid and i.encuesta_id = p_encuesta) then
          raise exception using message = 'invitado_invalido', errcode = 'P0001';
        end if;
        if x ? 'nombre' then
          update public.invitados
             set nombre = nullif(regexp_replace(btrim(coalesce(x ->> 'nombre', '')), '\s+', ' ', 'g'), '')
           where id = (x ->> 'id')::uuid;
        end if;
        if x ? 'email' then
          v_txt := lower(btrim(coalesce(x ->> 'email', '')));
          if v_txt = '' then
            -- Sin email: se conserva el ficticio si ya lo tenía; si no, uno nuevo.
            update public.invitados
               set email = 'sin-email-' || encode(extensions.gen_random_bytes(8), 'hex') || '@jorcas.invalid'
             where id = (x ->> 'id')::uuid and email !~ '^sin-email-[0-9a-f]{16}@jorcas\.invalid$';
          elsif v_txt !~ c_email or v_txt ~ '^sin-email-[0-9a-f]{16}@jorcas\.invalid$' then
            raise exception using message = 'invitados_invalidos', errcode = 'P0001';
          else
            update public.invitados set email = v_txt where id = (x ->> 'id')::uuid;
          end if;
        end if;
      end loop;
    end if;

    if c ? 'invitados_nuevos' then
      if exists (
        select 1 from jsonb_array_elements(c -> 'invitados_nuevos') i
         where jsonb_typeof(i) <> 'object'
            or (select count(*) from jsonb_object_keys(i) k where k not in ('email', 'nombre')) > 0
            or (i ? 'nombre' and jsonb_typeof(i -> 'nombre') not in ('string', 'null'))
            or (i ? 'email' and jsonb_typeof(i -> 'email') not in ('string', 'null'))
            or char_length(coalesce(i ->> 'nombre', '')) > 100
            or char_length(coalesce(i ->> 'email', '')) > 254
            or (btrim(coalesce(i ->> 'email', '')) = '' and btrim(coalesce(i ->> 'nombre', '')) = '')
            or (btrim(coalesce(i ->> 'email', '')) <> '' and (lower(btrim(i ->> 'email')) !~ c_email
                or lower(btrim(i ->> 'email')) ~ '^sin-email-[0-9a-f]{16}@jorcas\.invalid$'))
      ) then
        raise exception using message = 'invitados_invalidos', errcode = 'P0001';
      end if;
      insert into public.invitados (encuesta_id, email, nombre)
      select p_encuesta,
             coalesce(nullif(lower(btrim(coalesce(i ->> 'email', ''))), ''),
                      'sin-email-' || encode(extensions.gen_random_bytes(8), 'hex') || '@jorcas.invalid'),
             nullif(regexp_replace(btrim(coalesce(i ->> 'nombre', '')), '\s+', ' ', 'g'), '')
        from jsonb_array_elements(c -> 'invitados_nuevos') i;
    end if;
  exception when unique_violation then
    -- Email repetido dentro de la encuesta (restricción unique (encuesta_id, email)).
    raise exception using message = 'invitados_invalidos', errcode = 'P0001';
  end;

  select count(*) into v_n from public.invitados where encuesta_id = p_encuesta;
  if v_n not between 1 and 200 then
    raise exception using message = 'invitados_invalidos', errcode = 'P0001';
  end if;
  if exists (select 1 from public.invitados where encuesta_id = p_encuesta and nombre is not null
              group by public.clave_nombre(nombre) having count(*) > 1) then
    raise exception using message = 'nombres_repetidos', errcode = 'P0001';
  end if;

  return jsonb_build_object('id', p_encuesta, 'estado', v_estado);
end;
$$;

revoke all on function public.admin_editar_encuesta(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.admin_editar_encuesta(uuid, jsonb) to service_role;
