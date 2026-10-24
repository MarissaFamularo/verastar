// Confirms dist/_headers matches the built app's external loads.
// Run after `npm run build`. Exit 0 when the CSP covers every origin the
// bundle and index.html actually request, and the other security headers
// are present.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dist = 'dist'
const headersPath = join(dist, '_headers')
const headers = readFileSync(headersPath, 'utf8')
const sourceHeaders = readFileSync('public/_headers', 'utf8')
const failures = []
const fail = (message) => failures.push(message)

if (headers !== sourceHeaders) fail('dist/_headers differs from public/_headers')

const block = headers.split('\n').filter((line) => line.startsWith('  ') || line.startsWith('\t')).join('\n')
const value = (name) => {
  const match = block.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm'))
  return match ? match[1].trim() : ''
}

const required = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}
for (const [name, expected] of Object.entries(required)) {
  if (value(name) !== expected) fail(`${name} should be ${expected}`)
}
const permissions = value('Permissions-Policy')
if (!permissions.includes('screen-wake-lock=(self)')) fail('Permissions-Policy must allow the digest screen wake lock')
for (const denied of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()']) {
  if (!permissions.includes(denied)) fail(`Permissions-Policy must deny ${denied}`)
}

const csp = value('Content-Security-Policy')
if (!csp) fail('Content-Security-Policy missing')
const directive = (name) => {
  const match = csp.match(new RegExp(`(?:^|;)\\s*${name}\\s+([^;]+)`))
  return match ? match[1].trim() : ''
}
if (!directive('frame-ancestors').includes("'none'")) fail("frame-ancestors must be 'none'")
const scriptTokens = directive('script-src').split(/\s+/)
if (scriptTokens.includes("'unsafe-inline'") || scriptTokens.includes("'unsafe-eval'")) {
  fail('script-src must not allow inline or eval scripts')
}
if (!scriptTokens.includes("'wasm-unsafe-eval'")) fail('script-src must allow pdf.js WebAssembly compilation')
if (!directive('style-src').includes("'unsafe-inline'")) fail('style-src must allow the inline styles React sets')
if (!directive('worker-src').includes("'self'")) fail("worker-src must allow the same-origin pdf.js worker")
// Turnstile (src/lib/captcha.js) loads one script and renders one iframe. Nothing
// else may be framed.
const turnstile = 'https://challenges.cloudflare.com'
if (!scriptTokens.includes(turnstile)) fail('script-src must allow the Turnstile script')
const frameTokens = directive('frame-src').split(/\s+/)
if (frameTokens.join(' ') !== turnstile) fail('frame-src must allow only the Turnstile iframe')

// Hosts the browser navigates to or only mentions. They are not fetch/script/style loads.
const navigationOnly = new Set([
  'pubmed.ncbi.nlm.nih.gov',
  'pmc.ncbi.nlm.nih.gov',
  'www.ncbi.nlm.nih.gov',
  'doi.org',
  'dx.doi.org',
  'platform.claude.com',
  'papertrellis.com',
  'www.w3.org',
  'verastar.netlify.app',
])
// Strings shipped inside dependencies. They are not requests this app makes.
const mentionedOnly = new Set([
  'react.dev',
  'docs.expo.dev',
  'docs.anthropic.com',
  'github.com',
  'foo.bar',
])
// Fetched by the browser build. Each must appear in dist and in connect-src.
// api.crossref.org is referenced from sources.js but the client bundle does not
// keep it, so it is not allowed here.
const fetched = [
  'api.anthropic.com',
  'eutils.ncbi.nlm.nih.gov',
  'clinicaltrials.gov',
  'api.unpaywall.org',
]

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}
const files = walk(dist).filter((path) => /\.(html|js|css|mjs)$/.test(path) && !path.endsWith('_headers'))
const corpus = files.map((path) => readFileSync(path, 'utf8')).join('\n')
const hosts = new Set([...corpus.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1].toLowerCase()))

const styleSrc = directive('style-src')
const fontSrc = directive('font-src')
const connectSrc = directive('connect-src')
const scriptSrc = directive('script-src')
if (!styleSrc.includes('https://fonts.googleapis.com')) fail('style-src missing fonts.googleapis.com')
if (!fontSrc.includes('https://fonts.gstatic.com')) fail('font-src missing fonts.gstatic.com')
if (!hosts.has('fonts.googleapis.com')) fail('built index does not load fonts.googleapis.com')
if (!hosts.has('fonts.gstatic.com')) fail('built index does not reference fonts.gstatic.com')
for (const host of fetched) {
  if (!hosts.has(host)) fail(`built bundle does not load ${host}`)
  if (!connectSrc.includes(`https://${host}`)) fail(`connect-src missing ${host}`)
}
if (!connectSrc.includes('https://*.supabase.co') || !connectSrc.includes('wss://*.supabase.co')) {
  fail('connect-src must allow Supabase https and websocket')
}

for (const host of hosts) {
  if (navigationOnly.has(host) || mentionedOnly.has(host)) continue
  if (host === 'fonts.googleapis.com' || host === 'fonts.gstatic.com') continue
  if (fetched.includes(host)) continue
  // The project URL is baked in from VITE_SUPABASE_URL; connect-src allows it by wildcard.
  if (host.endsWith('.supabase.co')) continue
  const covered = [connectSrc, styleSrc, fontSrc, scriptSrc, directive('img-src')].some((src) => src.includes(host))
  if (!covered) fail(`built file references https://${host}, which CSP does not allow`)
}

if (failures.length) {
  for (const message of failures) console.error(message)
  process.exit(1)
}
console.log(`PASS netlify headers (${hosts.size} https hosts in the build)`)
