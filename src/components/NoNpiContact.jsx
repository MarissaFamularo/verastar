// components/NoNpiContact.jsx — the way in for people without a US NPI (international
// clinicians, researchers): email for an invite code that skips the NPI step.

import { NO_NPI_MAILTO, BETA_CONTACT_EMAIL } from '../lib/inviteCode.js'

export default function NoNpiContact({ small = false }) {
  return (
    <p style={{ margin: small ? '8px 0 0' : '12px 0 0', fontSize: small ? 11.5 : 13, lineHeight: 1.5, color: 'var(--color-fg-faint)' }}>
      Outside the US or no NPI?{' '}
      <a href={NO_NPI_MAILTO} style={{ color: 'var(--color-accent)' }}>Email {BETA_CONTACT_EMAIL}</a>{' '}
      for an invite code.
    </p>
  )
}
