-- Review fixes for the beta release. No live account edits or policy/cap changes.
begin;
-- Stable claims prevent a public NPI from funding multiple accounts, even if a receipt
-- later changes or an account is deleted. No client access; operator review handles disputes.
create table private.beta_npi_claims (
 npi text primary key check(npi ~ '^[12][0-9]{9}$'),
 user_id uuid not null,
 claimed_at timestamptz not null default now()
);
alter table private.beta_npi_claims enable row level security;
revoke all on private.beta_npi_claims from public,anon,authenticated;
grant select,insert on private.beta_npi_claims to service_role;
lock table public.sponsored_accounts in share row exclusive mode;
-- Preserve all existing accounts. For historical duplicates reserve their NPI to the
-- earliest enrollment; their current access is unchanged and retries still return already.
insert into private.beta_npi_claims(npi,user_id,claimed_at)
 select distinct on (u.raw_app_meta_data->'npi_match'->>'npi')
 u.raw_app_meta_data->'npi_match'->>'npi',s.user_id,s.created_at
 from public.sponsored_accounts s join auth.users u on u.id=s.user_id
 where u.raw_app_meta_data->'npi_match'->>'version'='1'
 and u.raw_app_meta_data->'npi_match'->>'npi' ~ '^[12][0-9]{9}$'
 order by u.raw_app_meta_data->'npi_match'->>'npi',s.created_at,s.user_id;
create function private.beta_claim_enrollment_npi()
returns trigger language plpgsql security definer set search_path='' as $$
declare receipt jsonb; holder uuid;
begin
 perform pg_catalog.pg_advisory_xact_lock(7243100002);
 select raw_app_meta_data->'npi_match' into receipt from auth.users where id=new.user_id;
 if receipt->>'version'='1' and receipt->>'npi' ~ '^[12][0-9]{9}$' then
   insert into private.beta_npi_claims(npi,user_id) values(receipt->>'npi',new.user_id) on conflict(npi) do nothing;
   select user_id into holder from private.beta_npi_claims where npi=receipt->>'npi';
   if holder is distinct from new.user_id then
     raise exception using errcode='PBNPI',message='This NPI already has beta access on another account.';
   end if;
 end if;
 return new;
end $$;
revoke all on function private.beta_claim_enrollment_npi() from public,anon,authenticated;
create trigger beta_enrollment_npi before insert on public.sponsored_accounts
 for each row execute function private.beta_claim_enrollment_npi();

create or replace function public.redeem_sponsor_invite(p_code text, p_user_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_inv public.sponsor_invites%rowtype; v_acc public.sponsored_accounts%rowtype; c public.sponsor_config%rowtype; n integer;
begin
  if p_user_id is null then raise exception using errcode = '22023', message = 'a verified user id is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(7243100002);
  select * into v_inv from public.sponsor_invites where code = p_code for update;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  select * into v_acc from public.sponsored_accounts where user_id = p_user_id for update;
  if found then
    if v_acc.active and (v_acc.ends_at is null or v_acc.ends_at > now()) then
      return jsonb_build_object('status', 'already', 'cohort', v_acc.cohort);
    end if;
    return jsonb_build_object('status', 'revoked');
  end if;
  if v_inv.revoked_at is not null then return jsonb_build_object('status', 'inactive'); end if;
  if v_inv.expires_at is not null and v_inv.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;
  if v_inv.ends_at is not null and v_inv.ends_at <= now() then return jsonb_build_object('status', 'expired'); end if; -- study ended
  if v_inv.uses >= v_inv.max_uses then return jsonb_build_object('status', 'exhausted'); end if;
  select * into c from public.sponsor_config where id;
  if not found or c.enrollment_paused or c.enrollment_limit is null then return jsonb_build_object('status', 'paused'); end if;
  select count(*) into n from public.sponsored_accounts where active and (ends_at is null or ends_at > now());
  if n >= c.enrollment_limit then return jsonb_build_object('status', 'full'); end if;
  insert into public.sponsored_accounts (user_id, active, cohort, daily_cap_usd, monthly_cap_usd, ends_at, note)
    values (p_user_id, true, v_inv.cohort, v_inv.daily_cap_usd, v_inv.monthly_cap_usd, v_inv.ends_at, 'invite ' || p_code);
  update public.sponsor_invites set uses = uses + 1 where code = p_code;
  return jsonb_build_object('status', 'enrolled', 'cohort', v_inv.cohort);
exception when sqlstate 'PBNPI' then
 return jsonb_build_object('status','npi_in_use');
end;
$$;

create or replace function public.enroll_npi_beta(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.sponsor_config%rowtype; a public.sponsored_accounts%rowtype; u auth.users%rowtype; n integer;
begin
 if p_user_id is null then raise exception using errcode='42501',message='sign in first'; end if;
 perform pg_catalog.pg_advisory_xact_lock(7243100002);
 select * into a from public.sponsored_accounts where user_id=p_user_id for update;
 if found then
   return jsonb_build_object('status',case when a.active and (a.ends_at is null or a.ends_at>now()) then 'already' else 'revoked' end,'cohort',a.cohort);
 end if;
 select * into u from auth.users where id=p_user_id;
 if not found or u.email_confirmed_at is null then return jsonb_build_object('status','email_required'); end if;
 if u.raw_app_meta_data->'npi_match'->>'version' is distinct from '1' or coalesce(u.raw_app_meta_data->'npi_match'->>'npi','')!~'^[12][0-9]{9}$' or u.raw_app_meta_data->'npi_match'->>'physician' is distinct from 'true' then return jsonb_build_object('status','npi_required'); end if;
 select * into c from public.sponsor_config where id for update;
 if not found or not c.npi_enrollment_enabled or c.enrollment_paused or c.enrollment_limit is null then return jsonb_build_object('status','paused'); end if;
 select count(*) into n from public.sponsored_accounts where active and (ends_at is null or ends_at>now());
 if n>=c.enrollment_limit then return jsonb_build_object('status','full'); end if;
 insert into public.sponsored_accounts(user_id,cohort,note) values(p_user_id,'beta-npi','Public individual physician NPI/name match; not identity verification');
 return jsonb_build_object('status','enrolled','cohort','beta-npi');
exception when sqlstate 'PBNPI' then
 return jsonb_build_object('status','npi_in_use');
end $$;

-- Never replay last_run_at as successful evidence: it also advances on abandonment.
-- Only a NEW actual outcome from the existing hook can recover the aggregate digest check.
create or replace function public.beta_monitor_tick()
returns void language plpgsql security definer set search_path='' as $$
declare overdue boolean;
begin
 select exists(select 1 from public.digest_schedules d join public.sponsored_accounts s using(user_id)
 where d.enabled and s.active and (s.ends_at is null or s.ends_at>now())
 and coalesce(d.last_run_at,d.updated_at)<now()-interval '26 hours') into overdue;
 if overdue then perform public.beta_monitor_record('digest',false,'overdue'); end if;
 perform public.beta_monitor_record('heartbeat',true,'ok');
end $$;
revoke all on function public.enroll_npi_beta(uuid) from public,anon,authenticated;
grant execute on function public.enroll_npi_beta(uuid) to service_role;
commit;
