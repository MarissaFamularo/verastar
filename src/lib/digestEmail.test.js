// The digest email builders and the Resend sender (supabase/functions/_shared/digestEmail.js).
import { describe, it, expect } from 'vitest'
import { buildDigestEmail, buildPauseEmail, digestItems, digestLinks, digestSender, makeResendSender, pauseLinks, prepareTracker, subjectFromTitle, DEFAULT_APP_URL, RESUME_LABEL } from '../../supabase/functions/_shared/digestEmail.js'

const paper = (i, extra = {}) => ({ paper: { id: `p${i}`, pmid: `p${i}`, title: `Paper ${i} title.`, author: 'Li X et al.', journal: 'J Vasc Surg', year: '2026', ...extra }, citation: { url: `https://pubmed.ncbi.nlm.nih.gov/p${i}/` } })
const record = (over = {}) => ({
  kind: 'daily', runBy: 'scheduler', server: { phase: 'done' }, openedAt: null, searchContext: { days: 3 },
  results: [paper(0), paper(1), paper(2)],
  triaged: {
    p0: { finding: 'Amputation-free survival was 71% at one year.', check: { verdict: 'supported' }, relevance: 'Limb salvage.' },
    p1: { finding: 'A number the guard withheld.', findingWithheld: 'stale-numbers', check: { verdict: 'supported' } },
    p2: { finding: 'Endothelial NR4A1 restrained thrombosis in mice.', check: { verdict: 'unchecked' } },
  },
  ...over,
})

describe('subjectFromTitle', () => {
  it('collapses whitespace, drops the final period, cuts at a word', () => {
    expect(subjectFromTitle('  A short\n title.  ')).toBe('A short title')
    const long = subjectFromTitle(`${'word '.repeat(30)}end`, 60)
    expect(long.length).toBeLessThanOrEqual(61)
    expect(long.endsWith('…')).toBe(true)
    expect(long).not.toMatch(/ …$/)
  })
})

describe('digestItems', () => {
  it('keeps digest order, drops withheld findings, labels checked findings, caps the list', () => {
    const items = digestItems(record())
    expect(items.map((i) => i.id)).toEqual(['p0', 'p1', 'p2'])
    expect(items[0]).toMatchObject({ finding: 'Amputation-free survival was 71% at one year.', checked: true, relevance: 'Limb salvage.', url: 'https://pubmed.ncbi.nlm.nih.gov/p0/' })
    expect(items[1].finding).toBe('')
    expect(items[2]).toMatchObject({ checked: false })
    const many = digestItems(record({ results: Array.from({ length: 9 }, (_, i) => paper(i)) }))
    expect(many).toHaveLength(5)
  })
  it('falls back to a PubMed link from the pmid and skips untitled results', () => {
    const items = digestItems({ results: [{ paper: { id: 'x', pmid: '123', title: 'T' } }, { paper: { id: 'y', title: '' } }] })
    expect(items).toEqual([expect.objectContaining({ id: 'x', url: 'https://pubmed.ncbi.nlm.nih.gov/123/' })])
  })
  it('is empty for anything that is not a digest with results', () => {
    expect(digestItems(null)).toEqual([])
    expect(digestItems({ results: [] })).toEqual([])
  })
})

describe('buildDigestEmail', () => {
  it('is null with nothing to send', () => {
    expect(buildDigestEmail({ record: { results: [] } })).toBeNull()
  })
  it('subject is the top paper; text and html carry the same items, labels and link', () => {
    const m = buildDigestEmail({ record: record(), replyTo: 'm@example.com', hourLabel: '6:00 am', timezone: 'America/New_York' })
    expect(m.subject).toBe('Paper 0 title')
    expect(m.text.startsWith('Hello, doctor,\n\n')).toBe(true)
    expect(m.text).toContain('3 papers from the last 3 days')
    expect(m.text).toContain('1. Paper 0 title.')
    expect(m.text).toContain('Amputation-free survival was 71% at one year.')
    expect(m.text).toContain('Checked against the source text.')
    expect(m.text).toContain('Not checked against the source text; read the abstract.')
    expect(m.text).not.toContain('A number the guard withheld.')
    expect(m.text).toContain(`${DEFAULT_APP_URL}/?src=digest-email`)
    expect(m.text).toContain('for 6:00 am America/New_York')
    expect(m.text).toContain('Reply to this email')
    expect(m.html).toContain('Amputation-free survival was 71% at one year.')
    expect(m.html).toContain('href="https://pubmed.ncbi.nlm.nih.gov/p0/"')
    expect(m.items).toHaveLength(3)
  })
  it('escapes html and omits the reply line without a reply address', () => {
    const m = buildDigestEmail({ record: record({ results: [paper(0, { title: 'A <b>bold</b> & "quoted" claim' })], triaged: {} }), appUrl: 'https://app.test/' })
    expect(m.html).toContain('A &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot; claim')
    expect(m.html).not.toContain('<b>bold</b>')
    expect(m.text).not.toContain('Reply to this email')
    expect(m.text).toContain('https://app.test/?src=digest-email')
  })
})

describe('buildPauseEmail', () => {
  const RESUME = 'https://fn.test/functions/v1/digest-resume?u=A&t=abc'
  it('is built around the resume button: no click in a week, the button, doing nothing leaves it paused', () => {
    const m = buildPauseEmail({ streak: 7, replyTo: 'm@example.com', resumeUrl: RESUME })
    expect(m.subject).toBe('Your Verastar digest is paused')
    expect(m.text.startsWith('Hello, doctor,')).toBe(true)
    expect(m.text).toContain('We haven’t seen a click on your Verastar digest in a week')
    expect(m.text).toContain(`${RESUME_LABEL} ${RESUME}`)
    expect(m.text).toContain('If you do nothing, it stays paused')
    expect(m.text).toContain('"Run now"')
    expect(m.text).toContain(`${DEFAULT_APP_URL}/?src=pause-email`)
    expect(m.text).toContain('reply and say why')
    expect(m.html).toContain(`href="${RESUME.replace('&', '&amp;')}"`)
    expect(m.html).toContain('No, don’t pause me. I like these digests!')
    // The button comes before the "do nothing" line.
    expect(m.html.indexOf(RESUME_LABEL)).toBeLessThan(m.html.indexOf('If you do nothing'))
    expect(buildPauseEmail({}).text).not.toContain('reply and say why')
  })
  it('names a different streak plainly', () => {
    expect(buildPauseEmail({ streak: 10, resumeUrl: RESUME }).text).toContain('in 10 mornings')
  })
  it('without a signed button, opening the app is the way back', () => {
    const m = buildPauseEmail({})
    expect(m.text).not.toContain(RESUME_LABEL)
    expect(m.text).toContain(`Open Verastar: ${DEFAULT_APP_URL}/?src=pause-email`)
    expect(m.html).toContain('>Open Verastar</a>')
  })
  it('tracks its app link', () => {
    const m = buildPauseEmail({ resumeUrl: RESUME, track: (l) => `https://t.test/${l.kind}` })
    expect(m.text).toContain('Open Verastar: https://t.test/pause-open')
    expect(m.text).not.toContain('?src=pause-email')
  })
})

describe('click tracking', () => {
  const track = (l) => `https://t.test/${l.kind}/${l.paperId || '-'}`
  it('every link in the digest email goes through the tracker, text and html', () => {
    const m = buildDigestEmail({ record: record({ results: [paper(0), { ...paper(1), oa: { url: 'https://pmc.test/p1' } }] }), track })
    for (const href of ['https://t.test/paper/p0', 'https://t.test/paper/p1', 'https://t.test/fulltext/p1', 'https://t.test/open/-']) {
      expect(m.text).toContain(href)
      expect(m.html).toContain(`href="${href}"`)
    }
    expect(m.text).not.toContain('https://pubmed.ncbi.nlm.nih.gov/')
    expect(m.html).not.toContain('?src=digest-email')
  })
  it('digestLinks lists exactly what the builder prints', () => {
    const rec = record({ results: [paper(0), { ...paper(1), oa: { url: 'https://pmc.test/p1' } }] })
    const printed = []
    buildDigestEmail({ record: rec, appUrl: 'https://app.test', track: (l) => { printed.push(l); return l.to } })
    const listed = digestLinks(rec, 'https://app.test')
    const key = (l) => `${l.kind}|${l.paperId}|${l.to}`
    expect(new Set(printed.map(key))).toEqual(new Set(listed.map(key)))
    expect(listed).toContainEqual({ kind: 'paper', paperId: 'p0', to: 'https://pubmed.ncbi.nlm.nih.gov/p0/' })
    expect(listed).toContainEqual({ kind: 'fulltext', paperId: 'p1', to: 'https://pmc.test/p1' })
    expect(listed).toContainEqual({ kind: 'open', paperId: '', to: 'https://app.test/?src=digest-email' })
    expect(pauseLinks('https://app.test')).toEqual([{ kind: 'pause-open', paperId: '', to: 'https://app.test/?src=pause-email' }])
  })
  it('prepareTracker signs each link once and prints a link that failed to sign untracked', async () => {
    const calls = []
    const t = await prepareTracker([
      { kind: 'paper', paperId: 'a', to: 'https://x.test/a' },
      { kind: 'paper', paperId: 'a', to: 'https://x.test/a' },
      { kind: 'paper', paperId: 'b', to: 'https://x.test/b' },
    ], async (l) => { calls.push(l.paperId); if (l.paperId === 'b') throw new Error('nope'); return `signed:${l.paperId}` })
    expect(calls).toEqual(['a', 'b'])
    expect(t({ kind: 'paper', paperId: 'a', to: 'https://x.test/a' })).toBe('signed:a')
    expect(t({ kind: 'paper', paperId: 'b', to: 'https://x.test/b' })).toBe('https://x.test/b')
    expect(t({ kind: 'open', paperId: '', to: 'https://x.test/never' })).toBe('https://x.test/never')
  })
  it('untracked builders print the destinations (the founder script path)', () => {
    const m = buildDigestEmail({ record: record() })
    expect(m.html).toContain('href="https://pubmed.ncbi.nlm.nih.gov/p0/"')
  })
})

describe('makeResendSender', () => {
  it('posts the message with the key and resolves the provider id', async () => {
    const calls = []
    const fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: 'em_1' }) } }
    const send = makeResendSender({ apiKey: 'k', from: 'Verastar <d@x.test>', replyTo: 'm@x.test', fetch })
    await expect(send({ to: 'a@b.test', subject: 'S', text: 'T', html: '<p>T</p>' })).resolves.toEqual({ id: 'em_1' })
    expect(calls[0].url).toBe('https://api.resend.com/emails')
    expect(calls[0].init.headers.Authorization).toBe('Bearer k')
    expect(JSON.parse(calls[0].init.body)).toEqual({ from: 'Verastar <d@x.test>', to: ['a@b.test'], subject: 'S', text: 'T', html: '<p>T</p>', reply_to: 'm@x.test' })
  })
  it('throws with the provider message on a failure', async () => {
    const fetch = async () => ({ ok: false, status: 422, statusText: 'Unprocessable', json: async () => ({ message: 'Invalid `from` field' }) })
    const send = makeResendSender({ apiKey: 'k', from: 'x', fetch })
    await expect(send({ to: 'a@b.test', subject: 'S', text: 'T', html: '' })).rejects.toThrow('Resend 422: Invalid `from` field')
  })
  it('refuses to build without a key or sender', () => {
    expect(() => makeResendSender({ from: 'x' })).toThrow(/apiKey/)
    expect(() => makeResendSender({ apiKey: 'k' })).toThrow(/from/)
  })
})

describe('opting out', () => {
  const rec = { results: [{ paper: { id: 'p', pmid: '1', title: 'T' } }], triaged: {} }
  it('with a link: footer names it, html links it, headers carry it, Settings is still named', () => {
    const m = buildDigestEmail({ record: rec, unsubscribeUrl: 'https://fn.test/u?u=x&t=y' })
    expect(m.text).toContain('Unsubscribe: https://fn.test/u?u=x&t=y')
    expect(m.text).toContain('Or turn off "Email me the digest" under Settings')
    expect(m.text).not.toContain('Run automatically')
    expect(m.html).toContain('<a href="https://fn.test/u?u=x&amp;t=y">Unsubscribe</a>')
    expect(m.headers).toEqual({ 'List-Unsubscribe': '<https://fn.test/u?u=x&t=y>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' })
    const p = buildPauseEmail({ unsubscribeUrl: 'https://fn.test/u?u=x&t=y' })
    expect(p.text).toContain('Unsubscribe: https://fn.test/u?u=x&t=y')
    expect(p.headers['List-Unsubscribe']).toBe('<https://fn.test/u?u=x&t=y>')
  })
  it('without a link: the Settings switch is the way off and no headers are set', () => {
    const m = buildDigestEmail({ record: rec })
    expect(m.text).toContain('To stop these, turn off "Email me the digest" under Settings')
    expect(m.text).not.toContain('Unsubscribe:')
    expect(m.headers).toEqual({})
  })
  it('the sender forwards headers to Resend', async () => {
    const calls = []
    const send = makeResendSender({ apiKey: 'k', from: 'x@y.test', fetch: async (url, init) => { calls.push(init); return { ok: true, status: 200, json: async () => ({ id: 'e' }) } } })
    await send({ to: 'a@b.test', subject: 's', text: 't', html: '', headers: { 'List-Unsubscribe': '<u>' } })
    expect(JSON.parse(calls[0].body).headers).toEqual({ 'List-Unsubscribe': '<u>' })
    await send({ to: 'a@b.test', subject: 's', text: 't', html: '' })
    expect(JSON.parse(calls[1].body).headers).toBeUndefined()
  })
})

describe('digestSender', () => {
  it('puts Marissa on the project sender, keeps the address, leaves junk alone', () => {
    expect(digestSender('Verastar <no-reply@mail.verastar.papertrellis.com>')).toBe('Marissa at Verastar <no-reply@mail.verastar.papertrellis.com>')
    expect(digestSender('no-reply@mail.verastar.papertrellis.com')).toBe('Marissa at Verastar <no-reply@mail.verastar.papertrellis.com>')
    expect(digestSender('')).toBeUndefined()
    expect(digestSender(undefined)).toBeUndefined()
    expect(digestSender('not an address')).toBe('not an address')
  })
})
