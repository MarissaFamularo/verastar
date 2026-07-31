// A read-only first impression for demo mode.
//
// This is deliberately separate from IndexedDB, Supabase, and the on-disk Verastar
// Library. It contains public publication metadata and generalized editorial copy only:
// no user profile, private projects, saved-paper state, notes, or personal rankings.

const papers = [
  {
    id: 'demo-42276369',
    pmid: '42276369',
    title: 'Progression from Minor to Major Amputation in Patients with Diabetes and Peripheral Arterial Disease: Risk Factors and Clinical Trajectories.',
    author: 'Hinojosa CA et al.',
    journal: 'Ann Vasc Surg',
    year: '2026',
    design: 'retrospective_cohort',
    score: 94,
    tier: 3,
    finding: 'Progression from minor to major amputation was common in this diabetic peripheral artery disease cohort, with chronic limb-threatening ischemia among the strongest risk markers.',
    relevance: 'A strong sample match for a limb-preservation and diabetic-foot evidence stream.',
  },
  {
    id: 'demo-42439053',
    pmid: '42439053',
    title: 'Modern Management of Asymptomatic Carotid Stenosis: A Meta-Analysis of CREST-2, SPACE-2, and ECST-2.',
    author: 'Ali A et al.',
    journal: 'Ann Clin Transl Neurol',
    year: '2026',
    design: 'meta_analysis',
    score: 91,
    tier: 3,
    finding: 'Across contemporary trials, adding revascularization to medical therapy did not clearly reduce long-term ipsilateral stroke in the primary pooled analysis, while sensitivity analyses produced a different signal.',
    relevance: 'A strong sample match for contemporary carotid decision-making and trial interpretation.',
  },
  {
    id: 'demo-42248487',
    pmid: '42248487',
    title: 'Failed endovascular intervention before open bypass does not worsen outcomes for chronic limb-threatening ischemia.',
    author: 'Kawaji Q et al.',
    journal: 'J Vasc Surg',
    year: '2026',
    design: 'retrospective_cohort',
    score: 88,
    tier: 3,
    finding: 'Prior failed endovascular intervention was not associated with worse subsequent open-bypass outcomes in patients with chronic limb-threatening ischemia.',
    relevance: 'A practical sample match for revascularization sequencing in limb preservation.',
  },
  {
    id: 'demo-42174809',
    pmid: '42174809',
    title: 'Data Integrity in Medical AI.',
    author: 'Lhotska L',
    journal: 'Stud Health Technol Inform',
    year: '2026',
    design: 'other',
    score: 77,
    tier: 3,
    finding: 'This conceptual report describes how poor data quality, bias, and noise can undermine the reliability of medical AI systems.',
    relevance: 'A useful sample background read for safe and trustworthy clinical AI.',
  },
  {
    id: 'demo-42403728',
    pmid: '42403728',
    title: 'From Clinical Encounter to Draft Documentation: A Mechanistic Narrative Review of Ambient Scribe Technology.',
    author: 'Kuhn TW',
    journal: 'Cureus',
    year: '2026',
    design: 'other',
    score: 71,
    tier: 3,
    finding: 'This narrative review maps the stages by which ambient scribe systems turn clinical conversations into draft documentation.',
    relevance: 'A sample horizon-scan item for clinical workflow and applied AI.',
  },
]

export const DEMO_DIGEST = Object.freeze({
  results: papers.map((paper) => ({
    paper: {
      id: paper.id,
      pmid: paper.pmid,
      pmcid: null,
      nct: null,
      title: paper.title,
    },
    citation: {
      pmid: paper.pmid,
      url: `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`,
      author: paper.author,
      journal: paper.journal,
      year: paper.year,
      title: paper.title,
      verified: true,
    },
    source: { pmcid: null },
    sourceDoc: { text: '', tables: '' },
    design: paper.design,
    rows: [],
    oa: null,
  })),
  triaged: Object.fromEntries(
    papers.map((paper) => [
      paper.id,
      {
        score: paper.score,
        tier: paper.tier,
        finding: paper.finding,
        relevance: paper.relevance,
      },
    ]),
  ),
})

export const DEMO_DIGEST_COUNTS = Object.freeze({
  verified: papers.length,
  saved: 0,
  flagged: 0,
})
