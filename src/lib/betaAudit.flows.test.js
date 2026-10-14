// betaAudit.flows.test.js — pre-beta probes of the account / onboarding / storage / cap flows.
// Same convention as pipeline/betaAudit.prose.test.js: every test asserts the SAFE outcome.
// A test whose name starts "FINDING:" is expected to FAIL today; the failure is the defect,
// not a bug in the test. All other tests are characterizations that pass and should stay green.
// Synthetic fixtures only. Network, auth and the model are mocked.

import React from 'react'
import { readdirSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred, mountDom } from '../test-utils/dom.js'
import { installOnboardHistory } from '../test-utils/onboardHistory.js'

const h = vi.hoisted(() => ({
  signedIn: true,
  user: { id: 'user-1', email: 'doc@example.org' },
  tables: {},
  extract: vi.fn(),
  saveProfile: vi.fn(async () => {}),
}))

vi.mock('./supabase.js', () => {
  const table = (name) => {
    const t = () => h.tables[name] || {}
    const q = {
      select: () => q,
      eq: () => q,
      order: () => q,
      range: () => q,
      maybeSingle: () => Promise.resolve(t().maybeSingle ? t().maybeSingle() : { data: null, error: null }),
      single: () => Promise.resolve(t().single ? t().single() : { data: null, error: null }),
      upsert: (row) => Promise.resolve(t().upsert ? t().upsert(row) : { error: null }),
      insert: (row) => Object.assign(Promise.resolve(t().insert ? t().insert(row) : { error: null }), { select: () => q }),
    }
    return q
  }
  return {
    supabaseConfigured: true,
    supabase: {
      auth: { getSession: async () => ({ data: { session: h.signedIn ? { access_token: 'tok', user: h.user } : null } }) },
      from: table,
      rpc: async () => ({ data: { match: false }, error: null }),
    },
    currentUser: () => (h.signedIn ? h.user : null),
    isSignedIn: () => h.signedIn,
    initAuth: async () => (h.signedIn ? h.user : null),
    signOut: async () => {},
    sendMagicLink: vi.fn(),
    verifyEmailCode: vi.fn(),
    adoptEmailSession: vi.fn(),
  }
})
vi.mock('./anthropic.js', async (importOriginal) => ({ ...(await importOriginal()), extractStructured: h.extract }))
vi.mock('./store.js', async (importOriginal) => ({ ...(await importOriginal()), saveProfile: h.saveProfile, getProfile: vi.fn(async () => null) }))
vi.mock('../pipeline/sources.js', async (importOriginal) => ({ ...(await importOriginal()), fetchAbstractsByPmid: vi.fn(async () => ({})) }))
vi.mock('../components/NpiMatch.jsx', () => ({
  default: ({ onContinue }) => React.createElement('div', null, 'NPI form', React.createElement('button', { onClick: onContinue }, 'Finish NPI')),
}))

import { CapReachedError, isCapReached, recordUsage, setApiKey, accessMode, requestOptions } from './anthropic.js'
import { redeemInviteCode } from './inviteCode.js'
import { refreshSponsorship, isSponsored, _setSponsoredForTests } from './sponsor.js'
import { runScheduledDigestNow } from './digestSchedule.js'
import { submitReport } from './feedback.js'
import { logEvent } from './events.js'
import { verifyEmailCodeForSignIn, emailCodeFailureKind } from './emailCode.js'
import { gmailAliasDecision, isMaskedGmailHint } from './gmailAlias.js'
import { safeRedirect, verifyCanonicalGmailCode } from './gmailCanonical.js'
import { migrateLocalToAccount, shouldOfferMigration, migrationRows } from './migrate.js'
import { createContinuationTickets } from './continuationTicket.js'
import { runAndRankDigest } from './digestRunAndRank.js'
import { specialtySlug } from '../pipeline/seed.js'
import { normalizeInterviewDraft, mergeInterviewProfile } from '../pipeline/interview.js'
import { selectCandidates } from '../pipeline/select.js'
import OnboardingQuiz from '../components/OnboardingQuiz.jsx'
import DigestSchedule from '../components/DigestSchedule.jsx'
import InviteCode from '../components/InviteCode.jsx'

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  h.signedIn = true
  h.tables = {}
  h.extract.mockReset()
  h.saveProfile.mockClear()
  _setSponsoredForTests(false)
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------------------
describe('1. sign-in state machine (emailCode / gmail alias)', () => {
  it('a hung code check reports a timeout quickly, and a late success still signs in', async () => {
    const pending = deferred()
    const late = vi.fn()
    const out = await verifyEmailCodeForSignIn('a@b.c', '123456', {
      timeoutMs: 30, sessionMs: 10, verify: () => pending.promise, getSession: async () => null, onLateSession: late,
    })
    expect(out.ok).toBe(false)
    expect(out.kind).toBe('timeout')
    pending.resolve({ id: 'u1' })
    await tick()
    expect(late).toHaveBeenCalledWith({ id: 'u1' })
  })

  it('a wrong code stays a readable error, never a success', async () => {
    const out = await verifyEmailCodeForSignIn('a@b.c', '000000', {
      timeoutMs: 200, sessionMs: 10, verify: async () => { throw new Error('Token has expired or is invalid') }, getSession: async () => null,
    })
    expect(out).toMatchObject({ ok: false, kind: 'invalid' })
  })

  it('a rate-limit error on the code check is not told to the reader as "invalid or expired"', () => {
    // supabase.js verifyEmailCode rethrows only error.message, so status/code never reach this classifier.
    expect(emailCodeFailureKind(new Error('email rate limit exceeded'))).not.toBe('invalid')
  })

  it('a masked Gmail hint is one character, and a full address is rejected', () => {
    expect(isMaskedGmailHint('a…@gmail.com')).toBe(true)
    expect(isMaskedGmailHint('alice@gmail.com')).toBe(false)
    expect(isMaskedGmailHint('a…@gmail.com\n')).toBe(false)
  })

  it('a Gmail match with no ticket blocks instead of opening a second account', () => {
    expect(gmailAliasDecision({ match: true, hint: 'a…@gmail.com', ticket: '' })).toMatchObject({ send: 'blocked' })
    expect(gmailAliasDecision({ match: true, hint: 'a…@gmail.com', ticket: '11111111-1111-4111-8111-111111111111' })).toMatchObject({ send: 'canonical' })
  })

  it('redirect targets keep only an http(s) origin, and a short or lettered code never reaches the function', async () => {
    expect(safeRedirect('https://user:pw@evil.test/x')).toBe('')
    expect(safeRedirect('javascript:alert(1)')).toBe('')
    expect(safeRedirect('https://verastar.netlify.app/path?x=1')).toBe('https://verastar.netlify.app')
    await expect(verifyCanonicalGmailCode({ verifyTicket: '11111111-1111-4111-8111-111111111111', code: '12ab56' })).rejects.toThrow('invalid')
  })
})

// ---------------------------------------------------------------------------------------
describe('2. invite redemption and sponsorship (inviteCode / sponsor)', () => {
  it('"enrolled" from the server leaves the client unsponsored when the follow-up read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, { status: 'enrolled', cohort: 'beta' })))
    h.tables.sponsored_accounts = { maybeSingle: async () => ({ data: null, error: { message: 'network' } }) }
    const out = await redeemInviteCode('beta-1')
    expect(out.status).toBe('enrolled') // the screen says "You are in"
    expect(isSponsored()).toBe(true) // but every gate still reads unsponsored until a reload
  })

  it('one transient read error at boot makes a sponsored account look unsponsored for the whole session', async () => {
    let calls = 0
    h.tables.sponsored_accounts = {
      maybeSingle: async () => (++calls === 1 ? { data: null, error: { message: 'flaky' } } : { data: { user_id: 'user-1', active: true, ends_at: null }, error: null }),
    }
    expect(await refreshSponsorship()).toBe(true)
  })

  it('a 503 {status:"paused"} from the redemption guard is shown as a generic error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(503, { status: 'paused' })))
    const out = await redeemInviteCode('beta-1')
    expect(out.status).toBe('paused')
  })

  it('a 403 that claims "enrolled" is not enrollment', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(403, { status: 'enrolled' })))
    expect((await redeemInviteCode('beta-1')).status).toBe('error')
    expect(isSponsored()).toBe(false)
  })

  it('"Run my digest" HTTP failures are indistinguishable from a dropped connection', async () => {
    _setSponsoredForTests(true)
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(500, {})))
    let err
    try { await runScheduledDigestNow() } catch (e) { err = e }
    expect(err).toBeInstanceOf(Error)
    // SpineCheck.startServerRun catches EVERYTHING and says "being prepared on the server".
    // It can only tell a 401/500 from an offline phone if the error carries the status.
    expect(err.status).toBe(500)
  })
})

// ---------------------------------------------------------------------------------------
describe('3. cap reached degrades, never blocks', () => {
  it('the pre-read scoring step turns a cap into a generic "try again" error', async () => {
    h.extract.mockRejectedValue(new CapReachedError())
    let err
    try { await selectCandidates({ rubric: 'r', northStars: ['n'], candidates: [{ id: '1', title: 't', abstract: 'a' }] }) } catch (e) { err = e }
    expect(err).toBeTruthy()
    expect(isCapReached(err)).toBe(true)
  })

  const PROFILE = { northStars: ['n'], rubric: { criteria: 'c', scoreFloor: 50 } }
  const read = (id) => ({ paper: { id, title: `Paper ${id}`, topics: ['t'] }, design: 'RCT', rows: [], error: null })
  function harness(fakes) {
    const calls = []
    const saved = []
    const ui = new Proxy({}, { get: (_, name) => (value) => { calls.push([name, value]) } })
    const run = (papers) => runAndRankDigest(papers, {}, {
      tickets: createContinuationTickets(),
      snapshot: { results: [], processedResults: [], triaged: {} },
      ui,
      persistDigest: (o) => saved.push(o),
      titleOf: (r) => r.paper.title,
      deps: { getProfile: async () => PROFILE, digestProjects: async () => [], logEvent: () => {}, ...fakes },
    })
    return { run, calls, saved }
  }
  const last = (calls, name) => [...calls].reverse().find(([n]) => n === name)?.[1]

  it('a cap during reading stops reading, ranks what was read, and says so without an error card', async () => {
    const triageIds = []
    const { run, calls, saved } = harness({
      runPaper: async (p) => (p.id === 'b' ? { paper: p, rows: [], error: new CapReachedError().message, errorObject: new CapReachedError() } : read(p.id)),
      triage: async ({ candidates }) => { triageIds.push(...candidates.map((c) => c.id)); return candidates.map((c) => ({ id: c.id, score: 80, tier: 'read', finding: 'f', relevance: 'r' })) },
    })
    const out = await run([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    expect(out.blocked).toBeFalsy()
    expect(triageIds).toEqual(['a'])
    expect(last(calls, 'setCapNotice')).toMatch(/read a lot today/)
    expect(saved.at(-1).processedResults.map((r) => r.paper.id)).toEqual(['a'])
  })

  it('a cap during the summary step keeps the verified papers and offers Finish, not a dead end', async () => {
    const { run, calls, saved } = harness({
      runPaper: async (p) => read(p.id),
      triage: async () => { throw new CapReachedError() },
    })
    const out = await run([{ id: 'a' }, { id: 'b' }])
    expect(out.processedResults).toHaveLength(2)
    expect(saved.at(-1).results).toHaveLength(2)
    expect(last(calls, 'setScanError')).toMatch(/Finish this digest/)
    expect(last(calls, 'setScanError')).toMatch(/read a lot today/)
    expect(last(calls, 'setRanking')).toBe(false)
  })

  it('a sponsored call never writes the USD ledger; a key-holder call does', () => {
    const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: vi.fn((k, v) => m.set(k, String(v))), removeItem: (k) => m.delete(k) } }
    const local = store()
    vi.stubGlobal('localStorage', local)
    vi.stubGlobal('sessionStorage', store())
    _setSponsoredForTests(true)
    expect(accessMode()).toBe('sponsored')
    recordUsage('claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 1000 })
    expect(local.setItem).not.toHaveBeenCalled()
    _setSponsoredForTests(false)
    setApiKey('sk-ant-test')
    recordUsage('claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 1000 })
    expect(local.setItem).toHaveBeenCalledTimes(1)
  })

  it('sponsored requests carry the proxy headers; key-holder requests carry none (Anthropic CORS)', () => {
    expect(requestOptions({ purpose: 'extraction', cacheKey: 'k' }, 'sponsored')).toEqual({ headers: { 'x-verastar-purpose': 'extraction', 'x-verastar-cache': 'k' } })
    expect(requestOptions({ purpose: 'extraction', cacheKey: 'k' }, 'byok')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------
describe('4. user key never leaves the browser', () => {
  const root = new URL('../', import.meta.url)
  const files = readdirSync(root, { recursive: true })
    .filter((f) => /\.(js|jsx)$/.test(f) && !/\.test\.|test-utils|^eval[\\/]/.test(f))

  it('only anthropic.js and App.jsx read the key; no module that talks to Supabase does', () => {
    const readers = files.filter((f) => /\bgetApiKey\(/.test(readFileSync(new URL(f, root), 'utf8')))
    expect(readers.sort()).toEqual(['App.jsx', 'lib/anthropic.js'])
  })

  it('the key goes to sessionStorage by default and to localStorage only on opt-in', () => {
    const mk = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) } }
    const local = mk(); const session = mk()
    vi.stubGlobal('localStorage', local); vi.stubGlobal('sessionStorage', session)
    setApiKey('sk-ant-one')
    expect(session.getItem('verastar.anthropic_key')).toBe('sk-ant-one')
    expect(local.getItem('verastar.anthropic_key')).toBeNull()
    setApiKey('sk-ant-one', { remember: true })
    expect(local.getItem('verastar.anthropic_key')).toBe('sk-ant-one')
    expect(session.getItem('verastar.anthropic_key')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------
describe('5. starter seeding shelf', () => {
  it('a cardiology clinician is routed to the vascular-surgery shelf ("cardiovascular" contains "vascular")', () => {
    expect(specialtySlug('Cardiovascular medicine: heart failure and arrhythmia trials')).toBe('cardiology')
  })

  it.fails('(open product decision, not fixed) the interview path never records profile.specialty (spec section 3), so seeding guesses from rubric prose', () => {
    const draft = normalizeInterviewDraft({ name: 'Dr. Lee', northStars: ['Heart failure'], rubric: 'Rank HF trials first.', topics: [{ label: 'HF', query: 'heart failure OR HFrEF', northStars: ['Heart failure'] }] })
    const saved = mergeInterviewProfile(null, draft)
    expect(saved.specialty).toBeTruthy()
  })

  it.fails('(open product decision, not fixed) a blank drafted rubric falls back to the vascular-surgery default, which then seeds the vascular shelf for anyone', () => {
    const draft = normalizeInterviewDraft({ name: 'Dr. Okoye', northStars: ['CKD progression'], rubric: '', topics: [] })
    expect(specialtySlug(draft.rubric.criteria)).not.toBe('vascular-surgery')
  })
})

// ---------------------------------------------------------------------------------------
describe('6. local to cloud migration', () => {
  function memoryState() {
    let st = null
    return async (userId, update) => {
      if (!update) return st
      if (st && st.userId !== userId) throw new Error('assigned to another account')
      st = st
        ? { ...st, nextBatch: Math.max(st.nextBatch || 0, update.nextBatch || 0), complete: st.complete || update.complete || false }
        : { ...update, userId }
      return st
    }
  }
  const circular = {}; circular.self = circular
  const entries = async (collection) => ({
    papers: Array.from({ length: 450 }, (_, i) => [String(i), { id: String(i) }]),
    profile: [['me', { onboarded: true }], ['libraryHandle', { kind: 'directory' }], ['migrationState', { userId: 'u' }], ['weird', circular]],
  }[collection] || [])
  const client = (userIds, rpc) => ({ auth: { getUser: async () => ({ data: { user: { id: userIds.shift() ?? 'u' } }, error: null }) }, rpc })

  it('resumes at the failed batch, never re-sends finished ones, and never uploads device-local or unserializable rows', async () => {
    const state = memoryState()
    const sent = []
    let n = 0
    const rpc = vi.fn(async (_fn, args) => {
      if (++n === 2) return { error: { message: 'boom' } }
      sent.push(args.p_rows)
      return { error: null }
    })
    await expect(migrateLocalToAccount({ client: client([], rpc), userId: 'u', entries, state })).rejects.toThrow(/paused after 1 batches/)
    expect((await state('u')).nextBatch).toBe(1)
    const total = await migrateLocalToAccount({ client: client([], rpc), userId: 'u', entries, state })
    expect(total).toBe(451)
    expect(rpc).toHaveBeenCalledTimes(4) // 1 ok + 1 failed + 2 resumed
    const keys = sent.flat().map((r) => `${r.collection}/${r.key}`)
    expect(keys).not.toContain('profile/libraryHandle')
    expect(keys).not.toContain('profile/migrationState')
    expect(keys).not.toContain('profile/weird')
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('stops if the signed-in account changes mid-move', async () => {
    const state = memoryState()
    const rpc = vi.fn(async () => ({ error: null }))
    await expect(migrateLocalToAccount({ client: client(['u', 'u', 'someone-else'], rpc), userId: 'u', entries, state })).rejects.toThrow(/Account changed/)
  })

  it('offers the move for a real local library, but not for the sample profile or another account\'s manifest', () => {
    expect(shouldOfferMigration({ localPapersCount: 0, localProfile: { onboarded: true, demo: true }, userId: 'u', progress: null })).toBe(false)
    expect(shouldOfferMigration({ localPapersCount: 0, localProfile: { onboarded: true }, userId: 'u', progress: null })).toBe(true)
    expect(shouldOfferMigration({ localPapersCount: 5, localProfile: null, userId: 'u', progress: { userId: 'other', complete: false } })).toBe(false)
    expect(migrationRows({ profile: [['libraryHandle', {}]] }, 'u')).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------
describe('7. beta reports and events', () => {
  it('telemetry is a silent no-op signed out and never throws when the insert rejects', async () => {
    const insert = vi.fn(async () => { throw new Error('boom') })
    h.tables.events = { insert }
    h.signedIn = false
    await expect(logEvent('app_opened', {})).resolves.toBeUndefined()
    expect(insert).not.toHaveBeenCalled()
    h.signedIn = true
    await expect(logEvent('app_opened', {})).resolves.toBeUndefined()
  })

  it('a report or feedback insert that never answers leaves "Sending…" forever (no deadline)', async () => {
    vi.useFakeTimers()
    const client = { from: () => ({ insert: () => ({ select: () => ({ single: () => new Promise(() => {}) }) }) }) }
    let done = false
    submitReport('beta_feedback', { text: 'x' }, { client, user: { id: 'u' }, configured: true }).then(() => { done = true }, () => { done = true })
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(done).toBe(true)
  })

  it('a confirmed insert returns the stored id; a refusal is an error, not a receipt', async () => {
    const ok = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: { id: 7 }, error: null }) }) }) }) }
    const bad = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'rls' } }) }) }) }) }
    await expect(submitReport('t', {}, { client: ok, user: { id: 'u' }, configured: true })).resolves.toEqual({ id: 7 })
    await expect(submitReport('t', {}, { client: bad, user: { id: 'u' }, configured: true })).rejects.toThrow(/Not sent/)
  })
})

// ---------------------------------------------------------------------------------------
describe('7b. fix unit tests', () => {
  it('a signed-out visitor still gets the sample button, and a failed write shows an error instead of nothing', async () => {
    const dom2 = await mountDom()
    installOnboardHistory()
    h.saveProfile.mockRejectedValueOnce(new Error('disk full'))
    const onDone = vi.fn()
    await dom2.render(React.createElement(OnboardingQuiz, { account: null, onDone }))
    await dom2.click(dom2.button('Explore a populated sample digest'))
    await dom2.settle(() => tick())
    expect(onDone).not.toHaveBeenCalled()
    expect(dom2.q('[role="alert"]').textContent).toMatch(/disk full/)
    await dom2.unmount()
  })

  it('a stale cap or HTTP status gets plain-language copy with no dollar figure', async () => {
    const { serverRunFailureNote, PAUSED_RUN_NOTE } = await import('./digestSchedule.js')
    expect(serverRunFailureNote({ status: 503, reason: 'paused' })).toBe(PAUSED_RUN_NOTE)
    expect(serverRunFailureNote({ status: 402 })).toMatch(/read a lot today/)
    expect(serverRunFailureNote({ status: 401 })).toMatch(/Sign in again/)
    for (const st of [402, 429, 500, 503]) expect(serverRunFailureNote({ status: st })).not.toMatch(/\$|USD|dollar/i)
  })

  it('sponsorship: a transient error never clears an existing true flag, and a clean read still clears it', async () => {
    const row = { user_id: 'user-1', active: true, ends_at: null }
    h.tables.sponsored_accounts = { maybeSingle: async () => ({ data: row, error: null }) }
    expect(await refreshSponsorship({ retryMs: 1 })).toBe(true)
    h.tables.sponsored_accounts = { maybeSingle: async () => ({ data: null, error: { message: 'blip' } }) }
    expect(await refreshSponsorship({ retryMs: 1 })).toBe(true)
    h.tables.sponsored_accounts = { maybeSingle: async () => ({ data: { ...row, active: false }, error: null }) }
    expect(await refreshSponsorship({ retryMs: 1 })).toBe(false)
  })

  it('a hung report resolves as a retryable failure', async () => {
    const client = { from: () => ({ insert: () => ({ select: () => ({ single: () => new Promise(() => {}) }) }) }) }
    await expect(submitReport('t', {}, { client, user: { id: 'u' }, configured: true, timeoutMs: 20 })).rejects.toThrow(/Not sent: .*in time/)
  })

  it('auth errors keep status and code, so a 429 is a rate-limit message', async () => {
    const err = Object.assign(new Error('Email rate limit exceeded'), { status: 429, code: 'over_email_send_rate_limit' })
    expect(emailCodeFailureKind(err)).toBe('rate')
    expect(emailCodeFailureKind(new Error('Token has expired or is invalid'))).toBe('invalid')
  })
})

// ---------------------------------------------------------------------------------------
describe('8. component flows', () => {
  let dom
  beforeEach(async () => { dom = await mountDom() })
  afterEach(async () => { await dom.unmount() })

  it('a signed-in account is not offered the sample digest, so its profile is never written as demo', async () => {
    installOnboardHistory()
    const onDone = vi.fn()
    await dom.render(React.createElement(OnboardingQuiz, { account: { email: 'doc@example.org' }, onDone }))
    expect(dom.button('Explore a populated sample digest')).toBeUndefined()
    await dom.settle(() => tick())
    // Signed in, saveProfile is the CLOUD profile/me row: onboarded:true + demo:true skips the invite,
    // NPI and interview steps and App.jsx only treats a profile as demo when signed OUT.
    expect(h.saveProfile).not.toHaveBeenCalled()
  })

  it('after any Run-now / save failure the schedule controls stay disabled until Settings is reopened', async () => {
    _setSponsoredForTests(true)
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(500, {})))
    await dom.render(React.createElement(DigestSchedule))
    await dom.settle(() => tick())
    await dom.click(dom.button('Run now'))
    await dom.settle(() => tick(40))
    expect(dom.text()).toContain('Digest run failed (500)')
    expect(dom.button('Run now').hasAttribute('disabled')).toBe(false)
  })

  it.fails('(open, not fixed; hypothetical server disagreement) after NPI match, a second npi_required re-opens the NPI form with no explanation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, { status: 'npi_required' })))
    await dom.render(React.createElement(InviteCode))
    await dom.type(dom.q('#beta-access-code'), 'beta')
    await dom.submit(dom.q('form'))
    await dom.settle(() => tick())
    expect(dom.text()).toContain('NPI form')
    await dom.click(dom.button('Finish NPI'))
    await dom.settle(() => tick())
    expect(dom.q('[role="alert"]')).toBeTruthy()
  })
})
