-- Single operator-approved delivery test; retries never send again.
begin;
alter table private.beta_alert_config add column test_attempted_at timestamptz;
alter table private.beta_alert_config add column test_sent_at timestamptz;
alter table private.beta_alert_config add column test_failed boolean;
create or replace function public.beta_alert_test_claim()
returns timestamptz language sql security definer set search_path='' as $$
 update private.beta_alert_config set test_attempted_at=now(),test_failed=true
 where id and test_attempted_at is null returning test_attempted_at;
$$;
create or replace function public.beta_alert_test_finish(p_sent boolean)
returns void language sql security definer set search_path='' as $$
 update private.beta_alert_config set test_sent_at=case when p_sent then now() else null end,test_failed=not p_sent
 where id and test_attempted_at is not null and test_sent_at is null;
$$;
revoke all on function public.beta_alert_test_claim(), public.beta_alert_test_finish(boolean) from public,anon,authenticated;
grant execute on function public.beta_alert_test_claim(), public.beta_alert_test_finish(boolean) to service_role;
commit;
