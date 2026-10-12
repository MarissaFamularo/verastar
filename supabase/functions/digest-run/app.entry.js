// Entry for the bundled app modules used by digest-run/index.ts. See scripts/bundle-functions.mjs.
// The scheduler binds each account through installServerScope (a request scope), never
// through process-wide setters, so the old configureServer* exports are not bundled.
export { installServerScope } from '../../../src/lib/serverScope.js'
export { makeSupabaseStore } from '../../../src/lib/storeSupabase.js'
export { schedulerMayRun } from '../../../src/lib/digestStore.js'
export { runDailyDigest } from '../../../src/pipeline/dailyDigest.js'
export { MODELS } from '../../../src/lib/anthropic.js'
export { CURRENT_EXTRACTION_VERSION, VERIFICATION_VERSION } from '../../../src/lib/evidenceVersion.js'
// The combined sha256 of this bundle's source files, compiled in by the bundler (define),
// so the running function can prove which source set it was built from.
/* global __VERASTAR_BUNDLE_SOURCE_SHA256__ */
export const BUNDLE_SOURCE_SHA256 = __VERASTAR_BUNDLE_SOURCE_SHA256__
