import { isSignedIn } from '../lib/supabase.js'

// One source of truth for the disclosure shown wherever unpublished steering context is
// entered. Exporting the copy function keeps the signed-in/signed-out claims unit-testable
// without mounting React or mocking Supabase auth state.
export function profileStorageMessage(signedIn) {
  return signedIn
    ? 'Your steering profile and saved library are stored in your Verastar account on our servers and sync across devices. Your Anthropic and NCBI credentials remain only in this browser.'
    : 'Your steering profile and saved library stay in this browser. Your Anthropic and NCBI credentials also remain browser-only.'
}

export default function ProfileStorageDisclosure({ style = {} }) {
  return (
    <p
      role="note"
      style={{
        margin: '14px 0 0',
        borderLeft: '2px solid var(--color-registry)',
        paddingLeft: 10,
        fontSize: 12,
        lineHeight: 1.55,
        color: 'var(--color-fg-muted)',
        ...style,
      }}
    >
      <span style={{ fontWeight: 600, color: 'var(--color-registry)' }}>Storage:</span>{' '}
      {profileStorageMessage(isSignedIn())}
    </p>
  )
}
