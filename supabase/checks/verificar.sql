-- verificar.sql — solo lectura. Pégalo en el SQL Editor tras aplicar las migraciones.

-- 1) RLS activo en las 4 tablas (rls = true en todas).
select c.relname as tabla, c.relrowsecurity as rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('encuestas', 'opciones', 'invitados', 'votos')
 order by 1;

-- 2) Políticas existentes en esas tablas (lo esperado: ninguna para anon/authenticated).
select tablename, policyname, roles, cmd
  from pg_policies
 where schemaname = 'public'
   and tablename in ('encuestas', 'opciones', 'invitados', 'votos');

-- 3) Quién puede ejecutar las funciones (lo esperado: solo service_role y el owner).
select f.funcion, r.rolname,
       has_function_privilege(r.rolname, f.firma, 'execute') as puede_ejecutar
  from pg_roles r
 cross join (values ('registrar_votos',    'public.registrar_votos(uuid, text, jsonb)'),
                    ('invitado_por_token', 'public.invitado_por_token(uuid, text)'),
                    ('admin_crear_encuesta',    'public.admin_crear_encuesta(text, text, timestamptz, jsonb, jsonb)'),
                    ('admin_cerrar_encuesta',   'public.admin_cerrar_encuesta(uuid)'),
                    ('admin_convocar_encuesta', 'public.admin_convocar_encuesta(uuid, uuid, text)'),
                    ('clave_nombre',            'public.clave_nombre(text)'),
                    ('token_de_invitado',       'public.token_de_invitado(uuid, uuid)'),
                    ('alta_invitado_comun',     'public.alta_invitado_comun(uuid, text)')) as f(funcion, firma)
 where r.rolname in ('anon', 'authenticated', 'service_role', 'postgres')
 order by 1, 2;
