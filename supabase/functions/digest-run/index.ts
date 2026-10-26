// supabase/functions/digest-run/index.ts — the scheduled morning digest (Deno entry).
//
// Invoked by pg_cron every few minutes (docs/SPONSORED_ACCESS_DEPLOY.md) or by a signed-in
// user's "run mine now". All behavior lives in ./handler.js (tested under vitest); this
// file binds it to the platform:
//   - the app's own pipeline modules come from ./app.bundle.js, generated from the local
//     reviewed source by `npm run bundle:functions` and deployed WITH this function (the
//     CLI bundles the whole module graph). No remote URL, no commit pin.
//   - each account's run executes inside an AsyncLocalStorage scope that carries its store,
//     model client and cache writer (src/lib/serverScope.js); nothing account-specific is
//     a module global, so overlapping requests in one isolate cannot exchange them.
//   - the model client's fetch is the guarded reserve/settle boundary
//     (../_shared/spending.js), the same contract as the browser proxy.
//   - a finished scheduled digest is emailed through Resend's HTTP API with the project's
//     existing Resend credentials (SMTP_PASSWORD when SMTP_HOST is Resend, SMTP_FROM), or
//     with RESEND_API_KEY / DIGEST_EMAIL_FROM when those are set (docs/DIGEST_DELIVERY.md);
//     with neither, nothing is sent and the scheduler behaves as before.
//
// Secrets: ANTHROPIC_API_KEY, DIGEST_CRON_SECRET; SUPABASE_* injected by the platform.
// Email: SMTP_HOST, SMTP_PASSWORD, SMTP_FROM (already set for beta-monitor), or
// RESEND_API_KEY and DIGEST_EMAIL_FROM ("Name <digest@domain>") to override. Optional:
// DIGEST_EMAIL_REPLY_TO, DIGEST_UNSUBSCRIBE_SECRET (signs the footer link, the tracked
// links and the pause email's resume button; shared with digest-unsubscribe, digest-click
// and digest-resume; without it emails carry plain links, no unsubscribe link, and a pause
// email whose only way back is opening the app),
// APP_URL (defaults to the public site).

import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { AsyncLocalStorage } from 'node:async_hooks'
import { DOMParser } from 'linkedom'
import * as app from './app.bundle.js'
import manifest from './app.bundle.manifest.js'
import { handleDigestRun } from './handler.js'
import { anthropicDispatch, anthropicTokenCounter, makeRpcLedger, resolveProviderUrl } from '../_shared/spending.js'
import { makeResendSender, digestSender, DEFAULT_APP_URL, DIGEST_REPLY_TO } from '../_shared/digestEmail.js'
import { unsubscribeUrl, resumeUrl } from '../_shared/unsubscribe.js'
import { clickUrl } from '../_shared/digestClick.js'
import { SERVER_CLIENT_TIMEOUT_MS } from '../_shared/timeouts.js'

// sources.js parses PMC and PubMed XML with the browser's DOMParser; linkedom provides the
// same surface on Deno.
;(globalThis as any).DOMParser = DOMParser

// Fail closed unless the loaded bundle was built from the source set its manifest names
// (BUNDLE_SOURCE_SHA256 is compiled into the bundle) and carries the manifest's versions
// and models. This is source-set identity checked at cold start; it does not hash the
// deployed bytes. Byte identity (manifest.bundleSha256) is checked offline and against the
// downloaded deployed function at release.
const bundleMismatch =
  app.BUNDLE_SOURCE_SHA256 !== manifest.sourceSha256 ||
  manifest.extractionVersion !== app.CURRENT_EXTRACTION_VERSION ||
  manifest.verificationVersion !== app.VERIFICATION_VERSION ||
  JSON.stringify(manifest.models) !== JSON.stringify(app.MODELS)

const scopes = new AsyncLocalStorage()
app.installServerScope(() => scopes.getStore() ?? null)

Deno.serve((req) => {
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const cronSecret = Deno.env.get('DIGEST_CRON_SECRET')
  const fail = (error: string) => new Response(JSON.stringify({ error }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  if (!anthropicKey || !supabaseUrl || !anonKey || !serviceKey) return fail('not configured')
  if (bundleMismatch) return fail('app bundle source identity or versions do not match its manifest')
  const provider = resolveProviderUrl(Deno.env.toObject())
  if (!provider.ok) return fail(provider.error || 'provider override refused')

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  // Resend is already the project's SMTP service (beta-monitor, Auth codes): its SMTP
  // password is a Resend API key, so the digest reuses it over the HTTP API unless a
  // dedicated key is set. The From defaults to the same verified sender.
  const smtpIsResend = /resend\.com$/i.test(Deno.env.get('SMTP_HOST') || '')
  const resendKey = Deno.env.get('RESEND_API_KEY') || (smtpIsResend ? Deno.env.get('SMTP_PASSWORD') || Deno.env.get('SMTP_Password') : undefined)
  const emailFrom = Deno.env.get('DIGEST_EMAIL_FROM') || (smtpIsResend ? digestSender(Deno.env.get('SMTP_FROM')) : undefined)
  const replyTo = Deno.env.get('DIGEST_EMAIL_REPLY_TO') || DIGEST_REPLY_TO
  const unsubscribeSecret = Deno.env.get('DIGEST_UNSUBSCRIBE_SECRET') || ''
  const email = resendKey && emailFrom ? {
    appUrl: Deno.env.get('APP_URL') || DEFAULT_APP_URL,
    replyTo,
    send: makeResendSender({ apiKey: resendKey, from: emailFrom, replyTo, fetch }),
    unsubscribeUrl: unsubscribeSecret ? (userId: string) => unsubscribeUrl(`${supabaseUrl}/functions/v1`, userId, unsubscribeSecret) : null,
    // Every link in the emails goes through digest-click, and the pause email's button to
    // digest-resume; both are signed with the same secret under their own prefixes.
    clickUrl: unsubscribeSecret ? (userId: string, link: { kind: string, paperId?: string, to: string }) => clickUrl(`${supabaseUrl}/functions/v1`, { userId, ...link }, unsubscribeSecret) : null,
    resumeUrl: unsubscribeSecret ? (userId: string) => resumeUrl(`${supabaseUrl}/functions/v1`, userId, unsubscribeSecret) : null,
    getAddress: async (userId: string) => {
      const { data, error } = await admin.auth.admin.getUserById(userId)
      return error ? null : data?.user?.email ?? null
    },
  } : null
  return handleDigestRun(req, {
    cronSecret,
    admin,
    email,
    app,
    ledger: makeRpcLedger(admin),
    dispatch: anthropicDispatch(anthropicKey, fetch, provider.url),
    countTokens: anthropicTokenCounter(anthropicKey, fetch, provider.url),
    // The SDK's own key header is ignored: the guarded fetch dispatches with only the
    // headers the API needs. Refusals and post-dispatch errors carry x-should-retry: false,
    // so the SDK does not stack retries on an unresolved liability. The explicit timeout
    // is longer than the boundary's provider timeout and shorter than the claim lease.
    makeClient: (fetch: typeof globalThis.fetch) => new Anthropic({ apiKey: 'sponsor-guarded', fetch, maxRetries: 2, timeout: SERVER_CLIENT_TIMEOUT_MS }),
    // Server-owned provenance stamped on every trusted cache write.
    provenance: { writer: 'digest-run', bundle_source_sha256: manifest.sourceSha256, manifest_bundle_sha256: manifest.bundleSha256 },
    runInScope: (scope: unknown, fn: () => Promise<unknown>) => scopes.run(scope, fn),
    getUser: async (authHeader: string) => {
      const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
      const { data, error } = await userClient.auth.getUser()
      return error ? null : data?.user ?? null
    },
  })
})
