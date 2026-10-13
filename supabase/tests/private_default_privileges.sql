-- Isolated test DB only. The fixture must run first.
\set ON_ERROR_STOP on

create or replace function pg_temp.assert_ok(v boolean, label text) returns void language plpgsql as $$
begin
  if not coalesce(v, false) then
    raise exception 'FAIL: %', label;
  end if;
end $$;

-- Before the migration, a new private function is executable by the anon key
-- and by a role that was never granted anything.
create function private.open_before() returns int language sql as 'select 1';
select pg_temp.assert_ok(has_function_privilege('anon', 'private.open_before()', 'execute'), 'before: anon can execute a new private function');
select pg_temp.assert_ok(has_function_privilege('bystander', 'private.open_before()', 'execute'), 'before: a bystander can execute a new private function');

-- An explicit grant, with PUBLIC removed, has to survive the migration.
create function private.granted_before() returns int language sql as 'select 1';
revoke all on function private.granted_before() from public;
grant execute on function private.granted_before() to anon;
select pg_temp.assert_ok(has_function_privilege('anon', 'private.granted_before()', 'execute'), 'before: explicit anon execute is present');
select pg_temp.assert_ok(not has_function_privilege('bystander', 'private.granted_before()', 'execute'), 'before: explicit grant does not include a bystander');

\ir ../migrations/20261013040000_private_default_privileges.sql

create function private.created_after() returns int language sql as 'select 1';
create procedure private.created_after_proc() language plpgsql as $$ begin null; end $$;
create table private.created_after_tbl (id int);
create sequence private.created_after_seq;
create view private.created_after_view as select 1 as id;
create function public.created_after_pub() returns int language sql as 'select 1';
create table public.created_after_pub_tbl (id int);

select pg_temp.assert_ok(not has_function_privilege('anon', 'private.created_after()', 'execute'), 'after: anon cannot execute a new private function');
select pg_temp.assert_ok(not has_function_privilege('authenticated', 'private.created_after()', 'execute'), 'after: authenticated cannot execute a new private function');
select pg_temp.assert_ok(not has_function_privilege('service_role', 'private.created_after()', 'execute'), 'after: service_role cannot execute a new private function');
select pg_temp.assert_ok(not has_function_privilege('bystander', 'private.created_after()', 'execute'), 'after: a bystander cannot execute a new private function');
select pg_temp.assert_ok(not has_function_privilege('anon', 'private.created_after_proc()', 'execute'), 'after: anon cannot execute a new private procedure');

select pg_temp.assert_ok(has_function_privilege('anon', 'private.granted_before()', 'execute'), 'existing explicit execute grant is kept');
select pg_temp.assert_ok(not has_function_privilege('bystander', 'private.granted_before()', 'execute'), 'existing explicit grant stays limited to anon');
select pg_temp.assert_ok(has_function_privilege('bystander', 'private.open_before()', 'execute'), 'existing function privileges are not rewritten');

select pg_temp.assert_ok(not has_table_privilege('anon', 'private.created_after_tbl', 'select'), 'after: anon cannot select a new private table');
select pg_temp.assert_ok(not has_table_privilege('anon', 'private.created_after_tbl', 'insert'), 'after: anon cannot insert a new private table');
select pg_temp.assert_ok(not has_table_privilege('authenticated', 'private.created_after_tbl', 'select'), 'after: authenticated cannot select a new private table');
select pg_temp.assert_ok(not has_table_privilege('service_role', 'private.created_after_tbl', 'select'), 'after: service_role cannot select a new private table');
select pg_temp.assert_ok(not has_table_privilege('anon', 'private.created_after_view', 'select'), 'after: anon cannot select a new private view');
select pg_temp.assert_ok(not has_sequence_privilege('anon', 'private.created_after_seq', 'usage'), 'after: anon cannot use a new private sequence');
select pg_temp.assert_ok(not has_sequence_privilege('anon', 'private.created_after_seq', 'select'), 'after: anon cannot select a new private sequence');
select pg_temp.assert_ok(not has_sequence_privilege('service_role', 'private.created_after_seq', 'usage'), 'after: service_role cannot use a new private sequence');

-- Schema public keeps the Data API grants. A role outside those grants does not.
select pg_temp.assert_ok(has_function_privilege('anon', 'public.created_after_pub()', 'execute'), 'after: anon can still execute a new public function');
select pg_temp.assert_ok(has_function_privilege('authenticated', 'public.created_after_pub()', 'execute'), 'after: authenticated can still execute a new public function');
select pg_temp.assert_ok(has_function_privilege('service_role', 'public.created_after_pub()', 'execute'), 'after: service_role can still execute a new public function');
select pg_temp.assert_ok(not has_function_privilege('bystander', 'public.created_after_pub()', 'execute'), 'after: a bystander cannot execute a new public function');
select pg_temp.assert_ok(has_table_privilege('anon', 'public.created_after_pub_tbl', 'select'), 'after: anon can still select a new public table');
select pg_temp.assert_ok(has_table_privilege('service_role', 'public.created_after_pub_tbl', 'insert'), 'after: service_role can still insert a new public table');

-- Applying the migration again does not reopen private or disturb public.
\ir ../migrations/20261013040000_private_default_privileges.sql

create function private.created_after_rerun() returns int language sql as 'select 1';
create table private.created_after_rerun_tbl (id int);
create function public.created_after_pub_rerun() returns int language sql as 'select 1';

select pg_temp.assert_ok(not has_function_privilege('anon', 'private.created_after_rerun()', 'execute'), 'rerun: anon cannot execute a new private function');
select pg_temp.assert_ok(not has_function_privilege('bystander', 'private.created_after_rerun()', 'execute'), 'rerun: a bystander cannot execute a new private function');
select pg_temp.assert_ok(not has_table_privilege('anon', 'private.created_after_rerun_tbl', 'select'), 'rerun: anon cannot select a new private table');
select pg_temp.assert_ok(has_function_privilege('anon', 'private.granted_before()', 'execute'), 'rerun: existing explicit execute grant is kept');
select pg_temp.assert_ok(not has_function_privilege('bystander', 'private.granted_before()', 'execute'), 'rerun: existing explicit grant stays limited to anon');
select pg_temp.assert_ok(has_function_privilege('anon', 'public.created_after_pub_rerun()', 'execute'), 'rerun: anon can still execute a new public function');
select pg_temp.assert_ok(not has_function_privilege('bystander', 'public.created_after_pub_rerun()', 'execute'), 'rerun: a bystander cannot execute a new public function');
