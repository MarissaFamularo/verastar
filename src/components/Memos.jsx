// components/Memos.jsx — the Memos surface: quick text capture. Voice-first by intent — on a
// phone the composer is where the iOS keyboard mic dictates, so the surface builds nothing
// special for voice: a textarea, a Save, a list. Memos sync through the store like every other
// collection (phone → account → desktop), and the vault drain lands them in memos/ as markdown —
// the save path below also writes immediately when this device has the folder connected.

import { useEffect, useState } from 'react'
import { store } from '../lib/store.js'
import { isSignedIn } from '../lib/supabase.js'
import { useWindowFocusRefresh } from '../lib/focusRefresh.js'
import { writeMemoToLibrary } from '../lib/library.js'

// Newest first by last-touched moment — an edited memo surfaces back to the top.
function sortMemos(list) {
  return [...(list || [])].sort((a, b) =>
    (a?.updatedAt || a?.createdAt || '') < (b?.updatedAt || b?.createdAt || '') ? 1 : -1,
  )
}

// "Jul 26" — year only when it isn't this year. Deliberately no relative-time library.
function dayLabel(iso) {
  const d = new Date(iso || '')
  if (isNaN(d.getTime())) return ''
  const opts = { month: 'short', day: 'numeric' }
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric'
  return d.toLocaleDateString('en-US', opts)
}

export default function Memos() {
  const [memos, setMemos] = useState([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editText, setEditText] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  async function refresh() {
    setMemos(sortMemos(await store.all('memos')))
  }

  useEffect(() => {
    refresh().catch(() => {}).finally(() => setLoading(false))
  }, [])

  // Signed in, the phone may have dictated memos while this tab was backgrounded — pull fresh
  // data on focus. Skipped mid-edit so the open editor can't have its record swapped under it.
  useWindowFocusRefresh(() => {
    if (isSignedIn() && editingId === null) refresh().catch(() => {})
  })

  async function save() {
    const text = draft.trim()
    if (!text || saving) return
    setSaving(true)
    try {
      const createdAt = new Date().toISOString()
      const memo = { id: `memo:${createdAt}`, text, createdAt }
      await store.put('memos', memo.id, memo)
      setDraft('')
      setMemos((prev) => sortMemos([memo, ...prev]))
      // Folder connected on this device → the file lands now (and the record gets its
      // vaultWrittenAt stamp). Disconnected/phone → the desktop drain picks it up.
      writeMemoToLibrary(memo).catch(() => {})
    } finally {
      setSaving(false)
    }
  }

  function startEdit(memo) {
    setConfirmDeleteId(null)
    setEditingId(memo.id)
    setEditText(memo.text || '')
  }

  async function saveEdit(id) {
    const text = editText.trim()
    // Re-read the live record so an edit never clobbers a vaultWrittenAt stamp (or a
    // cloud-side change) that landed while the editor was open.
    const current = await store.get('memos', id)
    if (!current || !text) return
    const next = { ...current, text, updatedAt: new Date().toISOString() }
    await store.put('memos', id, next)
    setMemos((prev) => sortMemos(prev.map((m) => (m.id === id ? next : m))))
    setEditingId(null)
    setEditText('')
    writeMemoToLibrary(next).catch(() => {})
  }

  // The app-side record goes; the vault file stays — the folder is append-only memory,
  // same contract as papers (stated in Settings' erase copy too).
  async function remove(id) {
    await store.delete('memos', id)
    setMemos((prev) => prev.filter((m) => m.id !== id))
    setConfirmDeleteId(null)
  }

  const inputStyle = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '12px 14px',
    borderRadius: 11,
    border: '1px solid rgba(255,255,255,.1)',
    background: 'var(--surface-input)',
    color: 'var(--color-fg)',
    fontSize: 16, // iOS zooms focused fields under 16px — keep the composer at 16
    lineHeight: 1.5,
    fontFamily: 'inherit',
    outline: 'none',
    resize: 'vertical',
    minHeight: 76, // ~3 lines
  }
  const smallBtn = (primary) => ({
    padding: '6px 13px',
    border: primary ? 0 : '1px solid rgba(255,255,255,.14)',
    borderRadius: 9,
    background: primary ? 'var(--color-accent)' : 'transparent',
    color: primary ? '#1c1206' : 'var(--color-fg-soft)',
    fontSize: 12.5,
    fontWeight: primary ? 600 : 500,
    fontFamily: 'inherit',
  })

  return (
    <div className="vs-page-pad" style={{ maxWidth: 720, padding: '46px 56px 64px' }}>
      <p style={{ margin: 0, fontSize: 12, letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Quick capture</p>
      <h1 style={{ margin: '9px 0 0', fontFamily: 'var(--font-serif)', fontSize: 34, fontWeight: 500, letterSpacing: '-.01em', color: 'var(--color-fg)' }}>Memos</h1>
      <p style={{ margin: '12px 0 0', fontSize: 15, color: 'var(--color-fg-dim)', maxWidth: 560, lineHeight: 1.55 }}>
        Thoughts you don't want to lose. They follow you across devices, and your desktop files
        them into your folder as plain markdown.
      </p>

      {/* composer */}
      <div style={{ marginTop: 28 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Capture a thought — on your phone, tap the mic and just talk."
          style={inputStyle}
        />
        <div className="flex" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={save}
            disabled={!draft.trim() || saving}
            className="cursor-pointer"
            style={{ padding: '9px 20px', border: 0, borderRadius: 10, background: 'var(--color-accent)', color: '#1c1206', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', opacity: !draft.trim() || saving ? 0.45 : 1 }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* list */}
      {!loading && memos.length === 0 && (
        <p style={{ margin: '34px 0 0', fontSize: 14, color: 'var(--color-fg-muted)', lineHeight: 1.55 }}>
          Nothing captured yet — memos are for the thought that arrives between patients, before it slips away.
        </p>
      )}
      <div className="flex flex-col" style={{ marginTop: 30, gap: 14 }}>
        {memos.map((memo) => (
          <div key={memo.id} style={{ padding: '16px 18px', borderRadius: 13, background: 'var(--surface-1)', border: '1px solid var(--hairline)' }}>
            <div className="flex items-center" style={{ gap: 10 }}>
              <span style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', letterSpacing: '.06em', color: 'var(--color-fg-faint)' }}>
                {dayLabel(memo.createdAt)}
                {memo.updatedAt && ` · edited ${dayLabel(memo.updatedAt)}`}
              </span>
              {editingId !== memo.id && (
                <span className="flex items-center" style={{ marginLeft: 'auto', gap: 10, fontSize: 12 }}>
                  {confirmDeleteId === memo.id ? (
                    <>
                      <span style={{ color: 'var(--color-fg-muted)' }}>Delete?</span>
                      <button onClick={() => remove(memo.id)} className="cursor-pointer" style={{ border: 0, background: 'transparent', padding: 0, color: '#f0a9a4', fontWeight: 600, fontFamily: 'inherit', fontSize: 12 }}>yes</button>
                      <button onClick={() => setConfirmDeleteId(null)} className="cursor-pointer" style={{ border: 0, background: 'transparent', padding: 0, color: 'var(--color-fg-muted)', fontFamily: 'inherit', fontSize: 12 }}>cancel</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => startEdit(memo)} className="cursor-pointer" style={{ border: 0, background: 'transparent', padding: 0, color: 'var(--color-fg-muted)', fontFamily: 'inherit', fontSize: 12 }}>Edit</button>
                      <button onClick={() => setConfirmDeleteId(memo.id)} className="cursor-pointer" style={{ border: 0, background: 'transparent', padding: 0, color: 'var(--color-fg-muted)', fontFamily: 'inherit', fontSize: 12 }}>Delete</button>
                    </>
                  )}
                </span>
              )}
            </div>
            {editingId === memo.id ? (
              <div style={{ marginTop: 10 }}>
                <textarea value={editText} onChange={(e) => setEditText(e.target.value)} style={inputStyle} />
                <div className="flex" style={{ marginTop: 8, gap: 8, justifyContent: 'flex-end' }}>
                  <button onClick={() => { setEditingId(null); setEditText('') }} className="cursor-pointer" style={smallBtn(false)}>Cancel</button>
                  <button onClick={() => saveEdit(memo.id)} disabled={!editText.trim()} className="cursor-pointer" style={{ ...smallBtn(true), opacity: editText.trim() ? 1 : 0.45 }}>Save</button>
                </div>
              </div>
            ) : (
              <p style={{ margin: '9px 0 0', fontFamily: 'var(--font-serif)', fontSize: 15.5, lineHeight: 1.6, color: 'var(--color-fg-soft)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
                {memo.text}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
