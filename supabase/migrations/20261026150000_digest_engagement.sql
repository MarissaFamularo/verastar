-- Scheduler: count email readers as present, not only in-app openers.
-- PROPOSED; applied only to disposable local databases until the authorized release.
--
-- The pause rule (20261025120000_digest_unopened_pause.sql) counted a digest as read only
-- when the app stamped openedAt on it. Now that the digest is emailed, a reader who reads
-- the email every morning and never visits the site would be paused after seven days with
-- an "unopened" notice that is not true. Engagement is now any of:
--
--   * opening the digest in the app (openedAt on the stored record, unchanged);
--   * clicking any link in a digest or pause email (digest-click stamps engaged_at);
--   * saving Settings (this trigger stamps engaged_at).
--
-- digest-run resets the streak when engaged_at is at or after the time the digest being
-- replaced was built (nextUnopenedStreak in supabase/functions/digest-run/handler.js).
--
-- engaged_at is never granted to readers for writing. The trigger stamps it from the
-- database clock only for a reader's own insert or update (auth.uid() = user_id); service
-- role writes (digest-run, digest-unsubscribe) have no auth.uid() and leave it alone, so an
-- unsubscribe is not counted as engagement. Rollback: drop the trigger, function and column.
begin;

alter table public.digest_schedules
  add column if not exists engaged_at timestamptz;

comment on column public.digest_schedules.engaged_at is
  'Last time the reader showed up outside the app digest screen: a click in a digest email (digest-click) or a Settings save (trigger). Resets unopened_streak for any digest built before it.';

create or replace function private.digest_schedules_stamp_engaged()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is not null and new.user_id = (select auth.uid()) then
    new.engaged_at := now();
  end if;
  return new;
end $$;

revoke all on function private.digest_schedules_stamp_engaged() from public, anon, authenticated;

drop trigger if exists digest_schedules_engaged on public.digest_schedules;
create trigger digest_schedules_engaged
  before insert or update on public.digest_schedules
  for each row execute function private.digest_schedules_stamp_engaged();

-- Settings may show when the reader was last counted as present.
grant select (engaged_at) on public.digest_schedules to authenticated;

commit;
