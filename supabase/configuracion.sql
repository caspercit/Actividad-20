-- Ejecutar en Supabase > SQL Editor, una sola vez.
-- Activar antes: Authentication > Providers > Anonymous Sign-Ins.
-- Diseño: usuarios anonimos autenticados; cada uno ve y carga solo sus incidencias.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('incidencias', 'incidencias', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.incidencias (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  titulo text not null check (char_length(trim(titulo)) between 3 and 100),
  descripcion text not null check (char_length(trim(descripcion)) between 5 and 1000),
  foto_path text not null unique,
  created_at timestamptz not null default now(),
  constraint ruta_propia check (foto_path like usuario_id::text || '/%')
);

alter table public.incidencias enable row level security;

drop policy if exists "Leer incidencias propias" on public.incidencias;
create policy "Leer incidencias propias" on public.incidencias
for select to authenticated using (usuario_id = (select auth.uid()));

drop policy if exists "Crear incidencias propias" on public.incidencias;
create policy "Crear incidencias propias" on public.incidencias
for insert to authenticated with check (usuario_id = (select auth.uid()));

-- Nota: las políticas de Storage se comprueban además del bucket privado.
drop policy if exists "Subir fotos a carpeta propia" on storage.objects;
create policy "Subir fotos a carpeta propia" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'incidencias'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and lower(storage.extension(name)) in ('jpg','jpeg','png','webp')
);

drop policy if exists "Leer fotos propias" on storage.objects;
create policy "Leer fotos propias" on storage.objects
for select to authenticated
using (
  bucket_id = 'incidencias'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

-- No existen políticas UPDATE ni DELETE para estos usuarios.
-- Importante: probar el aislamiento con dos sesiones diferentes.
