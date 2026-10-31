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
                    ('invitado_por_token', 'public.invitado_por_token(uuid, text)')) as f(funcion, firma)
 where r.rolname in ('anon', 'authenticated', 'service_role', 'postgres')
 order by 1, 2;
