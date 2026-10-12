-- READ-ONLY spending and scheduler health. Safe to run against production with a
-- read-capable role; it changes nothing. Proposed for the Sunday machinery and first-day
-- operation (docs/SPENDING_CONTRACT.md § Monitoring). Each row is one finding.

-- Liability that is not resolving: anything outstanding for more than 15 minutes needs
-- reconciliation (a live attempt cannot outlast the edge runtime's wall clock).
select 'stale_outstanding' as finding, id::text as ref, user_id::text, state, reserved_micro::numeric / 1e6 as usd,
       created_at, state_reason
  from public.spend_reservations
 where state in ('reserved', 'ambiguous') and created_at < now() - interval '15 minutes'
union all
-- Settlements above their reservation: the bound was wrong; spending is stopped until acknowledged.
select 'unacknowledged_overrun', id::text, user_id::text, null, actual_micro::numeric / 1e6, created_at, null
  from public.spend_overruns where acknowledged_at is null
union all
-- A settled/reconciled reservation must have exactly one ledger row.
select 'ledger_mismatch', r.id::text, r.user_id::text, r.state, r.actual_micro::numeric / 1e6, r.created_at, null
  from public.spend_reservations r
  left join public.model_spend m on m.reservation_id = r.id
 where r.state in ('settled', 'reconciled') and m.id is null
union all
-- Scheduler claims that outlived any possible tick.
select 'stuck_claim', user_id::text, user_id::text, null, null, claimed_at, last_result
  from public.digest_schedules
 where claimed_at is not null and claimed_at < now() - interval '10 minutes'
union all
-- Accounts whose scheduled digests are held (20261010130000_scheduler_hold.sql): an unresolved
-- scheduler attempt, or one reconciled that no operator has released yet. Read from the ledger,
-- the same rule as scheduler_hold_reason, written out here so a read-only role can run it. The
-- attempt a live tick is making right now (reserved, under a fresh claim) is not a hold.
-- state: unresolved_liability = reconcile first; reconciled_awaiting_recovery = run scheduler_recover.
select 'scheduler_held', r.user_id::text, r.user_id::text,
       case when bool_or(r.state in ('reserved', 'ambiguous')) then 'unresolved_liability' else 'reconciled_awaiting_recovery' end,
       coalesce(sum(r.reserved_micro) filter (where r.state in ('reserved', 'ambiguous')), 0)::numeric / 1e6,
       min(r.created_at), max(s.last_result)
  from public.spend_reservations r
  join public.digest_schedules s on s.user_id = r.user_id
 where r.source = 'scheduler'
   and ((r.state = 'ambiguous')
        or (r.state = 'reserved' and not (s.claim_token is not null and s.claimed_at > now() - interval '240 seconds'))
        or (r.state = 'reconciled' and r.recovered_at is null))
 group by r.user_id
union all
-- Configuration that fails closed (so nothing can be spent): surfaced, not hidden.
select 'spending_blocked_by_config', 'sponsor_config', null,
       case when spending_paused then 'paused' when beta_budget_usd is null then 'budget unset' else 'budget start unset/future' end,
       beta_budget_usd, updated_at, pause_note
  from public.sponsor_config
 where spending_paused or beta_budget_usd is null or beta_budget_starts_at is null or beta_budget_starts_at > now();

-- Totals for the operator (not findings): this UTC month, and since the beta budget start.
-- select (select coalesce(sum(usd),0) from public.model_spend where ts >= date_trunc('month', now() at time zone 'utc') at time zone 'utc') as month_ledger_usd,
--        (select coalesce(sum(reserved_micro),0)::numeric/1e6 from public.spend_reservations where state in ('reserved','ambiguous')) as outstanding_usd,
--        (select coalesce(sum(usd),0) from public.model_spend, public.sponsor_config c where ts >= c.beta_budget_starts_at) as beta_ledger_usd;
