// pipeline/topics.js — the search plan: what we ask PubMed for, and over how long.
//
// The scan used to OR-join every north star into ONE exact-phrase query and take the newest
// 40 from a 90-day window. Three things were wrong with that, and each one is a promise the
// digest was quietly breaking:
//
//   - `"limb preservation"[tiab]` only finds papers that say it that way. Quoting a phrase
//     into [tiab] turns PubMed's automatic term mapping OFF — the MeSH expansion that finds
//     the paper about "major amputation prevention" is exactly what the quotes suppress. Her
//     own rule for writing a query is the opposite: short, OR-based, one or two anchor
//     concepts, no field tags, and let PubMed expand. Long AND chains return zero.
//   - ONE shared pool means the biggest topic wins. Aortic publishes ~30 papers in three
//     days, carotid ~13; a single newest-40 cut can return zero carotid papers and nothing
//     in the app would say so.
//   - "Today's digest" over 90 days is not today's digest.
//
// So: one query per topic, each capped on its own, merged with attribution, over a window
// short enough that "papers from the last 3 days" is literally true. The window NEVER widens
// on its own — a thin morning is a true fact about the literature, and silently reaching
// back a month to fill the page would make the one line she trusts ("from the last 3 days")
// the one line that's false. Widening is hers to ask for; see lookbackOptions.
//
// Everything in this file is pure. The sequencing, the pacing, and the fetching live in
// pipeline.js, at the edge where the network is.

import { filterUnseen } from './seen.js'

// Three days is the daily-driver default: run it every morning and you've seen everything,
// skip a couple of days and you still haven't missed anything. The clamp exists because the
// number arrives from a text input — 90 is the old behavior and a sane ceiling for a
// deliberate catch-up, 1 is "only what landed since yesterday".
//
// DELIBERATE DIVERGENCE: her hand-run script defaults to a ONE-day window (and 15 per
// query). We use 3 because that's what she asked this app for in her own words — "studies
// published in the last 3 days" — and because a missed morning shouldn't cost her a day of
// literature. Not an oversight; don't quietly "align" it to the script.
export const DEFAULT_SEARCH_DAYS = 3
export const MIN_SEARCH_DAYS = 1
export const MAX_SEARCH_DAYS = 90

// Per-topic take, and it now means TEN PAPERS SHE HAS NEVER SEEN — the seen-ledger filter
// runs before this cap, not after (see mergeTopicResults). That reordering is what makes 10
// defensible: capping the raw search meant a topic's ten slots could be eight repeats and
// two new papers, while dozens of unseen papers sat unreachable behind the cap and then
// aged out of the window. Worst on exactly the daily use this app is for.
export const DEFAULT_TOPIC_CAP = 10
export const MAX_TOPIC_CAP = 50

// The cap can only mean "unseen" if we fetch enough ids to still have `cap` left after the
// already-seen ones are dropped, so each topic over-fetches. esearch returns bare ids and
// costs nothing, so the only question is how many repeats the fetch has to chew through.
//
// The multiple SCALES WITH THE WINDOW, and that is the whole point — do not simplify it back
// to a constant. The longer the window, the larger the fraction of it she has already been
// shown: a 3-day window turns over roughly a third of itself overnight, so most of the newest
// ids are genuinely new, but a 30-day look-back run by someone who reads this app daily is
// almost entirely papers already in her ledger. A fixed multiple gets eaten by repeats
// exactly on the widened look-back — the rescue path, where depth matters most and where
// under-filling is least visible.
//
// cap × (1 + days) is the cheapest thing with the right shape: identical to the old ×4 at
// the 3-day default, three times deeper at 30. MAX_RETMAX is the hard ceiling on what we'll
// ask PubMed for in one call.
export const MAX_RETMAX = 100

// How many ids to REQUEST for one topic, given the cap we intend to keep and the window.
export function overfetchFor(cap, days) {
  const multiple = 1 + normalizeSearchDays(days)
  return Math.min(normalizeTopicCap(cap) * multiple, MAX_RETMAX)
}

// What the empty state may offer as a deliberate, one-off widening. 90 is included so the
// affordance never disappears on someone whose saved window is already 30.
export const LOOKBACK_DAYS = [7, 30, 90]

// Her documented rule for writing these, in one line, shown next to the field.
export const TOPIC_HINT =
  'Short, OR-based, one or two anchor concepts — e.g. "aortic aneurysm OR aortic dissection OR TEVAR OR EVAR". Long AND chains return nothing; PubMed expands terms for you.'

// The last-resort topic. A profile with no topics AND no north stars still has to search
// something, and returning zero topics would render as "PubMed found nothing" — a lie about
// the literature when the truth is "you haven't told me what to look for".
export const FALLBACK_TOPIC = { label: 'Vascular surgery', query: 'vascular surgery' }

function str(value) {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
}

// Anything -> a usable [{ label, query }]. Total: malformed rows are dropped, never thrown
// on, because this runs on a profile blob that a previous version of the app wrote.
export function normalizeTopics(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const row of raw) {
    if (!row || typeof row !== 'object') {
      // A bare string in the array is a topic that labels itself — that's what a legacy
      // north-star list looks like, and it costs one line to accept it. Strings only: a
      // stray number in a topic list is corruption, not a search term.
      const only = typeof row === 'string' ? row.trim() : ''
      if (only && !seen.has(only.toLowerCase())) {
        seen.add(only.toLowerCase())
        out.push({ label: only, query: only })
      }
      continue
    }
    // `topic` is the key in her real config file, so pasting that file in Just Works.
    const label = str(row.label ?? row.topic ?? row.name)
    const query = str(row.query ?? row.term ?? row.q)
    // Half a row is still a usable row: a topic typed with only a label searches that
    // label; a query pasted with no label labels itself. A row with neither is noise.
    const q = query || label
    const l = label || query
    if (!q) continue
    const key = q.toLowerCase()
    if (seen.has(key)) continue // the same query twice is the same PubMed call twice
    seen.add(key)
    out.push({ label: l, query: q })
  }
  return out
}

// A legacy profile's north stars, as topics. The star phrase becomes the query AS-IS — no
// quotes, no [tiab]. That is a real behavior change for old profiles and it is the intended
// one: "CLTI outcomes" as a plain term lets PubMed map it, where "CLTI outcomes"[tiab] finds
// only the papers that used those two words side by side.
export function topicsFromStars(northStars) {
  return normalizeTopics((northStars || []).map((s) => ({ label: s, query: s })))
}

// The topics a profile actually searches. Structured topics win; a profile that predates
// them degrades to its north stars rather than crashing or searching nothing. North stars
// are NOT consumed here — they keep feeding the rubric and selection prompts either way.
export function profileTopics(profile) {
  const explicit = normalizeTopics(profile?.topics)
  if (explicit.length) return explicit
  const derived = topicsFromStars(profile?.northStars)
  return derived.length ? derived : [FALLBACK_TOPIC]
}

// Absent means "she never set it" -> the default. An out-of-range or unparseable number
// clamps rather than falling back, so typing 200 gives her the ceiling instead of silently
// snapping to 3.
export function normalizeSearchDays(raw) {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_SEARCH_DAYS
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return DEFAULT_SEARCH_DAYS
  return Math.min(Math.max(n, MIN_SEARCH_DAYS), MAX_SEARCH_DAYS)
}

export function normalizeTopicCap(raw) {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_TOPIC_CAP
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return DEFAULT_TOPIC_CAP
  return Math.min(Math.max(n, 1), MAX_TOPIC_CAP)
}

export function profileSearchDays(profile) {
  return normalizeSearchDays(profile?.search?.days)
}

export function profileTopicCap(profile) {
  return normalizeTopicCap(profile?.search?.perTopic)
}

// One topic's raw PMIDs as clean, de-duplicated strings — no cap. This is the set the
// seen-ledger filter runs over.
export function cleanIds(pmids) {
  const out = []
  const seen = new Set()
  for (const raw of pmids || []) {
    const id = str(raw)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

// One topic's PMIDs, capped and de-duplicated, as strings. The cap is enforced here rather
// than trusted from `retmax` so the guarantee "no topic contributes more than N" holds even
// if a caller forgets to pass it down.
export function capTopicPmids(pmids, cap = DEFAULT_TOPIC_CAP) {
  return cleanIds(pmids).slice(0, normalizeTopicCap(cap))
}

// Merge per-topic search results into ONE pmid pool. `results` is one entry per topic,
// `{ label, pmids, retmax }` or `{ label, error }`. `skipIds` is everything she has already
// been shown or saved. Returns:
//   { pmids, topicsByPmid, counts, failed, skipped }
//
// ORDER IS THE POINT: skip-then-cap, never cap-then-skip. Filtering after the cap meant the
// cap counted repeats — a topic's ten slots spent on eight papers she read yesterday, while
// the unseen ones behind them never entered the pool, were never stamped, and aged out of
// the window unread. Skipping first costs nothing (the ledger is keyed by pmid, so it needs
// no metadata) and makes `cap` mean ten papers she has never seen.
//
// Order within the pool is round-robin across topics, not topic-by-topic: the merged pool is
// what the funnel lists, so a 60-paper aortic day must not push carotid to the bottom.
export function mergeTopicResults(results, { cap = DEFAULT_TOPIC_CAP, skipIds } = {}) {
  const rows = (Array.isArray(results) ? results : []).filter(Boolean)
  const failed = []
  const counts = []
  const lists = []
  let skipped = 0
  for (const row of rows) {
    const label = str(row.label) || str(row.query)
    if (row.error) {
      // A failed topic is a hole in the day's coverage. It's kept as data, not swallowed,
      // because a digest that's silently missing a topic reads exactly like a quiet day.
      failed.push({ label, error: str(row.error) || 'search failed' })
      continue
    }
    const raw = cleanIds(row.pmids)
    const unseen = skipIds ? filterUnseen(raw, skipIds) : raw
    skipped += raw.length - unseen.length
    const ids = capTopicPmids(unseen, cap)
    // `more` = PubMed handed back everything we asked for, so there are papers beyond this
    // topic's fetch. It turns "10 of 40 new" into the honest "10 of 40+ new".
    const asked = Number(row.retmax)
    const more = Number.isFinite(asked) && asked > 0 && raw.length >= asked
    counts.push({ label, count: ids.length, available: unseen.length, more })
    lists.push({ label, ids })
  }

  const topicsByPmid = {}
  const pmids = []
  const depth = lists.reduce((max, l) => Math.max(max, l.ids.length), 0)
  for (let i = 0; i < depth; i++) {
    for (const { label, ids } of lists) {
      const id = ids[i]
      if (!id) continue
      if (!topicsByPmid[id]) {
        topicsByPmid[id] = []
        pmids.push(id) // first topic to reach it fixes its place in the pool
      }
      // A paper can genuinely belong to several topics — keep every one. Dropping the second
      // attribution makes "why is this in my digest?" unanswerable for precisely the
      // cross-cutting papers she cares most about.
      if (label && !topicsByPmid[id].includes(label)) topicsByPmid[id].push(label)
    }
  }
  return { pmids, topicsByPmid, counts, failed, skipped }
}

// Carry topic attribution onto the candidate objects the funnel scores and displays.
// Candidates that came back from esummary keyed by pmid; library-shaped records only carry
// `id`, so accept either (same rule as seen.js/candidateId).
export function attachTopics(candidates, topicsByPmid = {}) {
  const map = topicsByPmid && typeof topicsByPmid === 'object' ? topicsByPmid : {}
  return (candidates || []).map((c) => {
    const id = str(c?.pmid) || str(c?.id)
    return { ...c, topics: map[id] ? [...map[id]] : [] }
  })
}

// The widenings worth offering after an empty morning — always strictly longer than the
// window that just came back empty, so the button is never a no-op.
export function lookbackOptions(days) {
  const current = normalizeSearchDays(days)
  return LOOKBACK_DAYS.filter((d) => d > current)
}

// Topics where the per-topic cap held papers back (or where the fetch itself ran out before
// her backlog did). Both are the same fact from her side — there was more than she was
// shown — and both are invisible without this: a capped topic reports "10 papers" exactly
// like a topic that only had 10. She cannot tune a cap she cannot see binding.
export function heldBack(counts = []) {
  return (Array.isArray(counts) ? counts : []).filter(
    (c) => c && (Number(c.count) < Number(c.available) || c.more),
  )
}

// The one honest sentence about what was actually searched. The window is stated because it
// is the digest's central claim; a topic that failed is NAMED because "9 topics searched"
// with no names leaves her unable to tell which area she's flying blind in this morning; and
// a topic the cap bit is named for the same reason.
export function searchSummary({ days, counts = [], failed = [], found = null } = {}) {
  const windowDays = normalizeSearchDays(days)
  const topics = (counts?.length || 0) + (failed?.length || 0)
  if (!topics) return ''
  let out = `Searched ${topics} topic${topics === 1 ? '' : 's'} over the last ${windowDays} day${windowDays === 1 ? '' : 's'}`
  const n = Number(found)
  if (Number.isFinite(n)) out += ` — ${n} new paper${n === 1 ? '' : 's'}`
  out += '.'
  if (failed.length) {
    const names = failed.map((f) => f?.label).filter(Boolean)
    out += ` ${failed.length} topic${failed.length === 1 ? '' : 's'} failed to search${names.length ? `: ${names.join(', ')}` : ''} — those areas aren't covered today.`
  }
  const held = heldBack(counts)
  if (held.length) {
    // "+" when PubMed returned everything we asked for: there are more beyond the fetch, so
    // the denominator is a floor, not a total. Claiming a precise "of 40" there would be the
    // same class of quiet lie as widening the window.
    const parts = held.map((c) => `${c.label} ${c.count} of ${c.available}${c.more ? '+' : ''}`)
    out += ` Per topic: ${parts.join(', ')} — raise "per topic" in your profile to see more.`
  }
  return out
}

// --- paste-and-go -------------------------------------------------------------
//
// Her ten topics already exist, in a JSON file, in the shape `{ topic, query }`. The fastest
// path from that file into this app is a paste box that accepts it verbatim — retyping ten
// boolean queries into ten pairs of inputs is how a good feature goes unused.

function lineToTopic(line) {
  const row = (line || '').trim().replace(/^[-*•]\s+/, '')
  if (!row || row.startsWith('//') || row.startsWith('#')) return null
  // Tab first — that's a two-column paste out of a spreadsheet. Then the first colon
  // ("Aortic Disease: aortic aneurysm OR ..."). A line with neither is a query that labels
  // itself, which is what a bare list of search strings looks like.
  const tab = row.indexOf('\t')
  if (tab > 0) return { label: row.slice(0, tab), query: row.slice(tab + 1) }
  const colon = row.indexOf(':')
  if (colon > 0) return { label: row.slice(0, colon), query: row.slice(colon + 1) }
  return { label: row, query: row }
}

function tryJsonTopics(raw) {
  const attempts = [raw]
  // A slice copied out of the MIDDLE of her config is a run of `{…},` rows — legal JSON once
  // it's wrapped and the dangling comma is gone. Selecting exactly the array brackets in an
  // editor is the fiddly part; not having to is the point.
  if (raw.startsWith('{')) attempts.push(`[${raw.replace(/,\s*$/, '')}]`)
  for (const text of attempts) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed
      if (parsed && typeof parsed === 'object') {
        // A whole config file pasted in, topics and all.
        return Array.isArray(parsed.topics) ? parsed.topics : [parsed]
      }
    } catch {
      /* not JSON — fall through to the line form */
    }
  }
  return null
}

// Pasted text -> topics. Accepts her config JSON (whole array, a fragment of rows, or the
// enclosing object), "Label: query" lines, tab-separated columns, and a bare list of queries.
export function parseTopicsText(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) return []
  const json = tryJsonTopics(raw)
  if (json) return normalizeTopics(json)
  return normalizeTopics(raw.split(/\r?\n/).map(lineToTopic).filter(Boolean))
}
