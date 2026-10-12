// The beta preview showed papers that are not the topic: a hand-burn flap under CLTI,
// a tinnitus guideline under vascular-surgery education, an Impella/mitral paper under
// chronic venous disease, a cardiothoracic biobank under TEVAR, an immune-thrombocytopenia
// study under VTE, and a traumatic carotid-cavernous fistula under vascular access.
// Fixtures only — PubMed is not called.

import { describe, expect, it } from 'vitest'
import { compilePubmedQuery, fitsTopic } from './pubmedQuery.js'

const CLTI = {
  label: 'Limb preservation / CLTI / Diabetic foot',
  query: 'chronic limb-threatening ischemia OR CLTI OR diabetic foot OR amputation',
}
const EDUCATION = {
  label: 'Vascular surgery education',
  query: 'vascular surgery education OR surgical education OR residency training',
}
const VENOUS = {
  label: 'Chronic venous disease',
  query: 'chronic venous insufficiency OR venous stent OR varicose veins',
}
const AORTIC = {
  label: 'TEVAR / aortic',
  query: 'aortic aneurysm OR aortic dissection OR TEVAR OR EVAR',
}
const VTE = {
  label: 'Venous thromboembolism',
  query: 'venous thromboembolism OR deep vein thrombosis OR pulmonary embolism OR VTE',
}
const ACCESS = {
  label: 'Vascular access',
  query: 'arteriovenous fistula OR dialysis access OR vascular access OR arteriovenous graft',
}

describe('compilePubmedQuery', () => {
  it('quotes each OR-clause into title/abstract and leaves acronyms as words', () => {
    expect(compilePubmedQuery(AORTIC.query)).toBe(
      '"aortic aneurysm"[tiab] OR "aortic dissection"[tiab] OR TEVAR[tiab] OR EVAR[tiab]',
    )
    expect(compilePubmedQuery(CLTI.query)).toBe(
      '"chronic limb threatening ischemia"[tiab] OR CLTI[tiab] OR "diabetic foot"[tiab] OR amputation[tiab]',
    )
  })

  it('preserves parentheses, AND, NOT, and a field tag the clinician already wrote', () => {
    expect(compilePubmedQuery('(carotid stenosis OR carotid stenting) AND stroke')).toBe(
      '("carotid stenosis"[tiab] OR "carotid stenting"[tiab]) AND stroke[tiab]',
    )
    expect(compilePubmedQuery('vascular surgery NOT animal')).toBe('"vascular surgery"[tiab] NOT animal[tiab]')
    expect(compilePubmedQuery('stroke[mh] OR carotid stenosis')).toBe('stroke[mh] OR "carotid stenosis"[tiab]')
    expect(compilePubmedQuery('"operational tolerance" OR immunosuppression withdrawal')).toBe(
      '"operational tolerance"[tiab] OR "immunosuppression withdrawal"[tiab]',
    )
  })
})

describe('fitsTopic — beta mismatches stay out', () => {
  it('does not keep a hand-burn flap just because the abstract says amputation', () => {
    expect(fitsTopic({
      ...CLTI,
      title: 'Flap Reconstruction for Deep Hand Burns: A Case Series.',
      abstract: 'Deep hand burns required flap coverage. Amputation was considered before flap coverage. Amputation was later declined.',
    })).toBe(false)
  })

  it('does not keep a tinnitus guideline that never says vascular surgery', () => {
    expect(fitsTopic({
      ...EDUCATION,
      title: 'Executive Summary of the Clinical Practice Guideline on Tinnitus Update.',
      abstract: 'Vascular causes of tinnitus are reviewed. Surgery is rarely required. Patient education is emphasized for bothersome tinnitus.',
    })).toBe(false)
  })

  it('does not keep an Impella mitral paper that splits venous and stent', () => {
    expect(fitsTopic({
      ...VENOUS,
      title: 'Temporary Left Ventricular Unloading With Impella as a Bridge to Emergency Surgery for Acute Mitral Bioprosthetic Failure.',
      abstract: 'A bioprosthetic leaflet tore away from a stent post. Central venous pressure rose and the mitral valve was replaced.',
    })).toBe(false)
  })

  it('does not keep a cardiothoracic biobank that mentions aortic dissection once', () => {
    expect(fitsTopic({
      ...AORTIC,
      title: 'Towards a regional and national cardiothoracic biobank in India: translating a Dutch model to address a poorly characterised disease burden.',
      abstract: 'Acute type A aortic dissection presents in the mid-to-late forties in Indian patients, alongside earlier coronary disease.',
    })).toBe(false)
  })

  it('does not keep an immune-thrombocytopenia study indexed only as thrombosis', () => {
    expect(fitsTopic({
      ...VTE,
      title: 'Cardiovascular and comorbid risk factors for thrombosis in primary immune thrombocytopenia: a single-center retrospective study.',
      abstract: 'Patients with immune thrombocytopenia had an increased rate of arterial and venous thrombosis. Risk factors were estimated with Cox regression.',
    })).toBe(false)
  })

  it('does not keep a traumatic carotid-cavernous fistula under vascular access', () => {
    expect(fitsTopic({
      ...ACCESS,
      title: 'Combined antegrade and retrograde transarterial approaches for embolization of a traumatic carotid-cavernous fistula with concomitant middle meningeal arteriovenous fistula.',
      abstract: 'Endovascular embolization of the traumatic carotid-cavernous fistula and the concomitant middle meningeal arteriovenous fistula is described.',
    })).toBe(false)
  })
})

describe('fitsTopic — real topic papers still qualify', () => {
  it('keeps CLTI revascularization, including a lower-limb amputation in the title', () => {
    expect(fitsTopic({
      ...CLTI,
      title: 'Outcomes of revascularization for chronic limb-threatening ischemia.',
      abstract: 'Patients with chronic limb-threatening ischemia underwent endovascular treatment.',
    })).toBe(true)
    expect(fitsTopic({
      ...CLTI,
      title: 'Functional outcomes after major lower-limb amputation.',
      abstract: 'Amputation level and prosthesis use were recorded.',
    })).toBe(true)
  })

  it('keeps a bland title when the abstract keeps returning to aortic dissection', () => {
    expect(fitsTopic({
      ...AORTIC,
      title: 'Five-year durability of a false-lumen occlusion technique.',
      abstract: 'Aortic dissection was treated with a false-lumen plug. Aortic dissection remodeling was assessed at five years. Aortic dissection mortality is reported.',
    })).toBe(true)
  })

  it('keeps thoracic endovascular aortic repair when the title carries aortic and the abstract names TEVAR', () => {
    expect(fitsTopic({
      ...AORTIC,
      title: 'Complications associated with thoracic endovascular aortic repair.',
      abstract: 'Thoracic endovascular aortic repair (TEVAR) required closer cardiac monitoring.',
    })).toBe(true)
  })

  it('keeps dialysis arteriovenous fistula work and drops only the intracranial collision', () => {
    expect(fitsTopic({
      ...ACCESS,
      title: 'Ultrasound-Guided Nerve Blocks for Arteriovenous Fistula Angioplasty.',
      abstract: 'Nerve blocks were used during arteriovenous fistula angioplasty.',
    })).toBe(true)
    expect(fitsTopic({
      ...ACCESS,
      title: 'Recurrent bloodstream infection in patients requiring long-term vascular access.',
      abstract: 'Long-term vascular access was the indication for catheter exchange.',
    })).toBe(true)
  })

  it('keeps venous stents, VTE treatment, and vascular surgery education', () => {
    expect(fitsTopic({
      ...VENOUS,
      title: 'Patency after venous stent placement for chronic venous insufficiency.',
      abstract: 'Venous stent patency was the primary endpoint.',
    })).toBe(true)
    expect(fitsTopic({
      ...VTE,
      title: 'Apixaban for acute venous thromboembolism.',
      abstract: 'Venous thromboembolism was treated with apixaban.',
    })).toBe(true)
    expect(fitsTopic({
      ...EDUCATION,
      title: 'A simulation curriculum for vascular surgery education.',
      abstract: 'Vascular surgery education used a residency simulation lab.',
    })).toBe(true)
  })
})
