-- Invite end date is enforced at redemption. PROPOSED; applied only to disposable local
-- databases until the authorized release (docs/SPONSORED_ACCESS_DEPLOY.md § Deploy order).
--
-- sponsor_invites.ends_at is the study end copied onto every account the code enrolls.
-- redeem_sponsor_invite compared only expires_at (enrollment close) to now, so a code whose
-- study had already ENDED still enrolled: the new sponsored_accounts row was born with
-- ends_at in the past, accountActive() was false on the first request, and the reader was
-- locked out of an account that had just told them it was enrolled (beta audit 2026-10-14,
-- docs/BETA_TEST_PLAN.md § H).
--
-- Same body as the spending migration's function plus the one marked line: an invite whose
-- ends_at is not null and <= now() answers 'expired' BEFORE any insert and before the use
-- count moves. Placement: after the existing-account answers (already/revoked keep their
-- precedence, nothing new is created for them either way) and the code's own
-- revoked/expires_at checks, before exhausted/paused/full, so an ended cohort is reported as
-- expired rather than as full or paused. The client already words 'expired'
-- (src/lib/inviteCode.js). SECURITY INVOKER, service-role only, as before.
--
-- Release order: after 20261009120000_beta_spending_safeguards.sql (it replaces that
-- migration's redeem_sponsor_invite). Rollback: re-run that migration's definition.
begin;

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
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.redeem_sponsor_invite(text,uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;
