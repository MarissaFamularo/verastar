// sources.test.js — cleanAbstractText, the fix for the digest's worst silent failure.
//
// PubMed's plain-text record front-loads a citation line, the title, the author list and a
// block of affiliations. Everything downstream (the finding writer, the adversarial prose
// gate) reads a fixed window off the FRONT of that text, so on a multi-centre paper the
// window held author addresses and no results at all — the writer summarized from the
// title and the gate refuted the summary for lack of evidence, correctly. The fixtures
// below are trimmed from her real 2026-07-29 digest.

import { describe, it, expect } from 'vitest'
import { cleanAbstractText } from './sources.js'

// PMID 42516853 — 12 authors across 10 institutions. The abstract began at char 1,378 of
// the raw record; the window was 900. This is the paper whose summary was withheld.
const MULTI_CENTRE = `1. J Soc Cardiovasc Angiogr Interv. 2026 Apr 23;5(6):105372. doi:
10.1016/j.jscai.2026.105372. eCollection 2026 Jun.

Cardiovascular Impact of Endovascular Revascularization in Chronic
Limb-Threatening Ischemia Versus Claudication: A Contemporary Real-World
Analysis.

Jahan S(1), Awad A(2), Al-Mollah M(3), Hussein M(4), Alwifati N(5), Sirajuddin
K(6), Chalhoub M(7), Burhan M(8), Danish C(1), Tanveer A(1), Paul TK(9), Alraies
MC(10).

Author information:
(1)Department of Medicine, Valley Health System, Las Vegas, Nevada.
(2)Department of Medicine, Detroit Medical Center/Wayne State University,
Detroit, Michigan.
(3)Department of Medicine, Corewell Health, Dearborn, Michigan.

BACKGROUND: Chronic limb-threatening ischemia (CLTI) represents the most severe
form of peripheral artery disease.
METHODS: Using the TriNetX global research network, propensity score matching
yielded 3727 matched pairs.
RESULTS: At 5 years, patients with CLTI had higher all-cause mortality (38.9% vs
24.1%; P < .001).
CONCLUSIONS: Chronic limb-threatening ischemia patients experience significantly
worse cardiovascular outcomes compared with claudication.

© 2026 The Author(s).

DOI: 10.1016/j.jscai.2026.105372
PMCID: PMC13404045
PMID: 42516853`

describe('cleanAbstractText', () => {
  it('drops the citation line, authors and affiliations', () => {
    const out = cleanAbstractText(MULTI_CENTRE)
    expect(out).not.toMatch(/Jahan S/)
    expect(out).not.toMatch(/Valley Health System/)
    expect(out).not.toMatch(/Author information/)
    expect(out).not.toMatch(/J Soc Cardiovasc Angiogr Interv/)
  })

  it('drops the trailing copyright, DOI and PMID block', () => {
    const out = cleanAbstractText(MULTI_CENTRE)
    expect(out).not.toMatch(/PMID: 42516853/)
    expect(out).not.toMatch(/PMCID/)
    expect(out).not.toMatch(/© 2026/)
  })

  it('keeps the title and the whole abstract body', () => {
    const out = cleanAbstractText(MULTI_CENTRE)
    expect(out).toMatch(/Cardiovascular Impact of Endovascular Revascularization/)
    expect(out).toMatch(/BACKGROUND:/)
    expect(out).toMatch(/RESULTS:/)
    expect(out).toMatch(/CONCLUSIONS:/)
  })

  // The whole point: the results have to be reachable inside the evidence window. Before
  // this function they sat at char 2,101 of a 900-char window.
  it('puts the results inside the evidence window', () => {
    const out = cleanAbstractText(MULTI_CENTRE)
    expect(out.indexOf('RESULTS:')).toBeGreaterThan(-1)
    expect(out.indexOf('RESULTS:')).toBeLessThan(900)
  })

  it('handles a record with no affiliation block', () => {
    const raw = `1. Ann Vasc Surg. 2026 Jul 27. doi: 10.1016/j.avsg.2026.07.025.

A Short Title About Carotid Stenting.

Chen AX, Tsouknidas I, Meisner RJ.

OBJECTIVE: This study aims to identify factors associated with hypotension after
carotid artery stenting in a single institutional series of adult patients.
RESULTS: General anesthesia was associated with post-procedural hypotension.

PMID: 42508727`
    const out = cleanAbstractText(raw)
    expect(out).toMatch(/A Short Title About Carotid Stenting/)
    expect(out).toMatch(/OBJECTIVE:/)
    expect(out).not.toMatch(/Chen AX/)
    expect(out).not.toMatch(/PMID:/)
  })

  // A title with commas must not read as an author list, or the paper loses its title.
  it('does not mistake a comma-heavy title for an author list', () => {
    const raw = `1. J Vasc Surg. 2026 Jul 1. doi: 10.1016/j.jvs.2026.07.001.

Safety, Efficacy, and Durability of Fenestrated Repair.

Smith J(1), Jones A(2).

Author information:
(1)Somewhere.

BACKGROUND: A study of fenestrated endovascular repair in a contemporary cohort
of patients treated at two centres over ten years of follow-up.

PMID: 40000000`
    const out = cleanAbstractText(raw)
    expect(out).toMatch(/Safety, Efficacy, and Durability of Fenestrated Repair/)
    expect(out).not.toMatch(/Smith J/)
  })

  // `text` is ALSO the verifier's grounding corpus. Over-stripping would flag every number
  // in the digest rather than merely summarize badly, so an unrecognized shape passes through.
  it('passes an unfamiliar record shape through untouched', () => {
    const odd = 'Some unfamiliar record shape with no blank-line structure at all. '.repeat(12).trim()
    expect(cleanAbstractText(odd)).toBe(odd)
  })

  // The real gut case: a citation-only record (no abstract published yet — common for the
  // ahead-of-print papers a 3-day window is full of). Stripping leaves almost nothing, so
  // the raw record is returned rather than an empty corpus.
  it('falls back to the raw text when a record has no abstract to keep', () => {
    const citationOnly = `1. J Vasc Surg. 2026 Jul 28. doi: 10.1016/j.jvs.2026.07.028. Online ahead of print.

An Ahead-Of-Print Paper With No Abstract Yet.

Adams A(1), Baker B(2), Clark C(3), Davis D(4), Evans E(5), Foster F(6).

Author information:
(1)Department of Surgery, One Hospital, Somewhere, State, United States.
(2)Department of Surgery, Two Hospital, Elsewhere, State, United States.
(3)Department of Surgery, Three Hospital, Nowhere, State, United States.
(4)Department of Surgery, Four Hospital, Anywhere, State, United States.

DOI: 10.1016/j.jvs.2026.07.028
PMID: 40000002`
    expect(citationOnly.length).toBeGreaterThanOrEqual(400)
    expect(cleanAbstractText(citationOnly)).toBe(citationOnly)
  })

  it('is safe on empty and nullish input', () => {
    expect(cleanAbstractText('')).toBe('')
    expect(cleanAbstractText(null)).toBe('')
    expect(cleanAbstractText(undefined)).toBe('')
  })

  it('cleans every record in a multi-PMID fetch', () => {
    const two = `${MULTI_CENTRE}\n\n2. J Vasc Surg. 2026 Jul 2. doi: 10.1016/j.jvs.2026.07.002.

Second Paper Title Here.

Brown B(1), Green G(2).

Author information:
(1)Elsewhere.

RESULTS: The second paper reported a reduction in reintervention at three years
across the matched cohort of patients studied.

PMID: 40000001`
    const out = cleanAbstractText(two)
    expect(out).toMatch(/Second Paper Title Here/)
    expect(out).not.toMatch(/Brown B/)
    expect(out).not.toMatch(/Elsewhere/)
    expect(out).not.toMatch(/J Vasc Surg/)
  })
})
