// App-shell scenarios: the real Verastar app (vite dev on :5198, VITE_SUPABASE_URL pointed at
// a host Playwright intercepts) with real supabase-js and a fake in-memory backend.
// Everything here is SIMULATED: synthetic accounts, fake responses, no live services.
import { chromium } from 'playwright-core'
import { writeFileSync, mkdirSync } from 'node:fs'
import { makeFake, installFake, makeUser } from './fake.mjs'

const OUT = new URL('../../docs/screenshots/beta-release/', import.meta.url).pathname
mkdirSync(OUT, {recursive:true})
const APP = 'http://localhost:5198/'
const DESKTOP = { width: 1280, height: 900 }
const MOBILE = { width: 390, height: 844 }
const STATS = (await import('../../src/lib/betaAdmin.fixture.js')).STATS
const PROFILE = { name: 'Dr. Synthetic', specialty: 'vascular-surgery', northStars: ['Limb preservation'], projects: [], topics: [], journalPreferences: { mustNotMiss: [], preferred: [] }, rubric: { criteria: 'Rank trials first.', selectCount: 5, scoreFloor: 0 }, onboarded: true }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] })
const results = []
let failures = 0
const assert = (cond, label) => { if (!cond) { failures++; results.push(`FAIL ${label}`); console.log('FAIL', label) } else results.push(`ok   ${label}`) }

async function session({ viewport, admin = false, onboarded = false, sponsored = false, npi = true }) {
  const user = makeUser({ id: '11111111-1111-4111-8111-111111111111', email: 'synthetic@example.test', npi })
  const log = []
  const tables = { projects: [] }
  if (onboarded) tables.kv = [{ user_id: user.id, collection: 'profile', key: 'me', value: PROFILE, updated_at: new Date().toISOString() }]
  if (sponsored) tables.sponsored_accounts = [{ user_id: user.id, active: true, ends_at: null, cohort: 'pilot-synthetic', created_at: '2026-10-01T00:00:00Z' }]
  const fake = makeFake({ user, admin, tables, log })
  fake.control.stats = STATS
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await installFake(page, fake, user)
  await page.goto(APP, { waitUntil: 'networkidle' })
  return { page, fake, errors, log, close: () => context.close() }
}

// Drive onboarding up to the survey (welcome → connect → code → enrolled → survey).
async function reachSurvey(page) {
  await page.getByRole('button', { name: /Set up my digest/ }).click()
  await page.locator('#beta-access-code').fill('SYNTH-BETA')
  await page.keyboard.press('Enter')
  await page.getByText('This optional, one-minute survey').waitFor({ timeout: 10000 })
}
const surveySubmit = (fake) => fake.calls.rpc.filter((c) => c.fn === 'beta_survey_submit')

// Optional-code enrollment: real app, fake atomic server success, then existing survey.
{
  const s = await session({ viewport: MOBILE })
  await s.page.getByRole('button', { name: /Set up my digest/ }).click()
  await s.page.screenshot({path:`${OUT}/join-without-code-mobile.png`})
  await s.page.locator('#beta-access-code').press('Enter')
  await s.page.getByText('This optional, one-minute survey').waitFor({timeout:10000})
  const calls=s.fake.calls.functions.filter(c=>c.fn==='redeem-invite')
  assert(calls.length===1 && calls[0].body.code==='', 'S0 optional code submits empty code and offers survey after enrollment')
  assert(s.errors.length===0, 'S0 no page errors')
  await s.close()
}

// ---------------------------------------------------------------- S1 submit (desktop)
{
  const s = await session({ viewport: DESKTOP })
  await reachSurvey(s.page)
  await s.page.screenshot({ path: `${OUT}/shell-survey-desktop.png`, fullPage: true })
  assert(await s.page.getByRole('button', { name: /Send answers/ }).isDisabled(), 'S1 submit is disabled before all four answers')
  assert((await s.page.locator('fieldset').count()) === 4, 'S1 four fieldsets rendered in the app shell')
  await s.page.getByLabel('Find relevant papers', { exact: true }).check()
  await s.page.getByLabel('Several days a week', { exact: true }).check()
  await s.page.getByLabel('30–60 minutes', { exact: true }).check()
  await s.page.getByRole('radio', { name: '3', exact: true }).check()
  assert(await s.page.getByRole('button', { name: /Send answers/ }).isEnabled(), 'S1 submit enables after the fourth answer')
  await s.page.getByRole('button', { name: /Send answers/ }).click()
  await s.page.getByText('You are all set').waitFor({ timeout: 10000 })
  const calls = surveySubmit(s.fake)
  assert(calls.length === 1 && calls[0].args.p_status === 'completed' && calls[0].args.p_wave === 'signup', 'S1 one completed submit reached the backend')
  assert(JSON.stringify(calls[0].args.p_answers) === JSON.stringify({ reason: 'find_papers', read_frequency: 'several_weekly', weekly_time: '30_60m', confidence: '3' }), 'S1 submitted codes match the chosen labels')
  assert(!(await s.page.getByText('one-minute survey').isVisible().catch(() => false)), 'S1 survey is gone after submit')
  assert(await s.page.getByRole('button', { name: 'Continue →' }).isVisible(), 'S1 onboarding continues with the normal Continue')
  const redeem = s.fake.calls.functions.filter((c) => c.fn === 'redeem-invite')
  assert(redeem.length === 1 && redeem[0].body?.code === 'SYNTH-BETA', 'S1 the code went to redeem-invite exactly once')
  assert(s.errors.length === 0, `S1 no page errors (${s.errors.join('; ')})`)
  await s.page.screenshot({ path: `${OUT}/shell-survey-desktop-after.png` })
  await s.close()
}

// ---------------------------------------------------------------- S2 skip (mobile, scrolling)
{
  const s = await session({ viewport: MOBILE })
  await reachSurvey(s.page)
  assert(!(await s.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'S2 no horizontal overflow at 390px')
  await s.page.screenshot({ path: `${OUT}/shell-survey-mobile.png` })
  const skip = s.page.getByRole('button', { name: 'Skip for now' })
  await skip.scrollIntoViewIfNeeded()
  assert((await s.page.evaluate(() => window.scrollY)) > 100, 'S2 the page scrolled to reach Skip on a phone')
  await s.page.screenshot({ path: `${OUT}/shell-survey-mobile-bottom.png` })
  await skip.click()
  await s.page.getByText('You are all set').waitFor({ timeout: 10000 })
  const calls = surveySubmit(s.fake)
  assert(calls.length === 1 && calls[0].args.p_status === 'skipped' && Object.keys(calls[0].args.p_answers).length === 0, 'S2 skip recorded with no answers')
  assert(s.errors.length === 0, `S2 no page errors (${s.errors.join('; ')})`)
  await s.close()
}

// ---------------------------------------------------------------- S3 backend error on submit
{
  const s = await session({ viewport: DESKTOP })
  s.fake.control.survey = 'error'
  await reachSurvey(s.page)
  await s.page.getByLabel('Other', { exact: true }).check()
  await s.page.getByLabel('Daily', { exact: true }).check()
  await s.page.getByLabel('More than 3 hours', { exact: true }).check()
  await s.page.getByRole('radio', { name: '5', exact: true }).check()
  await s.page.getByRole('button', { name: /Send answers/ }).click()
  await s.page.getByText('You are all set').waitFor({ timeout: 10000 })
  assert(surveySubmit(s.fake).length === 1, 'S3 the failing submit was attempted once')
  assert(s.errors.length === 0, `S3 a 500 from the survey RPC is swallowed, setup continues (${s.errors.join('; ')})`)
  await s.close()
}

// ---------------------------------------------------------------- S4 backend never answers
{
  const s = await session({ viewport: DESKTOP })
  s.fake.control.survey = 'stall'
  await reachSurvey(s.page)
  const t0 = Date.now()
  await s.page.getByRole('button', { name: 'Skip for now' }).click()
  assert(await s.page.getByRole('button', { name: /Saving/ }).isVisible(), 'S4 shows Saving… while the backend hangs')
  await s.page.getByText('You are all set').waitFor({ timeout: 15000 })
  const elapsed = Date.now() - t0
  assert(elapsed >= 5500 && elapsed < 9000, `S4 continued after the 6 s timeout (${elapsed} ms)`)
  assert(s.errors.length === 0, `S4 no page errors (${s.errors.join('; ')})`)
  await s.close()
}

// ---------------------------------------------------------------- S5 keyboard-only survey
{
  const s = await session({ viewport: DESKTOP })
  await reachSurvey(s.page)
  // Start from the first radio and answer every question without the mouse.
  await s.page.locator('input[type="radio"]').first().focus()
  const active = () => s.page.evaluate(() => { const a = document.activeElement; return { tag: a?.tagName, name: a?.name, value: a?.value, text: a?.textContent?.trim().slice(0, 20) } })
  assert((await active()).name === 'reason', 'S5 focus lands on the first radio group')
  await s.page.keyboard.press('ArrowRight') // selects + moves within the group
  assert((await active()).value === 'find_papers', 'S5 ArrowRight moves within the group and checks the option')
  await s.page.keyboard.press('Tab')
  assert((await active()).name === 'read_frequency', 'S5 Tab leaves the group for the next question')
  await s.page.keyboard.press('ArrowDown'); await s.page.keyboard.press('ArrowDown')
  assert((await active()).value === 'weekly', 'S5 two ArrowDowns select the third option')
  await s.page.screenshot({ path: `${OUT}/shell-survey-keyboard-focus.png`, clip: { x: 0, y: 0, width: 1280, height: 900 } })
  await s.page.keyboard.press('Tab'); await s.page.keyboard.press('ArrowRight')
  assert((await active()).value === '30_60m', 'S5 third group answered by keyboard')
  await s.page.keyboard.press('Tab'); await s.page.keyboard.press('ArrowRight'); await s.page.keyboard.press('ArrowRight')
  assert((await active()).value === '3', 'S5 confidence group answered by keyboard')
  await s.page.keyboard.press('Tab')
  assert((await active()).text?.startsWith('Send answers'), 'S5 Tab after the last group reaches Send')
  await s.page.keyboard.press('Enter')
  await s.page.getByText('You are all set').waitFor({ timeout: 10000 })
  const calls = surveySubmit(s.fake)
  assert(JSON.stringify(calls[0]?.args.p_answers) === JSON.stringify({ reason: 'find_papers', read_frequency: 'weekly', weekly_time: '30_60m', confidence: '3' }), 'S5 keyboard-chosen answers were submitted')
  await s.close()
}

// ---------------------------------------------------------------- S6 admin settings (desktop)
async function openSettings(page) {
  await page.getByRole('button', { name: /^Settings for/ }).first().click()
  await page.getByRole('dialog').waitFor()
}
{
  const s = await session({ viewport: DESKTOP, admin: true, onboarded: true, sponsored: true })
  await s.page.getByText('Good morning, Dr. Synthetic').waitFor({ timeout: 10000 })
  await openSettings(s.page)
  const entry = s.page.getByRole('button', { name: /Beta admin/ })
  await entry.waitFor({ timeout: 5000 })
  assert(s.fake.calls.rpc.some((c) => c.fn === 'beta_admin_check'), 'S6 the entry waited for the server allowlist answer')
  assert(!s.fake.calls.rpc.some((c) => c.fn === 'beta_release_stats'), 'S6 no metrics were fetched before the section opened')
  await entry.click()
  await s.page.locator('section[aria-label="Service health"]').waitFor({ timeout: 10000 })
  assert(s.fake.calls.rpc.filter((c) => c.fn === 'beta_release_stats').length === 1, 'S6 metrics fetched once on open')
  const dialog = s.page.getByRole('dialog')
  await s.page.screenshot({ path: `${OUT}/shell-admin-desktop.png` })
  const before = await dialog.evaluate((el) => el.scrollTop)
  await s.page.locator('section[aria-label="Survey answers"]').scrollIntoViewIfNeeded()
  const after = await dialog.evaluate((el) => el.scrollTop)
  assert(after > before, 'S6 the settings card scrolls to the survey answers')
  const headerVisible = await s.page.getByRole('heading', { name: 'Beta admin' }).isVisible()
  assert(headerVisible, 'S6 the sticky header stays visible while scrolled')
  await s.page.screenshot({ path: `${OUT}/shell-admin-desktop-scrolled.png` })
  assert(await s.page.getByText('Technical diagnostics and metric definitions').isVisible(), 'S6 technical details are collapsed by default')
  assert(await s.page.getByText('Monitor active · schedule on track').isVisible(), 'S6 quiet schedule health remains separate from untested signup')
  // Date range change reloads.
  await s.page.getByText('Survey and diagnostic date range', {exact:true}).click()
  await s.page.getByLabel('From date').fill('2026-10-01')
  await s.page.getByLabel('To date').fill('2026-10-07')
  await s.page.getByRole('button', { name: 'Update' }).click()
  await s.page.getByText('7 days').waitFor({ timeout: 5000 })
  assert(s.fake.calls.rpc.filter((c) => c.fn === 'beta_release_stats').length === 2, 'S6 Update fetched the new range')
  // Keyboard: Tab stays inside the dialog; Escape closes and focus returns to the opener.
  let inside = true
  for (let i = 0; i < 40; i++) {
    await s.page.keyboard.press('Tab')
    if (!(await s.page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement)))) inside = false
  }
  assert(inside, 'S6 Tab never leaves the settings dialog')
  await s.page.keyboard.press('Escape')
  await s.page.waitForTimeout(300)
  assert((await s.page.getByRole('dialog').count()) === 0, 'S6 Escape closes settings')
  const opener = await s.page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
  assert(/^Settings for/.test(opener || ''), `S6 focus returns to the settings opener (${opener})`)
  assert(s.errors.length === 0, `S6 no page errors (${s.errors.join('; ')})`)
  await s.close()
}

// ---------------------------------------------------------------- S7 admin settings (mobile)
{
  const s = await session({ viewport: MOBILE, admin: true, onboarded: true, sponsored: true })
  await s.page.getByText('Good morning, Dr. Synthetic').waitFor({ timeout: 10000 })
  await openSettings(s.page)
  await s.page.getByRole('button', { name: /Beta admin/ }).click()
  await s.page.locator('section[aria-label="Service health"]').waitFor({ timeout: 10000 })
  assert(!(await s.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'S7 no horizontal overflow at 390px')
  await s.page.screenshot({ path: `${OUT}/shell-admin-mobile.png` })
  const dialog = s.page.getByRole('dialog')
  await s.page.locator('section[aria-label="Survey answers"]').scrollIntoViewIfNeeded()
  assert((await dialog.evaluate((el) => el.scrollTop)) > 0, 'S7 the card scrolls on a phone')
  assert(await s.page.getByRole('button', { name: 'Close settings' }).isVisible(), 'S7 the close button stays reachable while scrolled')
  await s.page.screenshot({ path: `${OUT}/shell-admin-mobile-scrolled.png` })
  await s.page.getByRole('button', { name: '← Back to settings' }).click()
  assert(await s.page.getByRole('button', { name: /Reading preferences/ }).isVisible(), 'S7 Back returns to the settings menu')
  assert(s.errors.length === 0, `S7 no page errors (${s.errors.join('; ')})`)
  await s.close()
}

// ---------------------------------------------------------------- S8 non-admin settings
{
  const s = await session({ viewport: DESKTOP, admin: false, onboarded: true, sponsored: true })
  await s.page.getByText('Good morning, Dr. Synthetic').waitFor({ timeout: 10000 })
  await openSettings(s.page)
  await s.page.waitForTimeout(800)
  assert(s.fake.calls.rpc.some((c) => c.fn === 'beta_admin_check'), 'S8 the allowlist was asked')
  assert((await s.page.getByRole('button', { name: /Beta admin/ }).count()) === 0, 'S8 no Beta admin entry for a non-admin')
  assert(!(await s.page.textContent('body')).includes('Aggregate counts'), 'S8 no dashboard text anywhere')
  assert(!s.fake.calls.rpc.some((c) => c.fn === 'beta_release_stats'), 'S8 no metrics request was made')
  await s.page.screenshot({ path: `${OUT}/shell-settings-non-admin.png` })
  await s.close()
}

await browser.close()
writeFileSync(`${OUT}/shell-results.txt`, `App-shell scenarios (simulated backend, synthetic accounts) ${new Date().toISOString()}\n${results.join('\n')}\n`)
console.log(results.join('\n'))
console.log(failures ? `${failures} FAILED` : 'all shell scenarios passed')
process.exit(failures ? 1 : 0)
