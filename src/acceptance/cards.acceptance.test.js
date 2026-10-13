// cards.acceptance.test.js — the development acceptance suite for the replacement card system.
//
// Reference: docs/CARD_ACCEPTANCE_REFERENCE.md (revision 4). Contract: ./schema.js.
// Runs SEPARATELY from the legacy suite: `npm run test:acceptance` (vitest.acceptance.config.js).
// It is excluded from `npm test` so legacy regression expectations and this suite never mix.
//
// Each case is judged on MEANING — typed claims, reason codes, render states — never on wording.
// Status key for the project: specified (this file + cases) · executable (yes) · demonstrated
// (no: assessCard is a stub, every case fails until the replacement exists).

import { describe, it, expect } from 'vitest'
import { assessCard } from '../cards/assess.js'
import bestcli from './cases/bestcli.js'
import crest2 from './cases/crest2.js'
import rao from './cases/rao.js'
import cilostazol from './cases/cilostazol.js'
import pcb from './cases/pcb.js'
import basil2 from './cases/basil2.js'
import diagnostic from './cases/diagnosticValidation.js'

const CASES = [bestcli, crest2, rao, cilostazol, pcb, basil2]

const run = (c, { source = c.source(), profile = c.profile, claims = [], personal = [], options } = {}) =>
  assessCard({ source, profile, card: { claims, personal, recommendation: { read: 'full', reasons: [] } }, options })

const byId = (list, id) => list.find((x) => x.id === id)
const expectReasons = (got, want) => {
  // At least one of the specified reason codes must be present (cases list the acceptable set).
  expect(want.some((r) => got.includes(r)), `expected one of [${want}] in [${got}]`).toBe(true)
}

for (const c of CASES) {
  describe(`${c.id} — ${c.title}`, () => {
    describe('claim support: supported claims', () => {
      for (const s of c.supported) {
        it(`${s.claim.id} → ${s.expect}`, async () => {
          const a = await run(c, { claims: [s.claim] })
          const r = byId(a.claims, s.claim.id)
          expect(r.status).toBe(s.expect)
          for (const el of s.bound || []) expect(r.elements[el], el).toBe('bound')
          if (s.expect === 'pass') expect(a.render.estimatesShown).toContain(s.claim.id)
        })
      }
    })

    describe('claim support: misleading variants', () => {
      for (const m of c.misleading) {
        it(`${m.name} → ${m.expect}`, async () => {
          const a = await run(c, { claims: [m.claim] })
          const r = byId(a.claims, m.claim.id)
          expect(r.status).toBe(m.expect)
          if (m.reasons) expectReasons(r.reasons, m.reasons)
          if (m.expect === 'fail') expect(a.render.claimsShown).not.toContain(m.claim.id)
        })
      }
    })

    describe('summary fidelity: whole card', () => {
      for (const f of c.fidelity) {
        it(`${f.name} → ${f.expect}`, async () => {
          const a = await run(c, { claims: f.card })
          expect(a.fidelity.status).toBe(f.expect)
          if (f.reasons) expectReasons(a.fidelity.reasons, f.reasons)
          if (f.expect === 'pass') expect(a.render.mainResultShown).toBe(true)
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
        })
      }
    })

    if (c.noPersonalLine) {
      it('a card with no personal line still renders', async () => {
        const a = await run(c, { claims: c.fidelity[0].card, personal: [] })
        expect(a.render.state).toBe('full')
        expect(a.render.mainResultShown).toBe(true)
        expect(a.render.personalShown).toEqual([])
      })
    }
  })
}

describe('C6-BASIL2 — scenarios', () => {
  const c = basil2
  const S = c.scenarios

  it('normal: full abstract, primary estimate prints, death labeled component', async () => {
    const a = await run(c, { source: S.normal.source(), claims: S.normal.card })
    expect(a.render.state).toBe('full')
    expect(a.render.mainResultShown).toBe(true)
    for (const id of S.normal.expect.estimatesShown) expect(a.render.estimatesShown).toContain(id)
    expect(a.fidelity.status).toBe('pass')
  })

  it('state A (genuine): value mismatch withholds the estimate, keeps the checked conclusion', async () => {
    const sc = S.stateA_genuine
    const a = await run(c, { source: sc.source(), claims: sc.card })
    const r = byId(a.claims, 'primary')
    expect(r.status).toBe('withhold')
    expectReasons(r.reasons, sc.expect.claim.reasons)
    expect(r.elements.direction).toBe('bound')
    expect(a.render.state).toBe(sc.expect.state)
    expect(a.render.mainResultShown).toBe(true)
    expect(a.render.claimsShown).toContain('primary')
    expect(a.render.estimatesShown).not.toContain('primary')
  })

  it('state A (simulated): forced estimate failure with the source untouched', async () => {
    const sc = S.stateA_simulated
    const a = await run(c, { source: sc.source(), claims: sc.card, options: sc.options })
    const r = byId(a.claims, 'primary')
    expect(r.status).toBe('withhold')
    expectReasons(r.reasons, sc.expect.claim.reasons)
    expect(a.render.state).toBe(sc.expect.state)
    expect(a.render.claimsShown).toContain('primary')
    expect(a.render.estimatesShown).not.toContain('primary')
    // death (a component) still checked on its own merits; it must not become the headline
    expect(a.fidelity.status).toBe('pass')
  })

  it('state A: no render state prints a withheld estimate (publication rule)', async () => {
    const sc = S.stateA_simulated
    const a = await run(c, { source: sc.source(), claims: sc.card, options: sc.options })
    expect(['full', 'reduced-estimate-withheld', 'reduced-results-unavailable']).toContain(a.render.state)
    for (const id of sc.neverPrinted) expect(a.render.estimatesShown).not.toContain(id)
  })

  it('state B: results genuinely unavailable → background and methods only', async () => {
    const sc = S.stateB
    const src = sc.source()
    expect(src.text).not.toMatch(/FINDINGS:/)
    expect(src.text).not.toMatch(/1·35/)
    const a = await run(c, { source: src, claims: sc.card })
    for (const [id, status] of Object.entries(sc.expect.claims)) expect(byId(a.claims, id).status, id).toBe(status)
    for (const [id, reasons] of Object.entries(sc.expect.reasons)) expectReasons(byId(a.claims, id).reasons, reasons)
    expect(a.render.state).toBe(sc.expect.state)
    expect(a.render.mainResultShown).toBe(false)
    for (const id of sc.expect.claimsShown) expect(a.render.claimsShown).toContain(id)
    for (const id of sc.expect.claimsNotShown) expect(a.render.claimsShown).not.toContain(id)
    expect(a.render.estimatesShown).toEqual([])
  })

  it('state B: an attributed direction is not admitted without a located sentence', async () => {
    const sc = S.stateB
    const a = await run(c, { source: sc.source(), claims: [sc.card.find((x) => x.id === 'primary-qual')] })
    const r = byId(a.claims, 'primary-qual')
    expect(['excluded', 'fail']).toContain(r.status)
    expectReasons(r.reasons, [sc.expect.reasons['primary-qual'][0]])
    expect(a.render.claimsShown).not.toContain('primary-qual')
  })
})

describe('C1-BESTCLI — landmark recommendation', () => {
  it('editorial landmark status strengthens the recommendation and adds no claim', async () => {
    const c = bestcli
    const withE = await run(c, { profile: c.recommendation.withEditorial.profile, claims: c.fidelity[0].card })
    const without = await run(c, { profile: c.recommendation.withoutEditorial.profile, claims: c.fidelity[0].card })
    expect(withE.render.claimsShown).toEqual(without.render.claimsShown)
    expect(withE.render.estimatesShown).toEqual(without.render.estimatesShown)
    expect(withE.recommendation?.read).toBe('full')
    expect(withE.recommendation?.basis).toContain('E1')
    expect(without.recommendation?.basis || []).not.toContain('E1')
  })
})

describe(`${diagnostic.id} — ${diagnostic.title}`, () => {
  it.todo(`MISSING: ${diagnostic.reason}`)
  for (const m of diagnostic.mustCover) it.todo(m)
})
