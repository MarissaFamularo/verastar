begin;
-- Monitor-only due-work check: no claims, schedule edits, model calls, or automatic recovery.
create function public.beta_monitor_tick()
returns void language plpgsql security definer set search_path='' as $$
declare overdue boolean; evidence boolean;
begin
 select exists(select 1 from public.digest_schedules d join public.sponsored_accounts s using(user_id)
 where d.enabled and s.active and (s.ends_at is null or s.ends_at>now())
 and coalesce(d.last_run_at,d.updated_at)<now()-interval '26 hours') into overdue;
 select exists(select 1 from public.digest_schedules where last_run_at>now()-interval '15 minutes') into evidence;
 if overdue then perform public.beta_monitor_record('digest',false,'overdue');
 elsif evidence then perform public.beta_monitor_record('digest',true,'ok'); end if;
 perform public.beta_monitor_record('heartbeat',true,'ok');
end $$;
-- One claim per message, serialized. Uncertain sends are held for operator review rather
-- than resent automatically; SMTP does not offer exactly-once delivery semantics.
create function public.beta_alert_claim()
returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.beta_alert_outbox%rowtype;
begin
 if not exists(select 1 from private.beta_alert_config where id and enabled) then return null; end if;
 select * into r from private.beta_alert_outbox where attempts=0 and sent_at is null
 order by created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 update private.beta_alert_outbox set attempts=1,last_attempt_at=now(),delivery_error=true where id=r.id;
 return jsonb_build_object('id',r.id,'check',r.check_name,'kind',r.kind,'incident_at',r.incident_at);
end $$;
create function public.beta_alert_finish(p_id uuid,p_sent boolean)
returns void language sql security definer set search_path='' as $$
 update private.beta_alert_outbox set sent_at=case when p_sent then now() else null end,delivery_error=not p_sent where id=p_id and attempts=1
$$;
do $$ declare f text; begin
 foreach f in array array['public.beta_monitor_tick()','public.beta_alert_claim()','public.beta_alert_finish(uuid,boolean)'] loop
 execute format('revoke all on function %s from public,anon,authenticated',f);
 execute format('grant execute on function %s to service_role',f);
 end loop;
end $$;
commit;
