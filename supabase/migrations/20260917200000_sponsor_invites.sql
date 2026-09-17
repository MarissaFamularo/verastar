-- Invite codes: how a clinician's account becomes sponsored without anyone running SQL
-- per person. One row per cohort code; the `redeem-invite` edge function checks a code
-- and creates the sponsored_accounts row. No client grants at all: the code is checked
-- server-side so a guessed code cannot be probed through the API.
begin;

create table if not exists public.sponsor_invites (
  code          text primary key,
  cohort        text not null,
  max_uses      integer not null default 50,
  uses          integer not null default 0,
  expires_at    timestamptz,                 -- last moment the code can be redeemed
  ends_at       timestamptz,                 -- copied onto each redeemed account (study end)
  daily_cap_usd numeric(8,4),                -- optional per-cohort overrides
  monthly_cap_usd numeric(8,4),
  note          text,
  created_at    timestamptz not null default now()
);
alter table public.sponsor_invites enable row level security;
revoke all on public.sponsor_invites from public, anon, authenticated;

-- Atomic redeem: one statement claims a use and enrolls the caller. Service role only.
create or replace function public.redeem_sponsor_invite(p_code text, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_inv public.sponsor_invites%rowtype;
begin
  if current_user <> 'service_role' and current_user <> 'postgres' then
    raise exception using errcode = '42501', message = 'redeem is server-side only';
  end if;
  select * into v_inv from public.sponsor_invites where code = p_code for update;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  if v_inv.expires_at is not null and v_inv.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;
  if exists (select 1 from public.sponsored_accounts where user_id = p_user_id) then
    update public.sponsored_accounts set active = true, ends_at = coalesce(v_inv.ends_at, ends_at), cohort = coalesce(cohort, v_inv.cohort) where user_id = p_user_id;
    return jsonb_build_object('status', 'already', 'cohort', v_inv.cohort);
  end if;
  if v_inv.uses >= v_inv.max_uses then return jsonb_build_object('status', 'exhausted'); end if;
  insert into public.sponsored_accounts (user_id, active, cohort, daily_cap_usd, monthly_cap_usd, ends_at, note)
    values (p_user_id, true, v_inv.cohort, v_inv.daily_cap_usd, v_inv.monthly_cap_usd, v_inv.ends_at, 'invite ' || p_code);
  update public.sponsor_invites set uses = uses + 1 where code = p_code;
  return jsonb_build_object('status', 'enrolled', 'cohort', v_inv.cohort);
end;
$$;
revoke all on function public.redeem_sponsor_invite(text, uuid) from public, anon, authenticated;
grant execute on function public.redeem_sponsor_invite(text, uuid) to service_role;

commit;
