# Verastar production evidence handoff

This evidence-only branch is based on verified production commit `22c408a969b267d3c167036b2f1e891584788792`. These are saved controlled production-code comparison records completed **2026-10-16T01:23:04.698Z**, not captures of today’s live daily digest. No model calls, tests, replays or paper refetches were performed for this handoff.

## Records

- [PARADE — PMID 42513277](42513277.json): postoperative antithrombotic treatment after open posterior popliteal artery aneurysm repair.
- [Aspirin — PMID 42769537](42769537.json): early aspirin discontinuation after PCI for acute coronary syndromes.
- [Balloon — PMID 42573020](42573020.json): drug-eluting versus uncoated balloon angioplasty for lower-limb peripheral arterial disease.

Each record identifies its original local artifact and selection path under `provenance`. Retained values are copied from the existing sanitized handoff without recomputation. Experimental, earlier-production and personal saved-library records are omitted.

## Reading the evidence

`result` contains the saved extraction input, source text/tables, extracted quantities, numeric rows/verdicts, and original `evidenceWindow` including version, kind, basis, reason, text, parts and flags. `findingAndChecks` preserves generated prose and checks; `displayed` records what this comparison displayed or withheld. These outputs are diagnostic evidence, not independently validated clinical conclusions.

`frozenSourceRecord` preserves separately saved source metadata, citation and `sourceHash`. That hash is not asserted to be a model-input hash. PARADE and aspirin contain original source sections, abstract parts and abstract. Balloon is abstract-only and lacks those structural fields; none were reconstructed. Empty table strings mean the saved corpus contained no table text, not that the publication had no tables.

For all three production results, `result.extractionVersion`, `result.cache` and `result.source.hash` were absent in the saved capture and remain absent. They must not be filled from a different run. Each record has an explicit `missingFields` list.

## Privacy and integrity

This repository is public. The packet contains scientific publication data and pipeline evidence only. Account/session identifiers, credentials, headers, profiles, preferences, personal notes, relevance prose, unrelated papers and spending records are excluded. Publication authors and identifiers are retained as citation metadata. Source material remains attributable to its cited publishers and authors; this packet grants no additional reuse rights.

[manifest.json](manifest.json) records SHA-256 hashes of these packaged JSON files, not paper-source hashes.

## Deployment isolation

Only this documentation directory is added. The existing GitHub workflow runs on pushes to main or pull requests; this branch has no pull request. Its commit uses `[skip ci] [skip netlify]`, which Netlify documents as skipping branch/production builds for direct branch pushes: https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/#skip-a-deploy

No application code, deployment settings or production branch is changed.
