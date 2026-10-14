-- The shared caches no longer expose who wrote a row. PROPOSED; applied only to disposable
-- local databases until the authorized release.
--
-- evidence_cache_trusted.created_by (and the legacy evidence_cache.created_by) is the
-- auth.users id of the account whose scheduled digest produced the extraction. Both tables
-- granted SELECT on every column to authenticated with a permissive read policy, so any
-- signed-in reader could list which accounts read which papers (beta audit 2026-10-14,
-- docs/BETA_TEST_PLAN.md § H). The reader needs the extraction, not its author.
--
-- Table-level SELECT is replaced by a column list that leaves created_by out. A client
-- `select *` on either table now fails with permission denied, which is why the app's
-- readers name their columns (src/pipeline/evidenceCache.js, functions/model/handler.js
-- reads as the service role). service_role keeps full access; the scheduler still writes
-- created_by. Rollback: `grant select on <table> to authenticated` restores the old grant.
begin;

revoke select on public.evidence_cache_trusted from authenticated;
grant select (pmid, extraction_version, source_hash, source_tier, citation, extraction, model, provenance, created_at)
  on public.evidence_cache_trusted to authenticated;

revoke select on public.evidence_cache from authenticated;
grant select (pmid, extraction_version, source_hash, source_tier, citation, extraction, model, created_at)
  on public.evidence_cache to authenticated;

commit;
