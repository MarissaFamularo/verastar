-- Beta dashboard: count digest-email readers as users, and show unsubscribes.
-- PROPOSED; applied only to disposable local databases until the authorized release.
--
-- The digest is emailed now (docs/DIGEST_DELIVERY.md), so a reader can use Verastar every
-- morning without opening the site. A click on any link in a digest or pause email
-- (digest_link_clicked, written by the digest-click function) is now meaningful use: it
-- counts toward "used in last 72 hours", "returned users" and week-1 retention, the same
-- way an in-app digest open does.
--
-- New `email` block, same enrolled-beta population and test exclusions as `shares`:
--   clicks          digest_link_clicked events in the range (repeat clicks counted)
--   clickers        distinct accounts behind them
--   unsubscribes    distinct accounts that used the signed unsubscribe link in the range
--   resumes         distinct accounts that pressed the pause email's resume button
--   email_off_now   enrolled accounts whose email switch is off now (link or Settings)
-- earliest_retained gains digest_link_clicked and digest_email_unsubscribed so the page
-- can say "not available" instead of zero before instrumentation existed.
-- Rollback: re-apply 20261015233845_share_click_metrics.sql.
begin;
create or replace function public.beta_release_stats(p_from timestamptz,p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare base jsonb; adoption jsonb; spend jsonb; survey jsonb; health jsonb; coverage timestamptz; shares jsonb; mail jsonb;
begin
 -- Existing RPC validates range and private.beta_admins authorization first.
 base:=public.beta_admin_stats(p_from,p_to);
 select started_at into coverage from private.beta_measurement where id;
 with people as (
   select * from public.sponsored_accounts s where not private.beta_is_test(s.user_id,s.created_at,s.cohort)
 ), activity as (
   select distinct e.user_id,(e.ts at time zone 'UTC')::date as day,e.ts
   from public.events e join people s on s.user_id=e.user_id
   where e.type in ('digest_opened','digest_viewed','digest_item_opened','paper_favorited','paper_shared','paper_share_clicked','badge_clicked','digest_link_clicked')
   and e.ts>=s.created_at and e.ts<=now() and not private.beta_is_test(e.user_id,e.ts)
 ), eligible as (
   select * from people where created_at>=coverage and created_at<=now()-interval '14 days'
 ), retained as (
   select s.user_id from eligible s where exists(select 1 from activity a where a.user_id=s.user_id
    and a.ts>=s.created_at+interval '7 days' and a.ts<s.created_at+interval '14 days')
 )
 select jsonb_build_object('signups',(select count(*) from people),
 'active72',(select count(distinct user_id) from activity where ts>=now()-interval '72 hours'),
 'returned',(select count(*) from (select user_id from activity group by user_id having count(distinct day)>1) r),
 'eligible',(select count(*) from eligible),'retained',(select count(*) from retained),
 'coverage_since',coverage,'complete72',coverage<=now()-interval '72 hours',
 'access_now',(select count(*) from people where active and (ends_at is null or ends_at>now()))) into adoption;
 with costs as (select * from public.model_spend where not cache_hit),
 finished as (
   select distinct user_id,(ts at time zone 'UTC')::date as day from public.events
   where type='digest_scheduled_run' and payload->>'phase'='done' and coalesce(payload->>'claimLost','')<>'true' and ts>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC' and ts<=now()
 ), browser as (
   select count(*) n from public.events e where type='digest_run' and coalesce(payload->>'showcase','')<>'true'
   and coalesce(payload->>'append','')<>'true' and private.beta_payload_count(payload,'papers')>0
   and ts>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC' and ts<=now()
   and exists(select 1 from public.sponsored_accounts s where s.user_id=e.user_id)
 )
 select jsonb_build_object(
 'today',coalesce(sum(usd) filter(where ts>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC' and ts<=now()),0),
 'month',coalesce(sum(usd) filter(where ts>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC' and ts<=now()),0),
 'completed',(select count(*) from finished)+(select n from browser),
 'outstanding',(select coalesce(sum(reserved_micro),0)::numeric/1000000 from public.spend_reservations where state in ('reserved','ambiguous')),
 'released_unknown',(select count(*) from public.spend_reservations where state='released'),
 'credit_balance',null,'cash_charge',null,
 'first_record',(select min(ts) from public.model_spend)) into spend from costs;
 with r as (
 select r.* from public.beta_survey_responses r
 where wave='signup' and not private.beta_is_test(r.user_id,r.responded_at,r.cohort)
 -- Known smoke user's survey was recorded under the original beta cohort; exclude that
 -- survey only, without changing the account or relabeling historical real-use events.
 and not exists(select 1 from public.sponsored_accounts s where s.user_id=r.user_id and s.cohort='smoke-qa-20261015')
 ), ranged as (select * from r where responded_at>=p_from and responded_at<p_to)
 select jsonb_build_object('completed',(select count(*) from ranged where status='completed'),
 'skipped',(select count(*) from ranged where status='skipped'),
 'completed_all_time',(select count(*) from r where status='completed'),
 'reason',(select coalesce(jsonb_object_agg(k,n),'{}') from(select reason k,count(*) n from ranged where status='completed' group by 1)x),
 'read_frequency',(select coalesce(jsonb_object_agg(k,n),'{}') from(select read_frequency k,count(*) n from ranged where status='completed' group by 1)x),
 'weekly_time',(select coalesce(jsonb_object_agg(k,n),'{}') from(select weekly_time k,count(*) n from ranged where status='completed' group by 1)x),
 'confidence',(select coalesce(jsonb_object_agg(k,n),'{}') from(select confidence::text k,count(*) n from ranged where status='completed' group by 1)x)) into survey;
 select jsonb_build_object('checks',coalesce((select jsonb_agg(jsonb_build_object('name',n,'state',case when i.last_checked_at is null then 'unknown' when n in ('heartbeat','schedule') and i.state<>'failed' and i.last_checked_at<now()-interval '15 minutes' then 'stale' else i.state end,'checked_at',i.last_checked_at)) from unnest(array['signup','digest','heartbeat','schedule']) n left join private.beta_incidents i on i.check_name=n),'[]'),
 'alerts_enabled',(select enabled from private.beta_alert_config where id),
 'mail_failed',exists(select 1 from private.beta_alert_outbox where delivery_error and sent_at is null),
 'pending_emails',(select count(*) from private.beta_alert_outbox where sent_at is null)) into health;
 -- Match adoption's enrolled beta population and event-time test exclusions.
 with clicks as (
   select e.user_id,e.ts from public.events e
   join public.sponsored_accounts s on s.user_id=e.user_id
   where e.type='paper_share_clicked' and e.ts>=s.created_at and e.ts<=now()
   and not private.beta_is_test(s.user_id,s.created_at,s.cohort)
   and not private.beta_is_test(e.user_id,e.ts)
 )
 select jsonb_build_object(
   'clicks',count(*) filter(where ts>=p_from and ts<p_to),
   'users',count(distinct user_id) filter(where ts>=p_from and ts<p_to),
   'earliest_retained',min(ts)) into shares from clicks;
 -- Digest email: same population and exclusions as shares.
 with ev as (
   select e.user_id,e.type,e.ts from public.events e
   join public.sponsored_accounts s on s.user_id=e.user_id
   where e.type in ('digest_link_clicked','digest_email_unsubscribed','digest_resume_clicked') and e.ts>=s.created_at and e.ts<=now()
   and not private.beta_is_test(s.user_id,s.created_at,s.cohort)
   and not private.beta_is_test(e.user_id,e.ts)
 )
 select jsonb_build_object(
   'clicks',count(*) filter(where type='digest_link_clicked' and ts>=p_from and ts<p_to),
   'clickers',count(distinct user_id) filter(where type='digest_link_clicked' and ts>=p_from and ts<p_to),
   'unsubscribes',count(distinct user_id) filter(where type='digest_email_unsubscribed' and ts>=p_from and ts<p_to),
   'resumes',count(distinct user_id) filter(where type='digest_resume_clicked' and ts>=p_from and ts<p_to),
   'email_off_now',(select count(*) from public.sponsored_accounts s join public.digest_schedules d on d.user_id=s.user_id
      where not d.email_digest and not private.beta_is_test(s.user_id,s.created_at,s.cohort)),
   'earliest_click',min(ts) filter(where type='digest_link_clicked'),
   'earliest_unsubscribe',min(ts) filter(where type='digest_email_unsubscribed')) into mail from ev;
 return base || jsonb_build_object('adoption',adoption,'spend',spend,'survey',survey,'health',health,'shares',shares,'email',mail - 'earliest_click' - 'earliest_unsubscribe',
 'earliest_retained',(base->'earliest_retained') || jsonb_build_object('paper_share_clicked',shares->'earliest_retained',
   'digest_link_clicked',mail->'earliest_click','digest_email_unsubscribed',mail->'earliest_unsubscribe'));
end $$;
revoke all on function public.beta_release_stats(timestamptz,timestamptz) from public,anon;
grant execute on function public.beta_release_stats(timestamptz,timestamptz) to authenticated,service_role;

commit;
