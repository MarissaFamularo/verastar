import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ user: { id: 'reader-1' }, insert: vi.fn() }))
vi.mock('./supabase.js', () => ({
  supabaseConfigured: true,
  isSignedIn: () => !!mocks.user,
  currentUser: () => mocks.user,
  supabase: { from: () => ({ insert: mocks.insert }) },
}))
import { logEvent } from './events.js'
import { sharePaper } from '../components/SharePaperButton.jsx'
beforeEach(() => {
  mocks.user = { id: 'reader-1' }
  mocks.insert.mockReset().mockResolvedValue({ error: null })
})
it('attributes share clicks to the current authenticated account only', async () => {
  const paper = { title: 'Private title', recipient: 'private@example.org', user_id: 'spoofed' }
  await sharePaper(paper, { navigatorObject: {}, locationObject: { href: '' } })
  expect(mocks.insert).toHaveBeenLastCalledWith({ user_id: 'reader-1', type: 'paper_share_clicked', payload: { surface: 'library' } })
  mocks.user = { id: 'reader-2' }
  await sharePaper(paper, { navigatorObject: {}, locationObject: { href: '' } })
  expect(mocks.insert).toHaveBeenLastCalledWith({ user_id: 'reader-2', type: 'paper_share_clicked', payload: { surface: 'library' } })
})
it('does not record signed-out clicks', async () => {
  mocks.user = null
  await logEvent('paper_share_clicked', { surface: 'digest' })
  expect(mocks.insert).not.toHaveBeenCalled()
})
it.each(['reject', 'throw'])('keeps sharing working when telemetry fails: %s', async (mode) => {
  if (mode === 'reject') mocks.insert.mockRejectedValue(new Error('offline'))
  else mocks.insert.mockImplementation(() => { throw new Error('offline') })
  const share = vi.fn().mockResolvedValue()
  await expect(sharePaper({}, { navigatorObject: { share } })).resolves.toBe('native')
  expect(share).toHaveBeenCalledTimes(1)
})
