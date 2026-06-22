// @file: Firestore sync — outbox drain and full spaces/votes synchronization.
// @consumers: composables/useSync.js, composables/useAuth.js (setSyncUser), views (updateSpace, deleteSpace)

import { L, safeUid } from './logger.js'
import { fbDb, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, collection, serverTimestamp, query, where } from '@/firebase/config.js'
import { dbGetSpace, dbSaveSpace, dbGetMySpaces, dbAddOutbox, getDB } from './db.js'

let _user = null
let _draining = false

/**
 * @purpose Set the current Firebase user for outbox drain and sync operations.
 * @param {object|null} user Firebase user object or null on sign-out.
 */
export function setSyncUser(user) {
  _user = user
}

/**
 * @purpose Flush all pending outbox entries to Firestore — votes batched by space, other events sent individually.
 * @invariant Re-entrant calls while draining are skipped; calls with window._blockSync return actual remaining count (used by E2E tests).
 * @returns {Promise<{status: 'ok'|'error'|'blocked'|'no-user', remaining: number}>}
 * @sideEffect Firestore writes; IDB deletes of successfully synced outbox entries.
 */
export async function drainOutbox() {
  // #region START_DRAIN_GUARD
  if (!_user) return { status: 'no-user', remaining: 0 }
  if (_draining || window._blockSync) {
    L('sync#drain', 'skip draining=' + _draining + ' blocked=' + !!window._blockSync)
    const db = await getDB()
    const remaining = (await db.getAll('outbox')).length
    return { status: window._blockSync ? 'blocked' : 'ok', remaining }
  }
  // #endregion END_DRAIN_GUARD

  _draining = true
  L('sync#drain', 'start uid=' + safeUid(_user.uid))
  try {
    const db = await getDB()
    const entries = await db.getAll('outbox')
    if (!entries.length) {
      L('sync#drain', 'outbox empty')
      return { status: 'ok', remaining: 0 }
    }

    // #region START_VOTE_BATCH_COLLECTION
    // purpose: merge multiple VOTE entries for the same space into one Firestore write to reduce write ops
    const votesBySpace = {}
    const others = []
    entries.forEach(e => {
      if (e.type === 'VOTE') {
        if (!votesBySpace[e.spaceId]) votesBySpace[e.spaceId] = []
        votesBySpace[e.spaceId].push(e)
      } else {
        others.push(e)
      }
    })
    // #endregion END_VOTE_BATCH_COLLECTION

    const done = []

    // #region START_VOTE_BATCH_FIRESTORE_FLUSH
    for (const [spaceId, votes] of Object.entries(votesBySpace)) {
      const merged = {}
      votes.forEach(v => { merged[v.name] = v.score })
      try {
        await setDoc(
          doc(fbDb, 'spaces', spaceId, 'votes', _user.uid),
          { votes: merged, updatedAt: serverTimestamp() },
          { merge: true }
        )
        votes.forEach(v => done.push(v.id))
        L('sync#drain', 'VOTE batch ok spaceId=' + spaceId.slice(0, 8) + ' count=' + votes.length)
      } catch (e) {
        L('sync#drain', 'VOTE batch error spaceId=' + spaceId.slice(0, 8), e.message)
      }
    }
    // #endregion END_VOTE_BATCH_FIRESTORE_FLUSH

    // #region START_OTHER_EVENTS_FIRESTORE_FLUSH
    for (const entry of others) {
      try {
        if (entry.type === 'SPACE_CREATE') {
          await setDoc(doc(fbDb, 'spaces', entry.spaceId), entry.data)
        } else if (entry.type === 'SPACE_UPDATE') {
          await updateDoc(doc(fbDb, 'spaces', entry.spaceId), entry.data)
        } else if (entry.type === 'MEMBER_JOIN') {
          await setDoc(doc(fbDb, 'spaces', entry.spaceId, 'members', _user.uid), entry.data, { merge: true })
        } else if (entry.type === 'USER_SPACE_LINK') {
          await setDoc(doc(fbDb, 'users', _user.uid, 'spaces', entry.spaceId), { at: serverTimestamp() }, { merge: true })
        } else {
          L('sync#drain', 'UNKNOWN type=' + entry.type)
          done.push(entry.id)
          continue
        }
        done.push(entry.id)
        L('sync#drain', entry.type + ' ok spaceId=' + entry.spaceId?.slice(0, 8))
      } catch (e) {
        L('sync#drain', entry.type + ' error', e.message)
      }
    }
    // #endregion END_OTHER_EVENTS_FIRESTORE_FLUSH

    // #region START_OUTBOX_CLEANUP
    await Promise.all(done.map(id => db.delete('outbox', id)))
    const remaining = entries.length - done.length
    L('sync#drain', 'done remaining=' + remaining)
    return { status: remaining ? 'error' : 'ok', remaining }
    // #endregion END_OUTBOX_CLEANUP

  } finally {
    _draining = false
  }
}

/**
 * @purpose Pull all spaces the user owns or has joined from Firestore and merge into IDB.
 * @invariant Four sequential steps; each wrapped in try/catch so a single step failure does not abort the rest.
 * @param {string} uid Firebase UID.
 * @returns {Promise<boolean>} True if any new or updated spaces were saved to IDB.
 * @sideEffect Firestore reads (queries + getDoc); IDB writes via dbSaveSpace.
 */
export async function syncSpacesFromFirestore(uid) {
  L('sync#fetch', 'start uid=' + safeUid(uid))
  let hadNew = false

  // #region START_SYNC_CREATOR_SPACES
  try {
    const q = query(collection(fbDb, 'spaces'), where('creatorUid', '==', uid))
    const snap = await getDocs(q)
    L('sync#fetch', 'creatorUid query returned=' + snap.size)
    for (const d of snap.docs) {
      const existing = await dbGetSpace(d.id)
      const data = d.data()
      const updated = {
        id: d.id, ...data,
        createdAt: data.createdAt?.toMillis?.() || Date.now(),
        joinedUids: data.joinedUids || [uid],
      }
      if (!existing) {
        await dbSaveSpace(updated)
        hadNew = true
      } else if (data.deleted !== existing.deleted || data.status !== existing.status) {
        await dbSaveSpace({ ...existing, ...updated })
        hadNew = true
      }
    }
  } catch (e) { L('sync#fetch', 'step1 error', e.message) }
  // #endregion END_SYNC_CREATOR_SPACES

  // #region START_SYNC_JOINED_SPACES
  // purpose: recover spaces joined on another device that are absent from the creator query
  try {
    const linksSnap = await getDocs(collection(fbDb, 'users', uid, 'spaces'))
    for (const linkDoc of linksSnap.docs) {
      const existing = await dbGetSpace(linkDoc.id)
      if (!existing) {
        const spaceSnap = await getDoc(doc(fbDb, 'spaces', linkDoc.id))
        if (spaceSnap.exists()) {
          const data = spaceSnap.data()
          const space = {
            id: spaceSnap.id, ...data,
            createdAt: data.createdAt?.toMillis?.() || Date.now(),
            joinedUids: data.joinedUids || [],
          }
          if (!space.joinedUids.includes(uid)) space.joinedUids.push(uid)
          await dbSaveSpace(space)
          hadNew = true
        }
      }
    }
  } catch (e) { L('sync#fetch', 'step2 error', e.message) }
  // #endregion END_SYNC_JOINED_SPACES

  // #region START_SYNC_DELETED_DETECTION
  // purpose: mark locally-known joined spaces as deleted when the creator has removed them from Firestore
  try {
    const allSpaces = await dbGetMySpaces(uid)
    for (const space of allSpaces.filter(s => s.creatorUid !== uid && !s.deleted)) {
      try {
        const snap = await getDoc(doc(fbDb, 'spaces', space.id))
        if (!snap.exists() || snap.data().deleted) {
          await dbSaveSpace({ ...space, deleted: true, status: 'deleted' })
          hadNew = true
        }
      } catch (_) {}
    }
  } catch (e) { L('sync#fetch', 'step2b error', e.message) }
  // #endregion END_SYNC_DELETED_DETECTION

  // #region START_SYNC_VOTE_PROGRESS
  // purpose: keep _progress counters accurate so HomeView can show per-space completion percentages
  try {
    const allSpaces = await dbGetMySpaces(uid)
    for (const space of allSpaces) {
      try {
        const vSnap = await getDoc(doc(fbDb, 'spaces', space.id, 'votes', uid))
        if (vSnap.exists()) {
          const count = Object.keys(vSnap.data().votes || {}).length
          if (count !== (space._progress || 0)) {
            space._progress = count
            await dbSaveSpace(space)
            hadNew = true
          }
        }
      } catch (e) { L('sync#fetch', 'progress error id=' + space.id.slice(0, 8), e.message) }
    }
  } catch (e) { L('sync#fetch', 'step3 error', e.message) }
  // #endregion END_SYNC_VOTE_PROGRESS

  L('sync#fetch', 'done hadNew=' + hadNew)
  return hadNew
}

/**
 * @purpose Apply a partial update to a space in IDB and enqueue a SPACE_UPDATE outbox entry.
 * @param {string} spaceId
 * @param {object} data Partial fields to merge into the space.
 * @sideEffect IDB write; outbox enqueue; triggers drainOutbox fire-and-forget.
 */
export async function updateSpace(spaceId, data) {
  const space = await dbGetSpace(spaceId)
  if (space) { Object.assign(space, data); await dbSaveSpace(space) }
  await dbAddOutbox({ type: 'SPACE_UPDATE', spaceId, data })
  drainOutbox()
}

/**
 * @purpose Delete a space from Firestore and IDB, removing all associated votes and member records.
 * @param {string} spaceId
 * @sideEffect Firestore deletes (space doc, votes, members, user link); IDB deletes (space, all votes for space).
 */
export async function deleteSpace(spaceId) {
  const uid = _user?.uid
  try {
    await updateDoc(doc(fbDb, 'spaces', spaceId), { deleted: true, status: 'deleted' })
  } catch (e) {
    L('deleteSpace', 'Firestore update failed', e.message)
  }

  // #region START_DELETE_FIRESTORE_SUBCOLLECTIONS
  if (uid) {
    await deleteDoc(doc(fbDb, 'spaces', spaceId, 'votes', uid)).catch(() => {})
    await deleteDoc(doc(fbDb, 'spaces', spaceId, 'members', uid)).catch(() => {})
    await deleteDoc(doc(fbDb, 'users', uid, 'spaces', spaceId)).catch(() => {})
  }
  await deleteDoc(doc(fbDb, 'spaces', spaceId)).catch(() => {})
  // #endregion END_DELETE_FIRESTORE_SUBCOLLECTIONS

  // #region START_DELETE_IDB_VOTES
  const db = await getDB()
  await db.delete('spaces', spaceId)
  const tx = db.transaction('votes', 'readwrite')
  const keys = await tx.store.index('bySpace').getAllKeys(spaceId)
  await Promise.all(keys.map(k => tx.store.delete(k)))
  await tx.done
  // #endregion END_DELETE_IDB_VOTES
}
