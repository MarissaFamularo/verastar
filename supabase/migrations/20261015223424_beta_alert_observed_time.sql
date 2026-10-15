-- Supply the queued observation time, including recovery's own timestamp.
begin;
create or replace function public.beta_alert_claim()
returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.beta_alert_outbox%rowtype;
begin
 if not exists(select 1 from private.beta_alert_config where id and enabled) then return null; end if;
 select * into r from private.beta_alert_outbox where attempts=0 and sent_at is null
 order by created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 update private.beta_alert_outbox set attempts=1,last_attempt_at=now(),delivery_error=true where id=r.id;
 return jsonb_build_object('id',r.id,'check',r.check_name,'kind',r.kind,'incident_at',r.incident_at,'observed_at',r.created_at);
end $$;
revoke all on function public.beta_alert_claim() from public,anon,authenticated;
grant execute on function public.beta_alert_claim() to service_role;
commit;
