-- Beta admin dashboard / signup survey: post-migration, PRE-GRANT verification.
-- Run as postgres (SQL editor or psql) right after applying
-- 20261015120000_beta_admin_dashboard_survey.sql and BEFORE inserting anyone into
-- private.beta_admins. Read-only: every check is a catalog read or a call that is
-- expected to be refused before it writes. Raises on the first failure, otherwise
-- prints one "ok:" notice per check and ends with "ALL CHECKS PASSED".
--
-- Sections: (1) objects, owners, SECURITY DEFINER and search_path; (2) EXECUTE on every
-- RPC and the private helper; (3) table and column grants, including that participants
-- cannot read cohort or answers; (4) the allowlist is empty; (5) runtime denials with the
-- allowlist empty: a non-admin and an anonymous caller are refused, and a signed-in
-- account without a sponsored_accounts row cannot submit a survey (nothing is written).
do $$
declare
  r record;
  n integer;
  v boolean;
  v_probe uuid := '00000000-0000-4000-8000-00000000beef'; -- any uuid: never on the allowlist, never sponsored
begin
  -- (1) objects ---------------------------------------------------------------------------
  perform 1 from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'private' and c.relname = 'beta_admins' and c.relkind = 'r' and c.relrowsecurity;
  if not found then raise exception 'FAIL: private.beta_admins missing or RLS off'; end if;
  raise notice 'ok: private.beta_admins exists with RLS';
  perform 1 from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relname = 'beta_survey_responses' and c.relkind = 'r' and c.relrowsecurity;
  if not found then raise exception 'FAIL: public.beta_survey_responses missing or RLS off'; end if;
  raise notice 'ok: public.beta_survey_responses exists with RLS';
  for r in
    select s.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.proconfig, p.oid
      from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where (s.nspname, p.proname) in (('public','beta_survey_submit'), ('public','beta_admin_check'), ('public','beta_admin_stats'), ('private','beta_payload_count'))
  loop
    if r.owner <> 'postgres' then raise exception 'FAIL: %.% owned by %', r.nspname, r.proname, r.owner; end if;
    if r.proconfig is null or not ('search_path=""' = any(r.proconfig)) then raise exception 'FAIL: %.% search_path is not empty: %', r.nspname, r.proname, r.proconfig; end if;
    if r.nspname = 'public' and not r.prosecdef then raise exception 'FAIL: %.% must be SECURITY DEFINER', r.nspname, r.proname; end if;
    if r.nspname = 'private' and r.prosecdef then raise exception 'FAIL: %.% must be SECURITY INVOKER', r.nspname, r.proname; end if;
    raise notice 'ok: %.%(%) owner=% secdef=% search_path=""', r.nspname, r.proname, r.args, r.owner, r.prosecdef;
  end loop;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where (s.nspname, p.proname) in (('public','beta_survey_submit'), ('public','beta_admin_check'), ('public','beta_admin_stats'), ('private','beta_payload_count'));
  if n <> 4 then raise exception 'FAIL: expected 4 functions, found %', n; end if;

  -- (2) EXECUTE privileges ----------------------------------------------------------------
  for r in select * from (values
      ('public.beta_survey_submit(text,text,text,jsonb)', 'anon', false), ('public.beta_survey_submit(text,text,text,jsonb)', 'authenticated', true), ('public.beta_survey_submit(text,text,text,jsonb)', 'service_role', true),
      ('public.beta_admin_check()', 'anon', false), ('public.beta_admin_check()', 'authenticated', true), ('public.beta_admin_check()', 'service_role', true),
      ('public.beta_admin_stats(timestamptz,timestamptz)', 'anon', false), ('public.beta_admin_stats(timestamptz,timestamptz)', 'authenticated', true), ('public.beta_admin_stats(timestamptz,timestamptz)', 'service_role', true),
      ('private.beta_payload_count(jsonb,text)', 'anon', false), ('private.beta_payload_count(jsonb,text)', 'authenticated', false), ('private.beta_payload_count(jsonb,text)', 'service_role', false)
    ) as t(fn, role, expected)
  loop
    if has_function_privilege(r.role, r.fn, 'execute') <> r.expected then raise exception 'FAIL: execute on % for % should be %', r.fn, r.role, r.expected; end if;
    raise notice 'ok: execute % for % = %', r.fn, r.role, r.expected;
  end loop;
  if has_function_privilege('public', 'public.beta_admin_stats(timestamptz,timestamptz)', 'execute') then raise exception 'FAIL: PUBLIC can execute beta_admin_stats'; end if;

  -- (3) table and column grants -----------------------------------------------------------
  for r in select * from (values ('anon'), ('authenticated')) as t(role) loop
    if has_table_privilege(r.role, 'private.beta_admins', 'select') or has_table_privilege(r.role, 'private.beta_admins', 'insert') then raise exception 'FAIL: % can touch private.beta_admins', r.role; end if;
    if has_table_privilege(r.role, 'public.beta_survey_responses', 'insert') or has_table_privilege(r.role, 'public.beta_survey_responses', 'update') or has_table_privilege(r.role, 'public.beta_survey_responses', 'delete') then raise exception 'FAIL: % can write beta_survey_responses directly', r.role; end if;
  end loop;
  raise notice 'ok: no client writes to beta_survey_responses, no client access to private.beta_admins';
  for r in select * from (values ('user_id', true), ('wave', true), ('survey_version', true), ('status', true), ('responded_at', true),
                                 ('cohort', false), ('reason', false), ('read_frequency', false), ('weekly_time', false), ('confidence', false)) as t(col, expected)
  loop
    if has_column_privilege('authenticated', 'public.beta_survey_responses', r.col, 'select') <> r.expected then raise exception 'FAIL: authenticated select on beta_survey_responses.% should be %', r.col, r.expected; end if;
    if has_column_privilege('anon', 'public.beta_survey_responses', r.col, 'select') then raise exception 'FAIL: anon can select beta_survey_responses.%', r.col; end if;
  end loop;
  raise notice 'ok: participants can read only status columns; cohort and answers are hidden';
  perform 1 from pg_policies where schemaname = 'public' and tablename = 'beta_survey_responses' and policyname = 'beta_survey_select_own' and cmd = 'SELECT';
  if not found then raise exception 'FAIL: own-row select policy missing'; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'beta_survey_responses' and cmd <> 'SELECT';
  if n <> 0 then raise exception 'FAIL: unexpected write policies on beta_survey_responses'; end if;
  raise notice 'ok: exactly one policy (own-row select)';

  -- (4) allowlist empty ----------------------------------------------------------------------
  select count(*) into n from private.beta_admins;
  if n <> 0 then raise exception 'FAIL: private.beta_admins already has % row(s); run these checks before any grant', n; end if;
  raise notice 'ok: allowlist is empty';

  -- (5) runtime denials with the allowlist empty (no writes happen) ------------------------
  perform set_config('request.jwt.claim.sub', v_probe::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_probe, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select public.beta_admin_check() into v;
  if v then raise exception 'FAIL: beta_admin_check answered true with an empty allowlist'; end if;
  raise notice 'ok: beta_admin_check is false for a signed-in non-admin';
  begin
    perform public.beta_admin_stats(now() - interval '30 days', now());
    raise exception 'FAIL: beta_admin_stats answered a non-admin';
  exception when insufficient_privilege then raise notice 'ok: beta_admin_stats refuses a non-admin (42501)';
  end;
  begin
    perform public.beta_survey_submit('signup', 'signup-v1', 'skipped');
    raise exception 'FAIL: a non-beta account could submit a survey';
  exception when insufficient_privilege then raise notice 'ok: beta_survey_submit refuses an account with no sponsored row (42501)';
  end;
  begin
    perform private.beta_payload_count('{}'::jsonb, 'n');
    raise exception 'FAIL: authenticated can call the private helper';
  exception when insufficient_privilege then raise notice 'ok: the private helper is not callable by users';
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    execute 'set local role anon';
    begin
      perform public.beta_admin_check();
      raise exception 'FAIL: anon can call beta_admin_check';
    exception when insufficient_privilege then raise notice 'ok: anon is refused (42501)';
    end;
    execute 'reset role';
  end;
  select count(*) into n from public.beta_survey_responses where user_id = v_probe;
  if n <> 0 then raise exception 'FAIL: the refused submit wrote a row'; end if;
  raise notice 'ALL CHECKS PASSED (allowlist still empty; grant admin only after this)';
end $$;
