// pipeline/pdfText.js — text out of a PDF the reader hands us, in the browser.
//
// This is the "manual PDF-drop" path AddPaper deferred at the hackathon. The reader picks a
// file; pdf.js reads it locally; the text goes through the same extract → verify gate as a
// PMC body. The verdicts land on the user-text tier, because the app can prove a quote is in
// this file but cannot prove this file is the paper. Two facts recorded alongside so the
// badge stays honest later: the file's sha256 and its name.
//
// Nothing here touches the network. pdf.js and its worker are loaded lazily so the bundle
// cost lands only on readers who upload.

import { sha256Hex } from './evidenceCache.js'

const MAX_BYTES = 40 * 1024 * 1024

let _pdfjs = null
async function loadPdfjs() {
  if (_pdfjs) return _pdfjs
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  _pdfjs = pdfjs
  return pdfjs
}

// Join pdf.js text items into prose. Items carry positions; a jump in y starts a new
// line, otherwise a space separates items. Hyphenated line breaks are re-joined. Two-column
// layouts still interleave sometimes; the verifier's fuzzy locate absorbs most of that, and
// what it cannot absorb is flagged rather than guessed.
export function joinTextItems(items) {
  let out = ''
  let lastY = null
  for (const item of items) {
    const str = item?.str ?? ''
    if (!str) continue
    const y = Array.isArray(item.transform) ? item.transform[5] : null
    if (lastY != null && y != null && Math.abs(y - lastY) > 2) {
      out = out.endsWith('-') ? out.slice(0, -1) : `${out}\n`
    } else if (out && !out.endsWith('\n') && !out.endsWith(' ') && !str.startsWith(' ')) {
      out += ' '
    }
    out += str
    if (y != null) lastY = y
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// Read a File → { text, hash, fileName, pages }. Throws with a plain message the UI can show.
export async function extractPdfText(file) {
  if (!file) throw new Error('Choose a PDF first.')
  if (file.size > MAX_BYTES) throw new Error('That PDF is over 40 MB. Try a smaller file.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const hash = await sha256Hex(bytes)
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({ data: bytes }).promise
  const pageTexts = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    pageTexts.push(joinTextItems(content.items))
  }
  const text = pageTexts.join('\n\n').trim()
  if (text.length < 200) {
    throw new Error('No readable text in that PDF. A scanned image needs OCR first.')
  }
  return { text, hash, fileName: file.name, pages: doc.numPages }
}
