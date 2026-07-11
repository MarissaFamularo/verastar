// lib/libraryFormat.js — PURE formatters that turn Verastar records into human-scannable markdown.
//
// This is the trust-preserving heart of the flat-file vault: the app writes the SAME verified
// facts it shows on screen out to plain markdown the clinician owns. Everything here is pure
// (no browser/FS APIs) so it's fully unit-testable and the disk layer (library.js) can stay thin —
// it only decides WHERE bytes land; WHAT they say is decided here, once.
//
// Design rule: never invent a field that isn't in the record. If a paper has no citation, we omit
// the line rather than fabricate one — same honesty ethos as the verifier.

import { domainLabel } from './domains.js'
import { fmtNum } from './format.js'

// --- pure helpers -------------------------------------------------------------------------------

// kebab-case an arbitrary string down to ascii: lowercase, strip diacritics + punctuation, join on
// single hyphens. The slug backbone — stable and filesystem-safe.
function kebab(str) {
  return String(str || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // drop combining accents so "café" → "cafe"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// The YYYY-MM-DD date prefix from an ISO string; 'undated' when absent so a slug never starts bare.
function isoDate(iso) {
  const d = String(iso || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : 'undated'
}

// A citation may be a plain string OR the app's citation object ({ author, journal, year, ... }) —
// tolerate both so the format layer never depends on which channel produced the record.
function citationText(c) {
  if (!c) return ''
  if (typeof c === 'string') return c.trim()
  return [c.author, c.journal, c.year].filter(Boolean).join(' · ')
}

// A PubMed link for a pmid (the canonical public home of the source).
function pubmedUrl(pmid) {
  return `https://pubmed.ncbi.nlm.nih.gov/${String(pmid)}/`
}

// Minimal YAML scalar: leave plain tokens (alnum, dash, dot, underscore) bare; quote anything with
// a space or special character so the frontmatter always parses cleanly.
function yamlScalar(v) {
  if (v == null) return ''
  const s = String(v)
  if (s === '') return '""'
  if (/^[A-Za-z0-9._-]+$/.test(s)) return s
  return '"' + s.replace(/"/g, '\\"') + '"'
}

// Build a `---`-fenced YAML frontmatter block from ordered [key, value] pairs. Arrays render inline
// (`[a, b]`); null/undefined keeps the key with an empty value so the shape is predictable.
function frontmatter(pairs) {
  const lines = ['---']
  for (const [key, value] of pairs) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map(yamlScalar).join(', ')}]`)
    } else if (value == null || value === '') {
      lines.push(`${key}:`)
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`)
    }
  }
  lines.push('---')
  return lines.join('\n')
}

// --- slugs --------------------------------------------------------------------------------------

// `YYYY-MM-DD_<title-kebab>` from savedAt + the first ~6 title words. Empty title → pmid fallback so
// every source still gets a unique, human-legible filename.
export function sourceSlug(paper) {
  const date = isoDate(paper?.savedAt)
  const words = String(paper?.title || '').trim().split(/\s+/).filter(Boolean).slice(0, 6).join(' ')
  const titlePart = kebab(words) || `pmid-${paper?.pmid ?? 'unknown'}`
  return `${date}_${titlePart}`
}

// Concept filename: just the kebab of its label (concepts are keyed by topic, not date).
export function conceptSlug(node) {
  return kebab(node?.label) || 'concept'
}

// --- notes --------------------------------------------------------------------------------------

// sources/<slug>.md — one saved paper as a readable note. Frontmatter carries the metadata; the body
// leads with why it mattered (relevance), then the finding, then the verifier's honest edge: every
// number listed WITH the tier the app proved it at. Never asserts a field the record doesn't have.
export function sourceNoteMd(paper) {
  const p = paper || {}
  const fm = frontmatter([
    ['title', p.title || ''],
    ['citation', citationText(p.citation)],
    ['pmid', p.pmid ?? ''],
    ['tier', p.tier || ''],
    ['domain', domainLabel(p.domain)],
    ['tags', p.tags || []],
    ['pdf', p.pdfUrl || ''],
    ['saved', p.savedAt || ''],
  ])

  const parts = [fm, '', `# ${p.title || `PMID ${p.pmid ?? ''}`.trim()}`]

  if (p.relevance) parts.push('', `_**Relevance** — ${p.relevance}_`)
  if (p.finding) parts.push('', '## Finding', '', p.finding)

  const quantities = (p.quantities || []).filter((q) => q && q.value != null)
  if (quantities.length) {
    parts.push('', '## Verified evidence', '')
    parts.push('_Each value below was re-verified against the source. The tier is what the app proved,')
    parts.push('not what a model asserted._', '')
    for (const q of quantities) {
      const name = q.name || 'Value'
      // Shared fact-channel formatter (lib/format.js) — the vault note and the on-screen
      // digest render the same string, operator derived from the verified quote.
      const val = fmtNum(q)
      const tier = q.tier ? ` — tier: \`${q.tier}\`` : ''
      parts.push(`- **${name}:** ${val}${tier}`)
    }
  }

  if (p.pmid != null && p.pmid !== '') {
    parts.push('', '## Source', '', `[PMID ${p.pmid}](${pubmedUrl(p.pmid)})`)
    if (p.pdfUrl) parts.push('', `[Open-access full text (PDF)](${p.pdfUrl})`)
    else if (p.oaUrl) parts.push('', `[Free full text](${p.oaUrl})`)
  }

  return parts.join('\n') + '\n'
}

// concepts/<slug>.md — a synthesized topic node. Frontmatter counts its sources; the body carries
// the synthesized summary prose, then every saved paper filed under it (passed in) with a link.
export function conceptNoteMd(node, papers = []) {
  const n = node || {}
  const members = papers || []
  const fm = frontmatter([
    ['topic', n.label || ''],
    ['domain', domainLabel(n.domain)],
    ['updated', n.updatedAt || ''],
    ['sources', members.length],
  ])

  const parts = [fm, '', `# ${n.label || 'Concept'}`]
  if (n.summary) parts.push('', n.summary)

  parts.push('', '## Sources', '')
  if (members.length) {
    for (const p of members) {
      const cite = citationText(p.citation)
      const bits = [p.title || 'Untitled', cite].filter(Boolean).join(' — ')
      const link = p.pmid != null && p.pmid !== '' ? ` — [PMID ${p.pmid}](${pubmedUrl(p.pmid)})` : ''
      parts.push(`- ${bits}${link}`)
    }
  } else {
    parts.push('_No sources filed under this concept yet._')
  }

  const tags = n.tags || []
  if (tags.length) parts.push('', `**Tags:** ${tags.join(', ')}`)

  return parts.join('\n') + '\n'
}

// digests/<date>_digest.md — a faithful readable snapshot of a set of papers. `entries` is a light
// shape ({ title, citation, tier, finding }) so any caller can hand it a day's digest to freeze.
export function digestMd(date, entries = []) {
  const list = entries || []
  const parts = [`# Digest — ${date}`, '', `_${list.length} paper${list.length === 1 ? '' : 's'}._`]
  for (const e of list) {
    parts.push('', `## ${e.title || 'Untitled'}`)
    const meta = [citationText(e.citation), e.tier].filter(Boolean).join(' · ')
    if (meta) parts.push('', `${meta}`)
    if (e.finding) parts.push('', e.finding)
  }
  return parts.join('\n') + '\n'
}

// A single connections.md ENTRY block (not the whole file) — prepended newest-first to the ledger.
// Threads the weekend read's number-free prose into a dated section; each thread names its anchor,
// the narrative, and the converging papers resolved via `paperLookup` (pmid → { title, citation }).
// Unknown pmids drop out gracefully so a stale id never prints a broken line.
export function connectionsEntryMd(date, weekend, paperLookup) {
  const w = weekend || {}
  const lookup =
    paperLookup instanceof Map ? paperLookup : new Map(Object.entries(paperLookup || {}))
  const parts = [`## Week of ${date}`]
  if (w.opener) parts.push('', w.opener)

  for (const t of w.threads || []) {
    parts.push('', `### ${t.anchor || 'Cross-cutting'}`)
    if (t.narrative) parts.push('', t.narrative)
    const cited = (t.pmids || [])
      .map((id) => {
        const p = lookup.get(String(id))
        if (!p) return null // unknown pmid — drop it rather than print a dangling reference
        const cite = citationText(p.citation)
        const bits = [p.title || 'Untitled', cite].filter(Boolean).join(' — ')
        return `- ${bits} — [PMID ${id}](${pubmedUrl(id)})`
      })
      .filter(Boolean)
    if (cited.length) parts.push('', '**Converging papers:**', ...cited)
  }

  const gaps = (w.gaps || []).filter(Boolean)
  if (gaps.length) {
    parts.push('', '### Gaps')
    for (const g of gaps) parts.push(`- ${g}`)
  }

  return parts.join('\n') + '\n'
}

// README.md — the cover page you see first when you open the folder in Finder. Explains what this is
// (the clinician's OWNED evidence library, written by Verastar), maps the folder layout, and shows
// live counts. Deliberately warm and plain — it's the first impression of a folder they control.
export function readmeMd({ profileName, counts } = {}) {
  const c = counts || {}
  const sources = c.sources ?? 0
  const concepts = c.concepts ?? 0
  const owner = profileName ? `${profileName}'s` : 'Your'
  return [
    `# ${owner} evidence library`,
    '',
    'This folder is written by **Verastar** and belongs to you. Every paper you save, every concept',
    'Verastar synthesizes, and every weekend read it threads is filed here as plain markdown you own —',
    'openable in Finder, searchable with any tool, portable to wherever you keep your work next. The',
    'app only ever touches this one folder you chose.',
    '',
    '## What lives here',
    '',
    '```',
    'sources/        one note per saved paper (with its PDF when open-access)',
    'concepts/       synthesized topic notes, each linking its sources',
    'digests/        dated snapshots of a scan',
    'connections.md  the running Weekend Read ledger, newest first',
    '```',
    '',
    '## In your library right now',
    '',
    `- **${sources}** source${sources === 1 ? '' : 's'}`,
    `- **${concepts}** concept${concepts === 1 ? '' : 's'}`,
    '',
    '---',
    '',
    'These are plain markdown files you own. Point any editor, notebook, or tool at this folder later —',
    'nothing here is locked inside an app.',
    '',
  ].join('\n')
}
