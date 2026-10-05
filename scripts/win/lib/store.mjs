/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * Local, non-secret bookkeeping: whether we are linked, what the last sync saw,
 * and which chats are behind. Credentials live in `baileys_auth/` and are never
 * copied here; this file is what `status --json` reads.
 */
import { readJson, writeJsonAtomic } from './fsutil.mjs'
import { VERSION } from './contract.mjs'

export function emptyState() {
  return {
    version: VERSION,
    vinculado: false,
    cuenta_enmascarada: null,
    ultima_sync: null,
    ultima_sync_ts: null,
    jids_sync: {},
  }
}

export function readState(stateFile) {
  const raw = readJson(stateFile, null)
  if (!raw || typeof raw !== 'object') return emptyState()
  return { ...emptyState(), ...raw, jids_sync: raw.jids_sync || {} }
}

export function writeState(stateFile, state) {
  writeJsonAtomic(stateFile, state)
}

/**
 * How many allowed chats carry a message newer than the last sync. This is the
 * `pendientes` field, and it is deliberately computed from message timestamps
 * rather than from a "did we run" flag — a run that fetched nothing must not
 * read as caught up.
 */
export function countPending(chats, state) {
  let pending = 0
  for (const chat of chats || []) {
    const newest = newestTs(chat)
    const seen = state.jids_sync?.[chat.jid] || 0
    if (newest > seen) pending += 1
  }
  return pending
}

export function newestTs(chat) {
  let newest = 0
  for (const m of chat.mensajes || []) {
    const ts = Number(m.ts) || 0
    if (ts > newest) newest = ts
  }
  return newest
}

export function markSynced(state, chats, { now = new Date().toISOString() } = {}) {
  const next = { ...state, jids_sync: { ...(state.jids_sync || {}) } }
  let newest = 0
  for (const chat of chats || []) {
    const ts = newestTs(chat)
    next.jids_sync[chat.jid] = Math.max(next.jids_sync[chat.jid] || 0, ts)
    if (ts > newest) newest = ts
  }
  next.ultima_sync = now
  next.ultima_sync_ts = newest || next.ultima_sync_ts
  return next
}
