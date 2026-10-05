/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * The allow-list gate.
 *
 * This connector is read-only *and* minimal: it exports only the chats the
 * product explicitly asked for. A chat is written iff its JID is in the list.
 * Groups are not a special case — they simply never appear unless someone put
 * them there, which is what makes "a group that was not allowed is not written"
 * true by construction rather than by a branch that can be forgotten.
 *
 * With no list configured the answer is "nothing": a connector that has not
 * been told what to read must not guess. That default is asserted by a test.
 */
import { readFileSync } from 'fs'

export function normalizeJid(jid) {
  return String(jid || '').trim().toLowerCase()
}

export function parseAllowList(raw) {
  let data = raw
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw) } catch { data = raw }
  }
  let list
  if (Array.isArray(data)) list = data
  else if (data && typeof data === 'object') list = data.jids || data.allow || []
  else list = String(data).split(/[\s,]+/)
  return new Set(list.filter(Boolean).map(normalizeJid))
}

export function loadAllowList(file) {
  if (!file) return new Set()
  try {
    return parseAllowList(readFileSync(file, 'utf8'))
  } catch {
    return new Set()
  }
}

export function isAllowed(jid, allow) {
  return allow instanceof Set && allow.size > 0 && allow.has(normalizeJid(jid))
}

/** Filter `chats` down to the permitted set, preserving order. */
export function filterAllowed(chats, allow) {
  return (chats || []).filter((c) => isAllowed(c.jid, allow))
}
