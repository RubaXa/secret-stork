// @file: Unit tests for services/sync.js — outbox drain, vote batching, full-space sync, update/delete.
// @invariant Firebase config is loaded from https:// CDN URLs that Vitest cannot resolve, so
//   '@/firebase/config.js' is fully mocked below. IndexedDB is provided by fake-indexeddb.
// These tests assert CURRENT behavior of the frozen product code (no product changes allowed).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'

// --- Firebase mock (must be hoisted before importing sync.js) --------------------------------
// doc()/collection() return a stable path token so tests can assert which document a write targeted.
// The real Firebase doc(db, ...segments) takes the db handle as the first arg; product code passes
// `fbDb` (our {} mock) there. We drop that leading non-string handle so __path is the clean
// 'spaces/{id}/votes/{uid}'-style path segments the assertions expect.
vi.mock('@/firebase/config.js', () => {
  const pathOf = (...a) => ({ __path: a.filter(x => typeof x === 'string').join('/') })
  return {
    fbDb: {},
    doc: vi.fn(pathOf),
    setDoc: vi.fn(),
    getDoc: vi.fn(),
    getDocs: vi.fn(),
    updateDoc: vi.fn(),
    deleteDoc: vi.fn(),
    collection: vi.fn(pathOf),
    serverTimestamp: vi.fn(() => '__ts__'),
    query: vi.fn(),
    where: vi.fn(),
  }
})

// Same path-token builder, used to restore doc/collection implementations after clearAllMocks().
const pathOf = (...a) => ({ __path: a.filter(x => typeof x === 'string').join('/') })

import {
  setSyncUser,
  drainOutbox,
  syncSpacesFromFirestore,
  updateSpace,
  deleteSpace,
} from '@/services/sync.js'
import {
  dbAddOutbox,
  dbSaveSpace,
  dbGetSpace,
  dbGetMySpaces,
  getDB,
} from '@/services/db.js'
import {
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
} from '@/firebase/config.js'

const UID = 'user-abc-123'

// fake-indexeddb note: sync.js/db.js hold a module-level singleton `_db` for the "names-roulette"
// database. We cannot reset that singleton between tests (no exported reset), so instead of deleting
// the whole DB we clear every store's contents in beforeEach — this gives clean state while keeping
// the already-open singleton valid across tests.
async function clearStores() {
  const db = await getDB()
  for (const name of ['spaces', 'votes', 'outbox', 'names']) {
    if (db.objectStoreNames.contains(name)) {
      const tx = db.transaction(name, 'readwrite')
      await tx.store.clear()
      await tx.done
    }
  }
}

async function outboxAll() {
  const db = await getDB()
  return db.getAll('outbox')
}

// Helper builders for Firestore snapshot shapes ------------------------------------------------
function makeDocSnap(id, data, exists = true) {
  return {
    id,
    exists: () => exists,
    data: () => data,
  }
}
function makeQuerySnap(docs) {
  return { size: docs.length, docs }
}

beforeEach(async () => {
  vi.clearAllMocks()
  // Re-apply the path-token implementations that clearAllMocks wipes for doc/collection/serverTimestamp.
  const cfg = await import('@/firebase/config.js')
  cfg.doc.mockImplementation(pathOf)
  cfg.collection.mockImplementation(pathOf)
  cfg.serverTimestamp.mockImplementation(() => '__ts__')
  // Default: async no-op resolutions for write ops.
  setDoc.mockResolvedValue(undefined)
  updateDoc.mockResolvedValue(undefined)
  deleteDoc.mockResolvedValue(undefined)
  await clearStores()
  delete window._blockSync
  setSyncUser(null)
})

afterEach(async () => {
  delete window._blockSync
  setSyncUser(null)
  // Belt-and-suspenders: attempt to drop the DB too (no-op if singleton keeps it open).
  try { indexedDB.deleteDatabase('names-roulette') } catch (_) {}
})

// ============================================================================================
describe('drainOutbox — guards', () => {
  it('returns {status:no-user, remaining:0} when no user is set', async () => {
    setSyncUser(null)
    const res = await drainOutbox()
    expect(res).toEqual({ status: 'no-user', remaining: 0 })
    expect(setDoc).not.toHaveBeenCalled()
  })

  it('returns status:blocked with the real remaining count when window._blockSync is set', async () => {
    setSyncUser({ uid: UID })
    await dbAddOutbox({ type: 'VOTE', spaceId: 's1', name: 'Alice', score: 5 })
    await dbAddOutbox({ type: 'VOTE', spaceId: 's1', name: 'Bob', score: 3 })
    window._blockSync = true

    const res = await drainOutbox()
    expect(res.status).toBe('blocked')
    expect(res.remaining).toBe(2)
    // Blocked drain must NOT flush to Firestore.
    expect(setDoc).not.toHaveBeenCalled()
    // Outbox untouched.
    expect((await outboxAll()).length).toBe(2)
  })

  it('returns status:ok remaining:0 on an empty outbox', async () => {
    setSyncUser({ uid: UID })
    const res = await drainOutbox()
    expect(res).toEqual({ status: 'ok', remaining: 0 })
    expect(setDoc).not.toHaveBeenCalled()
  })
})

// ============================================================================================
describe('drainOutbox — VOTE batching', () => {
  it('merges multiple VOTE entries for one space into exactly ONE setDoc under votes/{uid}', async () => {
    setSyncUser({ uid: UID })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'space-1', name: 'Alice', score: 5 })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'space-1', name: 'Bob', score: 2 })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'space-1', name: 'Carol', score: 4 })

    const res = await drainOutbox()

    expect(res).toEqual({ status: 'ok', remaining: 0 })
    // Exactly one Firestore write for the batch.
    expect(setDoc).toHaveBeenCalledTimes(1)
    const [ref, payload, opts] = setDoc.mock.calls[0]
    expect(ref.__path).toBe(`spaces/space-1/votes/${UID}`)
    expect(payload).toEqual({
      votes: { Alice: 5, Bob: 2, Carol: 4 },
      updatedAt: '__ts__',
    })
    expect(opts).toEqual({ merge: true })
    // Outbox emptied on success.
    expect((await outboxAll()).length).toBe(0)
  })

  it('HOLDS a VOTE queued under a different uid — does NOT write it under the current user', async () => {
    // Two accounts, one browser: a vote queued while 'SOME-OTHER-UID' was signed in must not be
    // written under the CURRENTLY signed-in user's Firestore doc when drain runs later.
    setSyncUser({ uid: UID })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'space-1', name: 'Alice', score: 5, uid: 'SOME-OTHER-UID' })

    const res = await drainOutbox()

    expect(setDoc).not.toHaveBeenCalled()
    expect(res).toEqual({ status: 'ok', remaining: 1 }) // held, not an error — just deferred
    expect((await outboxAll())).toHaveLength(1) // still queued, untouched
  })

  it('drains only the current uid\'s votes; the other uid\'s entry stays queued', async () => {
    setSyncUser({ uid: UID })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'space-1', name: 'Mine', score: 4, uid: UID })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'space-1', name: 'TheirsNotMine', score: 1, uid: 'OTHER-UID' })

    const res = await drainOutbox()

    expect(setDoc).toHaveBeenCalledTimes(1)
    const [, payload] = setDoc.mock.calls[0]
    expect(payload.votes).toEqual({ Mine: 4 })
    expect(res).toEqual({ status: 'ok', remaining: 1 })
    const left = await outboxAll()
    expect(left).toHaveLength(1)
    expect(left[0].name).toBe('TheirsNotMine')
  })

  it('legacy VOTE entries with no uid field (queued before uid-scoping shipped) still drain under the signed-in user', async () => {
    setSyncUser({ uid: UID })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'space-1', name: 'Legacy', score: 3 }) // no `uid` field

    const res = await drainOutbox()

    expect(setDoc).toHaveBeenCalledTimes(1)
    const [ref] = setDoc.mock.calls[0]
    expect(ref.__path).toBe(`spaces/space-1/votes/${UID}`)
    expect(res).toEqual({ status: 'ok', remaining: 0 })
  })

  it('batches per-space: two spaces produce two separate setDoc writes', async () => {
    setSyncUser({ uid: UID })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'space-A', name: 'Alice', score: 5 })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'space-A', name: 'Bob', score: 1 })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'space-B', name: 'Zoe', score: 3 })

    const res = await drainOutbox()

    expect(res.remaining).toBe(0)
    expect(setDoc).toHaveBeenCalledTimes(2)
    const paths = setDoc.mock.calls.map(c => c[0].__path).sort()
    expect(paths).toEqual([
      `spaces/space-A/votes/${UID}`,
      `spaces/space-B/votes/${UID}`,
    ])
    const payloadA = setDoc.mock.calls.find(c => c[0].__path.includes('space-A'))[1]
    expect(payloadA.votes).toEqual({ Alice: 5, Bob: 1 })
    expect((await outboxAll()).length).toBe(0)
  })

  it('later VOTE entry for the same name overwrites the earlier score in the merged payload', async () => {
    setSyncUser({ uid: UID })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'space-1', name: 'Alice', score: 2 })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'space-1', name: 'Alice', score: 5 })

    await drainOutbox()

    expect(setDoc).toHaveBeenCalledTimes(1)
    // insertion order is autoIncrement id; last-wins => 5
    expect(setDoc.mock.calls[0][1].votes).toEqual({ Alice: 5 })
  })
})

// ============================================================================================
describe('drainOutbox — mixed / other event types', () => {
  it('SPACE_CREATE → setDoc on spaces/{id} with the entry data (no merge option)', async () => {
    setSyncUser({ uid: UID })
    const data = { title: 'Baby names', creatorUid: UID }
    await dbAddOutbox({ type: 'SPACE_CREATE', spaceId: 'sc-1', data })

    const res = await drainOutbox()

    expect(res.remaining).toBe(0)
    expect(setDoc).toHaveBeenCalledTimes(1)
    const call = setDoc.mock.calls[0]
    expect(call[0].__path).toBe('spaces/sc-1')
    expect(call[1]).toEqual(data)
    expect(call[2]).toBeUndefined()
  })

  it('SPACE_UPDATE → updateDoc on spaces/{id} with the entry data', async () => {
    setSyncUser({ uid: UID })
    const data = { status: 'closed' }
    await dbAddOutbox({ type: 'SPACE_UPDATE', spaceId: 'su-1', data })

    await drainOutbox()

    expect(updateDoc).toHaveBeenCalledTimes(1)
    expect(updateDoc.mock.calls[0][0].__path).toBe('spaces/su-1')
    expect(updateDoc.mock.calls[0][1]).toEqual(data)
  })

  it('MEMBER_JOIN → setDoc on spaces/{id}/members/{uid} with merge:true, joinedAt added fresh', async () => {
    setSyncUser({ uid: UID })
    const data = { name: 'Kostya' }
    await dbAddOutbox({ type: 'MEMBER_JOIN', spaceId: 'mj-1', data })

    await drainOutbox()

    expect(setDoc).toHaveBeenCalledTimes(1)
    const call = setDoc.mock.calls[0]
    expect(call[0].__path).toBe(`spaces/mj-1/members/${UID}`)
    expect(call[1]).toEqual({ ...data, joinedAt: '__ts__' }) // joinedAt always built at drain time
    expect(call[2]).toEqual({ merge: true })
  })

  it('MEMBER_JOIN builds joinedAt fresh at DRAIN TIME — never trusts a joinedAt value from the outbox', async () => {
    // A real Firestore serverTimestamp() sentinel is a class instance; IndexedDB's structured-clone
    // strips its prototype silently (see db.test.js "BLIND SPOT"), so whatever the outbox entry
    // carries for joinedAt could already be corrupted garbage by the time drain reads it back.
    // The fix: sync.js must construct serverTimestamp() itself at drain time (mirroring how VOTE's
    // updatedAt and USER_SPACE_LINK's `at` are already built fresh here, never carried in the entry),
    // and ignore/overwrite anything under entry.data.joinedAt.
    setSyncUser({ uid: UID })
    const corruptedSentinel = { _methodName: 'serverTimestamp' } // what a real sentinel looks like post-IDB-clone
    await dbAddOutbox({
      type: 'MEMBER_JOIN', spaceId: 'mj-fresh', uid: UID,
      data: { displayName: 'X', joinedAt: corruptedSentinel },
    })

    await drainOutbox()

    expect(setDoc).toHaveBeenCalledTimes(1)
    const [, payload] = setDoc.mock.calls[0]
    expect(payload.joinedAt).toBe('__ts__') // fresh sentinel from drain time
    expect(payload.joinedAt).not.toBe(corruptedSentinel)
    expect(payload.displayName).toBe('X') // rest of the payload preserved
  })

  it('USER_SPACE_LINK → setDoc on users/{uid}/spaces/{id} with {at: serverTimestamp} merge:true', async () => {
    setSyncUser({ uid: UID })
    await dbAddOutbox({ type: 'USER_SPACE_LINK', spaceId: 'link-1' })

    await drainOutbox()

    expect(setDoc).toHaveBeenCalledTimes(1)
    const call = setDoc.mock.calls[0]
    expect(call[0].__path).toBe(`users/${UID}/spaces/link-1`)
    expect(call[1]).toEqual({ at: '__ts__' })
    expect(call[2]).toEqual({ merge: true })
  })

  it('MEMBER_JOIN queued under a different uid is held, not written under the current user', async () => {
    setSyncUser({ uid: UID })
    await dbAddOutbox({ type: 'MEMBER_JOIN', spaceId: 'mj-2', uid: 'OTHER-UID', data: { name: 'Someone Else' } })

    const res = await drainOutbox()

    expect(setDoc).not.toHaveBeenCalled()
    expect(res).toEqual({ status: 'ok', remaining: 1 })
  })

  it('USER_SPACE_LINK queued under a different uid is held, not written under the current user', async () => {
    setSyncUser({ uid: UID })
    await dbAddOutbox({ type: 'USER_SPACE_LINK', spaceId: 'link-2', uid: 'OTHER-UID' })

    const res = await drainOutbox()

    expect(setDoc).not.toHaveBeenCalled()
    expect(res).toEqual({ status: 'ok', remaining: 1 })
  })

  it('unknown event type is DROPPED (marked done, removed from outbox) not retried', async () => {
    setSyncUser({ uid: UID })
    await dbAddOutbox({ type: 'WEIRD_EVENT', spaceId: 'x', data: {} })

    const res = await drainOutbox()

    // Dropped as done => remaining 0, status ok, and no Firestore write attempted.
    expect(res).toEqual({ status: 'ok', remaining: 0 })
    expect(setDoc).not.toHaveBeenCalled()
    expect(updateDoc).not.toHaveBeenCalled()
    expect((await outboxAll()).length).toBe(0)
  })

  it('handles a full mixed batch: votes + all four other types in one drain', async () => {
    setSyncUser({ uid: UID })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'sp', name: 'Alice', score: 5 })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'sp', name: 'Bob', score: 1 })
    await dbAddOutbox({ type: 'SPACE_CREATE', spaceId: 'sp', data: { title: 'T' } })
    await dbAddOutbox({ type: 'SPACE_UPDATE', spaceId: 'sp', data: { status: 'open' } })
    await dbAddOutbox({ type: 'MEMBER_JOIN', spaceId: 'sp', data: { name: 'K' } })
    await dbAddOutbox({ type: 'USER_SPACE_LINK', spaceId: 'sp' })

    const res = await drainOutbox()

    expect(res).toEqual({ status: 'ok', remaining: 0 })
    // setDoc: 1 vote batch + SPACE_CREATE + MEMBER_JOIN + USER_SPACE_LINK = 4
    expect(setDoc).toHaveBeenCalledTimes(4)
    expect(updateDoc).toHaveBeenCalledTimes(1)
    expect((await outboxAll()).length).toBe(0)
  })
})

// ============================================================================================
describe('drainOutbox — partial failure', () => {
  it('a rejected other-event stays in outbox; successful ones are removed; status:error remaining>0', async () => {
    setSyncUser({ uid: UID })
    await dbAddOutbox({ type: 'SPACE_CREATE', spaceId: 'ok-space', data: { title: 'ok' } })
    await dbAddOutbox({ type: 'MEMBER_JOIN', spaceId: 'fail-space', data: { name: 'K' } })

    // First setDoc (SPACE_CREATE) succeeds, second (MEMBER_JOIN) rejects.
    setDoc
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('permission-denied'))

    const res = await drainOutbox()

    expect(res.status).toBe('error')
    expect(res.remaining).toBe(1)
    const left = await outboxAll()
    expect(left.length).toBe(1)
    expect(left[0].type).toBe('MEMBER_JOIN')
    expect(left[0].spaceId).toBe('fail-space')
  })

  it('a rejected VOTE batch keeps all that space\'s votes in the outbox', async () => {
    setSyncUser({ uid: UID })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'space-1', name: 'Alice', score: 5 })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'space-1', name: 'Bob', score: 3 })
    setDoc.mockRejectedValue(new Error('offline'))

    const res = await drainOutbox()

    expect(res.status).toBe('error')
    expect(res.remaining).toBe(2)
    expect((await outboxAll()).length).toBe(2)
  })

  it('one failing space does not block a different succeeding space', async () => {
    setSyncUser({ uid: UID })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'space-A', name: 'Alice', score: 5 })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'space-B', name: 'Bob', score: 3 })

    // Reject only the write whose target path is space-A's votes doc.
    setDoc.mockImplementation((ref) =>
      ref.__path.includes('space-A')
        ? Promise.reject(new Error('denied'))
        : Promise.resolve(undefined)
    )

    const res = await drainOutbox()

    expect(res.status).toBe('error')
    expect(res.remaining).toBe(1)
    const left = await outboxAll()
    expect(left.length).toBe(1)
    expect(left[0].spaceId).toBe('space-A')
  })
})

// ============================================================================================
describe('drainOutbox — re-entrancy guard', () => {
  it('a concurrent second drain while the first is still in-flight is skipped (status ok, no double write)', async () => {
    setSyncUser({ uid: UID })
    await dbAddOutbox({ type: 'VOTE', spaceId: 'sp', name: 'Alice', score: 5 })

    // Make setDoc hang until we release it, so the first drain is still "draining".
    let release
    const gate = new Promise(r => { release = r })
    setDoc.mockImplementation(() => gate)

    const first = drainOutbox()
    // Second call observes _draining === true and short-circuits.
    const second = await drainOutbox()
    expect(second.status).toBe('ok') // not blocked (window._blockSync unset)
    // Only the first drain's single write has been issued so far.
    expect(setDoc).toHaveBeenCalledTimes(1)

    release()
    const firstRes = await first
    expect(firstRes).toEqual({ status: 'ok', remaining: 0 })
  })
})

// ============================================================================================
describe('syncSpacesFromFirestore', () => {
  it('step 1: creator-query spaces are saved to IDB when absent locally', async () => {
    getDocs
      // step 1: creatorUid query
      .mockResolvedValueOnce(makeQuerySnap([
        makeDocSnap('sp-created', { title: 'Mine', creatorUid: UID, createdAt: { toMillis: () => 1000 } }),
      ]))
      // step 2: users/{uid}/spaces links -> empty
      .mockResolvedValueOnce(makeQuerySnap([]))
    // step 3 loops call getDoc (votes) + possibly getDocs (members). Provide safe defaults.
    getDoc.mockResolvedValue(makeDocSnap('x', {}, false))
    getDocs.mockResolvedValue(makeQuerySnap([])) // for later step3 members getDocs after the two above

    const hadNew = await syncSpacesFromFirestore(UID)

    expect(hadNew).toBe(true)
    const saved = await dbGetSpace('sp-created')
    expect(saved).toBeTruthy()
    expect(saved.title).toBe('Mine')
    expect(saved.creatorUid).toBe(UID)
    expect(saved.createdAt).toBe(1000)
    expect(saved.joinedUids).toEqual([UID])
  })

  it('step 1: existing space is re-saved only when deleted/status changed', async () => {
    await dbSaveSpace({ id: 'sp-x', title: 'Old', creatorUid: UID, status: 'open', deleted: false, createdAt: 5 })

    getDocs
      .mockResolvedValueOnce(makeQuerySnap([
        makeDocSnap('sp-x', { title: 'New', creatorUid: UID, status: 'closed', deleted: false }),
      ]))
      .mockResolvedValueOnce(makeQuerySnap([])) // step2
    getDoc.mockResolvedValue(makeDocSnap('x', {}, false))

    const hadNew = await syncSpacesFromFirestore(UID)
    expect(hadNew).toBe(true)
    const s = await dbGetSpace('sp-x')
    // merged: existing spread then updated -> status becomes closed, title updated too.
    expect(s.status).toBe('closed')
    expect(s.title).toBe('New')
  })

  it('step 2: joined space absent locally is recovered via users/{uid}/spaces link', async () => {
    getDocs
      .mockResolvedValueOnce(makeQuerySnap([])) // step1 creator query empty
      .mockResolvedValueOnce(makeQuerySnap([{ id: 'joined-sp' }])) // step2 link docs
    getDoc
      // step2 getDoc(spaces/joined-sp)
      .mockResolvedValueOnce(makeDocSnap('joined-sp', {
        title: 'Shared', creatorUid: 'other-uid', joinedUids: ['other-uid'],
        createdAt: { toMillis: () => 2000 },
      }))
      // step3 votes getDoc -> not exists
      .mockResolvedValue(makeDocSnap('x', {}, false))

    const hadNew = await syncSpacesFromFirestore(UID)

    expect(hadNew).toBe(true)
    const s = await dbGetSpace('joined-sp')
    expect(s).toBeTruthy()
    expect(s.creatorUid).toBe('other-uid')
    expect(s.createdAt).toBe(2000)
    // uid appended to joinedUids since it was absent
    expect(s.joinedUids).toContain(UID)
    expect(s.joinedUids).toContain('other-uid')
  })

  it('step 2b: locally-known joined space is marked deleted when Firestore doc is gone', async () => {
    // Local joined space (not created by uid, not yet deleted).
    await dbSaveSpace({ id: 'gone-sp', title: 'Gone', creatorUid: 'other', joinedUids: [UID], deleted: false, status: 'open' })

    getDocs
      .mockResolvedValueOnce(makeQuerySnap([])) // step1
      .mockResolvedValueOnce(makeQuerySnap([])) // step2 links empty
    // step2b + step3 both use getDoc(spaces/gone-sp). Return non-existent.
    getDoc.mockResolvedValue(makeDocSnap('gone-sp', {}, false))

    const hadNew = await syncSpacesFromFirestore(UID)

    expect(hadNew).toBe(true)
    const s = await dbGetSpace('gone-sp')
    expect(s.deleted).toBe(true)
    expect(s.status).toBe('deleted')
  })

  it('step 2b: marks deleted when Firestore doc exists but has deleted:true', async () => {
    await dbSaveSpace({ id: 'del-sp', title: 'X', creatorUid: 'other', joinedUids: [UID], deleted: false, status: 'open' })

    getDocs
      .mockResolvedValueOnce(makeQuerySnap([])) // step1
      .mockResolvedValueOnce(makeQuerySnap([])) // step2
    getDoc.mockResolvedValue(makeDocSnap('del-sp', { deleted: true }, true))

    await syncSpacesFromFirestore(UID)
    const s = await dbGetSpace('del-sp')
    expect(s.deleted).toBe(true)
    expect(s.status).toBe('deleted')
  })

  it('step 3: updates _progress from votes/{uid} and _memberCount for creator spaces', async () => {
    await dbSaveSpace({ id: 'sp3', title: 'Mine', creatorUid: UID, joinedUids: [UID], deleted: false, status: 'open', createdAt: 1 })

    getDocs
      .mockResolvedValueOnce(makeQuerySnap([])) // step1
      .mockResolvedValueOnce(makeQuerySnap([])) // step2 links
      // step3: members getDocs for sp3 (creator space). 2 members, neither is creator uid.
      .mockResolvedValueOnce(makeQuerySnap([{ id: 'm1' }, { id: 'm2' }]))
    // step2b getDoc is skipped (space is creator's own, filtered out). step3 votes getDoc:
    getDoc.mockResolvedValue(makeDocSnap('sp3', { votes: { Alice: 5, Bob: 3, Carol: 1 } }, true))

    const hadNew = await syncSpacesFromFirestore(UID)

    expect(hadNew).toBe(true)
    const s = await dbGetSpace('sp3')
    expect(s._progress).toBe(3) // three names voted
    // memberCount = members.size (2) + (creator absent ? 1 : 0) = 3
    expect(s._memberCount).toBe(3)
  })

  it('step 3: does not fetch members for a non-creator space (no _memberCount set)', async () => {
    await dbSaveSpace({ id: 'sp-joined', title: 'J', creatorUid: 'other', joinedUids: [UID], deleted: false, status: 'open', createdAt: 1 })

    getDocs
      .mockResolvedValueOnce(makeQuerySnap([])) // step1
      .mockResolvedValueOnce(makeQuerySnap([])) // step2
    // step2b getDoc(spaces/sp-joined) exists & not deleted -> no change; step3 votes getDoc:
    getDoc.mockResolvedValue(makeDocSnap('sp-joined', { votes: { Alice: 5 } }, true))

    await syncSpacesFromFirestore(UID)
    const s = await dbGetSpace('sp-joined')
    expect(s._progress).toBe(1)
    expect(s._memberCount).toBeUndefined()
  })

  it('step isolation: a throwing getDocs in step 1 does NOT abort step 3', async () => {
    await dbSaveSpace({ id: 'sp-iso', title: 'Iso', creatorUid: UID, joinedUids: [UID], deleted: false, status: 'open', createdAt: 1 })

    getDocs
      .mockRejectedValueOnce(new Error('step1 boom')) // step1 creator query throws
      .mockResolvedValueOnce(makeQuerySnap([]))        // step2 links
      .mockResolvedValueOnce(makeQuerySnap([]))        // step3 members (creator space) -> empty
    getDoc.mockResolvedValue(makeDocSnap('sp-iso', { votes: { Alice: 5, Bob: 2 } }, true))

    const hadNew = await syncSpacesFromFirestore(UID)

    // step3 still ran and updated progress despite step1 throwing.
    expect(hadNew).toBe(true)
    const s = await dbGetSpace('sp-iso')
    expect(s._progress).toBe(2)
    // members empty, creator absent => memberCount 0 + 1 = 1
    expect(s._memberCount).toBe(1)
  })

  it('returns false (hadNew) when nothing new/changed', async () => {
    getDocs
      .mockResolvedValueOnce(makeQuerySnap([])) // step1
      .mockResolvedValueOnce(makeQuerySnap([])) // step2
    getDoc.mockResolvedValue(makeDocSnap('x', {}, false))

    const hadNew = await syncSpacesFromFirestore(UID)
    expect(hadNew).toBe(false)
    expect((await dbGetMySpaces(UID)).length).toBe(0)
  })
})

// ============================================================================================
describe('updateSpace', () => {
  it('merges data into the local space, enqueues SPACE_UPDATE, and triggers drain', async () => {
    setSyncUser({ uid: UID })
    await dbSaveSpace({ id: 'up-1', title: 'Before', creatorUid: UID })

    await updateSpace('up-1', { title: 'After', status: 'closed' })

    const s = await dbGetSpace('up-1')
    expect(s.title).toBe('After')
    expect(s.status).toBe('closed')

    // Wait a microtask/tick for the fire-and-forget drainOutbox() to flush.
    await new Promise(r => setTimeout(r, 0))

    // drain ran (user set) -> SPACE_UPDATE flushed via updateDoc, outbox emptied.
    expect(updateDoc).toHaveBeenCalledTimes(1)
    expect(updateDoc.mock.calls[0][0].__path).toBe('spaces/up-1')
    expect(updateDoc.mock.calls[0][1]).toEqual({ title: 'After', status: 'closed' })
    expect((await outboxAll()).length).toBe(0)
  })

  it('still enqueues SPACE_UPDATE even when the space is not present locally', async () => {
    setSyncUser(null) // no drain -> entry persists so we can inspect it
    await updateSpace('missing', { status: 'x' })

    const left = await outboxAll()
    expect(left.length).toBe(1)
    expect(left[0].type).toBe('SPACE_UPDATE')
    expect(left[0].spaceId).toBe('missing')
    expect(left[0].data).toEqual({ status: 'x' })
  })
})

// ============================================================================================
describe('deleteSpace', () => {
  it('updates the Firestore space doc, deletes subcollection docs + space doc, and clears IDB', async () => {
    setSyncUser({ uid: UID })
    await dbSaveSpace({ id: 'del-1', title: 'Del', creatorUid: UID })
    // Seed local votes for the space so we can confirm they are purged.
    const db = await getDB()
    await db.put('votes', { key: `${UID}::del-1::Alice`, uid: UID, spaceId: 'del-1', name: 'Alice', score: 5 })
    await db.put('votes', { key: `${UID}::del-1::Bob`, uid: UID, spaceId: 'del-1', name: 'Bob', score: 2 })
    await db.put('votes', { key: `${UID}::other::Zoe`, uid: UID, spaceId: 'other', name: 'Zoe', score: 1 })

    await deleteSpace('del-1')

    // 1) marks space deleted in Firestore
    expect(updateDoc).toHaveBeenCalledTimes(1)
    expect(updateDoc.mock.calls[0][0].__path).toBe('spaces/del-1')
    expect(updateDoc.mock.calls[0][1]).toEqual({ deleted: true, status: 'deleted' })

    // 2) deletes votes/{uid}, members/{uid}, users/{uid}/spaces/{id}, and the space doc itself
    const deletedPaths = deleteDoc.mock.calls.map(c => c[0].__path)
    expect(deletedPaths).toContain(`spaces/del-1/votes/${UID}`)
    expect(deletedPaths).toContain(`spaces/del-1/members/${UID}`)
    expect(deletedPaths).toContain(`users/${UID}/spaces/del-1`)
    expect(deletedPaths).toContain('spaces/del-1')
    expect(deleteDoc).toHaveBeenCalledTimes(4)

    // 3) IDB: space removed, its votes purged, other space's vote untouched.
    expect(await dbGetSpace('del-1')).toBeUndefined()
    const remainingVotes = await db.getAll('votes')
    expect(remainingVotes.map(v => v.key)).toEqual([`${UID}::other::Zoe`])
  })

  it('without a signed-in user, skips subcollection deletes but still deletes the space doc + IDB', async () => {
    setSyncUser(null)
    await dbSaveSpace({ id: 'del-2', title: 'X', creatorUid: 'someone' })

    await deleteSpace('del-2')

    // uid falsy => only the space doc delete runs (the `if (uid)` block is skipped).
    expect(deleteDoc).toHaveBeenCalledTimes(1)
    expect(deleteDoc.mock.calls[0][0].__path).toBe('spaces/del-2')
    expect(await dbGetSpace('del-2')).toBeUndefined()
  })

  it('swallows a Firestore updateDoc rejection and still clears local IDB', async () => {
    setSyncUser({ uid: UID })
    await dbSaveSpace({ id: 'del-3', title: 'X', creatorUid: UID })
    updateDoc.mockRejectedValue(new Error('offline'))

    await expect(deleteSpace('del-3')).resolves.toBeUndefined()
    expect(await dbGetSpace('del-3')).toBeUndefined()
  })
})
