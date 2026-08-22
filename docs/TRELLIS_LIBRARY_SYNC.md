# PaperTrellis → Library sync contract

PaperTrellis shares this Supabase project and `auth.uid()`. As of 2026-08-22 it
can (opt-in, per user, per device) write papers it collects into the signed-in
user's Verastar library, and stamps which PaperTrellis projects use each paper.
RLS on `kv` means it can only ever touch the current user's own rows — adding a
paper to a *shared* PaperTrellis project syncs it to *your* library, never a
teammate's.

The writer lives in PaperTrellis at `src/lib/verastarLibrary.js`. This document
is the contract that writer follows; change either side and the other must move
with it.

## What PaperTrellis writes

Only PubMed papers sync (the library is keyed by pmid; DOI-only and website
entries have no home here yet). Two operations, never a blind upsert:

1. **Insert if absent** — a minimal record Verastar reads as a *legacy* save:
   `id` = `pmid` = kv key (pmid as string), `title`, `extractionVersion: null`,
   `check`/`cautionCheck` verdict `'unchecked'`, empty `tags`/`quantities`/
   `notes`/`finding`, `saveSource: 'papertrellis'`, `savedAt` ISO-8601, and
   `trellisProjects` (below). No `vaultWrittenAt`, so the desktop drain still
   writes the markdown note itself. The Library offers "Create digest details"
   on these, exactly like any legacy record — extraction claims are never
   fabricated by the writer.
2. **Patch if present** — read the live `value`, append to `trellisProjects`
   if the project isn't already listed, write the whole value back. Nothing
   else in the record is touched. Idempotent per (paper, project). A 23505 on
   insert (concurrent Verastar save) falls through to the patch path.

## The provenance field

```json
"trellisProjects": [
  { "id": "<papertrellis project uuid>", "title": "CLTI Outcomes", "addedAt": "2026-08-22T05:00:00.000Z" }
]
```

Additive and optional: records without it are untouched history, and code must
treat a missing field as `[]`. It answers "which papers am I using for which
paper I'm writing" — the Library renders it as a "Used in PaperTrellis" line
linking each project's literature page (`PAPERTRELLIS_URL` in `lib/trellis.js`).

## Invariants both sides rely on

- `value.id === key === String(pmid)` — every Verastar patch path depends on it.
- `tags` and `quantities` are arrays; `check`/`cautionCheck` are objects;
  `savedAt` is ISO-8601 UTC (lexicographic date comparisons and vault
  filenames).
- Verastar's store is last-write-wins whole-row replace: any writer (either
  app) must read-modify-write, and every Verastar mutation spreads the live
  record so foreign fields like `trellisProjects` survive. `savePaper` and
  `mergeRefreshedEvidence` (both in `pipeline/save.js`) enforce this on the
  save/refresh paths: an already-saved pmid gets fresh evidence merged in,
  never a fresh record over it.
- `events` is write-only telemetry; the sync does not (and need not) write it.
  New rows appear in the Library on window-focus refresh.
- The `seen` ledger is left alone: a paper present in `papers` is already
  excluded from future digests.

## Not in scope yet

- Removal: taking a paper out of a PaperTrellis project does not retract the
  provenance entry (the paper stays "read and worth keeping" in the library).
- Syncing Verastar → PaperTrellis (saving a digest paper into a project's
  shared evidence set) — the reverse write goes through PaperTrellis RLS and
  belongs to a later phase alongside the project bot pilot.
