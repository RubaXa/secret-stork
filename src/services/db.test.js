// @file: Unit tests for the IndexedDB access layer (services/db.js).
// @purpose Lock the behavioral invariants of the local persistence layer, especially the
//   uid-scoping of votes (v4 migration) which prevents two accounts on one device from
//   sharing votes.
//
// Test isolation strategy:
//   - `import 'fake-indexeddb/auto'` installs a real IndexedDB implementation into globalThis,
//     so we exercise genuine IDB semantics (indexes, key paths, upgrade transactions).
//   - db.js caches the opened DB in a module-level `_db` singleton. To get a clean DB per test
//     we (a) delete the physical 'names-roulette' database and (b) `vi.resetModules()` + re-import
//     db.js so the cached `_db` is discarded. A small `loadDb()` helper does both re-import steps.

import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const DB_NAME = 'names-roulette'

// The module loaded for the current test. db.js caches its connection in a
// module-level `_db` and never closes it; an open connection makes
// indexedDB.deleteDatabase() block (onblocked) forever, so afterEach must close
// the singleton before deleting. Because db.js's helpers all funnel through the
// same getDB() singleton, calling module.getDB() in teardown returns that exact
// connection so we can close it.
let currentMod = null

/**
 * Delete the physical DB and force db.js to rebuild its `_db` singleton by
 * resetting the module registry and dynamically re-importing it.
 * @returns {Promise<typeof import('./db.js')>}
 */
async function loadDb() {
  vi.resetModules()
  currentMod = await import('./db.js')
  return currentMod
}

/** Promise-wrap indexedDB.deleteDatabase. */
function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
}

beforeEach(async () => {
  currentMod = null
  await deleteDatabase(DB_NAME)
})

afterEach(async () => {
  // Close the connection db.js cached (if any test opened one) so the delete
  // below is not blocked by an open handle.
  if (currentMod) {
    try {
      const db = await currentMod.getDB()
      db.close()
    } catch (_) { /* module errored or never opened — nothing to close */ }
  }
  currentMod = null
  vi.resetModules()
  await deleteDatabase(DB_NAME)
})

describe('getDB', () => {
  it('opens the names-roulette database at version 4 with all four stores', async () => {
    const { getDB } = await loadDb()
    const db = await getDB()
    expect(db.name).toBe(DB_NAME)
    expect(db.version).toBe(4)
    const stores = Array.from(db.objectStoreNames).sort()
    expect(stores).toEqual(['names', 'outbox', 'spaces', 'votes'])
  })

  it('creates the votes.bySpace index and the autoincrement outbox store', async () => {
    const { getDB } = await loadDb()
    const db = await getDB()
    const votesIdx = db.transaction('votes').store.indexNames
    expect(Array.from(votesIdx)).toContain('bySpace')
    // outbox uses autoIncrement keys (no keyPath) — add() should assign ids.
    const id1 = await db.add('outbox', { type: 'x' })
    const id2 = await db.add('outbox', { type: 'y' })
    expect(id2).toBeGreaterThan(id1)
  })

  it('returns the same singleton instance across calls', async () => {
    const { getDB } = await loadDb()
    const a = await getDB()
    const b = await getDB()
    expect(a).toBe(b)
  })

  // NOTE ON THE SINGLETON: db.js's JSDoc claims "parallel calls before first
  // resolve share the same Promise via _db assignment", but the code assigns
  // `_db = await openDB(...)` — i.e. `_db` only holds the *resolved* connection,
  // not the in-flight Promise. So two truly-parallel first calls each see `_db`
  // undefined and each open a separate connection. This test documents that
  // ACTUAL behavior (two distinct connections) rather than the aspirational
  // doc. The freeze rule forbids fixing db.js; if the singleton is later made
  // Promise-based, flip this to `toBe`.
  it('opens two separate connections for truly-parallel first calls (documents current behavior; not the promise-dedup the JSDoc implies)', async () => {
    const { getDB } = await loadDb()
    const [a, b] = await Promise.all([getDB(), getDB()])
    // Both are usable connections to the same database...
    expect(a.name).toBe(DB_NAME)
    expect(b.name).toBe(DB_NAME)
    // ...but they are NOT deduplicated (no in-flight promise cache).
    expect(a).not.toBe(b)
    // A subsequent call, after the singleton is populated, returns the cached one.
    const c = await getDB()
    expect(c).toBe(b)
    // Close the un-cached extra connection so teardown's deleteDatabase is not
    // blocked by a handle afterEach cannot reach (afterEach only closes _db).
    if (a !== c) a.close()
  })
})

describe('dbSaveVote / dbGetVotes — uid scoping', () => {
  it('returns a vote for the uid that saved it', async () => {
    const { dbSaveVote, dbGetVotes } = await loadDb()
    await dbSaveVote('uidA', 'space1', 'Alice', 5)
    const votes = await dbGetVotes('uidA', 'space1')
    expect(votes).toEqual({ Alice: 5 })
  })

  it('does NOT return uidA votes when queried as uidB (uid-scoping)', async () => {
    const { dbSaveVote, dbGetVotes } = await loadDb()
    await dbSaveVote('uidA', 'space1', 'Alice', 5)
    const votesB = await dbGetVotes('uidB', 'space1')
    expect(votesB).toEqual({})
  })

  it('keeps two uids voting in the same space fully separated', async () => {
    const { dbSaveVote, dbGetVotes } = await loadDb()
    await dbSaveVote('uidA', 'space1', 'Alice', 5)
    await dbSaveVote('uidA', 'space1', 'Bob', 1)
    await dbSaveVote('uidB', 'space1', 'Alice', 2)
    await dbSaveVote('uidB', 'space1', 'Carol', 4)

    expect(await dbGetVotes('uidA', 'space1')).toEqual({ Alice: 5, Bob: 1 })
    expect(await dbGetVotes('uidB', 'space1')).toEqual({ Alice: 2, Carol: 4 })
  })

  it('scopes votes by spaceId too — same uid, different space does not leak', async () => {
    const { dbSaveVote, dbGetVotes } = await loadDb()
    await dbSaveVote('uidA', 'space1', 'Alice', 5)
    await dbSaveVote('uidA', 'space2', 'Alice', 3)
    expect(await dbGetVotes('uidA', 'space1')).toEqual({ Alice: 5 })
    expect(await dbGetVotes('uidA', 'space2')).toEqual({ Alice: 3 })
  })

  it('overwrites an existing vote for the same (uid, space, name) key', async () => {
    const { dbSaveVote, dbGetVotes } = await loadDb()
    await dbSaveVote('uidA', 'space1', 'Alice', 5)
    await dbSaveVote('uidA', 'space1', 'Alice', 2)
    expect(await dbGetVotes('uidA', 'space1')).toEqual({ Alice: 2 })
  })

  it('stores the composite key ${uid}::${spaceId}::${name} in the record', async () => {
    const { getDB, dbSaveVote } = await loadDb()
    await dbSaveVote('uidA', 'space1', 'Alice', 5)
    const db = await getDB()
    const rec = await db.get('votes', 'uidA::space1::Alice')
    expect(rec).toMatchObject({
      key: 'uidA::space1::Alice',
      uid: 'uidA',
      spaceId: 'space1',
      name: 'Alice',
      score: 5,
    })
    expect(typeof rec.updatedAt).toBe('number')
  })

  it('returns an empty map for a space with no votes', async () => {
    const { dbGetVotes } = await loadDb()
    expect(await dbGetVotes('uidA', 'no-such-space')).toEqual({})
  })
})

describe('dbGetVotesOrdered', () => {
  it('filters by uid and sorts oldest-first by updatedAt', async () => {
    const { getDB, dbGetVotesOrdered } = await loadDb()
    const db = await getDB()
    // Write records directly so we control updatedAt precisely (out of chronological order).
    await db.put('votes', { key: 'uidA::space1::Bob', uid: 'uidA', spaceId: 'space1', name: 'Bob', score: 2, updatedAt: 300 })
    await db.put('votes', { key: 'uidA::space1::Alice', uid: 'uidA', spaceId: 'space1', name: 'Alice', score: 5, updatedAt: 100 })
    await db.put('votes', { key: 'uidA::space1::Carol', uid: 'uidA', spaceId: 'space1', name: 'Carol', score: 3, updatedAt: 200 })
    // Another uid's vote must be excluded.
    await db.put('votes', { key: 'uidB::space1::Zed', uid: 'uidB', spaceId: 'space1', name: 'Zed', score: 1, updatedAt: 50 })

    const { map, ordered } = await dbGetVotesOrdered('uidA', 'space1')
    expect(ordered.map(r => r.name)).toEqual(['Alice', 'Carol', 'Bob'])
    expect(ordered.every(r => r.uid === 'uidA')).toBe(true)
    expect(map).toEqual({ Alice: 5, Carol: 3, Bob: 2 })
  })

  it('returns empty map and empty ordered array when there are no votes', async () => {
    const { dbGetVotesOrdered } = await loadDb()
    const { map, ordered } = await dbGetVotesOrdered('uidA', 'space1')
    expect(map).toEqual({})
    expect(ordered).toEqual([])
  })

  it('reflects real save order when updatedAt is assigned by dbSaveVote', async () => {
    // NB: use a Date.now spy, NOT vi.useFakeTimers(). Fake timers stall
    // fake-indexeddb's internal scheduling, so IDB promises never resolve and
    // the test (and its teardown hook) hang. Spying Date.now keeps real timers.
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      const { dbSaveVote, dbGetVotesOrdered } = await loadDb()
      nowSpy.mockReturnValue(1000)
      await dbSaveVote('uidA', 'space1', 'First', 5)
      nowSpy.mockReturnValue(2000)
      await dbSaveVote('uidA', 'space1', 'Second', 4)
      nowSpy.mockReturnValue(3000)
      await dbSaveVote('uidA', 'space1', 'Third', 3)
      const { ordered } = await dbGetVotesOrdered('uidA', 'space1')
      expect(ordered.map(r => r.name)).toEqual(['First', 'Second', 'Third'])
      expect(ordered.map(r => r.updatedAt)).toEqual([1000, 2000, 3000])
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe('dbDeleteVote', () => {
  it('removes only the targeted uid record', async () => {
    const { dbSaveVote, dbGetVotes, dbDeleteVote } = await loadDb()
    await dbSaveVote('uidA', 'space1', 'Alice', 5)
    await dbSaveVote('uidB', 'space1', 'Alice', 2)

    await dbDeleteVote('uidA', 'space1', 'Alice')

    expect(await dbGetVotes('uidA', 'space1')).toEqual({})
    expect(await dbGetVotes('uidB', 'space1')).toEqual({ Alice: 2 })
  })

  it('leaves other names for the same uid intact', async () => {
    const { dbSaveVote, dbGetVotes, dbDeleteVote } = await loadDb()
    await dbSaveVote('uidA', 'space1', 'Alice', 5)
    await dbSaveVote('uidA', 'space1', 'Bob', 3)
    await dbDeleteVote('uidA', 'space1', 'Alice')
    expect(await dbGetVotes('uidA', 'space1')).toEqual({ Bob: 3 })
  })

  it('is a no-op when the vote does not exist', async () => {
    const { dbDeleteVote, dbGetVotes } = await loadDb()
    await expect(dbDeleteVote('uidA', 'space1', 'Ghost')).resolves.toBeUndefined()
    expect(await dbGetVotes('uidA', 'space1')).toEqual({})
  })
})

describe('dbSaveSpace / dbGetSpace', () => {
  it('round-trips a space by id', async () => {
    const { dbSaveSpace, dbGetSpace } = await loadDb()
    const space = { id: 'sp1', title: 'Baby names', creatorUid: 'uidA', createdAt: 123, joinedUids: [] }
    await dbSaveSpace(space)
    expect(await dbGetSpace('sp1')).toEqual(space)
  })

  it('overwrites an existing space with the same id', async () => {
    const { dbSaveSpace, dbGetSpace } = await loadDb()
    await dbSaveSpace({ id: 'sp1', title: 'Old' })
    await dbSaveSpace({ id: 'sp1', title: 'New' })
    expect((await dbGetSpace('sp1')).title).toBe('New')
  })

  it('returns undefined on a miss', async () => {
    const { dbGetSpace } = await loadDb()
    expect(await dbGetSpace('nope')).toBeUndefined()
  })
})

describe('dbGetMySpaces', () => {
  it('includes spaces where the user is the creator', async () => {
    const { dbSaveSpace, dbGetMySpaces } = await loadDb()
    await dbSaveSpace({ id: 'a', creatorUid: 'uidA', createdAt: 1, joinedUids: [] })
    const spaces = await dbGetMySpaces('uidA')
    expect(spaces.map(s => s.id)).toEqual(['a'])
  })

  it('includes spaces where the user is a joined member', async () => {
    const { dbSaveSpace, dbGetMySpaces } = await loadDb()
    await dbSaveSpace({ id: 'a', creatorUid: 'someoneElse', createdAt: 1, joinedUids: ['uidA', 'uidC'] })
    const spaces = await dbGetMySpaces('uidA')
    expect(spaces.map(s => s.id)).toEqual(['a'])
  })

  it('excludes spaces the user neither created nor joined', async () => {
    const { dbSaveSpace, dbGetMySpaces } = await loadDb()
    await dbSaveSpace({ id: 'mine', creatorUid: 'uidA', createdAt: 1, joinedUids: [] })
    await dbSaveSpace({ id: 'joined', creatorUid: 'x', createdAt: 2, joinedUids: ['uidA'] })
    await dbSaveSpace({ id: 'other', creatorUid: 'x', createdAt: 3, joinedUids: ['uidB'] })
    const ids = (await dbGetMySpaces('uidA')).map(s => s.id).sort()
    expect(ids).toEqual(['joined', 'mine'])
  })

  it('sorts results newest-first by createdAt', async () => {
    const { dbSaveSpace, dbGetMySpaces } = await loadDb()
    await dbSaveSpace({ id: 'old', creatorUid: 'uidA', createdAt: 100, joinedUids: [] })
    await dbSaveSpace({ id: 'new', creatorUid: 'uidA', createdAt: 300, joinedUids: [] })
    await dbSaveSpace({ id: 'mid', creatorUid: 'uidA', createdAt: 200, joinedUids: [] })
    const spaces = await dbGetMySpaces('uidA')
    expect(spaces.map(s => s.id)).toEqual(['new', 'mid', 'old'])
  })

  it('tolerates spaces with missing createdAt and missing joinedUids', async () => {
    const { dbSaveSpace, dbGetMySpaces } = await loadDb()
    // No createdAt -> treated as 0; no joinedUids -> optional chaining must not throw.
    await dbSaveSpace({ id: 'nometa', creatorUid: 'uidA' })
    await dbSaveSpace({ id: 'nomembers', creatorUid: 'x' }) // not mine, no joinedUids array
    const spaces = await dbGetMySpaces('uidA')
    expect(spaces.map(s => s.id)).toEqual(['nometa'])
  })

  it('returns an empty array when the user has no spaces', async () => {
    const { dbGetMySpaces } = await loadDb()
    expect(await dbGetMySpaces('uidNobody')).toEqual([])
  })
})

describe('dbAddOutbox', () => {
  it('appends an entry with createdAt and attempts:0', async () => {
    // Date.now spy (not fake timers — see dbGetVotesOrdered note) for a stable createdAt.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(42000)
    try {
      const { getDB, dbAddOutbox } = await loadDb()
      await dbAddOutbox({ type: 'vote', spaceId: 'space1', extra: 'payload' })
      const db = await getDB()
      const all = await db.getAll('outbox')
      expect(all).toHaveLength(1)
      expect(all[0]).toMatchObject({
        type: 'vote',
        spaceId: 'space1',
        extra: 'payload',
        createdAt: 42000,
        attempts: 0,
      })
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('appends multiple entries with autoincrement ids preserving insertion order', async () => {
    const { getDB, dbAddOutbox } = await loadDb()
    await dbAddOutbox({ type: 'first' })
    await dbAddOutbox({ type: 'second' })
    const db = await getDB()
    const all = await db.getAll('outbox')
    expect(all.map(e => e.type)).toEqual(['first', 'second'])
    expect(all.every(e => e.attempts === 0)).toBe(true)
  })

  it('BLIND SPOT: a Firestore FieldValue-style sentinel loses its class identity on the IDB round-trip', async () => {
    // Firestore's serverTimestamp() returns a class instance (a "sentinel"), not a plain value —
    // the SDK recognizes it internally via `instanceof`/prototype checks before serializing a write.
    // IndexedDB persists entries via the structured-clone algorithm, which does NOT preserve custom
    // prototypes: a class instance survives the round-trip as a plain object with the same OWN
    // properties, but loses its constructor/prototype chain entirely (no throw — silent).
    // Concretely: enqueuing `{ joinedAt: serverTimestamp() }` in the outbox, then reading it back
    // at drain time, hands Firestore a stripped plain object instead of the real sentinel — Firestore
    // no longer recognizes it as "write the server time" and either rejects the write or stores
    // garbage. This is why MEMBER_JOIN's serverTimestamp() must be constructed AT DRAIN TIME
    // (see sync.js), never stored in the outbox payload itself.
    class FakeServerTimestampSentinel {
      constructor() { this._methodName = 'serverTimestamp' }
      isEqual(other) { return other instanceof FakeServerTimestampSentinel }
    }
    const sentinel = new FakeServerTimestampSentinel()
    expect(sentinel instanceof FakeServerTimestampSentinel).toBe(true) // sanity: true before the round-trip

    const { getDB, dbAddOutbox } = await loadDb()
    await dbAddOutbox({ type: 'MEMBER_JOIN', spaceId: 'space1', data: { joinedAt: sentinel } })
    const db = await getDB()
    const [stored] = await db.getAll('outbox')

    expect(stored.data.joinedAt instanceof FakeServerTimestampSentinel).toBe(false) // identity lost
    expect(stored.data.joinedAt.isEqual).toBeUndefined() // methods gone too — Firestore can't recognize it
    expect(stored.data.joinedAt).toEqual({ _methodName: 'serverTimestamp' }) // only own data properties survive
  })
})

describe('v4 migration — votes store cleared', () => {
  it('clears legacy un-scoped vote records when upgrading a v3 DB to v4', async () => {
    // Seed a v3 database directly (bypassing db.js) with the pre-v4 schema and a
    // legacy vote whose key had no uid prefix (`${spaceId}::${name}`).
    const v3 = await openDB(DB_NAME, 3, {
      upgrade(db) {
        db.createObjectStore('spaces', { keyPath: 'id' })
        const votes = db.createObjectStore('votes', { keyPath: 'key' })
        votes.createIndex('bySpace', 'spaceId')
        db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true })
        db.createObjectStore('names', { keyPath: 'name' })
      },
    })
    await v3.put('votes', { key: 'space1::Alice', spaceId: 'space1', name: 'Alice', score: 5 })
    await v3.put('spaces', { id: 'sp1', creatorUid: 'uidA', createdAt: 1 })
    // A pre-existing space must survive the upgrade (only votes are cleared).
    expect(await v3.getAll('votes')).toHaveLength(1)
    v3.close()

    // Now open through db.js at version 4 — the upgrade must clear the votes store.
    const { getDB } = await loadDb()
    const db = await getDB()
    expect(db.version).toBe(4)
    expect(await db.getAll('votes')).toEqual([])
    // Non-vote data (spaces) is untouched by the v4 migration.
    expect(await db.getAll('spaces')).toHaveLength(1)
  })

  it('after migration, freshly saved uid-scoped votes work normally', async () => {
    const v3 = await openDB(DB_NAME, 3, {
      upgrade(db) {
        db.createObjectStore('spaces', { keyPath: 'id' })
        const votes = db.createObjectStore('votes', { keyPath: 'key' })
        votes.createIndex('bySpace', 'spaceId')
        db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true })
        db.createObjectStore('names', { keyPath: 'name' })
      },
    })
    await v3.put('votes', { key: 'space1::Alice', spaceId: 'space1', name: 'Alice', score: 5 })
    v3.close()

    const { dbSaveVote, dbGetVotes } = await loadDb()
    await dbSaveVote('uidA', 'space1', 'Alice', 4)
    // Legacy record gone; only the new uid-scoped one remains.
    expect(await dbGetVotes('uidA', 'space1')).toEqual({ Alice: 4 })
  })
})
