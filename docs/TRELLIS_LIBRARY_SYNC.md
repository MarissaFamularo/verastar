# Personal library mutation and recovery contract

Verastar and PaperTrellis share `auth.uid()` and `kv` in the same Supabase project.
A shared project addition affects only the adding user's personal library.

## One cloud paper writer

Apply `20260911201707_harden_library_writes.sql` once, from either repository.
Both copies must remain byte-identical. Every cloud paper mutation passes through
`mutate_library_paper`; its definer function verifies the caller ID before using
an account-scoped transaction lock. Direct client INSERT/UPDATE/DELETE of paper
rows is rejected, including old tabs and attempts to change a row's collection.
TRUNCATE is revoked. Other collections retain existing owner-scoped RLS and their
existing replacement semantics.

Verastar `get`/`all` attach a Symbol read baseline to each paper. It survives object
spread, but is omitted from JSON. `put` computes changed top-level fields, sends
only those fields plus their expected old values, and merges under the server
lock. The returned current row replaces the caller's object, so later state/file
writes see preserved concurrent fields. Keep the baseline when constructing a
paper update; an untracked existing record is rejected, never blind-replaced.

Two writes to independent fields both survive (notes, evidence, favorite, tags,
memos, OA links, vault stamp, retraction or provenance). A same-field edit whose
expected value changed fails visibly to the caller with reload/reapply guidance.
Nested objects and arrays are single fields; there is no silent element-wise
merge except for PaperTrellis provenance. An identical successful patch may be
retried. There is no unbounded retry or last-writer-wins fallback.

Writer inventory: `pipeline/save.js` (save/note/OA), `refreshEvidence.js`,
`deposit.js` (classification/refile), `lib/favorites.js`, `retractionWatch.js`,
`library.js`/`drain.js` (vault), and `KnowledgeBase.jsx`/`Memos.jsx` all route
through this same store. An operation's read establishes its conflict baseline;
a later deliberate re-read starts a new edit. Existing signed-out IndexedDB
behavior and device-local keys/folder handles remain unchanged.

PaperTrellis sends `provenance` with a minimal unchecked record for absent papers
and one project entry. The database unions by project ID, touching no other
fields. Retry is idempotent. Existing legacy fields remain legacy; provenance
never implies extraction or clinical verification. A provenance event that arrives
after an explicit re-save may append to that new current paper; it carries no
stale evidence or annotation snapshot.

## Delete, clear, and explicit Save

Delete and clear use the same lock and keep private tombstones. Background patch,
bridge sync, and migration cannot recreate a removed paper. A user's explicit
Save (`restoreDeleted: true` in the single savePaper entry point) may recreate it;
this is ordered atomically against delete/clear. New records receive a server
`_libraryEpoch`. Edits holding a baseline from a deleted incarnation cannot alter
the explicitly restored paper. Clients must preserve this server field.

## Resuming a device library

`profile/migrationState` in IndexedDB holds an atomic first-account claim, frozen
rows, next batch, and completion. It is device-local and never uploaded. A second
account cannot adopt that manifest, including after reload or partial success.
The importer verifies the active account before claiming and before each batch;
the server also checks it. The original IndexedDB records remain untouched.

`import_library_batch` inserts at most 200 rows per transaction, with ON CONFLICT
DO NOTHING. Existing cloud records, including starter papers and edits made after
an earlier batch, win. Tombstones win over late resumed rows. Success advances the
local checkpoint; an ambiguous response is safely retried. Cloud contents are
never interpreted as completion. Recovery is offered even with an onboarded or
seeded cloud account, until this device's manifest records completion.

## Rollout, validation and rollback

1. Test the migration and both frontends in a disposable environment. Run
   `supabase/tests/library_hardening.sql` and `library_concurrency.py`; the latter
   uses two real PostgreSQL connections. Unit tests exercise both actual app
   storage entry points and importer pause/reload/resume.
2. Schedule the database migration immediately before publishing both frontends.
   The migration intentionally rejects old paper writes; ask users to reload old
   tabs. Reads remain available. There is no unsafe old-writer compatibility mode.
   New frontend before migration fails to save because the RPC is unavailable.
3. Verify signed-in notes, favorites, refresh, provenance sync, delete/re-save and
   interrupted migration with synthetic data before reopening ordinary use.
4. Rollback frontend only to an RPC-compatible build. Preserve functions, guard,
   tombstones and manifest. Disabling the guard or restoring whole-row clients
   reintroduces data loss; do not do that as an automatic rollback. No source rows
   are dropped by this migration.

The database contract is tested on local PostgreSQL, not live production. Its
server authorization checks complement (and do not replace) existing RLS.
