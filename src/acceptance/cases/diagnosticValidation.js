// Category 5 of the reference — methods / diagnostic-validation paper — is UNFILLED.
// No paper in the saved Development set or the 2026-10-12 digest fixture is a methods or
// diagnostic-validation paper, and the PCB paper (cases/pcb.js) does not count as coverage.
// This file exists so the gap is visible in the suite rather than silently absent.
export default {
  id: 'C7-DIAGNOSTIC-VALIDATION',
  title: 'Methods / diagnostic-validation paper',
  missing: true,
  reason: 'No development paper of this type is available. Needs a sensitivity/specificity or model-validation paper confirmed as a development example before cases can be written.',
  // Behaviors the eventual case must cover, so they are not forgotten:
  mustCover: [
    'sensitivity and specificity bound to the named test and the named reference standard',
    'AUC/C-statistic bound to the model and the cohort (derivation vs validation) it was measured in',
    'internal vs external validation stated as reported, never inferred',
    'a "validated" claim fails unless the source reports validation in a separate cohort',
    'respectively-ordered pairs bound in order; swapped order fails',
  ],
}
