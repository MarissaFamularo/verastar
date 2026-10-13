// cards.acceptance.test.js — development acceptance suite for the replacement card system.
//
// Behavioral authority: docs/CARD_ACCEPTANCE_REFERENCE.md (revision 4). Contract: ./schema.js.
// Design under test: docs/CARD_REPLACEMENT_DESIGN.md. Runs apart from the legacy suite:
// `npm run test:acceptance`. Judged on meaning — eligibility, display, reason codes, render
// state, sentence verdicts — never on wording.
//
// Status: specified (cases) · executable (yes) · demonstrated (no — assessCard and checkProse
// are stubs; every test fails "not implemented").

import { describe, it, expect } from 'vitest'
import { assessCard } from '../cards/assess.js'
import { checkProse } from '../cards/prose.js'
import { REASONS as R } from './schema.js'
import bestcli from './cases/bestcli.js'
import crest2 from './cases/crest2.js'
import rao from './cases/rao.js'
import cilostazol from './cases/cilostazol.js'
import pcb from './cases/pcb.js'
import basil2 from './cases/basil2.js'
import diagnostic from './cases/diagnosticValidation.js'
import adversarial from './cases/adversarial.js'
import roles from './cases/roles.js'
import prose from './cases/prose.js'

const CASES = [bestcli, crest2, rao, cilostazol, pcb, basil2]

const run = (c, { source = c.source(), profile = c.profile, claims = [], personal = [], omissions, options } = {}) =>
  assessCard({ source, profile, card: { claims, personal, omissions, recommendation: { read: 'full', reasons: [] } }, options })

const byId = (list, id) => list.find((x) => x.id === id)
const expectReasons = (got, want) =>
  expect(want.some((r) => got.includes(r)), `expected one of [${want}] in [${got}]`).toBe(true)

// Invariants every assessment must satisfy, whatever the case.
function expectInvariants(a) {
  const elig = new Map(a.claims.map((c) => [c.id, c.eligibility]))
  for (const id of a.render.claimsShown) {
    expect(['pass', 'pass-qualitative', 'withhold'], `shown claim ${id} must be eligible`).toContain(elig.get(id))
    expect(a.render.display[id]).not.toBe('not-shown')
  }
  for (const id of a.render.estimatesShown) {
    expect(elig.get(id), `estimate shown for ${id} requires pass`).toBe('pass')
    expect(a.render.display[id]).toBe('shown-with-estimate')
  }
  for (const [id, d] of Object.entries(a.render.display)) {
    if (d === 'not-shown') expect(a.render.claimsShown).not.toContain(id)
    if (d === 'shown-with-estimate') expect(a.render.estimatesShown).toContain(id)
  }
  if (a.render.fallback) {
    for (const id of a.render.fallback.conclusionClaims) {
      expect(['pass', 'pass-qualitative'], `fallback conclusion ${id} must be independently checked`).toContain(elig.get(id))
      expect(byId(a.claims, id).elements.direction).toBe('bound')
    }
    if (a.render.fallback.conclusionClaims.length === 0) expect(a.render.mainResultShown).toBe(false)
  }
  // Positional classification is never a source fact.
  for (const e of a.fidelity.inventory.entries) if (e.roleBasis === 'positional' || e.linkage === 'positional') expect(e.uncertain).toBe(true)
}

for (const c of CASES) {
  describe(`${c.id} — ${c.title}`, () => {
    describe('claim eligibility: supported claims', () => {
      for (const s of c.supported) {
        it(`${s.claim.id} → ${s.expect}`, async () => {
          const a = await run(c, { claims: [s.claim] })
          expectInvariants(a)
          const r = byId(a.claims, s.claim.id)
          expect(r.eligibility).toBe(s.expect)
          for (const el of s.bound || []) expect(r.elements[el], el).toBe('bound')
          expect(['same-sentence', 'definition-linked', 'adjacent-sentence', 'none']).toContain(r.linkage) // never positional for a supported claim
          if (s.expect === 'pass') expect(a.render.display[s.claim.id]).toBe('shown-with-estimate')
        })
      }
    })

    describe('claim eligibility: misleading variants', () => {
      for (const m of c.misleading) {
        it(`${m.name} → ${m.expect}`, async () => {
          const a = await run(c, { claims: [m.claim] })
          expectInvariants(a)
          const r = byId(a.claims, m.claim.id)
          expect(r.eligibility).toBe(m.expect)
          if (m.reasons) expectReasons(r.reasons, m.reasons)
          if (m.expect === 'fail') expect(a.render.display[m.claim.id]).toBe('not-shown')
        })
      }
    })

    describe('summary fidelity: whole card (display decided after fidelity)', () => {
      for (const f of c.fidelity) {
        it(`${f.name} → ${f.expect}`, async () => {
          const a = await run(c, { claims: f.card })
          expectInvariants(a)
          expect(a.fidelity.status).toBe(f.expect)
          if (f.reasons) expectReasons(a.fidelity.reasons, f.reasons)
          if (f.expect === 'pass') {
            expect(a.render.mainResultShown).toBe(true)
            expect(a.fidelity.omitted.filter((o) => o.severity === 'blocking')).toEqual([])
          } else {
            // Eligible claims stay eligible; the whole-card failure changes display, not eligibility.
            for (const cl of f.card) {
              const r = byId(a.claims, cl.id)
              if (r.eligibility === 'pass' || r.eligibility === 'pass-qualitative') expect(r.reasons).not.toContain(R.PRIMARY_MISSING)
            }
            expect(a.render.mainResultShown).toBe(false)
            expect(a.render.state).toBe('reduced-fidelity-failed')
          }
        })
      }
    })

    describe('personalization support', () => {
      for (const p of c.personal) {
        it(`${p.personal.id} → ${p.expect}`, async () => {
          const a = await run(c, { profile: p.profile || c.profile, personal: [p.personal] })
          const r = byId(a.personal, p.personal.id)
          expect(r.status).toBe(p.expect)
          if (p.reasons) expectReasons(r.reasons, p.reasons)
          if (p.expect === 'fail') expect(a.render.personalShown).not.toContain(p.personal.id)
          else expect(a.render.personalShown).toContain(p.personal.id)
        })
      }
    })

    if (c.noPersonalLine) {
      it('a card with no personal line still renders in full', async () => {
        const a = await run(c, { claims: c.fidelity[0].card, personal: [] })
        expect(a.render.state).toBe('full')
        expect(a.render.mainResultShown).toBe(true)
        expect(a.render.personalShown).toEqual([])
      })
    }
  })
}

describe('C1-BESTCLI — omitted factual assertions are represented', () => {
  const c = bestcli
  for (const o of c.omissions) {
    it(o.name, async () => {
      const a = await run(c, { claims: o.card, omissions: o.declared })
      expectInvariants(a)
      expect(a.fidelity.status).toBe(o.fidelity)
      const hit = a.fidelity.omitted.find((x) => (o.omitted.roleIn ? o.omitted.roleIn.includes(x.role) : true) && (o.omitted.describes ? x.entry.toLowerCase().includes(o.omitted.describes) : true))
      expect(hit, `expected an omitted entry matching ${JSON.stringify(o.omitted)}`).toBeTruthy()
      expect(hit.severity).toBe(o.omitted.severity)
      if (o.declared) expect(hit.declared).toBe(true)
    })
  }
  it('fidelity failure falls back only to checked claims (cohort 2 omitted → no main result)', async () => {
    const a = await run(c, { claims: c.fidelityFallback.card })
    expectInvariants(a)
    expect(a.render.state).toBe('reduced-fidelity-failed')
    expect(a.render.mainResultShown).toBe(false)
    if (a.render.fallback) for (const id of a.render.fallback.conclusionClaims) expect(c.fidelityFallback.card.map((x) => x.id)).toContain(id)
  })
})

describe('C6-BASIL2 — scenarios', () => {
  const c = basil2
  const S = c.scenarios

  it('normal: full abstract, primary estimate prints, death labeled component', async () => {
    const a = await run(c, { source: S.normal.source(), claims: S.normal.card })
    expectInvariants(a)
    expect(a.render.state).toBe('full')
    expect(a.render.mainResultShown).toBe(true)
    for (const id of S.normal.expect.estimatesShown) expect(a.render.estimatesShown).toContain(id)
    expect(a.fidelity.status).toBe('pass')
    expect(a.render.fallback).toBeNull()
  })

  for (const key of ['stateA_genuine', 'stateA_simulated']) {
    const sc = S[key]
    it(`${key}: estimate withheld, conclusion carried by an independently checked claim`, async () => {
      const a = await run(c, { source: sc.source(), claims: sc.card, options: sc.options })
      expectInvariants(a)
      const r = byId(a.claims, 'primary')
      expect(r.eligibility).toBe('withhold')
      expectReasons(r.reasons, sc.expect.claim.reasons)
      expect(r.elements.direction, 'direction must not be inherited from the failed estimate').not.toBe('bound')
      expect(a.render.state).toBe('reduced-estimate-withheld')
      expect(a.render.mainResultShown).toBe(true)
      expect(a.render.fallback.kind).toBe('estimate-withheld')
      expect(a.render.fallback.conclusionClaims).toEqual(['primary-qual'])
      expect(a.render.display.primary).toBe('shown-qualitative')
      expect(a.render.estimatesShown).not.toContain('primary')
      expect(a.fidelity.status).toBe('pass')
    })
  }

  it('state A without any independently checked conclusion → no direction shown', async () => {
    const sc = S.stateA_noConclusion
    const a = await run(c, { source: sc.source(), claims: sc.card, options: sc.options })
    expectInvariants(a)
    expect(byId(a.claims, 'primary').eligibility).toBe('withhold')
    expect(a.render.state).toBe('reduced-estimate-withheld')
    expect(a.render.fallback.conclusionClaims).toEqual([])
    expect(a.render.mainResultShown).toBe(false)
  })

  it('state A: no render state prints a withheld estimate (publication rule)', async () => {
    const sc = S.stateA_simulated
    const a = await run(c, { source: sc.source(), claims: sc.card, options: sc.options })
    for (const id of sc.neverPrinted) {
      expect(a.render.estimatesShown).not.toContain(id)
      expect(a.render.display[id]).not.toBe('shown-with-estimate')
    }
  })

  it('state B: results genuinely unavailable → background and methods only', async () => {
    const sc = S.stateB
    const src = sc.source()
    expect(src.text).not.toMatch(/FINDINGS:/)
    expect(src.text).not.toMatch(/1·35/)
    const a = await run(c, { source: src, claims: sc.card })
    expectInvariants(a)
    for (const [id, e] of Object.entries(sc.expect.claims)) expect(byId(a.claims, id).eligibility, id).toBe(e)
    for (const [id, reasons] of Object.entries(sc.expect.reasons)) expectReasons(byId(a.claims, id).reasons, reasons)
    expect(a.render.state).toBe('reduced-results-unavailable')
    expect(a.render.mainResultShown).toBe(false)
    expect(a.render.fallback.kind).toBe('results-unavailable')
    expect(a.render.fallback.conclusionClaims).toEqual([])
    for (const id of sc.expect.claimsShown) expect(a.render.claimsShown).toContain(id)
    for (const id of sc.expect.claimsNotShown) expect(a.render.display[id]).toBe('not-shown')
    expect(a.render.estimatesShown).toEqual([])
  })

  it('state B: an attributed direction is not admitted without a located sentence', async () => {
    const sc = S.stateB
    const a = await run(c, { source: sc.source(), claims: [sc.card.find((x) => x.id === 'primary-qual')] })
    const r = byId(a.claims, 'primary-qual')
    expect(['excluded', 'fail']).toContain(r.eligibility)
    expectReasons(r.reasons, [R.ATTRIBUTION_NOT_SUBSTITUTE])
    expect(a.render.display['primary-qual']).toBe('not-shown')
  })
})

describe('C1-BESTCLI — landmark recommendation', () => {
  it('editorial landmark status strengthens the recommendation and adds no claim', async () => {
    const c = bestcli
    const withE = await run(c, { profile: c.recommendation.withEditorial.profile, claims: c.fidelity[0].card })
    const without = await run(c, { profile: c.recommendation.withoutEditorial.profile, claims: c.fidelity[0].card })
    expect(withE.render.claimsShown).toEqual(without.render.claimsShown)
    expect(withE.render.estimatesShown).toEqual(without.render.estimatesShown)
    expect(withE.recommendation.read).toBe('full')
    expect(withE.recommendation.basis).toContain('E1')
    expect(without.recommendation.basis).not.toContain('E1')
  })
})

describe(`${adversarial.id} — ${adversarial.title}`, () => {
  for (const g of adversarial.groups) {
    describe(g.paper, () => {
      for (const t of g.cases) {
        it(`${t.name} → ineligible`, async () => {
          const src = g.source()
          // Precondition: every number in the claim is printed somewhere in the source.
          const e = t.claim.estimate
          for (const n of [e.value, e.interval?.low, e.interval?.high, e.p].filter((x) => x != null)) {
            const printed = String(Math.abs(n)).replace('.', '[.·]')
            expect(src.text, `${n} should be printed in the source`).toMatch(new RegExp(printed))
          }
          const a = await assessCard({ source: src, profile: [], card: { claims: [t.claim], personal: [], recommendation: { read: 'full', reasons: [] } } })
          expectInvariants(a)
          const r = byId(a.claims, t.claim.id)
          expect(['fail', 'withhold']).toContain(r.eligibility)
          expect(a.render.estimatesShown).not.toContain(t.claim.id)
          expectReasons(r.reasons, t.reasons)
        })
      }
    })
  }
})

describe(`${roles.id} — ${roles.title}`, () => {
  const n = roles.noDeclaredPrimary
  it('no declared primary: role "primary" is unverified; estimate not shown on that claim', async () => {
    const a = await assessCard({ source: n.source(), profile: [], card: { claims: [n.claims.asPrimary.claim], personal: [], recommendation: { read: 'full', reasons: [] } } })
    expectInvariants(a)
    const r = byId(a.claims, n.claims.asPrimary.claim.id)
    expect(r.eligibility).toBe(n.claims.asPrimary.eligibility)
    expect(r.elements.role).toBe('positional-only')
    expectReasons(r.reasons, n.claims.asPrimary.reasons)
    expect(a.render.estimatesShown).not.toContain(r.id)
  })
  it('no declared primary: role "reported" passes with the estimate', async () => {
    const a = await assessCard({ source: n.source(), profile: [], card: { claims: [n.claims.asReported.claim], personal: [], recommendation: { read: 'full', reasons: [] } } })
    const r = byId(a.claims, n.claims.asReported.claim.id)
    expect(r.eligibility).toBe('pass')
    expect(r.elements.role).toBe('not-asserted')
    expect(a.render.estimatesShown).toContain(r.id)
  })
  it('inventory records primaryBasis "none" and never promotes a result to primary by position', async () => {
    const a = await assessCard({ source: n.source(), profile: [], card: { claims: n.card, personal: [], recommendation: { read: 'full', reasons: [] } } })
    expectInvariants(a)
    expect(a.fidelity.status).toBe(n.fidelity.status)
    expect(a.fidelity.inventory.primaryBasis).toBe('none')
    expect(a.fidelity.inventory.uncertain).toBe(true)
    expectReasons(a.fidelity.reasons, n.fidelity.reasons)
    for (const e of a.fidelity.inventory.entries) expect(n.inventoryMustNotContainRole).not.toContain(e.role)
  })
  it('whole-card fidelity still applies without a declared primary (null mortality omitted)', async () => {
    const a = await assessCard({ source: n.source(), profile: [], card: { claims: n.partialCard.card, personal: [], recommendation: { read: 'full', reasons: [] } } })
    expect(a.fidelity.status).toBe(n.partialCard.expect)
    expectReasons(a.fidelity.reasons, n.partialCard.reasons)
    expect(a.fidelity.omitted.some((o) => o.entry.toLowerCase().includes(n.partialCard.omittedMustInclude))).toBe(true)
  })
  it('adjacent-sentence linkage is recorded, not silently treated as same-sentence', async () => {
    const t = roles.adjacentLinkage
    const a = await assessCard({ source: t.source(), profile: [], card: { claims: [t.claim], personal: [], recommendation: { read: 'full', reasons: [] } } })
    const r = byId(a.claims, t.claim.id)
    expect(r.eligibility).toBe(t.expect.eligibility)
    expect(r.linkage).toBe(t.expect.linkage)
    for (const [k, v] of Object.entries(t.expect.elements)) expect(r.elements[k], k).toBe(v)
  })
})

describe(`${prose.id} — ${prose.title}`, () => {
  for (const t of prose.accepted) {
    it(`accepted: ${t.name}`, () => {
      const p = checkProse({ rendered: t.rendered, assessment: t.assessment, claims: bestcli.fidelity[0].card })
      expect(p.status).toBe('pass')
      for (const s of p.sentences) expect(s.status, `sentence ${s.index}`).toBe('ok')
    })
  }
  for (const t of prose.rejected) {
    it(`rejected: ${t.name}`, () => {
      const p = checkProse({ rendered: { sentences: [t.sentence] }, assessment: t.assessment, claims: bestcli.fidelity[0].card })
      expect(p.status).toBe('fail')
      expect(p.sentences[0].status).toBe('reject')
      expectReasons(p.sentences[0].reasons, t.reasons)
    })
  }
  it('a printed bracket may be rendered only as printed, never as a CI', () => {
    const b = prose.bracket
    const claims = [pcb.supported.find((s) => s.claim.id === 'peroneal').claim]
    expect(claims[0].estimate.interval.label).toBe(b.claimIntervalLabel)
    const ok = checkProse({ rendered: { sentences: [b.accepted] }, assessment: b.assessment, claims })
    expect(ok.status).toBe('pass')
    const bad = checkProse({ rendered: { sentences: [b.rejected.sentence] }, assessment: b.assessment, claims })
    expect(bad.status).toBe('fail')
    expectReasons(bad.sentences[0].reasons, b.rejected.reasons)
  })
})

describe(`${diagnostic.id} — ${diagnostic.title}`, () => {
  it.todo(`MISSING: ${diagnostic.reason}`)
  for (const m of diagnostic.mustCover) it.todo(m)
})
