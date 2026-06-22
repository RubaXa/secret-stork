// @file: IndexedDB access layer (idb@8) — all persistent local state for spaces, votes, outbox, and name cache.
// @consumers: services/sync.js, services/names.js

import { openDB } from 'idb'
import { L, safeUid } from './logger.js'

let _db

/**
 * @purpose Return the shared IndexedDB instance, opening and migrating it on first call.
 * @invariant Singleton — parallel calls before first resolve share the same Promise via _db assignment.
 * @returns {Promise<import('idb').IDBPDatabase>}
 * @sideEffect Opens 'names-roulette' DB v3; runs schema upgrade migrations on version mismatch.
 */
export async function getDB() {
  if (_db) return _db
  _db = await openDB('names-roulette', 3, {
    upgrade(db, oldVersion, _newVersion, tx) {
      // #region START_SCHEMA_V1_INIT
      if (oldVersion < 1) {
        db.createObjectStore('spaces', { keyPath: 'id' })
        const votes = db.createObjectStore('votes', { keyPath: 'key' })
        votes.createIndex('bySpace', 'spaceId')
        db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true })
        db.createObjectStore('names', { keyPath: 'name' })
      }
      // #endregion END_SCHEMA_V1_INIT
      // #region START_SCHEMA_NAMES_RESET
      // purpose: names data format changed in v2 and v3 — clear stale cache to force re-fetch from network
      if (oldVersion < 2) tx.objectStore('names').clear()
      if (oldVersion < 3) tx.objectStore('names').clear()
      // #endregion END_SCHEMA_NAMES_RESET
    },
  })
  return _db
}

/**
 * @purpose Persist or overwrite a space record in IndexedDB.
 * @param {object} space Space object with required `id` field.
 * @sideEffect IDB write to 'spaces' store.
 */
export async function dbSaveSpace(space) {
  L('db#saveSpace', 'id=' + space.id?.slice(0, 8))
  const db = await getDB()
  await db.put('spaces', space)
}

/**
 * @purpose Retrieve a single space by ID from IndexedDB.
 * @param {string} id Space ID.
 * @returns {Promise<object|undefined>} Space object or undefined on miss.
 */
export async function dbGetSpace(id) {
  const db = await getDB()
  const s = await db.get('spaces', id)
  L('db#getSpace', 'id=' + id?.slice(0, 8), s ? 'HIT' : 'MISS')
  return s
}

/**
 * @purpose Return all spaces where the user is creator or joined member, sorted newest first.
 * @param {string} uid Firebase UID of the current user.
 * @returns {Promise<object[]>} Sorted array of space objects.
 */
export async function dbGetMySpaces(uid) {
  const db = await getDB()
  const all = await db.getAll('spaces')
  const result = all
    .filter(s => s.creatorUid === uid || s.joinedUids?.includes(uid))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  L('db#getMySpaces', 'uid=' + safeUid(uid), 'found=' + result.length)
  return result
}

/**
 * @purpose Persist or overwrite a vote record for a specific name in a space.
 * @param {string} spaceId
 * @param {string} name
 * @param {number} score 1–5.
 * @sideEffect IDB write to 'votes' store.
 */
export async function dbSaveVote(spaceId, name, score) {
  const db = await getDB()
  await db.put('votes', { key: `${spaceId}::${name}`, spaceId, name, score, updatedAt: Date.now() })
}

/**
 * @purpose Return all votes for a space as a name→score map.
 * @param {string} spaceId
 * @returns {Promise<Record<string, number>>}
 */
export async function dbGetVotes(spaceId) {
  const db = await getDB()
  const idx = db.transaction('votes').store.index('bySpace')
  const rows = await idx.getAll(spaceId)
  const map = {}
  rows.forEach(r => { map[r.name] = r.score })
  return map
}

/**
 * @purpose Return votes for a space sorted by vote time, plus the raw ordered array.
 * @param {string} spaceId
 * @returns {Promise<{map: Record<string, number>, ordered: object[]}>}
 *   `ordered` is sorted oldest-first; used by HistoryView to reconstruct the vote sequence.
 */
export async function dbGetVotesOrdered(spaceId) {
  const db = await getDB()
  const idx = db.transaction('votes').store.index('bySpace')
  const rows = await idx.getAll(spaceId)
  rows.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
  const map = {}
  rows.forEach(r => { map[r.name] = r.score })
  return { map, ordered: rows }
}

/**
 * @purpose Delete a single vote record from IndexedDB.
 * @param {string} spaceId
 * @param {string} name
 * @sideEffect IDB delete from 'votes' store.
 */
export async function dbDeleteVote(spaceId, name) {
  const db = await getDB()
  await db.delete('votes', `${spaceId}::${name}`)
}

/**
 * @purpose Enqueue an outbox entry for later sync to Firestore.
 * @param {{ type: string, spaceId?: string, [key: string]: any }} entry
 * @sideEffect IDB write to 'outbox' store.
 */
export async function dbAddOutbox(entry) {
  L('db#outbox', 'add type=' + entry.type)
  const db = await getDB()
  await db.add('outbox', { ...entry, createdAt: Date.now(), attempts: 0 })
}
