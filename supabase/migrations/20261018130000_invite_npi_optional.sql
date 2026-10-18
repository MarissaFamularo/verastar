-- Invite codes for people without a US NPI (international clinicians, researchers).
--
-- Every existing and default code keeps requiring an NPI/name match before redemption.
-- A code created with npi_required = false lets redeem-invite skip that step; the
-- atomic redeem_sponsor_invite RPC still checks the code, the account, the enrollment
-- pause and capacity, and the usual per-account spending caps apply.

alter table public.sponsor_invites
  add column if not exists npi_required boolean not null default true;
