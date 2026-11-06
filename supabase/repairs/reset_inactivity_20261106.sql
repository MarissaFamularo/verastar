-- OPERATOR REPAIR, never an automatic migration. Requires a separately reviewed
-- transaction-local JSON manifest. No names/emails or cohort IDs are committed here.
-- Caller: BEGIN ISOLATION LEVEL SERIALIZABLE; set_config(..., manifest, true);
--         execute this file; COMMIT. Do not invoke digests or send test mail.
do $$
declare
 m jsonb := nullif(current_setting('verastar.inactivity_repair_manifest',true),'')::jsonb;
 cutoff constant timestamptz := '2026-11-03 00:00:00 America/New_York'::timestamptz;
 protected_ids uuid[]; eligible_ids uuid[]; resume_ids uuid[]; expected_ids uuid[];
 before_rows jsonb; d public.digest_schedules%rowtype; rec jsonb;
 identity_at timestamptz; marker timestamptz; next_pause timestamptz;
 counter_changes integer:=0; resumed integer:=0; row_changes integer:=0; marker_changes integer:=0;
begin
 if m is null or auth.uid() is not null then raise exception 'reviewed manifest and service context required'; end if;
 if (m->>'cutoff')::timestamptz<>cutoff then raise exception 'wrong historical cutoff'; end if;
 perform 1 from public.digest_schedules order by user_id for update;
 select jsonb_object_agg(user_id::text,to_jsonb(s)) into before_rows from public.digest_schedules s;
 select coalesce(array_agg(s.user_id order by s.user_id),'{}'::uuid[]) into protected_ids
 from public.digest_schedules s where s.paused_at<cutoff or exists(
   select 1 from public.events e where e.user_id=s.user_id and e.ts<cutoff
   and e.type in('digest_paused','digest_pause_emailed','digest_pause_email_failed','digest_pause_email_capped'));
 select coalesce(array_agg(user_id order by user_id),'{}'::uuid[]) into eligible_ids
 from public.digest_schedules where not(user_id=any(protected_ids));
 select coalesce(array_agg(v::uuid order by v::uuid),'{}'::uuid[]) into expected_ids
 from jsonb_array_elements_text(m->'protected_ids') v;
 if protected_ids is distinct from expected_ids then raise exception 'protected cohort changed'; end if;
 select coalesce(array_agg(v::uuid order by v::uuid),'{}'::uuid[]) into expected_ids
 from jsonb_array_elements_text(m->'eligible_ids') v;
 if eligible_ids is distinct from expected_ids then raise exception 'eligible cohort changed'; end if;
 select coalesce(array_agg(v::uuid order by v::uuid),'{}'::uuid[]) into resume_ids
 from jsonb_array_elements_text(m->'resume_ids') v;
 if cardinality(protected_ids)<>(m->>'protected_count')::integer
 or cardinality(eligible_ids)<>(m->>'eligible_count')::integer
 or cardinality(resume_ids)<>(m->>'resume_count')::integer
 or cardinality(resume_ids)<>cardinality(array(select distinct unnest(resume_ids)))
 or cardinality(protected_ids)+cardinality(eligible_ids)<>(m->>'total_count')::integer
 then raise exception 'manifest count mismatch'; end if;
 if exists(select 1 from unnest(resume_ids) u where not(u=any(eligible_ids))) then raise exception 'resume list includes a protected or missing account'; end if;
 if exists(select 1 from public.digest_schedules s where s.user_id=any(eligible_ids) and s.claim_token is not null) then raise exception 'eligible account has an active/stale claim; wait and recheck'; end if;
 if exists(select 1 from public.digest_schedules s where
   (jsonb_build_object('enabled',s.enabled,'email_digest',s.email_digest)) is distinct from m->'preferences'->s.user_id::text)
 then raise exception 'user preferences changed since review'; end if;
 if exists(select 1 from public.digest_schedules s where s.user_id=any(eligible_ids)
   and ((s.paused_at is not null) is distinct from (s.user_id=any(resume_ids)))) then raise exception 'current pause set changed'; end if;
 if exists(select 1 from public.digest_schedules s where s.user_id=any(resume_ids) and (
   not s.enabled or s.paused_at is distinct from (m->'pause_times'->>s.user_id::text)::timestamptz
   or s.paused_at<cutoff or not exists(select 1 from public.events e where e.user_id=s.user_id
     and e.type='digest_paused' and e.payload->>'streak'='7'
     and e.ts between s.paused_at and s.paused_at+interval '10 seconds')))
 then raise exception 'resume origin, timestamp or automatic-run preference changed'; end if;
 if (select count(*) from public.digest_schedules where user_id=any(eligible_ids) and unopened_streak<>0)<>(m->>'nonzero_count')::integer then raise exception 'counter preview changed'; end if;
 for d in select * from public.digest_schedules where user_id=any(eligible_ids) order by user_id loop
   select value into rec from public.kv where user_id=d.user_id and collection='digests' and key='daily:latest' for share;
   identity_at:=null;
   begin identity_at:=nullif(coalesce(rec->>'ranAt',rec->>'savedAt'),'')::timestamptz; exception when others then identity_at:=null; end;
   marker:=d.inactivity_counted_at;
   if identity_at is not null and isfinite(identity_at) and identity_at<=now() then marker:=greatest(marker,identity_at); end if;
   next_pause:=case when d.user_id=any(resume_ids) then null else d.paused_at end;
   if d.unopened_streak<>0 then counter_changes:=counter_changes+1; end if;
   if d.paused_at is distinct from next_pause then resumed:=resumed+1; end if;
   if d.inactivity_counted_at is distinct from marker then marker_changes:=marker_changes+1; end if;
   if d.unopened_streak<>0 or d.inactivity_counted_at is distinct from marker or d.paused_at is distinct from next_pause then
     update public.digest_schedules set unopened_streak=0,inactivity_counted_at=marker,paused_at=next_pause,updated_at=now() where user_id=d.user_id;
     row_changes:=row_changes+1;
   end if;
 end loop;
 if resumed<>cardinality(resume_ids) or counter_changes<>(m->>'nonzero_count')::integer then raise exception 'repair result count mismatch'; end if;
 if exists(select 1 from public.digest_schedules s where s.user_id=any(protected_ids)
   and to_jsonb(s) is distinct from before_rows->s.user_id::text) then raise exception 'protected state changed; rolling back'; end if;
 if exists(select 1 from public.digest_schedules s where
   (to_jsonb(s)-array['unopened_streak','inactivity_counted_at','paused_at','updated_at'])
   is distinct from ((before_rows->s.user_id::text)-array['unopened_streak','inactivity_counted_at','paused_at','updated_at']))
 then raise exception 'unrelated schedule fields changed; rolling back'; end if;
 if exists(select 1 from public.digest_schedules where user_id=any(eligible_ids) and unopened_streak<>0) then raise exception 'eligible counter not reset'; end if;
 perform set_config('verastar.inactivity_repair_result',jsonb_build_object(
   'protected_unchanged',cardinality(protected_ids),'eligible',cardinality(eligible_ids),
   'rows_updated',row_changes,'counters_reset',counter_changes,'checkpoints_baselined',marker_changes,
   'pauses_resumed',resumed,'preferences_preserved',true,'unrelated_fields_preserved',true)::text,true);
end $$;
select current_setting('verastar.inactivity_repair_result')::jsonb as repair_result;
