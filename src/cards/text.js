// cards/text.js — shared text helpers for the replacement card system. Pure.
//
// Normalization and number tokenization are reused from pipeline/verify.js on purpose: they
// are correct and tested (NFKC, dash and interpunct folding, thousands separators,
// representation-equal comparison). Nothing else from the legacy verifier is imported.

import { normalize, extractNumbersWithIndex, numbersEqual } from '../pipeline/verify.js'

export { normalize, extractNumbersWithIndex, numbersEqual }

const STOP = new Set(('a an the of in on at to for from by with and or vs versus than as is was were are be been ' +
  'had has have did do does not no any all both each per who whom which that this these those it its their there ' +
  'first second initial strategy group groups patients participants people subjects after over within during ' +
  'between among compared comparing rate rates risk event events outcome outcomes primary secondary co-primary ' +
  'median mean years year months month weeks week days day up more most less least also only into out').split(' '))

// Canonical spellings so an outcome named two ways compares as one: death from any cause /
// all-cause mortality / died → death.
const CANON = [[/\bdeath from any cause\b|\ball-cause (?:death|mortality)\b|\bany-cause mortality\b|\boverall mortality\b|\bmortality\b|\bdied\b|\bdeaths\b/g, 'death']]
export function canonical(s) {
  let n = normalize(s)
  for (const [re, to] of CANON) n = n.replace(re, to)
  return n
}

// Content tokens: lowercase, alphanumeric, plural-insensitive, stopwords removed.
export function tokens(s) {
  return canonical(s)
    .replace(/[^a-z0-9%]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOP.has(w) && !/^\d+(\.\d+)?%?$/.test(w))
    .map(singular)
}
export function singular(w) {
  if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y'
  if (w.length > 3 && /[^s]s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1)
  return w
}
export const tokenSet = (s) => new Set(tokens(s))
export const overlap = (a, b) => [...a].filter((t) => b.has(t))
export const hasAny = (text, set) => tokens(text).some((t) => set.has(t))

// Acronyms of every 2–5 word window of a phrase ("major adverse limb event" → "male"), so a
// claim written with the abbreviation binds to a definition written in full.
const ARTICLES = new Set(['a', 'an', 'the'])
const BREAKERS = new Set(['of', 'in', 'for', 'to', 'from', 'by', 'with', 'or', 'and', 'which', 'was', 'were', 'as', 'any', 'above', 'at', 'on', 'that', 'defined'])
export function acronyms(phrase) {
  const out = new Set()
  for (const segment of normalize(phrase).split(/[,;:()[\]-]+/)) {
    const words = segment.replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter((w) => w && !ARTICLES.has(w))
    for (let n = 3; n <= 5; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const win = words.slice(i, i + n)
        if (win.some((w) => BREAKERS.has(w))) continue
        out.add(win.map((w) => w[0]).join(''))
      }
    }
  }
  return out
}

export const fmtNum = (n) => (Number.isInteger(n) && Math.abs(n) >= 1000 ? n.toLocaleString('en-US') : String(n))
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)
