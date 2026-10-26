// supabase/functions/_shared/digestEmail.js — the morning digest as an email, and the
// pause notice. Pure builders plus a Resend sender; no Deno dependency, so vitest covers it
// (src/lib/digestEmail.test.js) and scripts/founder-recapture-email.mjs reuses it.
//
// What goes in an email is what the app already shows and nothing it does not: the paper
// (title, authors, journal, year), the PubMed link, the open-access link when one was found,
// and the triage finding for the paper. A finding is labelled as checked against the source
// text only when the triage check said so; anything else is labelled as not checked. No
// number, quote or citation is produced here; nothing is summarized by a model at send time.

export const DEFAULT_APP_URL = 'https://verastar.papertrellis.com'
// The digest arrives from Marissa, at the address the project already sends from, and
// replies go to the mailbox she reads (decided 2026-10-26).
export const DIGEST_FROM_NAME = 'Marissa at Verastar'
export const DIGEST_REPLY_TO = 'statupfordocs@gmail.com'
// Every email opens the same way: profile names are free text ("Dr. Kim", "Anna", blank), so
// no greeting is built from them (2026-10-26).
export const GREETING = 'Hello, doctor,'

// "Marissa at Verastar <addr>" from whatever SMTP_FROM holds: "Name <addr>" or a bare
// address. Anything else comes back unchanged, so a malformed value fails at Resend, not
// here.
export function digestSender(smtpFrom) {
  const raw = String(smtpFrom ?? '').trim()
  if (!raw) return undefined
  const m = raw.match(/<([^<>\s]+@[^<>\s]+)>\s*$/) || raw.match(/^([^<>\s]+@[^<>\s]+)$/)
  return m ? `${DIGEST_FROM_NAME} <${m[1]}>` : raw
}
export const MAX_ITEMS = 5
export const RESEND_URL = 'https://api.resend.com/emails'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

// One line of a title for a subject: whitespace collapsed, trailing period dropped, cut at
// a word boundary near `max` characters.
export function subjectFromTitle(title, max = 100) {
  let t = clean(title).replace(/\.$/, '')
  if (t.length <= max) return t
  t = t.slice(0, max)
  const cut = t.lastIndexOf(' ')
  return `${cut > 40 ? t.slice(0, cut) : t}…`
}

// The record's results, in digest order, reduced to what an email shows. Items without a
// title are dropped. A finding withheld by the number guard (findingWithheld) is omitted.
export function digestItems(record, { limit = MAX_ITEMS } = {}) {
  const results = Array.isArray(record?.results) ? record.results : []
  const triaged = record?.triaged && typeof record.triaged === 'object' ? record.triaged : {}
  const out = []
  for (const r of results) {
    const paper = r?.paper || {}
    const title = clean(paper.title)
    if (!title) continue
    const id = String(paper.id ?? paper.pmid ?? '')
    const take = triaged[id] || {}
    const finding = take.findingWithheld ? '' : clean(take.finding)
    out.push({
      id,
      title,
      author: clean(paper.author),
      journal: clean(paper.journal),
      year: clean(paper.year),
      url: clean(r?.citation?.url) || (paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(paper.pmid)}/` : ''),
      oaUrl: clean(r?.oa?.url),
      finding,
      checked: !!finding && take.check?.verdict === 'supported',
      relevance: clean(take.relevance),
    })
    if (out.length >= limit) break
  }
  return out
}

function meta(item) {
  return [item.author, item.journal, item.year].filter(Boolean).join(', ')
}

function checkedNote(item) {
  if (!item.finding) return ''
  return item.checked ? 'Checked against the source text.' : 'Not checked against the source text; read the abstract.'
}

function openLink(appUrl, src) {
  const base = String(appUrl || DEFAULT_APP_URL).replace(/\/+$/, '')
  return `${base}/?src=${encodeURIComponent(src)}`
}

// How to stop the email, in every footer: the one-click link when the runtime signs one,
// and the Settings switch either way. The in-app digest is not affected by either.
export function stopLines(unsubscribeUrl) {
  return [
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : '',
    `${unsubscribeUrl ? 'Or turn' : 'To stop these, turn'} off "Email me the digest" under Settings in Verastar. The digest itself keeps running in the app.`,
  ].filter(Boolean)
}

// RFC 8058 headers so Gmail and Apple Mail show their own unsubscribe button.
export function unsubscribeHeaders(unsubscribeUrl) {
  if (!unsubscribeUrl) return {}
  return { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
}

const FOOTER_TEXT = (appUrl, { replyTo, hourLabel, timezone, unsubscribeUrl }) => [
  `You get this because your Verastar morning digest is switched on${hourLabel ? ` for ${hourLabel}${timezone ? ` ${timezone}` : ''}` : ''}.`,
  ...stopLines(unsubscribeUrl),
  replyTo ? 'Reply to this email and it reaches Marissa directly.' : '',
].filter(Boolean).join('\n')

function footerHtml(appUrl, opts) {
  const lines = FOOTER_TEXT(appUrl, opts).split('\n').map((l) => {
    if (opts.unsubscribeUrl && l.startsWith('Unsubscribe: ')) return `<a href="${esc(opts.unsubscribeUrl)}">Unsubscribe</a>`
    return esc(l)
  })
  return `<p style="color:#666;font-size:12px;line-height:1.5;">${lines.join('<br>')}</p>`
}

// --- click tracking -------------------------------------------------------------------
// Every link an email carries is described as { kind, paperId, to } (kinds in
// ./digestClick.js). The runtime signs each one through digest-click; the builders take a
// sync `track(link)` that returns the href to print. Signing is async and the builders are
// not, so the caller signs the list first (prepareTracker) and hands the lookup in. The
// default prints the destination itself, which is what tests and the founder script use.
export const untracked = (link) => link.to
const linkKey = (l) => `${l.kind}|${l.paperId || ''}|${l.to}`

// The links buildDigestEmail will print for `record`, in order.
export function digestLinks(record, appUrl = DEFAULT_APP_URL) {
  const out = []
  for (const it of digestItems(record)) out.push(...itemLinks(it))
  out.push({ kind: 'open', paperId: '', to: openLink(appUrl, 'digest-email') })
  return out
}

// The links buildPauseEmail will print (the resume button is its own signed link).
export function pauseLinks(appUrl = DEFAULT_APP_URL) {
  return [{ kind: 'pause-open', paperId: '', to: openLink(appUrl, 'pause-email') }]
}

function itemLinks(it) {
  const out = []
  if (it.url) out.push({ kind: 'paper', paperId: it.id, to: it.url })
  if (it.oaUrl && it.oaUrl !== it.url) out.push({ kind: 'fulltext', paperId: it.id, to: it.oaUrl })
  return out
}

// Sign every link with `sign(link) -> Promise<url>` and return the sync lookup. A link
// that fails to sign is printed untracked: the email still goes, only the click is lost.
export async function prepareTracker(links, sign) {
  const signed = new Map()
  for (const l of links || []) {
    if (signed.has(linkKey(l))) continue
    try { signed.set(linkKey(l), await sign(l)) } catch { /* printed untracked */ }
  }
  return (l) => signed.get(linkKey(l)) || l.to
}

// The morning digest. `record` is the stored daily digest (kv digests/daily:latest).
// Returns null when there is nothing to send (no items). The result carries `headers` for
// the sender (unsubscribe headers when a link was given).
export function buildDigestEmail({ record, appUrl = DEFAULT_APP_URL, replyTo = null, hourLabel = '', timezone = '', intro = null, unsubscribeUrl = null, track = untracked } = {}) {
  const items = digestItems(record)
  if (!items.length) return null
  const days = Number(record?.searchContext?.days) || null
  const greeting = GREETING
  const count = `${items.length} paper${items.length === 1 ? '' : 's'}${days ? ` from the last ${days} day${days === 1 ? '' : 's'}` : ''}, picked for your north stars.`
  const link = track({ kind: 'open', paperId: '', to: openLink(appUrl, 'digest-email') })
  const lead = intro ? clean(intro) : null

  const textItems = formatItemsText(items, track)

  const text = [
    greeting,
    '',
    lead,
    count,
    '',
    textItems,
    '',
    `Open in Verastar: ${link}`,
    '',
    FOOTER_TEXT(appUrl, { replyTo, hourLabel, timezone, unsubscribeUrl }),
  ].filter((l) => l !== null).join('\n')

  const html = wrapHtml(`
    <p style="margin:0 0 8px 0;">${esc(greeting)}</p>
    ${lead ? `<p style="margin:0 0 8px 0;">${esc(lead)}</p>` : ''}
    <p style="margin:0 0 18px 0;">${esc(count)}</p>
    ${formatItemsHtml(items, track)}
    ${buttonHtml(link, 'Open in Verastar')}
    ${footerHtml(appUrl, { replyTo, hourLabel, timezone, unsubscribeUrl })}`)

  return { subject: subjectFromTitle(items[0].title), text, html, items, headers: unsubscribeHeaders(unsubscribeUrl) }
}

// The numbered paper list, plain text. Shared with the founder mailing script. `track`
// maps each link to the href to print (see prepareTracker).
export function formatItemsText(items, track = untracked) {
  return items.map((it, i) => {
    const [paper, full] = linksOf(it, track)
    return [
      `${i + 1}. ${it.title}`,
      meta(it) ? `   ${meta(it)}` : '',
      it.finding ? `   ${it.finding}` : '',
      it.finding ? `   ${checkedNote(it)}` : '',
      it.relevance ? `   Why it is here: ${it.relevance}` : '',
      paper ? `   ${paper}` : '',
      full ? `   Full text: ${full}` : '',
    ].filter(Boolean).join('\n')
  }).join('\n\n')
}

// [paper href, full-text href] for one item, either '' when absent.
function linksOf(it, track) {
  const paper = it.url ? track({ kind: 'paper', paperId: it.id, to: it.url }) : ''
  const full = it.oaUrl && it.oaUrl !== it.url ? track({ kind: 'fulltext', paperId: it.id, to: it.oaUrl }) : ''
  return [paper, full]
}

// The same list as HTML, escaped.
export function formatItemsHtml(items, track = untracked) {
  const li = items.map((it, i) => {
    const [paper, full] = linksOf(it, track)
    return `
      <li style="margin:0 0 18px 0;">
        <div style="font-weight:600;">${i + 1}. ${esc(it.title)}</div>
        ${meta(it) ? `<div style="color:#666;font-size:13px;">${esc(meta(it))}</div>` : ''}
        ${it.finding ? `<div style="margin-top:6px;">${esc(it.finding)}</div><div style="color:#666;font-size:12px;">${esc(checkedNote(it))}</div>` : ''}
        ${it.relevance ? `<div style="margin-top:6px;color:#444;font-size:13px;">Why it is here: ${esc(it.relevance)}</div>` : ''}
        <div style="margin-top:6px;font-size:13px;">
          ${paper ? `<a href="${esc(paper)}">PubMed</a>` : ''}
          ${full ? ` &middot; <a href="${esc(full)}">Full text</a>` : ''}
        </div>
      </li>`
  }).join('')
  return `<ol style="padding-left:0;list-style:none;margin:0;">${li}\n    </ol>`
}

export function buttonHtml(href, label) {
  return `<p style="margin:18px 0;"><a href="${esc(href)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">${esc(label)}</a></p>`
}

export function wrapHtml(inner) {
  return `<!doctype html><html><body style="margin:0;padding:24px 16px;background:#fff;color:#111;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;">${inner}
  </div>
</body></html>`
}

// A paragraph of plain text as escaped HTML, one <p> per blank-line-separated block.
export function paragraphsHtml(text) {
  return String(text).split(/\n\s*\n/).map((p) => `<p style="margin:0 0 12px 0;">${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n    ')
}

export { esc as escapeHtml, openLink }

export const RESUME_LABEL = 'No, don’t pause me. I like these digests!'

// Sent once when the scheduler pauses an account. Built around one button: `resumeUrl`
// (digest-resume, signed) clears the pause. Without a signed button (no secret on the
// server) the email falls back to opening the app, which also resumes.
export function buildPauseEmail({ appUrl = DEFAULT_APP_URL, streak = 7, replyTo = null, unsubscribeUrl = null, resumeUrl = null, track = untracked } = {}) {
  const link = track({ kind: 'pause-open', paperId: '', to: openLink(appUrl, 'pause-email') })
  const n = Number(streak) || 7
  const span = n === 7 ? 'a week' : `${n} mornings`
  const lead = `We haven’t seen a click on your Verastar digest in ${span}, so we’ve paused it.`
  const ask = resumeUrl ? 'If you still want it, press the button and it starts again tomorrow morning:' : 'If you still want it, open Verastar and it starts again the next morning:'
  const rest = 'If you do nothing, it stays paused: no digests are built or emailed. Nothing is deleted, and opening Verastar or pressing "Run now" under Settings starts it again whenever you like.'
  const tail = [
    ...stopLines(unsubscribeUrl),
    replyTo ? 'If it stopped earning your attention, reply and say why. That is the most useful thing you can send.' : '',
  ].filter(Boolean)
  const text = [
    GREETING,
    '',
    lead,
    ask,
    resumeUrl ? `${RESUME_LABEL} ${resumeUrl}` : `Open Verastar: ${link}`,
    '',
    rest,
    resumeUrl ? `Open Verastar: ${link}` : null,
    '',
    ...tail,
  ].filter((l) => l !== null).join('\n')
  const tailHtml = tail.map((l) => (unsubscribeUrl && l.startsWith('Unsubscribe: ') ? `<a href="${esc(unsubscribeUrl)}">Unsubscribe</a>` : esc(l))).join('<br>')
  const html = wrapHtml(`
    <p>${esc(GREETING)}</p>
    <p>${esc(lead)}<br>${esc(ask)}</p>
    ${resumeUrl ? buttonHtml(resumeUrl, RESUME_LABEL) : buttonHtml(link, 'Open Verastar')}
    <p>${esc(rest)}${resumeUrl ? ` <a href="${esc(link)}">Open Verastar</a>` : ''}</p>
    <p style="color:#666;font-size:12px;">${tailHtml}</p>`)
  return { subject: 'Your Verastar digest is paused', text, html, headers: unsubscribeHeaders(unsubscribeUrl) }
}

// A sender over Resend's HTTP API. Resolves { id } or throws with the provider's message.
// `fetch` is injectable for tests; the edge runtime passes the global.
export function makeResendSender({ apiKey, from, replyTo = null, fetch = globalThis.fetch, url = RESEND_URL } = {}) {
  if (!apiKey) throw new Error('makeResendSender: apiKey is required')
  if (!from) throw new Error('makeResendSender: from is required')
  return async function send({ to, subject, text, html, headers = null }) {
    if (!to) throw new Error('send: to is required')
    const body = { from, to: [to], subject, text, html }
    if (replyTo) body.reply_to = replyTo
    if (headers && Object.keys(headers).length) body.headers = headers
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    let data = null
    try { data = await res.json() } catch { data = null }
    if (!res.ok) throw new Error(`Resend ${res.status}: ${data?.message || data?.error || res.statusText || 'send failed'}`)
    return { id: data?.id ?? null }
  }
}
