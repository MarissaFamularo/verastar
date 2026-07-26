// categorize.test.js — the category layer's guarantees, model mocked at the call boundary
// (like check.test.js) and the store swapped for an in-memory map with fault injection:
// the free no-op condition, the in-code cap to the 9 largest, the never-rename rule (a
// respelled hub is a NEW category, the old one demoted), the no-churn rule for stable
// assignments, and — the load-bearing one — the apply ORDER: a simulated throw at every
// single write position must leave a working superset of the old graph.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory store with fault injection: state.failAt = N makes the Nth WRITE (put/delete)
// throw, so the superset test can crash apply at every possible position.
const mem = vi.hoisted(() => {
  const data = new Map()
  const state = { failAt: Infinity, writes: 0 }
  const key = (c, k) => `${c}/${k}`
  const bump = () => {
    if (++state.writes >= state.failAt) throw new Error('simulated crash')
  }
  const store = {
    async get(c, k) {
      return data.get(key(c, k))
    },
    async put(c, k, v) {
      bump()
      data.set(key(c, k), v)
    },
    async all(c) {
      const out = []
      for (const [k, v] of data) if (k.startsWith(c + '/')) out.push(v)
      return out
    },
    async delete(c, k) {
      bump()
      data.delete(key(c, k))
    },
    async clear(c) {
      for (const k of [...data.keys()]) if (k.startsWith(c + '/')) data.delete(k)
    },
  }
  return {
    data,
    state,
    store,
    reset() {
      data.clear()
      state.failAt = Infinity
      state.writes = 0
    },
  }
})

vi.mock('../lib/store.js', () => ({
  store: mem.store,
  getProfile: async () => undefined,
  saveProfile: async () => {},
}))
vi.mock('../lib/anthropic.js', () => ({
  MODELS: { extraction: 'x', triage: 'triage-tier', interview: 'x', fast: 'x' },
  extractStructured: vi.fn(),
}))

import { extractStructured } from '../lib/anthropic.js'
import {
  isCategorized,
  shouldReorganize,
  capCategories,
  planCategorization,
  applyPlan,
  categorizeLibrary,
  resolveCategory,
  ensureOtherCategory,
  CATEGORIZE_SCHEMA,
  CATEGORY_CAP,
  MAX_CATEGORIES,
  REORG_UNFILED_MIN,
} from './categorize.js'
import { conceptId, OTHER_LABEL } from './concepts.js'

beforeEach(() => {
  mem.reset()
  extractStructured.mockReset()
})

// --- fixtures ---

const hub = (id, label) => ({ id, kind: 'concept', label, isHub: true, tags: [], sourcePmids: [] })
const sat = (id, label, tags = []) => ({ id, kind: 'concept', label, isHub: false, tags, sourcePmids: [] })
const tax = (source, target) => ({ id: `${[source, target].sort().join('~~')}`, source, target, origin: 'taxonomy', status: 'confirmed' })

function seed(nodes, edges) {
  for (const n of nodes) mem.data.set(`graphNodes/${n.id}`, n)
  for (const e of edges) mem.data.set(`graphEdges/${e.id}`, e)
}
const storedNodes = () => [...mem.data.entries()].filter(([k]) => k.startsWith('graphNodes/')).map(([, v]) => v)
const storedEdges = () => [...mem.data.entries()].filter(([k]) => k.startsWith('graphEdges/')).map(([, v]) => v)

describe('isCategorized — the free no-op condition', () => {
  const H = hub('concept:cat-a', 'Shelf A')
  it('true when hubs ≤ 10 and every satellite is filed under a hub', () => {
    expect(isCategorized([H, sat('concept:s1', 'S1')], [tax('concept:s1', 'concept:cat-a')])).toBe(true)
  })
  it('true for an empty library and for a hub-only library', () => {
    expect(isCategorized([], [])).toBe(true)
    expect(isCategorized([H], [])).toBe(true)
  })
  it('false when a satellite lacks a taxonomy edge', () => {
    expect(isCategorized([H, sat('concept:s1', 'S1')], [])).toBe(false)
  })
  it('an edge to a NON-hub target does not count as filed', () => {
    const s2 = sat('concept:s2', 'S2')
    expect(isCategorized([H, sat('concept:s1', 'S1'), s2], [tax('concept:s1', 'concept:s2'), tax('concept:s2', 'concept:cat-a')])).toBe(false)
  })
  it('false the moment the hub tier overflows the cap', () => {
    const hubs = Array.from({ length: MAX_CATEGORIES + 1 }, (_, i) => hub(`concept:h${i}`, `H${i}`))
    expect(isCategorized(hubs, [])).toBe(false)
  })
})

describe('shouldReorganize — the post-deposit trigger', () => {
  it('fires on hub overflow', () => {
    const hubs = Array.from({ length: MAX_CATEGORIES + 1 }, (_, i) => hub(`concept:h${i}`, `H${i}`))
    expect(shouldReorganize(hubs, [])).toBe(true)
  })
  it(`fires at ${REORG_UNFILED_MIN} shelf-less concepts, not below`, () => {
    const H = hub('concept:cat-a', 'Shelf A')
    const some = Array.from({ length: REORG_UNFILED_MIN - 1 }, (_, i) => sat(`concept:s${i}`, `S${i}`))
    expect(shouldReorganize([H, ...some], [])).toBe(false)
    expect(shouldReorganize([H, ...some, sat('concept:s-last', 'Last')], [])).toBe(true)
  })
  it('quiet when the library is organized', () => {
    expect(shouldReorganize([hub('concept:cat-a', 'A'), sat('concept:s1', 'S1')], [tax('concept:s1', 'concept:cat-a')])).toBe(false)
  })
})

describe('capCategories — the in-code cap', () => {
  const cat = (label, n) => ({ label, memberIds: Array.from({ length: n }, (_, i) => `${label}-${i}`) })
  it('passes ≤ cap through untouched', () => {
    const cats = [cat('A', 3), cat('B', 1)]
    expect(capCategories(cats)).toEqual({ kept: cats, overflow: [] })
  })
  it('keeps the largest, spills the rest to overflow', () => {
    const cats = Array.from({ length: CATEGORY_CAP + 2 }, (_, i) => cat(`C${i}`, i + 1))
    const { kept, overflow } = capCategories(cats)
    expect(kept).toHaveLength(CATEGORY_CAP)
    expect(kept.map((c) => c.label)).not.toContain('C0')
    expect(kept.map((c) => c.label)).not.toContain('C1')
    expect(overflow).toEqual([...cat('C0', 1).memberIds, ...cat('C1', 2).memberIds])
  })
  it('breaks ties by original order (stable)', () => {
    const cats = [...Array.from({ length: CATEGORY_CAP }, (_, i) => cat(`C${i}`, 2)), cat('Late', 2)]
    const { kept } = capCategories(cats)
    expect(kept.map((c) => c.label)).not.toContain('Late')
  })
})

describe('planCategorization — the model proposes, this disposes', () => {
  const H1 = hub('concept:cat-vasc', 'Carotid Disease')
  const H2 = hub('concept:cat-old', 'Old Shelf')
  const s1 = sat('concept:s1', 'TCAR Outcomes')
  const s2 = sat('concept:s2', 'Stenting Durability')
  const s3 = sat('concept:s3', 'Wound Care')
  const E = [tax('concept:s1', 'concept:cat-vasc'), tax('concept:s2', 'concept:cat-old')]

  it('reuses an existing hub by label — id and stored label untouched', () => {
    const plan = planCategorization([{ label: '  carotid disease ', memberIds: ['concept:s1'] }], [H1, s1], E)
    expect(plan.shelves).toEqual([{ id: 'concept:cat-vasc', label: 'Carotid Disease' }])
    // s1 already sits there — nothing to add or remove
    expect(plan.edges.add).toEqual([])
    expect(plan.edges.removeIds).toEqual([])
  })

  it('a respelled hub label is a NEW category; the old hub is demoted and re-filed', () => {
    const plan = planCategorization(
      [{ label: 'Carotid Diseases', memberIds: ['concept:s1'] }],
      [H1, s1],
      [tax('concept:s1', 'concept:cat-vasc')],
    )
    const ids = plan.shelves.map((s) => s.id)
    expect(ids).toContain(conceptId('Carotid Diseases')) // new slug id, not cat-vasc
    expect(ids).not.toContain('concept:cat-vasc')
    expect(plan.demote).toEqual(['concept:cat-vasc'])
    // the demoted hub is filed like any member (unassigned → Other)
    expect(ids).toContain(conceptId(OTHER_LABEL))
    expect(plan.edges.add).toContainEqual(expect.objectContaining({ source: 'concept:cat-vasc', target: conceptId(OTHER_LABEL) }))
    // s1 was reassigned to the new shelf → old edge retired only after the new one exists
    expect(plan.edges.add).toContainEqual(expect.objectContaining({ source: 'concept:s1', target: conceptId('Carotid Diseases') }))
    expect(plan.edges.removeIds).toContain(tax('concept:s1', 'concept:cat-vasc').id)
  })

  it('an unassigned concept KEEPS its shelf when that shelf survived (no churn)', () => {
    const plan = planCategorization(
      [{ label: 'Carotid Disease', memberIds: [] }, { label: 'Old Shelf', memberIds: [] }],
      [H1, H2, s1, s2],
      E,
    )
    expect(plan.edges.add).toEqual([])
    expect(plan.edges.removeIds).toEqual([])
    expect(plan.demote).toEqual([])
    // no Other needed — everyone kept a surviving shelf
    expect(plan.shelves.map((s) => s.id)).not.toContain(conceptId(OTHER_LABEL))
  })

  it('an unassigned concept with no surviving shelf falls to Other', () => {
    const plan = planCategorization([{ label: 'Carotid Disease', memberIds: ['concept:s1'] }], [H1, s3], [])
    expect(plan.shelves.map((s) => s.label)).toContain(OTHER_LABEL)
    expect(plan.edges.add).toContainEqual(expect.objectContaining({ source: 'concept:s3', target: conceptId(OTHER_LABEL) }))
  })

  it('Other only materializes when it has members', () => {
    const plan = planCategorization([{ label: 'Carotid Disease', memberIds: ['concept:s1'] }], [H1, s1], E)
    expect(plan.shelves.map((s) => s.label)).not.toContain(OTHER_LABEL)
  })

  it('a model-returned "Other" is never a named shelf — its members pool into the real Other', () => {
    const plan = planCategorization(
      [{ label: 'Carotid Disease', memberIds: ['concept:s1'] }, { label: 'other', memberIds: ['concept:s3'] }],
      [H1, s1, s3],
      E,
    )
    const others = plan.shelves.filter((s) => s.label.toLowerCase() === 'other')
    expect(others).toHaveLength(1)
    expect(plan.edges.add).toContainEqual(expect.objectContaining({ source: 'concept:s3', target: others[0].id }))
  })

  it('drops unknown member ids and honors first-assignment-wins', () => {
    const plan = planCategorization(
      [
        { label: 'Shelf One', memberIds: ['concept:s1', 'concept:ghost'] },
        { label: 'Shelf Two', memberIds: ['concept:s1', 'concept:s3'] },
      ],
      [s1, s3],
      [],
    )
    expect(plan.edges.add).toContainEqual(expect.objectContaining({ source: 'concept:s1', target: conceptId('Shelf One') }))
    expect(plan.edges.add).not.toContainEqual(expect.objectContaining({ source: 'concept:s1', target: conceptId('Shelf Two') }))
    expect(plan.edges.add.some((e) => e.source === 'concept:ghost')).toBe(false)
  })

  it('caps >9 categories to the 9 largest, overflow members to Other', () => {
    // 10 named categories with DISJOINT members: Cat 0 holds one, Cat 1–9 hold two each →
    // Cat 0 is the smallest and gets dropped; its member has no surviving shelf → Other.
    const sats = Array.from({ length: 19 }, (_, i) => sat(`concept:m${i}`, `M${i}`))
    const raw = [
      { label: 'Cat 0', memberIds: ['concept:m0'] },
      ...Array.from({ length: 9 }, (_, i) => ({
        label: `Cat ${i + 1}`,
        memberIds: [`concept:m${2 * i + 1}`, `concept:m${2 * i + 2}`],
      })),
    ]
    const plan = planCategorization(raw, sats, [])
    const labels = plan.shelves.map((s) => s.label)
    expect(labels).not.toContain('Cat 0')
    expect(labels).toContain(OTHER_LABEL)
    expect(plan.shelves.length).toBeLessThanOrEqual(MAX_CATEGORIES)
    expect(plan.edges.add).toContainEqual(expect.objectContaining({ source: 'concept:m0', target: conceptId(OTHER_LABEL) }))
  })

  it('shelves are never members of shelves', () => {
    const plan = planCategorization(
      [{ label: 'Shelf One', memberIds: ['concept:cat-vasc'] }, { label: 'Carotid Disease', memberIds: [] }],
      [H1, s1],
      [tax('concept:s1', 'concept:cat-vasc')],
    )
    // the reused hub stays a shelf; the attempt to file it under Shelf One is ignored
    expect(plan.edges.add.some((e) => e.source === 'concept:cat-vasc')).toBe(false)
    expect(plan.demote).toEqual([])
  })
})

describe('applyPlan — order makes a mid-apply crash leave a working superset', () => {
  // Old world: hubs H1, H2; s1→H1, s2→H2, s3 unfiled. New world: "New Shelf" (s1),
  // reuse "Shelf A" (s2), H2 demoted, s3 + H2 → Other. Exercises every phase.
  const nodes = [
    hub('concept:cat-a', 'Shelf A'),
    hub('concept:cat-b', 'Shelf B'),
    sat('concept:s1', 'S1'),
    sat('concept:s2', 'S2'),
    sat('concept:s3', 'S3'),
  ]
  const edges = [tax('concept:s1', 'concept:cat-a'), tax('concept:s2', 'concept:cat-b')]
  const raw = [
    { label: 'New Shelf', memberIds: ['concept:s1'] },
    { label: 'Shelf A', memberIds: ['concept:s2'] },
  ]

  // The working invariant: no node lost, and every satellite filed BEFORE still has a
  // taxonomy edge to a node that is STILL a hub.
  function assertWorkingSuperset(beforeNodeIds, filedBefore) {
    const ns = storedNodes()
    const es = storedEdges()
    const byId = new Map(ns.map((n) => [n.id, n]))
    for (const id of beforeNodeIds) expect(byId.has(id)).toBe(true)
    for (const satId of filedBefore) {
      const ok = es.some(
        (e) => e.origin === 'taxonomy' && e.source === satId && byId.get(e.target)?.isHub,
      )
      expect(ok, `satellite ${satId} must stay filed under a live hub`).toBe(true)
    }
  }

  it('a throw at EVERY write position preserves the invariant; a clean run converges', async () => {
    const plan = planCategorization(raw, nodes, edges)

    // clean run first: count writes and check the end state
    seed(nodes, edges)
    await applyPlan(plan)
    const totalWrites = mem.state.writes
    expect(totalWrites).toBeGreaterThan(0)
    const endHubs = storedNodes().filter((n) => n.isHub).map((n) => n.label).sort()
    expect(endHubs).toEqual(['New Shelf', OTHER_LABEL, 'Shelf A'].sort())
    expect(storedNodes().find((n) => n.id === 'concept:cat-b').isHub).toBe(false)

    const beforeNodeIds = nodes.map((n) => n.id)
    const filedBefore = ['concept:s1', 'concept:s2']
    for (let failAt = 1; failAt <= totalWrites; failAt++) {
      mem.reset()
      seed(nodes, edges)
      mem.state.failAt = failAt
      await expect(applyPlan(plan)).rejects.toThrow('simulated crash')
      assertWorkingSuperset(beforeNodeIds, filedBefore)
    }
  })

  it('re-running from any crashed state converges to the plan', async () => {
    const plan = planCategorization(raw, nodes, edges)
    seed(nodes, edges)
    mem.state.failAt = 4 // crash mid-apply
    await expect(applyPlan(plan)).rejects.toThrow()
    mem.state.failAt = Infinity
    await applyPlan(plan)
    const hubLabels = storedNodes().filter((n) => n.isHub).map((n) => n.label).sort()
    expect(hubLabels).toEqual(['New Shelf', OTHER_LABEL, 'Shelf A'].sort())
  })
})

describe('categorizeLibrary — plumbing', () => {
  it('organized library: free no-op, model never called', async () => {
    seed([hub('concept:cat-a', 'Shelf A'), sat('concept:s1', 'S1')], [tax('concept:s1', 'concept:cat-a')])
    const res = await categorizeLibrary()
    expect(res).toEqual({ ok: true, skipped: true, categories: 1, filed: 0 })
    expect(extractStructured).not.toHaveBeenCalled()
  })

  it('model failure is a clean no-op: nothing written', async () => {
    seed([sat('concept:s1', 'S1'), sat('concept:s2', 'S2')], [])
    extractStructured.mockRejectedValue(new Error('network down'))
    const res = await categorizeLibrary()
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/network down/)
    expect(mem.state.writes).toBe(0)
  })

  it('applies a good proposal on the classification tier and reports counts', async () => {
    seed([sat('concept:s1', 'TCAR', ['carotid']), sat('concept:s2', 'EVAR')], [])
    extractStructured.mockResolvedValue({
      categories: [{ label: 'Carotid', memberIds: ['concept:s1'] }, { label: 'Aortic', memberIds: ['concept:s2'] }],
    })
    const res = await categorizeLibrary()
    expect(res).toEqual({ ok: true, categories: 2, filed: 2 })
    const call = extractStructured.mock.calls[0][0]
    expect(call.model).toBe('triage-tier') // metadata work rides the triage tier, never extraction
    expect(call.schema).toBe(CATEGORIZE_SCHEMA)
    expect(call.content).toContain('concept:s1 | TCAR | carotid')
    const hubs = storedNodes().filter((n) => n.isHub)
    expect(hubs.map((h) => h.label).sort()).toEqual(['Aortic', 'Carotid'])
    for (const h of hubs) expect(h.summary).toBeTruthy() // the honest shelf line, no evidence claims
  })
})

describe('deposit-time filing helpers', () => {
  const hubs = [hub('concept:cat-a', 'Carotid Disease'), hub('concept:cat-oth', OTHER_LABEL)]

  it('resolveCategory: a named category resolves case/space-insensitively', () => {
    expect(resolveCategory('  carotid disease ', hubs)).toBe(hubs[0])
  })
  it('resolveCategory: a missing category is null (→ the caller files to Other)', () => {
    expect(resolveCategory('Brand New Shelf', hubs)).toBe(null)
    expect(resolveCategory('', hubs)).toBe(null)
  })
  it('ensureOtherCategory reuses an existing Other hub whatever its id', async () => {
    expect(await ensureOtherCategory(hubs)).toBe(hubs[1])
    expect(mem.state.writes).toBe(0)
  })
  it('ensureOtherCategory creates the shelf when missing', async () => {
    const node = await ensureOtherCategory([hubs[0]])
    expect(node.id).toBe(conceptId(OTHER_LABEL))
    expect(node.isHub).toBe(true)
    expect((await mem.store.get('graphNodes', node.id)).label).toBe(OTHER_LABEL)
  })
})
