#!/usr/bin/env node
// scripts/founder-recapture-email.mjs — one founder email to each beta reader, by hand.
//
// Why: the beta's first week (2026-10-18 to 2026-10-25) enrolled 49 clinicians and told none
// of them when a digest was ready. This sends each one a note from Marissa with the digest
// that was built for them this morning, or, for a reader who never finished setup, the one
// step that is left. Run it once, after the pause-rule release has let the scheduler build
// fresh digests (docs/DIGEST_DELIVERY.md § Recapture).
//
// Dry run by default: prints who would get what and the full text of the first email of each
// kind. Nothing is sent and nothing is written until --send. With --send, each delivery is
// recorded as an events row (founder_email_sent) and a reader who already has one is skipped,
// so a second run cannot double-send.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DIGEST_UNSUBSCRIBE_SECRET=... \
//   RESEND_API_KEY=<the project's SMTP_PASSWORD secret> SMTP_FROM=<the SMTP_FROM secret> \
//   node scripts/founder-recapture-email.mjs [options]
//
// Sends as "Marissa at Verastar" from the SMTP_FROM address with replies to the mailbox in
// digestEmail.js; DIGEST_EMAIL_FROM and DIGEST_EMAIL_REPLY_TO override.
//
//   --send                 actually send (default: dry run)
//   --segment digest|setup|all   which readers (default all)
//   --only <email|user_id> one reader, for a test send to yourself
//   --limit N              at most N sends this run
//   --fresh-hours H        a digest counts as today's within H hours (default 36)
//   --cohort <pattern>     SQL LIKE pattern on sponsored_accounts.cohort (default beta-%)
//   --app-url <url>        link target (default the public site)
//
// Secrets are read from the environment only. Addresses are printed in the dry run because
// the operator is the one person meant to see them; do not paste the output anywhere.

import { createClient } from '@supabase/supabase-js'
import { buttonHtml, digestItems, digestSender, formatItemsHtml, formatItemsText, makeResendSender, openLink, paragraphsHtml, subjectFromTitle, wrapHtml, DEFAULT_APP_URL, DIGEST_REPLY_TO } from '../supabase/functions/_shared/digestEmail.js'
import { unsubscribeUrl } from '../supabase/functions/_shared/unsubscribe.js'

const EVENT = 'founder_email_sent'
const SEND_GAP_MS = 700 // Resend's free tier allows two requests a second.

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  if (i < 0) return fallback
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}
const SEND = process.argv.includes('--send')
const SEGMENT = String(arg('--segment', 'all'))
const ONLY = arg('--only', null)
const LIMIT = Number(arg('--limit', Infinity)) || Infinity
const FRESH_HOURS = Number(arg('--fresh-hours', 36)) || 36
const COHORT = String(arg('--cohort', 'beta-%'))
const APP_URL = String(arg('--app-url', process.env.APP_URL || DEFAULT_APP_URL))
const REPLY_TO = process.env.DIGEST_EMAIL_REPLY_TO || DIGEST_REPLY_TO
const UNSUB_SECRET = process.env.DIGEST_UNSUBSCRIBE_SECRET || ''

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing ${k}`); process.exit(2) } return v }
const supabaseUrl = need('SUPABASE_URL')
const serviceKey = need('SUPABASE_SERVICE_ROLE_KEY')
const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
const FUNCTIONS_BASE = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1`
if (!UNSUB_SECRET) { console.error('Missing DIGEST_UNSUBSCRIBE_SECRET: every email must carry a working unsubscribe link.'); process.exit(2) }

// --- copy ---------------------------------------------------------------------------------
// Marissa's words (2026-10-25), typos fixed, placeholders filled. Edit here, then dry-run.

function stopLine(unsub) {
  return unsub
    ? 'If you want to stop it, click the unsubscribe link at the bottom of this email, or turn off "Email me the digest" under Settings in Verastar.'
    : 'If you want to stop it, turn off "Email me the digest" under Settings in Verastar.'
}

function founderDigestEmail({ record, unsub }) {
  const items = digestItems(record)
  if (!items.length) return null
  const link = openLink(APP_URL, 'founder-email')
  const body = [
    'Hi, doctor,',
    '',
    'Marissa here. I built the digest engine for Verastar and I really didn’t want to add any noise to your already busy life. If you opened the app, the next morning’s digest was already built for you. But, if you didn’t, the engine stopped and waited... quietly. Nothing reached you. I didn’t realize that this required users to remember to check Verastar, which is a big ask for busy physicians.',
    '',
    `From now on your digest will land in your email each morning. ${stopLine(unsub)} If this is helpful, please reply and let me know. If something else would be better, let me know. Here is today’s digest:`,
  ].join('\n')
  const footer = [`Open in Verastar: ${link}`, '', ...(unsub ? [`Unsubscribe: ${unsub}`] : []), 'Or turn off "Email me the digest" under Settings in Verastar.'].join('\n')
  const text = `${body}\n\n${formatItemsText(items)}\n\n${footer}`
  const html = wrapHtml(`
    ${paragraphsHtml(body)}
    ${formatItemsHtml(items)}
    ${buttonHtml(link, 'Open in Verastar')}
    <p style="color:#666;font-size:12px;">${unsub ? `<a href="${esc(unsub)}">Unsubscribe</a><br>` : ''}Or turn off "Email me the digest" under Settings in Verastar.</p>`)
  return { subject: subjectFromTitle(items[0].title), text, html, headers: headersFor(unsub) }
}

function founderSetupEmail({ name, step, unsub }) {
  const link = openLink(APP_URL, 'founder-email')
  const hi = name ? `Hi ${name},` : 'Hi, doctor,'
  const left = step === 'north-stars'
    ? 'set your north stars, the concepts you want the literature filtered by'
    : 'turn on the morning run under Settings'
  const paragraphs = [
    hi,
    'Marissa here. You signed up for the Verastar beta, got partway through setup, and stopped. Fair. It asks for real setup before it gives anything back.',
    `One step is left: ${left}. Two minutes.`,
    'After that, a digest lands in this inbox each morning, built for those north stars. Each claim in it says whether it was checked against the source text.',
    `Finish setup: ${link}`,
    'Reply if any part of the setup was confusing. I read every one of these.',
    'Marissa',
  ]
  const footer = [...(unsub ? [`Unsubscribe: ${unsub}`] : []), 'Or turn off "Email me the digest" under Settings in Verastar.'].join('\n')
  const text = `${paragraphs.join('\n\n')}\n\n${footer}`
  const html = wrapHtml(`
    ${paragraphsHtml(paragraphs.slice(0, 4).join('\n\n'))}
    ${buttonHtml(link, 'Finish setup')}
    ${paragraphsHtml(paragraphs.slice(5).join('\n\n'))}
    <p style="color:#666;font-size:12px;">${unsub ? `<a href="${esc(unsub)}">Unsubscribe</a><br>` : ''}Or turn off "Email me the digest" under Settings in Verastar.</p>`)
  return { subject: 'One step left on your Verastar digest', text, html, headers: headersFor(unsub) }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const headersFor = (unsub) => (unsub ? { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {})

// --- data ---------------------------------------------------------------------------------

async function must(q, what) {
  const { data, error } = await q
  if (error) throw new Error(`${what}: ${error.message}`)
  return data || []
}

async function loadEmails(ids) {
  const want = new Set(ids)
  const out = new Map()
  for (let page = 1; page <= 50 && out.size < want.size; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`auth users: ${error.message}`)
    for (const u of data?.users || []) if (want.has(u.id)) out.set(u.id, u.email || null)
    if (!data?.users?.length || data.users.length < 200) break
  }
  return out
}

async function main() {
  const accounts = await must(admin.from('sponsored_accounts').select('user_id, cohort, active, created_at').like('cohort', COHORT).eq('active', true), 'sponsored_accounts')
  const ids = accounts.map((a) => a.user_id)
  if (!ids.length) { console.log('No accounts match.'); return }
  const [schedules, kv, sent, emails] = await Promise.all([
    must(admin.from('digest_schedules').select('user_id, enabled, hour_local, timezone, last_run_at, paused_at, unopened_streak, email_digest').in('user_id', ids), 'digest_schedules'),
    must(admin.from('kv').select('user_id, collection, key, value').in('user_id', ids).in('collection', ['profile', 'digests']).in('key', ['me', 'daily:latest']), 'kv'),
    must(admin.from('events').select('user_id, ts, payload').eq('type', EVENT).in('user_id', ids), 'events'),
    loadEmails(ids),
  ])
  const byUser = (rows) => { const m = new Map(); for (const r of rows) m.set(r.user_id, r); return m }
  const sched = byUser(schedules)
  const already = byUser(sent)
  const profile = new Map(kv.filter((r) => r.collection === 'profile').map((r) => [r.user_id, r.value]))
  const latest = new Map(kv.filter((r) => r.collection === 'digests').map((r) => [r.user_id, r.value]))
  const freshSince = Date.now() - FRESH_HOURS * 3600 * 1000

  const plan = []
  for (const a of accounts) {
    const email = emails.get(a.user_id) || null
    const me = profile.get(a.user_id) || {}
    const name = typeof me.name === 'string' ? me.name.trim().split(/\s+/)[0] : ''
    const onboarded = me.onboarded === true && Array.isArray(me.northStars) && me.northStars.length > 0
    const s = sched.get(a.user_id)
    const rec = latest.get(a.user_id)
    const hasPapers = Array.isArray(rec?.results) && rec.results.length > 0
    const ranAt = rec?.ranAt ?? rec?.savedAt ?? null
    const fresh = hasPapers && ranAt && Date.parse(ranAt) >= freshSince && rec?.server?.phase !== 'reading' && rec?.server?.phase !== 'rank'
    const unsub = await unsubscribeUrl(FUNCTIONS_BASE, a.user_id, UNSUB_SECRET)
    let segment, message, note = ''
    if (!email) { segment = 'skip'; note = 'no address' }
    else if (already.has(a.user_id)) { segment = 'skip'; note = `already sent ${String(already.get(a.user_id).ts).slice(0, 10)}` }
    else if (s && s.email_digest === false) { segment = 'skip'; note = 'opted out of email' }
    else if (!onboarded) { segment = 'setup'; message = founderSetupEmail({ name, step: 'north-stars', unsub }) }
    else if (!s?.enabled) { segment = 'setup'; message = founderSetupEmail({ name, step: 'schedule', unsub }) }
    else if (fresh) { segment = 'digest'; message = founderDigestEmail({ name, record: rec, unsub }) }
    else { segment = 'skip'; note = hasPapers ? `digest is stale (${String(ranAt).slice(0, 10)}); let the morning run replace it first` : 'no digest with papers yet' }
    if (segment !== 'skip' && SEGMENT !== 'all' && SEGMENT !== segment) { segment = 'skip'; note = `not in --segment ${SEGMENT}` }
    if (ONLY && ONLY !== a.user_id && ONLY !== email) { segment = 'skip'; note = 'not --only' }
    if (segment !== 'skip' && !message) { segment = 'skip'; note = 'nothing to send' }
    plan.push({ user_id: a.user_id, cohort: a.cohort, email, name, segment, note, message })
  }

  const counts = plan.reduce((m, p) => ({ ...m, [p.segment]: (m[p.segment] || 0) + 1 }), {})
  console.log(`${SEND ? 'SENDING' : 'DRY RUN'}: ${plan.length} accounts, cohort ${COHORT}. ${JSON.stringify(counts)}\n`)
  for (const p of plan) console.log(`${p.segment.padEnd(6)} ${p.user_id.slice(0, 8)}  ${(p.email || '-').padEnd(34)} ${p.cohort.padEnd(10)} ${p.segment === 'skip' ? p.note : p.message.subject}`)

  if (!SEND) {
    for (const seg of ['digest', 'setup']) {
      const first = plan.find((p) => p.segment === seg)
      if (!first) continue
      console.log(`\n===== first ${seg} email (to ${first.email}) =====\nSubject: ${first.message.subject}\n\n${first.message.text}\n`)
    }
    console.log('\nDry run. Add --send to deliver.')
    return
  }

  // The project's Resend credentials are its SMTP secrets (SMTP_PASSWORD is a Resend API
  // key); RESEND_API_KEY / DIGEST_EMAIL_FROM override them.
  const apiKey = process.env.RESEND_API_KEY || process.env.SMTP_PASSWORD || need('RESEND_API_KEY')
  const from = process.env.DIGEST_EMAIL_FROM || digestSender(process.env.SMTP_FROM) || need('DIGEST_EMAIL_FROM')
  const send = makeResendSender({ apiKey, from, replyTo: REPLY_TO })
  let n = 0
  for (const p of plan) {
    if (p.segment === 'skip') continue
    if (n >= LIMIT) { console.log(`limit ${LIMIT} reached`); break }
    try {
      const out = await send({ to: p.email, subject: p.message.subject, text: p.message.text, html: p.message.html, headers: p.message.headers })
      const { error } = await admin.from('events').insert({ user_id: p.user_id, type: EVENT, payload: { segment: p.segment, subject: p.message.subject, provider_id: out.id } })
      if (error) console.error(`  sent to ${p.email} but the event was NOT recorded (${error.message}); record it by hand before re-running`)
      console.log(`sent   ${p.user_id.slice(0, 8)}  ${p.email}  ${out.id || ''}`)
      n++
    } catch (err) {
      console.error(`FAILED ${p.user_id.slice(0, 8)}  ${p.email}  ${err.message}`)
    }
    await new Promise((r) => setTimeout(r, SEND_GAP_MS))
  }
  console.log(`\n${n} sent.`)
}

main().catch((err) => { console.error(err.message || err); process.exit(1) })
