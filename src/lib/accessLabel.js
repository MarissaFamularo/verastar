// lib/accessLabel.js — the status word beside a saved personal Anthropic key.
//
// Active sponsorship wins over a saved key (lib/anthropic.js accessMode), so while it is on
// the key is stored but not used. Calling it "Active" then misleads the reader about which
// lane pays for her reading. Pure.
export function savedKeyLabel({ sponsored = false, remembered = false } = {}) {
  if (sponsored) return remembered ? 'Saved · remembered · not in use' : 'Saved · not in use'
  return remembered ? 'Active · remembered' : 'Active'
}
