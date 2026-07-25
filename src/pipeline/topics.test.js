// topics.test.js — the search plan. Locks the properties the daily digest's central claim
// rests on: an old profile still searches (and searches WITHOUT the [tiab] quoting that was
// hiding papers), the window is 3 days and never widens by itself, no single topic can eat
// the pool, and a paper that matches several topics keeps every attribution.

import { describe, it, expect } from 'vitest'
import {
  normalizeTopics,
  topicsFromStars,
  profileTopics,
  normalizeSearchDays,
  normalizeTopicCap,
  profileSearchDays,
  profileTopicCap,
  capTopicPmids,
  mergeTopicResults,
  attachTopics,
  lookbackOptions,
  searchSummary,
  parseTopicsText,
  DEFAULT_SEARCH_DAYS,
  MIN_SEARCH_DAYS,
  MAX_SEARCH_DAYS,
  DEFAULT_TOPIC_CAP,
  MAX_TOPIC_CAP,
  FALLBACK_TOPIC,
} from './topics.js'

// Two of her real ten, verbatim.
const AORTIC = { topic: 'Aortic Disease', query: 'aortic aneurysm OR aortic dissection OR TEVAR OR EVAR' }
const LIMB = {
  topic: 'Limb Preservation / CLTI / Diabetic Foot',
  query: 'peripheral artery disease OR limb ischemia OR diabetic foot OR wound healing amputation',
}

describe('normalizeTopics', () => {
  it('accepts her config shape verbatim — `topic` is the key in her real file', () => {
    expect(normalizeTopics([AORTIC, LIMB])).toEqual([
      { label: 'Aortic Disease', query: AORTIC.query },
      { label: 'Limb Preservation / CLTI / Diabetic Foot', query: LIMB.query },
    ])
  })

  it('accepts the app-native { label, query } shape', () => {
    expect(normalizeTopics([{ label: 'Carotid', query: 'carotid stenosis OR carotid stenting' }])).toEqual([
      { label: 'Carotid', query: 'carotid stenosis OR carotid stenting' },
    ])
  })

  it('fills in a half-written row from the half that exists', () => {
    expect(normalizeTopics([{ label: 'Carotid' }])).toEqual([{ label: 'Carotid', query: 'Carotid' }])
    expect(normalizeTopics([{ query: 'carotid stenting' }])).toEqual([
      { label: 'carotid stenting', query: 'carotid stenting' },
    ])
  })

  it('accepts a bare string — that is what a legacy north-star list looks like', () => {
    expect(normalizeTopics(['CLTI outcomes'])).toEqual([{ label: 'CLTI outcomes', query: 'CLTI outcomes' }])
  })

  it('drops empty rows and collapses duplicate queries into one PubMed call', () => {
    expect(normalizeTopics([{ label: '', query: '' }, null, 42, { }])).toEqual([])
    const dup = normalizeTopics([AORTIC, { topic: 'Aorta again', query: AORTIC.query.toUpperCase() }])
    expect(dup).toHaveLength(1)
  })

  it('never throws on a malformed profile field', () => {
    expect(normalizeTopics(undefined)).toEqual([])
    expect(normalizeTopics('aortic')).toEqual([])
    expect(normalizeTopics({ topic: 'x' })).toEqual([])
  })

  it('trims whitespace off pasted rows', () => {
    expect(normalizeTopics([{ topic: '  Aortic  ', query: '  aortic aneurysm  ' }])).toEqual([
      { label: 'Aortic', query: 'aortic aneurysm' },
    ])
  })
})

describe('topicsFromStars / profileTopics', () => {
  it('derives topics from a legacy profile with no topics field', () => {
    const profile = { northStars: ['CLTI outcomes', 'Carotid revascularization'] }
    expect(profileTopics(profile)).toEqual([
      { label: 'CLTI outcomes', query: 'CLTI outcomes' },
      { label: 'Carotid revascularization', query: 'Carotid revascularization' },
    ])
  })

  it('uses the star phrase AS-IS — no quotes, no [tiab], so PubMed can expand it', () => {
    const [derived] = topicsFromStars(['limb preservation'])
    expect(derived.query).toBe('limb preservation')
    expect(derived.query).not.toContain('[tiab]')
    expect(derived.query).not.toContain('"')
  })

  it('prefers structured topics over north stars when both exist', () => {
    const profile = { topics: [AORTIC], northStars: ['CLTI outcomes'] }
    expect(profileTopics(profile)).toEqual([{ label: 'Aortic Disease', query: AORTIC.query }])
  })

  it('falls back to north stars when the topics field is present but unusable', () => {
    const profile = { topics: [{ label: '' }], northStars: ['CLTI outcomes'] }
    expect(profileTopics(profile)).toEqual([{ label: 'CLTI outcomes', query: 'CLTI outcomes' }])
  })

  it('never returns an empty plan — nothing to search would read as "PubMed found nothing"', () => {
    expect(profileTopics(null)).toEqual([FALLBACK_TOPIC])
    expect(profileTopics({})).toEqual([FALLBACK_TOPIC])
    expect(profileTopics({ northStars: [] })).toEqual([FALLBACK_TOPIC])
  })
})

describe('normalizeSearchDays', () => {
  it('defaults to 3 days, not 90', () => {
    expect(DEFAULT_SEARCH_DAYS).toBe(3)
    expect(normalizeSearchDays(undefined)).toBe(3)
    expect(normalizeSearchDays(null)).toBe(3)
    expect(normalizeSearchDays('')).toBe(3)
    expect(normalizeSearchDays('abc')).toBe(3)
    expect(normalizeSearchDays(NaN)).toBe(3)
  })

  it('takes a usable number, rounding what a text input hands over', () => {
    expect(normalizeSearchDays(7)).toBe(7)
    expect(normalizeSearchDays('30')).toBe(30)
    expect(normalizeSearchDays(6.6)).toBe(7)
  })

  it('clamps rather than falling back, so a typo gives the ceiling not the default', () => {
    expect(normalizeSearchDays(0)).toBe(MIN_SEARCH_DAYS)
    expect(normalizeSearchDays(-5)).toBe(MIN_SEARCH_DAYS)
    expect(normalizeSearchDays(365)).toBe(MAX_SEARCH_DAYS)
  })

  it('reads the profile field and survives a profile that has none', () => {
    expect(profileSearchDays({ search: { days: 7 } })).toBe(7)
    expect(profileSearchDays({})).toBe(3)
    expect(profileSearchDays(null)).toBe(3)
  })
})

describe('normalizeTopicCap', () => {
  it('defaults to 10 and clamps to a sane range', () => {
    expect(normalizeTopicCap(undefined)).toBe(DEFAULT_TOPIC_CAP)
    expect(normalizeTopicCap('')).toBe(DEFAULT_TOPIC_CAP)
    expect(normalizeTopicCap(5)).toBe(5)
    expect(normalizeTopicCap(0)).toBe(1)
    expect(normalizeTopicCap(999)).toBe(MAX_TOPIC_CAP)
  })

  it('reads the profile field', () => {
    expect(profileTopicCap({ search: { perTopic: 4 } })).toBe(4)
    expect(profileTopicCap({})).toBe(DEFAULT_TOPIC_CAP)
  })
})

describe('capTopicPmids', () => {
  it('caps a topic to its own take', () => {
    expect(capTopicPmids(['1', '2', '3', '4'], 2)).toEqual(['1', '2'])
  })

  it('stringifies and de-duplicates within a topic', () => {
    expect(capTopicPmids([1, '1', 2], 10)).toEqual(['1', '2'])
  })

  it('is total on junk input', () => {
    expect(capTopicPmids(null)).toEqual([])
    expect(capTopicPmids([null, '', undefined, '7'])).toEqual(['7'])
  })
})

describe('mergeTopicResults', () => {
  const results = [
    { label: 'Aortic', pmids: ['a1', 'a2', 'a3'] },
    { label: 'Carotid', pmids: ['c1'] },
    { label: 'Limb', pmids: ['l1', 'l2'] },
  ]

  it('merges every topic into one pool', () => {
    const { pmids } = mergeTopicResults(results)
    expect([...pmids].sort()).toEqual(['a1', 'a2', 'a3', 'c1', 'l1', 'l2'])
  })

  it('interleaves so a high-volume topic cannot crowd out a low-volume one', () => {
    const { pmids } = mergeTopicResults(results)
    expect(pmids.slice(0, 3)).toEqual(['a1', 'c1', 'l1'])
  })

  it('de-duplicates a paper that matches several topics and keeps EVERY attribution', () => {
    const { pmids, topicsByPmid } = mergeTopicResults([
      { label: 'Aortic', pmids: ['x', 'a2'] },
      { label: 'Limb', pmids: ['l1', 'x'] },
    ])
    expect(pmids.filter((p) => p === 'x')).toHaveLength(1)
    expect(topicsByPmid.x).toEqual(['Aortic', 'Limb'])
    expect(topicsByPmid.l1).toEqual(['Limb'])
  })

  it('applies the per-topic cap during the merge, not just at search time', () => {
    const { pmids, counts } = mergeTopicResults([{ label: 'Aortic', pmids: ['1', '2', '3'] }], { cap: 2 })
    expect(pmids).toEqual(['1', '2'])
    expect(counts).toEqual([{ label: 'Aortic', count: 2 }])
  })

  it('keeps a failed topic out of the pool but names it in `failed`', () => {
    const { pmids, failed, counts } = mergeTopicResults([
      { label: 'Aortic', error: '429 Too Many Requests' },
      { label: 'Carotid', pmids: ['c1'] },
    ])
    expect(pmids).toEqual(['c1'])
    expect(failed).toEqual([{ label: 'Aortic', error: '429 Too Many Requests' }])
    expect(counts).toEqual([{ label: 'Carotid', count: 1 }])
  })

  it('reports a topic that legitimately returned nothing as a zero count, not a failure', () => {
    const { failed, counts } = mergeTopicResults([{ label: 'Carotid', pmids: [] }])
    expect(failed).toEqual([])
    expect(counts).toEqual([{ label: 'Carotid', count: 0 }])
  })

  it('is total on junk input', () => {
    expect(mergeTopicResults(null)).toEqual({ pmids: [], topicsByPmid: {}, counts: [], failed: [] })
  })
})

describe('attachTopics', () => {
  it('carries attribution onto the candidate objects', () => {
    const out = attachTopics([{ pmid: 'x', title: 'T' }], { x: ['Aortic', 'Limb'] })
    expect(out[0]).toMatchObject({ pmid: 'x', title: 'T', topics: ['Aortic', 'Limb'] })
  })

  it('reads the store-key id when there is no pmid, and gives an unmatched paper an empty list', () => {
    expect(attachTopics([{ id: 'y' }], { y: ['Carotid'] })[0].topics).toEqual(['Carotid'])
    expect(attachTopics([{ pmid: 'z' }], { x: ['Aortic'] })[0].topics).toEqual([])
  })

  it('does not alias the attribution array between candidates', () => {
    const map = { x: ['Aortic'] }
    const out = attachTopics([{ pmid: 'x' }], map)
    out[0].topics.push('Mutated')
    expect(map.x).toEqual(['Aortic'])
  })
})

describe('lookbackOptions', () => {
  it('offers only windows strictly wider than the one that came back empty', () => {
    expect(lookbackOptions(3)).toEqual([7, 30, 90])
    expect(lookbackOptions(7)).toEqual([30, 90])
    expect(lookbackOptions(30)).toEqual([90])
    expect(lookbackOptions(90)).toEqual([])
  })

  it('normalizes its input so a junk window still offers the full ladder', () => {
    expect(lookbackOptions(undefined)).toEqual([7, 30, 90])
  })
})

describe('searchSummary', () => {
  it('states the window — it is the digest\'s central claim', () => {
    const line = searchSummary({ days: 3, counts: [{ label: 'A', count: 4 }], found: 4 })
    expect(line).toBe('Searched 1 topic over the last 3 days — 4 papers.')
  })

  it('names the topics that failed rather than just counting them', () => {
    const line = searchSummary({
      days: 3,
      counts: [{ label: 'Carotid', count: 2 }],
      failed: [{ label: 'Aortic Disease', error: 'boom' }],
      found: 2,
    })
    expect(line).toContain('2 topics over the last 3 days')
    expect(line).toContain('Aortic Disease')
    expect(line).toContain("aren't covered today")
  })

  it('says nothing when nothing was searched', () => {
    expect(searchSummary({ days: 3 })).toBe('')
    expect(searchSummary()).toBe('')
  })
})

describe('parseTopicsText', () => {
  it('takes her config JSON array verbatim', () => {
    const pasted = JSON.stringify([AORTIC, LIMB], null, 2)
    expect(parseTopicsText(pasted)).toEqual([
      { label: 'Aortic Disease', query: AORTIC.query },
      { label: 'Limb Preservation / CLTI / Diabetic Foot', query: LIMB.query },
    ])
  })

  it('takes a fragment of rows copied out of the middle of that file', () => {
    const pasted = `{ "topic": "Aortic Disease", "query": "${AORTIC.query}" },\n{ "topic": "Carotid", "query": "carotid stenosis" },`
    expect(parseTopicsText(pasted)).toEqual([
      { label: 'Aortic Disease', query: AORTIC.query },
      { label: 'Carotid', query: 'carotid stenosis' },
    ])
  })

  it('takes the whole config object with a topics array', () => {
    expect(parseTopicsText(JSON.stringify({ topics: [AORTIC] }))).toEqual([
      { label: 'Aortic Disease', query: AORTIC.query },
    ])
  })

  it('takes "Label: query" lines', () => {
    const pasted = 'Aortic Disease: aortic aneurysm OR TEVAR\nCarotid: carotid stenosis OR CEA'
    expect(parseTopicsText(pasted)).toEqual([
      { label: 'Aortic Disease', query: 'aortic aneurysm OR TEVAR' },
      { label: 'Carotid', query: 'carotid stenosis OR CEA' },
    ])
  })

  it('takes tab-separated columns out of a spreadsheet', () => {
    expect(parseTopicsText('Aortic Disease\taortic aneurysm OR TEVAR')).toEqual([
      { label: 'Aortic Disease', query: 'aortic aneurysm OR TEVAR' },
    ])
  })

  it('takes a bare list of queries, each labelling itself', () => {
    expect(parseTopicsText('aortic aneurysm OR TEVAR\n- carotid stenosis OR CEA')).toEqual([
      { label: 'aortic aneurysm OR TEVAR', query: 'aortic aneurysm OR TEVAR' },
      { label: 'carotid stenosis OR CEA', query: 'carotid stenosis OR CEA' },
    ])
  })

  it('skips blank and commented lines', () => {
    expect(parseTopicsText('\n// my topics\n# skip me\nAortic: aortic aneurysm\n\n')).toEqual([
      { label: 'Aortic', query: 'aortic aneurysm' },
    ])
  })

  it('returns nothing for empty or non-string input', () => {
    expect(parseTopicsText('')).toEqual([])
    expect(parseTopicsText('   ')).toEqual([])
    expect(parseTopicsText(null)).toEqual([])
  })
})
