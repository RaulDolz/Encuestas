-- 0002_registrar_votos.sql
-- Registra (o actualiza) la disponibilidad de un invitado en una encuesta.
--
-- p_votos: array JSON de objetos {"opcion_id": "<uuid>", "disponible": true|false}
--
-- Errores (SQLSTATE P0001, el texto del mensaje es el código):
--   token_invalido   -> el token no pertenece a esa encuesta
--   encuesta_cerrada -> estado <> 'abierta' o now() >= cierre
--   votos_invalidos  -> p_votos mal formado o con opciones repetidas
--   opcion_invalida  -> algún opcion_id no pertenece a la encuesta
--
-- Todo ocurre en la transacción de la llamada: si algo falla, no se escribe nada.

create or replace function public.registrar_votos(
  p_encuesta uuid,
  p_token    text,
  p_votos    jsonb
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invitado_id uuid;
  v_estado      text;
  v_cierre      timestamptz;
  v_total       int;
  v_distintas   int;
  v_validas     int;
begin
  if p_encuesta is null or p_token is null or p_token = '' then
    raise exception using message = 'token_invalido', errcode = 'P0001';
  end if;

  -- Bloquea la fila del invitado: serializa envíos simultáneos del mismo invitado.
  select i.id
    into v_invitado_id
    from public.invitados i
   where i.encuesta_id = p_encuesta
     and i.token = p_token
   for update;

  if v_invitado_id is null then
    raise exception using message = 'token_invalido', errcode = 'P0001';
  end if;

  -- FOR SHARE: impide que la encuesta se cierre a mitad de este registro.
  select e.estado, e.cierre
    into v_estado, v_cierre
    from public.encuestas e
   where e.id = p_encuesta
   for share;

  if v_estado is distinct from 'abierta' or not (now() < v_cierre) then
    raise exception using message = 'encuesta_cerrada', errcode = 'P0001';
  end if;

  -- Forma de p_votos: array no vacío de {opcion_id: uuid, disponible: boolean}.
  if p_votos is null or jsonb_typeof(p_votos) <> 'array' or jsonb_array_length(p_votos) = 0 then
    raise exception using message = 'votos_invalidos', errcode = 'P0001';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_votos) v
     where jsonb_typeof(v) <> 'object'
        or jsonb_typeof(v -> 'disponible') is distinct from 'boolean'
        or jsonb_typeof(v -> 'opcion_id') is distinct from 'string'
        or (v ->> 'opcion_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception using message = 'votos_invalidos', errcode = 'P0001';
  end if;

  select count(*), count(distinct (v ->> 'opcion_id')::uuid)
    into v_total, v_distintas
    from jsonb_array_elements(p_votos) v;

  if v_total <> v_distintas then
    raise exception using message = 'votos_invalidos', errcode = 'P0001';
  end if;

  -- Todas las opciones deben pertenecer a esta encuesta.
  select count(*)
    into v_validas
    from jsonb_array_elements(p_votos) v
    join public.opciones o
      on o.id = (v ->> 'opcion_id')::uuid
     and o.encuesta_id = p_encuesta;

  if v_validas <> v_total then
    raise exception using message = 'opcion_invalida', errcode = 'P0001';
  end if;

  insert into public.votos (invitado_id, opcion_id, disponible, actualizado_at)
  select v_invitado_id,
         (v ->> 'opcion_id')::uuid,
         (v ->> 'disponible')::boolean,
         now()
    from jsonb_array_elements(p_votos) v
  on conflict (invitado_id, opcion_id) do update
     set disponible     = excluded.disponible,
         actualizado_at = now();

  update public.invitados
     set respondio_at = now()
   where id = v_invitado_id;
end;
$$;

revoke all on function public.registrar_votos(uuid, text, jsonb) from public;
revoke all on function public.registrar_votos(uuid, text, jsonb) from anon, authenticated;
grant execute on function public.registrar_votos(uuid, text, jsonb) to service_role;
