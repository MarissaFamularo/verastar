// Account & sync — magic-link sign-in (no passwords). Renders nothing when
// Supabase env isn't configured, so a cloned repo without keys keeps the
// original local-only app. A signed-in reader who is not yet sponsored can
// enter a beta invite code here.

import { EmailCodeStatus } from './GmailAliasNotice.jsx'
import InviteCode from './InviteCode.jsx'
import { useEmailCodeSignIn } from '../lib/emailCode.js'
import { signOut, supabaseConfigured } from '../lib/supabase.js'

export default function AccountSection({ account, first = false, onEnrolled }) {
  const form = useEmailCodeSignIn()
  if (!supabaseConfigured) return null

  return (
    <>
      {!first && <div style={{ height: 1, background: 'var(--hairline)', margin: '26px 0' }} />}
      <p style={{ margin: '0 0 14px', fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Account &amp; sync</p>
      {account ? (
        <>
          <div className="flex items-center" style={{ gap: 10, padding: '10px 13px', borderRadius: 10, background: 'var(--surface-1)', border: '1px solid rgba(255,255,255,.08)' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-verified)', boxShadow: '0 0 7px var(--color-verified)' }} />
            <span style={{ color: 'var(--color-fg-soft)', fontSize: 13 }}>{account.email}</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-verified-soft)', fontWeight: 600 }}>Signed in</span>
          </div>
          <p style={{ margin: '12px 0 0', fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-fg-muted)' }}>
            Your library lives in your account so it works on every device — and you always hold
            your own copy on disk, in plain files any agent can read. Your API key and your disk
            folder stay on this device, never in your account.
          </p>
          <InviteCode inputId="beta-invite-code" onEnrolled={onEnrolled} />
          <button
            onClick={async () => { await signOut(); window.location.reload() }}
            className="cursor-pointer"
            style={{ marginTop: 12, padding: '9px 15px', border: '1px solid rgba(255,255,255,.14)', borderRadius: 10, background: 'transparent', color: 'var(--color-fg-soft)', fontSize: 13, fontWeight: 500, fontFamily: 'inherit' }}
          >
            Sign out
          </button>
        </>
      ) : (
        <>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-fg-muted)' }}>
            Sign in and your library follows you — we keep it so it works on every device, and you
            always hold your own copy on disk, in plain files any agent can read. Your API key
            stays on this device, never in your account.
          </p>
          {form.sendState === 'sent' ? (
            <>
              <EmailCodeStatus
                compact
                email={form.email.trim()}
                aliasNote={form.aliasNote}
                busy={form.resending}
                onSeparate={form.sendSeparate}
              />
              <form onSubmit={form.verify} style={{ marginTop: 10 }}>
                <label htmlFor="settings-email-code" style={{ display: 'block', marginBottom: 6, fontSize: 13, color: '#aab0be', fontWeight: 500 }}>6-digit code</label>
                <div className="flex" style={{ gap: 9 }}>
                  <input
                    id="settings-email-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={form.code}
                    onChange={(e) => form.setCode(e.target.value)}
                    placeholder="123456"
                    aria-invalid={form.verifyState === 'error'}
                    style={{ flex: 1, padding: '10px 13px', borderRadius: 10, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', color: 'var(--color-fg)', fontSize: 14, fontFamily: 'inherit', outline: 'none', letterSpacing: '.14em' }}
                  />
                  <button type="submit" disabled={form.verifyBusy} className="cursor-pointer" style={{ padding: '9px 15px', border: 0, borderRadius: 10, background: 'var(--color-accent)', color: '#1c1206', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', opacity: form.verifyBusy ? 0.6 : 1 }}>
                    {form.verifyBusy ? 'Checking…' : 'Continue'}
                  </button>
                </div>
              </form>
              {form.verifyState === 'error' && (
                <div role="alert" style={{ marginTop: 10, padding: '10px 13px', borderRadius: 10, background: 'rgba(224,96,90,.12)', color: '#f0a9a4', fontSize: 13, lineHeight: 1.5 }}>
                  {form.verifyError}
                </div>
              )}
              {form.resendNote && <p role="status" style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--color-verified-soft)' }}>{form.resendNote}</p>}
              <button type="button" onClick={form.resend} disabled={form.resending} className="cursor-pointer" style={{ marginTop: 10, border: 0, background: 'transparent', padding: 0, color: 'var(--color-accent)', fontSize: 13, fontFamily: 'inherit' }}>
                {form.resending ? 'Sending…' : 'Send a new code'}
              </button>
            </>
          ) : (
            <form onSubmit={form.send}>
              <label htmlFor="settings-account-email" style={{ display: 'block', marginBottom: 6, fontSize: 13, color: '#aab0be', fontWeight: 500 }}>Account email</label>
              <div className="flex" style={{ gap: 9 }}>
                <input
                  id="settings-account-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => form.setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  style={{ flex: 1, padding: '10px 13px', borderRadius: 10, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', color: 'var(--color-fg)', fontSize: 14, fontFamily: 'inherit', outline: 'none' }}
                />
                <button type="submit" disabled={form.sendBusy} className="cursor-pointer" style={{ padding: '9px 15px', border: 0, borderRadius: 10, background: 'var(--color-accent)', color: '#1c1206', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', opacity: form.sendBusy ? 0.6 : 1 }}>
                  {form.sendBusy ? 'Sending…' : 'Email me a code'}
                </button>
              </div>
            </form>
          )}
          {form.sendState === 'error' && (
            <div role="alert" style={{ marginTop: 10, padding: '10px 13px', borderRadius: 10, background: 'rgba(224,96,90,.12)', color: '#f0a9a4', fontSize: 13, lineHeight: 1.5 }}>
              <span style={{ fontWeight: 600 }}>Couldn&rsquo;t send the code:</span> {form.sendError}
            </div>
          )}
          <p style={{ margin: '10px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--color-fg-faint)' }}>
            Signing in stores your steering profile, literature library, and usage events on our servers —
            never patient data, and never sold. You always hold your own flat-file copy
            on disk. Usage data may be analyzed, in aggregate, for research.
          </p>
        </>
      )}
    </>
  )
}
