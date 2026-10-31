-- 0003_invitado_por_token.sql
-- Busca el invitado de una encuesta por su token.
--
-- Existe para que el token viaje en el body de un POST (RPC) y no en la query
-- string de un GET a /rest/v1/invitados, que queda registrada en los logs del
-- gateway de Supabase.
--
-- Devuelve 0 o 1 fila (id, nombre). Nunca devuelve email ni token.

create or replace function public.invitado_por_token(
  p_encuesta uuid,
  p_token    text
) returns table (id uuid, nombre text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select i.id, i.nombre
    from public.invitados i
   where i.encuesta_id = p_encuesta
     and i.token = p_token
   limit 1;
$$;

revoke all on function public.invitado_por_token(uuid, text) from public;
revoke all on function public.invitado_por_token(uuid, text) from anon, authenticated;
grant execute on function public.invitado_por_token(uuid, text) to service_role;
