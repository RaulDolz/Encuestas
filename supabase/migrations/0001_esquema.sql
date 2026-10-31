-- 0001_esquema.sql
-- Esquema de encuestas de fecha (Comisión de Fiestas de Jorcas 2027).
--
-- Idempotente y NO destructivo: cada tabla solo se crea (y se le activa RLS)
-- si todavía no existe. Si ya la creó el artifact de actas, no se toca nada:
-- ni columnas, ni constraints, ni RLS. Usa supabase/checks/verificar.sql para
-- comprobar el estado real de RLS y permisos.

-- gen_random_bytes() viene de pgcrypto. En Supabase ya está instalada en el
-- esquema "extensions"; estas dos sentencias son no-op allí.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if to_regclass('public.encuestas') is null then
    create table public.encuestas (
      id                 uuid primary key default gen_random_uuid(),
      titulo             text not null,
      descripcion        text,
      cierre             timestamptz not null,
      estado             text not null default 'abierta'
                           check (estado in ('abierta', 'cerrada', 'convocada')),
      ganadora_opcion_id uuid null,
      evento_outlook_id  text null,
      creada_at          timestamptz default now()
    );
    alter table public.encuestas enable row level security;
  end if;

  if to_regclass('public.opciones') is null then
    create table public.opciones (
      id          uuid primary key default gen_random_uuid(),
      encuesta_id uuid references public.encuestas on delete cascade,
      inicio      timestamptz not null,
      fin         timestamptz not null,
      orden       int
    );
    alter table public.opciones enable row level security;
  end if;

  if to_regclass('public.invitados') is null then
    create table public.invitados (
      id           uuid primary key default gen_random_uuid(),
      encuesta_id  uuid references public.encuestas on delete cascade,
      email        text not null,
      nombre       text,
      token        text unique not null default encode(extensions.gen_random_bytes(24), 'hex'),
      enviado_at   timestamptz,
      respondio_at timestamptz,
      unique (encuesta_id, email)
    );
    alter table public.invitados enable row level security;
  end if;

  if to_regclass('public.votos') is null then
    create table public.votos (
      invitado_id    uuid references public.invitados on delete cascade,
      opcion_id      uuid references public.opciones on delete cascade,
      disponible     boolean not null,
      actualizado_at timestamptz default now(),
      primary key (invitado_id, opcion_id)
    );
    alter table public.votos enable row level security;
  end if;
end
$$;

-- Sin políticas para anon ni authenticated: con RLS activo, solo service_role
-- (que hace bypass de RLS) puede leer o escribir.
