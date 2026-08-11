// Account-entry decisions kept pure so the recovery and first-run routes cannot
// silently drift apart. Production is account-first; an unconfigured clone keeps
// Verastar's original local-only behavior, and preview/demo paths stay account-free.

export function needsExistingLibrarySync({ configured, user, profile, preview = false }) {
  return Boolean(configured && !user && !preview && profile?.onboarded && !profile?.demo)
}

export function setupStartStep({ configured, account, preview = false }) {
  return configured && !account && !preview ? 'signin' : 'connect'
}
