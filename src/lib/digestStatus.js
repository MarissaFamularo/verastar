import { digestActionResult } from '../../supabase/functions/_shared/digestAction.js'

export function renderDigestStatus(document, search) {
  const result = digestActionResult(new URLSearchParams(search).get('result'))
  document.title = `${result.title} · Verastar`
  document.getElementById('result-title').textContent = result.title
  document.getElementById('result-body').textContent = result.body
}
