-- Close default privileges for objects created later in schema private.
--
-- Not applied by the change that added this file. Apply it with the usual
-- migration path when you are ready. It does not rewrite privileges on
-- objects that already exist, including the explicit execute grant on
-- private.gmail_alias_lookup.
--
-- Postgres grants EXECUTE to PUBLIC on every new function unless that global
-- default is revoked. A REVOKE limited to one schema cannot remove it: per-schema
-- default privileges only add grants, or undo an earlier grant in that same
-- schema. New functions in private were therefore executable by anon and
-- authenticated even though the tables there are owner-only.
--
-- The global revoke below applies to functions created by postgres, which is
-- the role that owns this schema. Default grants already recorded for schema
-- public (anon, authenticated, service_role) stay in place, so a new public
-- function remains callable by those Data API roles. A role that is none of
-- those no longer receives EXECUTE merely by existing.
--
-- The private-schema revokes undo a copy of the public grants onto private.
-- They do not change schema public.

begin;

create schema if not exists private;

alter default privileges for role postgres
  revoke execute on functions from public;

alter default privileges for role postgres in schema private
  revoke all on functions from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema private
  revoke all on tables from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema private
  revoke all on sequences from public, anon, authenticated, service_role;

commit;
