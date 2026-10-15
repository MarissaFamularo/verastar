-- Disposable-database fixture for the spending/scheduler/invite tests. NEVER run against a
-- linked project. Recreates the parts of a Supabase database the migrations depend on:
-- the anon/authenticated/service_role roles (service_role bypasses RLS), Supabase's
-- default grants on new public objects (so a migration's revokes are actually tested), and
-- a minimal auth schema.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create extension if not exists pgcrypto;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email_confirmed_at timestamptz, raw_app_meta_data jsonb default '{}');
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant select on auth.users to service_role;
