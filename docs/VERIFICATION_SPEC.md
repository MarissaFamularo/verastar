# Verification spec — the sacred core

*Authored 2026-07-07 for the Verastar build. Deterministic; no LLM runs in this layer.*

## The promise

Every number, quote, or citation the app surfaces carries a badge that the **app has
proven** by matching it against real source text. The model proposes; the app disposes.
If the app cannot prove a value, it is **flagged** — never charted, never asserted,
never silently dropped. A wrong "verified" badge is the one failure that invalidates
the entire product, so this layer is built first and protected hardest.

## Where it sits

```
sources → extract (LLM) → VERIFY (this layer, deterministic) → badge → UI
```

`extract` returns quantities with a verbatim `source_quote` and a `location_hint`
(schema in [FACTS.md](FACTS.md)). `verify` never trusts those fields — it re-derives
truth from the fetched source text.

## Algorithm

For each extracted quantity `q` (with `q.value`, optional `q.ci_low`, `q.ci_high`,
`q.p_value`, `q.source_quote`, `q.location_hint`), against `sourceText`:

### 1. Normalize (both quote and source text)
- Unicode **NFKC**.
- Map every dash/minus variant (`‐ ‑ – — − －`) → ASCII `-`.
- Map interpunct/middle-dot decimals to a period: `(\d)[·‧⋅∙•](\d)` → `$1.$2`.
  *(Lancet/EJVES write `0·84`; without this every middle-dot journal false-flags.)*
- Collapse all whitespace to single spaces; lowercase for matching.

### 2. Locate the quote
- **Exact substring** of normalized `sourceText` first.
- On miss, **fuzzy**: strip both to alphanumerics only and test containment
  (tolerates stray punctuation / reflow). Require length > 6 to avoid trivial matches.
- If `location_hint` names a table, match against flattened `<table-wrap>` cell text,
  not prose.
- Result: `found` (bool) + the matched span for highlighting.

### 3. Numeric consistency — tokenized float-equality, NOT substring
This is decision ①. Substring matching false-verifies (`0.02` "found" inside `0.028`).
Instead:
- Regex **all numeric tokens** out of the **matched span** (boundary-delimited:
  `(?<![\d.])\d+(?:\.\d+)?(?![\d.])` after normalization).
- Parse each to a float → `quoteNums`.
- For each of `q.value`, `q.ci_low`, `q.ci_high`, `q.p_value` that is present, require
  a float in `quoteNums` that is **representation-equal**: equal after normalizing
  `0.84 = .84 = 0.840`. Compare with an epsilon that only absorbs float
  representation (`1e-9`), **not rounding** — `0.84` must not satisfy `0.847`.
- `consistent` = every present extracted number has a representation-equal token in the
  matched span. Record `badNums` for the flag message.

### 4. Assign tier
| Condition | Tier |
|---|---|
| `found && consistent && value equals the pre-mapped CT.gov posted outcome` | **verified-registry** (strongest) |
| `found && consistent` (full text located) | **verified-full-text** |
| `found && consistent` but only the abstract was available (no `<body>`) | **abstract-only** |
| `!found || !consistent` | **flagged** |

**Decision ②: the registry tier must value-match the registry.** It is *not* enough that
an NCT exists with `hasResults=true`. The extracted value must equal the CT.gov
structured outcome (within representation-normalization) or it falls back to
full-text tier. The strongest badge carries the strongest proof.

## Integrity rules (enforced above the badge)
- **Flagged values are never charted and never rendered as fact** — shown greyed, with
  what was and wasn't found.
- **Refuse-to-pool guard:** `figures.js` will not pool values across differing `design`
  fields. It renders a plain-language "these designs differ; pooling would mislead"
  card instead of a combined chart.
- **No fabrication:** if extraction returns a source_quote the app can't locate, the
  app does not substitute a plausible citation. It flags.

## Test oracle (spine day is done when all three hold)
Run the live pipeline — cached *source docs* are fine, cached *results* are not.
- **BASIL-3** (PMID 39993822) HR **0.84** → `verified-full-text`.
- **STARDUST** (PMID 38470420, NCT04881110) TcPO2 diff **11.2 mmHg** → `verified-registry`
  (value matches the CT.gov posted outcome).
- A **deliberately corrupted** value (e.g. HR 0.94 injected) → `flagged`, not charted.

If only this works, the wedge is demoable.
