-- Disposable database only. Recreates the Supabase-shaped defaults this
-- migration has to close, including a copy of those grants onto schema private.
-- NEVER run against a linked project.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'bystander') then create role bystander nologin; end if;
end $$;

grant usage on schema public to anon, authenticated, service_role, bystander;

alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to anon, authenticated, service_role;

create schema if not exists private;
grant usage on schema private to anon, authenticated, service_role, bystander;

-- The leak the migration must undo: the same grants, aimed at private.
alter default privileges for role postgres in schema private
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema private
  grant execute on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema private
  grant usage, select on sequences to anon, authenticated, service_role;
