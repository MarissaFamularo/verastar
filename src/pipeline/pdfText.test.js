import { describe, it, expect } from 'vitest'
import { joinTextItems } from './pdfText.js'

const item = (str, y) => ({ str, transform: [1, 0, 0, 1, 0, y] })

describe('joinTextItems', () => {
  it('joins items on one line with spaces and breaks lines on a y jump', () => {
    const text = joinTextItems([item('Mortality was', 700), item('10%.', 700), item('Next line', 680)])
    expect(text).toBe('Mortality was 10%.\nNext line')
  })
  it('re-joins a hyphenated line break', () => {
    const text = joinTextItems([item('amputation-', 700), item('free survival', 680)])
    expect(text).toBe('amputationfree survival')
  })
  it('skips empty items and trims', () => {
    expect(joinTextItems([item('', 700), item('  ', 700), item('x', 700)])).toBe('x')
  })
})
