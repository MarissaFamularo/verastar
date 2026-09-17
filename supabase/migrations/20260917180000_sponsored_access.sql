-- Sponsored access, shared evidence cache, and seed collection.
-- Spec: docs/SPONSORED_ACCESS_SPEC.md. Apply once to the shared Verastar / PaperTrellis
-- project. No cap values live here: they are rows in sponsor_config, readable only by the
-- service role, so the public code says "there are caps" and nothing else.
begin;

-- --- Sponsored accounts ------------------------------------------------------------
-- One row per account whose model calls the sponsor pays for. A user can read only
-- whether their own row exists and is active; caps and notes are service-role only
-- (column-level grant), so the client learns a boolean and nothing about money.
create table if not exists public.sponsored_accounts (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  active          boolean not null default true,
  cohort          text,                 -- e.g. 'pilot-1'; study arm label, never shown
  daily_cap_usd   numeric(8,4),         -- null = use sponsor_config default
  monthly_cap_usd numeric(8,4),         -- null = use sponsor_config default
  note            text,
  created_at      timestamptz not null default now(),
  ends_at         timestamptz           -- null = open-ended; the edge function treats past as inactive
);
alter table public.sponsored_accounts enable row level security;
revoke all on public.sponsored_accounts from public, anon, authenticated;
grant select (user_id, active, ends_at) on public.sponsored_accounts to authenticated;
create policy "sponsored_select_own" on public.sponsored_accounts
  for select to authenticated using (user_id = (select auth.uid()));

-- --- Sponsor config ------------------------------------------------------------------
-- Single-row defaults and the global ceiling. Service role only. Edit with SQL, never
-- from a client.
create table if not exists public.sponsor_config (
  id                        boolean primary key default true check (id),
  default_daily_cap_usd     numeric(8,4) not null,
  default_monthly_cap_usd   numeric(8,4) not null,
  global_monthly_ceiling_usd numeric(10,4) not null,
  updated_at                timestamptz not null default now()
);
alter table public.sponsor_config enable row level security;
revoke all on public.sponsor_config from public, anon, authenticated;

-- --- Evidence cache ------------------------------------------------------------------
-- Extraction output keyed by what it was extracted FROM. The verifier never runs here:
-- every reader re-verifies the cached proposal against source text in their own session,
-- so a cache hit is a skipped model call, never a skipped proof. Holds only what a
-- citation holds (metadata, proposed quantities with their short verbatim quotes); never
-- full text. Written only by the edge function under the service role.
create table if not exists public.evidence_cache (
  pmid               text not null,
  extraction_version text not null,
  source_hash        text not null,      -- sha256 hex of the exact normalized source text
  source_tier        text not null,      -- full_text | abstract_only | user_text
  citation           jsonb,
  extraction         jsonb not null,     -- the model's structured output, unmodified
  model              text not null,
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  primary key (pmid, extraction_version, source_hash)
);
create index if not exists evidence_cache_pmid_idx on public.evidence_cache (pmid, extraction_version);
alter table public.evidence_cache enable row level security;
revoke all on public.evidence_cache from public, anon, authenticated;
grant select on public.evidence_cache to authenticated;
create policy "evidence_cache_read_authenticated" on public.evidence_cache
  for select to authenticated using (true);
-- No insert/update/delete policy for authenticated: writes are service-role only.

-- --- Reference papers (seed collection) -------------------------------------------------
-- Hand-curated. Populated only with papers already present in evidence_cache so seeding a
-- new library never spends a model call. Readable by everyone signed in.
create table if not exists public.reference_papers (
  specialty  text not null,
  pmid       text not null,
  rank       integer not null default 100,
  note       text,
  added_at   timestamptz not null default now(),
  primary key (specialty, pmid)
);
alter table public.reference_papers enable row level security;
revoke all on public.reference_papers from public, anon, authenticated;
grant select on public.reference_papers to authenticated;
create policy "reference_papers_read_authenticated" on public.reference_papers
  for select to authenticated using (true);

-- --- Model spend ledger -------------------------------------------------------------------
-- Written by the edge function only. NOT the `events` table: users hold an update policy on
-- their own events rows, so a ledger there could be edited down. This table has no client
-- grants at all; the client never reads or writes it.
create table if not exists public.model_spend (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  ts            timestamptz not null default now(),
  model         text not null,
  purpose       text,
  input_tokens  integer not null default 0,
  cached_tokens integer not null default 0,
  output_tokens integer not null default 0,
  usd           numeric(10,6) not null,
  cache_hit     boolean not null default false
);
create index if not exists model_spend_user_ts_idx on public.model_spend (user_id, ts desc);
create index if not exists model_spend_ts_idx on public.model_spend (ts desc);
alter table public.model_spend enable row level security;
revoke all on public.model_spend from public, anon, authenticated;

commit;
