// @ts-check
// Playwright E2E spec — view flows NOT covered by roulette.spec.js.
// Run: npx playwright test tests/flows.spec.js --config=playwright.config.js
// Requires: npx playwright install chromium
//
// Reuses roulette.spec.js patterns: fake user via ?e2e_user=, BASE, window.__e2e.blockSync.
// Scope = what works with fake Firebase (local IDB + rendering + navigation), NOT real cross-user sync.

const { test, expect } = require('@playwright/test')

const BASE = 'http://localhost:4173/secret-stork'

// Primary fake user (creator).
const FAKE_USER = Buffer.from(JSON.stringify({
  uid: 'e2e-flows-001',
  displayName: 'Флоу Тестовна',
  email: 'flows@e2e.local',
  photoURL: null,
})).toString('base64')

// Second fake user (different uid) — used to prove non-creators can't reach admin.
const FAKE_USER_2 = Buffer.from(JSON.stringify({
  uid: 'e2e-flows-002',
  displayName: 'Чужой Пользователь',
  email: 'flows2@e2e.local',
  photoURL: null,
})).toString('base64')

// @invariant The e2e_user param MUST be percent-encoded: base64 can contain '+', which a URL query
//   string decodes to a space → corrupts atob() in getE2EUser() → fake auth silently fails → login screen.
//   (roulette.spec.js avoids this only because its fixed user strings happen to encode without '+'/'/'.)
function appUrl(hash = '', user = FAKE_USER) {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  return `${BASE}/?e2e_user=${encodeURIComponent(user)}${h ? '#' + h : ''}`
}

async function getSpaceId(page) {
  const hash = await page.evaluate(() => location.hash)
  const m = hash.match(/\/space\/([^/]+)/)
  return m ? m[1] : null
}

// Restrict a new space to a single origin group (by chip label). The chips start ALL checked,
// so we uncheck every chip except the target → the created space has only that group's names.
// Returns { spaceId, total } after landing on the voting screen.
async function createSpaceWithOnlyGroup(page, groupLabel, title = '') {
  await page.goto(appUrl())
  await page.waitForSelector('.home-create')
  await page.locator('.home-create').click()
  await page.waitForSelector('#inp-title')
  if (title) await page.locator('#inp-title').fill(title)

  // Uncheck all chips whose label is not the target group.
  const chips = page.locator('.origin-chip')
  const count = await chips.count()
  let targetIdx = -1
  for (let i = 0; i < count; i++) {
    const txt = (await chips.nth(i).textContent()).trim()
    if (txt.startsWith(groupLabel)) { targetIdx = i; continue }
    // chips start checked → click to uncheck
    if (await chips.nth(i).locator('input').isChecked()) {
      await chips.nth(i).click()
    }
  }
  expect(targetIdx).toBeGreaterThanOrEqual(0)
  // Ensure the target chip is checked.
  if (!(await chips.nth(targetIdx).locator('input').isChecked())) {
    await chips.nth(targetIdx).click()
  }

  // The create button label reflects the active count: "Создать — N имён".
  const btnText = (await page.locator('#btn-create').textContent()).trim()
  const total = parseInt(btnText.match(/(\d+)/)?.[1] || '0', 10)
  expect(total).toBeGreaterThan(0)

  await page.locator('#btn-create').click()
  await page.waitForURL(/.*#\/space\/[a-z0-9]+$/)
  await page.evaluate(() => window.__e2e.blockSync(true))
  const spaceId = await getSpaceId(page)
  return { spaceId, total }
}

// Vote once and wait for the swipe animation (FLY_MS=420) to settle.
async function voteOnce(page, ratingIndex) {
  await page.locator('.r-btn').nth(ratingIndex).click()
  await page.waitForTimeout(500)
}

// ─── Done screen ──────────────────────────────────────────────────────────────

test.describe('Done screen', () => {
  // "Европейские" is the smallest origin group (22 names) — smallest total to vote through.
  const SMALLEST_GROUP = 'Европейские'

  test('voting through ALL names shows the done screen; creator sees organizer button', async ({ page }) => {
    const { total } = await createSpaceWithOnlyGroup(page, SMALLEST_GROUP, 'Done Screen Test')
    expect(total).toBeLessThan(60) // sanity: this really is a restricted, small space

    // Vote through every name (rating index 3 = "Нравится" score 4, instant advance).
    for (let i = 0; i < total; i++) {
      // Guard: once done fires early we stop; but we expect exactly `total` cards.
      if (await page.locator('.done-view').count()) break
      await voteOnce(page, 3)
    }

    await page.waitForSelector('.done-view', { timeout: 5000 })
    await expect(page.locator('.done-title')).toHaveText(`Вы оценили все ${total} имён!`)
    // Creator → "Панель организатора" primary button present.
    await expect(page.locator('.done-view .btn-primary')).toHaveText('Панель организатора')
    // "Посмотреть мои оценки" ghost button always present.
    await expect(page.locator('.done-view .btn-ghost')).toBeVisible()
  })
})

// ─── Swipe direction per score ─────────────────────────────────────────────────

test.describe('Swipe direction by score', () => {
  // RATINGS order in the grid: index 0..4 → scores 1..5.
  // swipeDir: score>=4 → swipe-right · score===3 → swipe-down · score 1,2 → swipe-left.
  const cases = [
    { idx: 0, dir: 'swipe-left' },  // score 1
    { idx: 1, dir: 'swipe-left' },  // score 2
    { idx: 2, dir: 'swipe-down' },  // score 3
    { idx: 3, dir: 'swipe-right' }, // score 4
    { idx: 4, dir: 'swipe-right' }, // score 5
  ]

  test('tapping a rating applies the correct swipe-* class to the flying ghost', async ({ page }) => {
    await createSpaceWithOnlyGroup(page, 'Европейские', 'Swipe Dir Test')

    for (const c of cases) {
      const progressBefore = parseInt((await page.locator('.progress-text').textContent()).split('/')[0], 10)
      // Tap the rating; the ghost overlay (.card-wrap with the swipe-* class) appears mid-animation.
      await page.locator('.r-btn').nth(c.idx).click()
      // The flyingCard ghost has zIndex 6 and one of the swipe-* classes. Assert the class is present
      // while it flies (FLY_MS=420 window).
      await expect(page.locator(`.card-deck .card-wrap.${c.dir}`)).toHaveCount(1, { timeout: 400 })
      await page.waitForTimeout(500) // let ghost unmount + stack settle
      const progressAfter = parseInt((await page.locator('.progress-text').textContent()).split('/')[0], 10)
      expect(progressAfter).toBe(progressBefore + 1) // each rating advanced progress
    }
  })
})

// ─── History ────────────────────────────────────────────────────────────────

test.describe('History', () => {
  test('empty state before any votes; counter reflects votes after', async ({ page }) => {
    const { spaceId, total } = await createSpaceWithOnlyGroup(page, 'Европейские', 'History Test')

    // Empty state: no votes yet.
    await page.goto(appUrl(`#/space/${spaceId}/history`))
    await page.waitForSelector('.inner-view')
    await expect(page.locator('.empty-text')).toHaveText('Ещё нет оценок')
    await expect(page.locator('.hist-item')).toHaveCount(0)
    await expect(page.locator('.inner-view > div').first()).toHaveText(`0 из ${total} оценено`)

    // Go back to voting and cast 2 votes.
    await page.goto(appUrl(`#/space/${spaceId}`))
    await page.waitForSelector('.card-current .card-name')
    await page.evaluate(() => window.__e2e.blockSync(true))
    await voteOnce(page, 4)
    await voteOnce(page, 0)

    // History now shows 2 items and the counter reads "2 из N оценено".
    await page.goto(appUrl(`#/space/${spaceId}/history`))
    await page.waitForSelector('.hist-item')
    await expect(page.locator('.hist-item')).toHaveCount(2)
    await expect(page.locator('.empty-text')).toHaveCount(0)
    await expect(page.locator('.inner-view > div').first()).toHaveText(`2 из ${total} оценено`)
  })
})

// ─── Home tabs ────────────────────────────────────────────────────────────────

test.describe('Home tabs', () => {
  // @invariant "Участвую" and "Мои голосования" are mutually exclusive: a space you created shows
  //   under "Мои голосования" ONLY, never doubled up under "Участвую" too (that was a real bug —
  //   participatingSpaces used to be the full unfiltered list, including your own creations).
  test('a created (owned) space shows under "Мои голосования" only, not "Участвую"; mine-card routes to /admin', async ({ page }) => {
    await page.goto(appUrl())
    await page.waitForSelector('.home-create')
    await page.locator('.home-create').click()
    await page.locator('#inp-title').fill('Home Tab Space')
    await page.locator('#btn-create').click()
    await page.waitForURL(/.*#\/space\//)
    const spaceId = await getSpaceId(page)

    // Back home, default tab is "Участвую" — the space you just CREATED must NOT be here.
    await page.goto(appUrl())
    await page.waitForSelector('.home-tabs')
    await expect(page.locator('.space-card-name', { hasText: 'Home Tab Space' })).toHaveCount(0)

    // "Мои голосования" tab: the owned space DOES show here, and a mine-card routes to /admin.
    await page.locator('.home-tab', { hasText: 'Мои голосования' }).click()
    await expect(page.locator('.space-card-name', { hasText: 'Home Tab Space' })).toBeVisible()
    await page.locator('.space-card', { hasText: 'Home Tab Space' }).first().click()
    await page.waitForURL(new RegExp(`#/space/${spaceId}/admin$`))
    await page.waitForSelector('.admin-view')

    // NOTE: "a genuinely joined-but-not-owned space routes to voting from Участвую" is not covered
    // here — this harness has no way to produce one. Joining requires either (a) the space already
    // being absent from local IDB, which is false for a second fake user sharing the same browser
    // storage as the creator, or (b) a real Firestore round-trip, which the fake E2E auth can't
    // perform (unauthenticated writes/reads are rejected by the security rules). The template's
    // routing logic for that branch (@click pushes `/space/:id`, no `/admin` suffix) is identical
    // code to the already-covered mine-card branch, just a different target — not a fix target here.
  })
})

// ─── NewSpaceView defaults ─────────────────────────────────────────────────────

test.describe('NewSpaceView', () => {
  test('empty title creates space titled «Наш список имён»; male gender button disabled', async ({ page }) => {
    await page.goto(appUrl('#/new-space'))
    await page.waitForSelector('#inp-title')

    // Male gender button is disabled ("скоро").
    await expect(page.locator('#btn-male')).toBeDisabled()
    await expect(page.locator('#btn-female')).toHaveClass(/active/)

    // Leave title empty → create.
    await page.locator('#btn-create').click()
    await page.waitForURL(/.*#\/space\//)
    const spaceId = await getSpaceId(page)

    // The VotingView NavBar title reflects the persisted space title → assert it is the default.
    await page.waitForSelector('.voting-view, .done-view')
    await expect(page.locator('.nav-title')).toHaveText('Наш список имён')
  })
})

// ─── Admin access control ──────────────────────────────────────────────────────

test.describe('Admin access control', () => {
  test('non-creator hitting /admin is redirected home (no access)', async ({ page }) => {
    // Creator makes a space.
    await page.goto(appUrl())
    await page.waitForSelector('.home-create')
    await page.locator('.home-create').click()
    await page.locator('#inp-title').fill('Admin Guard Space')
    await page.locator('#btn-create').click()
    await page.waitForURL(/.*#\/space\//)
    const spaceId = await getSpaceId(page)

    // The space lives in shared IDB. Open it as user 2 first (so their IDB copy exists via join),
    // then user 2 attempts the admin route → creatorUid !== uid → redirect to '/'.
    await page.goto(`${BASE}/?e2e_user=${encodeURIComponent(FAKE_USER_2)}#/space/${spaceId}`)
    await page.waitForSelector('.voting-view, .done-view')

    await page.goto(`${BASE}/?e2e_user=${encodeURIComponent(FAKE_USER_2)}#/space/${spaceId}/admin`)
    // AdminView.onMounted redirects non-creators to '/'. Wait for the home create button.
    await page.waitForSelector('.home-create', { timeout: 5000 })
    const hash = await page.evaluate(() => location.hash)
    expect(hash === '' || hash === '#/' || hash === '#').toBeTruthy()
    await expect(page.locator('.admin-view')).toHaveCount(0)
  })
})

// ─── Results redirect ───────────────────────────────────────────────────────────

test.describe('Results redirect', () => {
  test('opening /results for a non-closed space redirects to voting (toast)', async ({ page }) => {
    // Create an active (non-closed) space.
    await page.goto(appUrl())
    await page.waitForSelector('.home-create')
    await page.locator('.home-create').click()
    await page.locator('#inp-title').fill('Results Guard Space')
    await page.locator('#btn-create').click()
    await page.waitForURL(/.*#\/space\//)
    const spaceId = await getSpaceId(page)

    // Hit results directly — space.status !== 'closed' → toast + replace back to /space/:id.
    await page.goto(appUrl(`#/space/${spaceId}/results`))
    await page.waitForURL(new RegExp(`#/space/${spaceId}$`), { timeout: 5000 })
    await expect(page.locator('.results-view')).toHaveCount(0)
    await expect(page.locator('.voting-view, .done-view')).toHaveCount(1)
  })
})
