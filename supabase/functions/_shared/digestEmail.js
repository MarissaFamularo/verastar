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

// The morning digest. `record` is the stored daily digest (kv digests/daily:latest).
// Returns null when there is nothing to send (no items). The result carries `headers` for
// the sender (unsubscribe headers when a link was given).
export function buildDigestEmail({ record, appUrl = DEFAULT_APP_URL, name = '', replyTo = null, hourLabel = '', timezone = '', intro = null, unsubscribeUrl = null } = {}) {
  const items = digestItems(record)
  if (!items.length) return null
  const days = Number(record?.searchContext?.days) || null
  const who = clean(name)
  const greeting = who ? `Good morning, ${who}.` : 'Good morning.'
  const count = `${items.length} paper${items.length === 1 ? '' : 's'}${days ? ` from the last ${days} day${days === 1 ? '' : 's'}` : ''}, picked for your north stars.`
  const link = openLink(appUrl, 'digest-email')
  const lead = intro ? clean(intro) : null

  const textItems = formatItemsText(items)

  const text = [
    greeting,
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
    ${formatItemsHtml(items)}
    ${buttonHtml(link, 'Open in Verastar')}
    ${footerHtml(appUrl, { replyTo, hourLabel, timezone, unsubscribeUrl })}`)

  return { subject: subjectFromTitle(items[0].title), text, html, items, headers: unsubscribeHeaders(unsubscribeUrl) }
}

// The numbered paper list, plain text. Shared with the founder mailing script.
export function formatItemsText(items) {
  return items.map((it, i) => [
    `${i + 1}. ${it.title}`,
    meta(it) ? `   ${meta(it)}` : '',
    it.finding ? `   ${it.finding}` : '',
    it.finding ? `   ${checkedNote(it)}` : '',
    it.relevance ? `   Why it is here: ${it.relevance}` : '',
    it.url ? `   ${it.url}` : '',
    it.oaUrl && it.oaUrl !== it.url ? `   Full text: ${it.oaUrl}` : '',
  ].filter(Boolean).join('\n')).join('\n\n')
}

// The same list as HTML, escaped.
export function formatItemsHtml(items) {
  const li = items.map((it, i) => `
      <li style="margin:0 0 18px 0;">
        <div style="font-weight:600;">${i + 1}. ${esc(it.title)}</div>
        ${meta(it) ? `<div style="color:#666;font-size:13px;">${esc(meta(it))}</div>` : ''}
        ${it.finding ? `<div style="margin-top:6px;">${esc(it.finding)}</div><div style="color:#666;font-size:12px;">${esc(checkedNote(it))}</div>` : ''}
        ${it.relevance ? `<div style="margin-top:6px;color:#444;font-size:13px;">Why it is here: ${esc(it.relevance)}</div>` : ''}
        <div style="margin-top:6px;font-size:13px;">
          ${it.url ? `<a href="${esc(it.url)}">PubMed</a>` : ''}
          ${it.oaUrl && it.oaUrl !== it.url ? ` &middot; <a href="${esc(it.oaUrl)}">Full text</a>` : ''}
        </div>
      </li>`).join('')
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

// Sent once when the scheduler pauses an account.
export function buildPauseEmail({ appUrl = DEFAULT_APP_URL, name = '', streak = 7, replyTo = null, unsubscribeUrl = null } = {}) {
  const who = clean(name)
  const link = openLink(appUrl, 'pause-email')
  const n = Number(streak) || 7
  const head = [
    who ? `Hi ${who},` : 'Hi,',
    '',
    `Your Verastar digest ran ${n} mornings in a row without being opened, so it has stopped running.`,
    'Nothing is deleted. Open Verastar once and the next digest is built the following morning, at your usual hour.',
    '',
    `Open Verastar: ${link}`,
  ]
  const tail = [
    'If you would rather it stayed off, turn off "Run automatically" under Settings and no more of these will come.',
    ...stopLines(unsubscribeUrl),
    replyTo ? 'If it stopped earning your attention, reply and say why. That is the most useful thing you can send.' : '',
  ].filter(Boolean)
  const text = [...head, '', ...tail].join('\n')
  const tailHtml = tail.map((l) => (unsubscribeUrl && l.startsWith('Unsubscribe: ') ? `<a href="${esc(unsubscribeUrl)}">Unsubscribe</a>` : esc(l))).join('<br>')
  const html = wrapHtml(`
    <p>${esc(head[0])}</p>
    <p>${esc(head[2])}<br>${esc(head[3])}</p>
    ${buttonHtml(link, 'Open Verastar')}
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
