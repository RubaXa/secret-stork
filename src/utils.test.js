import { describe, it, expect } from 'vitest'
import { RATINGS, RATING_COLORS, CARD_BG, clampScore, genId, shuffle, initials, spaceUrl } from './utils.js'

describe('RATINGS', () => {
  it('has 5 entries ordered score 1–5', () => {
    expect(RATINGS).toHaveLength(5)
    RATINGS.forEach((r, i) => expect(r.score).toBe(i + 1))
  })
})

describe('clampScore', () => {
  it('clamps to [1, 5]', () => {
    expect(clampScore(0)).toBe(1)
    expect(clampScore(6)).toBe(5)
    expect(clampScore(3)).toBe(3)
  })

  it('rounds fractional scores', () => {
    expect(clampScore(2.7)).toBe(3)
    expect(clampScore(4.4)).toBe(4)
  })
})

describe('genId', () => {
  it('returns a non-empty string', () => {
    expect(typeof genId()).toBe('string')
    expect(genId().length).toBeGreaterThan(4)
  })

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, genId))
    expect(ids.size).toBe(100)
  })
})

describe('shuffle', () => {
  it('returns same length array', () => {
    const arr = [1, 2, 3, 4, 5]
    expect(shuffle(arr)).toHaveLength(5)
  })

  it('does not mutate original', () => {
    const arr = [1, 2, 3]
    shuffle(arr)
    expect(arr).toEqual([1, 2, 3])
  })

  it('contains all original elements', () => {
    const arr = [1, 2, 3, 4, 5]
    expect(shuffle(arr).sort()).toEqual([1, 2, 3, 4, 5])
  })
})

describe('initials', () => {
  it('extracts up to 2 initials', () => {
    expect(initials('Иван Петров')).toBe('ИП')
    expect(initials('Анна')).toBe('А')
    expect(initials('Иван Иванович Петров')).toBe('ИИ')
  })

  it('handles falsy input', () => {
    expect(initials('')).toBe('?')
    expect(initials(null)).toBe('?')
    expect(initials(undefined)).toBe('?')
  })
})

describe('CARD_BG', () => {
  it('is a non-empty list of [color, color] pairs', () => {
    expect(CARD_BG.length).toBeGreaterThan(0)
    for (const pair of CARD_BG) {
      expect(pair).toHaveLength(2)
      expect(pair.every(c => /^#[0-9A-Fa-f]{6}$/.test(c))).toBe(true)
    }
  })
})

describe('RATING_COLORS', () => {
  it('has one color per rating score', () => {
    expect(RATING_COLORS).toHaveLength(RATINGS.length)
    expect(RATING_COLORS.every(c => /^#[0-9A-Fa-f]{6}$/.test(c))).toBe(true)
  })
})

describe('spaceUrl', () => {
  it('builds a hash deep-link and strips any existing hash', () => {
    const url = spaceUrl('abc123')
    expect(url.endsWith('#/space/abc123')).toBe(true)
    expect(url.split('#')).toHaveLength(2) // exactly one hash, old one dropped
    expect(url.startsWith(location.href.split('#')[0])).toBe(true)
  })
})
