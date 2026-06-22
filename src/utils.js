// @file: Shared UI constants, pure utility functions, and URL helpers.
// @consumers: VotingView.vue, AdminView.vue, HistoryView.vue, ResultsView.vue

export const CARD_BG = [
  ['#FF6B9D','#FF9A5C'],['#7B68EE','#48C0A3'],['#FFD93D','#FF9B44'],['#4FACFE','#00F2FE'],
  ['#43E97B','#38F9D7'],['#FA709A','#FEE140'],['#A18CD1','#FBC2EB'],['#F093FB','#F5576C'],
]

/** @purpose Voting rating scale: score values, display emoji, and labels. */
export const RATINGS = [
  { score: 1, emoji: '❌', label: 'Точно нет' },
  { score: 2, emoji: '👎', label: 'Скорее нет' },
  { score: 3, emoji: '😐', label: 'Нейтрально' },
  { score: 4, emoji: '👍', label: 'Нравится' },
  { score: 5, emoji: '❤️', label: 'Обожаю' },
]

/** @purpose CSS fill color per rating score (index 0 = score 1). */
export const RATING_COLORS = ['#c0392b', '#e67e22', '#9e9e9e', '#4a90e2', '#e91e63']

/**
 * @purpose Clamp and round a raw score to the valid 1–5 rating range.
 * @param {number} s Raw score.
 * @returns {number} Integer in [1, RATINGS.length].
 */
export function clampScore(s) {
  return Math.min(Math.max(Math.round(s), 1), RATINGS.length)
}

/**
 * @purpose Generate a short collision-resistant ID for new spaces.
 * @returns {string} Base-36 timestamp + 5 random chars.
 */
export function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

/**
 * @purpose Fisher-Yates in-place shuffle — returns a new array, does not mutate the original.
 * @template T
 * @param {T[]} arr Source array.
 * @returns {T[]}
 */
export function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * @purpose Build the shareable deep-link URL for a voting space.
 * @invariant Uses location.href base so the result works on both localhost and GitHub Pages.
 * @param {string} spaceId
 * @returns {string} Full hash URL, e.g. https://rubaxa.github.io/names-roulette/#/space/abc123.
 */
export function spaceUrl(spaceId) {
  return location.href.split('#')[0] + '#/space/' + spaceId
}

/**
 * @purpose Extract up to two initials from a display name.
 * @param {string|null} name Full display name or null.
 * @returns {string} 1–2 uppercase characters; '?' when name is absent.
 */
export function initials(name) {
  return (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
}
