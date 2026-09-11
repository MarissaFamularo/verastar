// Identical synthetic relationship fixtures are maintained in both applications.
// No paper processing or network is involved.
const source = 'Mortality was 10% in Treatment A and 20% in Treatment B.'
const quantity = { name: 'Mortality', quantity_type: 'comparison', value: null, first_label: 'Treatment A', first_value: 10, second_label: 'Treatment B', second_value: 20, unit: '%', source_quote: source }
export const relationshipCases = [
  { label: 'correct arm binding', source, quantity, validated: true },
  { label: 'swapped arms', source, quantity: { ...quantity, first_value: 20, second_value: 10 }, validated: false },
  { label: 'wrong endpoint with duplicate values', source: source + ' Stroke was 10% in Treatment A and 20% in Treatment B.', quantity: { ...quantity, name: 'Stroke' }, validated: false },
  { label: 'wrong timepoint', source, quantity: { ...quantity, name: '30-day mortality' }, validated: false },
  { label: 'wrong units', source, quantity: { ...quantity, unit: 'mg' }, validated: false },
  { label: 'ambiguous flattened table', source: { tables: source }, quantity, validated: false },
  { label: 'duplicate identical sentence', source: source + ' ' + source, quantity, validated: false },
  { label: 'incomplete coverage', source, quantity: { ...quantity, second_value: 30 }, validated: false },
  { label: 'incomplete quote', source: 'At 30 days, ' + source, quantity, validated: false },
  { label: 'correct scalar', source: 'Mortality was 10%.', quantity: { name: 'Mortality', quantity_type: 'single', value: 10, unit: '%', source_quote: 'Mortality was 10%.' }, validated: true },
  { label: 'correct range', source: 'Mortality ranged from 10% to 20%.', quantity: { name: 'Mortality', quantity_type: 'range', range_low: 10, range_high: 20, unit: '%', source_quote: 'Mortality ranged from 10% to 20%.' }, validated: true },
  { label: 'correct directional change', source: 'Mortality decreased from 20% to 10%.', quantity: { name: 'Mortality', quantity_type: 'change', first_value: 20, second_value: 10, unit: '%', source_quote: 'Mortality decreased from 20% to 10%.' }, validated: true },
  { label: 'reversed directional change', source: 'Mortality decreased from 20% to 10%.', quantity: { name: 'Mortality', quantity_type: 'change', first_value: 10, second_value: 20, unit: '%', source_quote: 'Mortality decreased from 20% to 10%.' }, validated: false },
  { label: 'same values different statistical roles', source: 'Mortality was 10% (95% CI 5-20%).', quantity: { name: 'Mortality', quantity_type: 'single', value: 20, ci_low: 5, ci_high: 10, unit: '%', source_quote: 'Mortality was 10% (95% CI 5-20%).' }, validated: false },
]
