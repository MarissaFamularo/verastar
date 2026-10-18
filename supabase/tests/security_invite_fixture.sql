-- Disposable fixture for the invite-attempt ledger test (M1 of the 2026-10-13 audit).
-- Requires supabase/tests/spending_fixture.sql and the events migration first.
-- Never run against a linked project.

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-00000000000a'),
  ('a0000000-0000-0000-0000-00000000000b'),
  ('a0000000-0000-0000-0000-00000000000c'),
  ('a0000000-0000-0000-0000-00000000000d'),
  ('a0000000-0000-0000-0000-00000000000e'),
  ('a0000000-0000-0000-0000-00000000000f')
on conflict do nothing;

-- One recent attempt (must be copied) and one expired attempt (must not).
insert into public.events (user_id, type, ts) values
  ('a0000000-0000-0000-0000-00000000000a', 'invite_attempt', now()),
  ('a0000000-0000-0000-0000-00000000000a', 'invite_attempt', now() - interval '2 hours');
