/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * A Baileys double for the test suite. It implements exactly the adapter
 * interface `cli.mjs` consumes — nothing more — so the whole control contract
 * can be exercised with no network and no WhatsApp account.
 *
 * `WA_DOUBLE_MODE` selects the scenario:
 *   ok           linked, fetches chats
 *   unlinked     not linked; link --qr/--code succeeds
 *   no-net       linked, but fetching fails as if offline
 *   bad-session  linked, but fetching fails with an invalid session
 */
const ACCOUNT = { jid: '573001112233@s.whatsapp.net', mask: '+********2233' }

export const doubleMetrics = {
  inventoryCalls: 0,
  fetchCalls: 0,
  mappedMessages: 0,
  downloadCalls: 0,
}

export function chatsFixture() {
  return [
    {
      jid: '573001112233@s.whatsapp.net',
      nombre: 'Ana',
      es_grupo: false,
      mensajes: [
        { ts: 1710000000, fromMe: false, author: 'Ana', text: 'Hola\n¿cómo estás?' },
        { ts: 1710000060, fromMe: true, author: 'Yo', text: 'Bien, gracias' },
        { ts: 1710000120, system: true, text: 'Los mensajes y las llamadas están cifrados de extremo a extremo.' },
        { ts: 1710000180, fromMe: false, author: 'Ana', text: '', attachment: { kind: 'document', fileName: 'presupuesto.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 fixture') } },
        { ts: 1710000240, fromMe: false, author: 'Ana', text: '', attachment: { kind: 'image', fileName: 'foto.jpg', mime: 'image/jpeg' } },
      ],
    },
    {
      jid: '120363000000000001@g.us',
      nombre: 'Equipo',
      es_grupo: true,
      mensajes: [{ ts: 1710000300, fromMe: false, author: 'Luis', text: 'Reunión mañana' }],
    },
    {
      jid: '120363000000000009@g.us',
      nombre: 'No permitido',
      es_grupo: true,
      mensajes: [{ ts: 1710000400, fromMe: false, author: 'X', text: 'secreto', attachment: { kind: 'document', fileName: 'secreto.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-should-not-download') } }],
    },
    {
      jid: '573009998877@s.whatsapp.net',
      nombre: 'Desconocido',
      es_grupo: false,
      mensajes: [{ ts: 1710000500, fromMe: false, author: 'Z', text: 'no permitido' }],
    },
  ]
}

export function inventoryFixture() {
  return chatsFixture().map(({ jid, nombre, es_grupo }) => ({ jid, nombre, es_grupo }))
}

function tagged(kind, message) {
  const err = new Error(message)
  err.kind = kind
  return err
}

export async function createAdapter({ env = process.env } = {}) {
  const mode = env.WA_DOUBLE_MODE || 'ok'
  const startsUnlinked = new Set(['unlinked', 'qr-error', 'qr-timeout', 'code-error'])
  let linked = !startsUnlinked.has(mode)
  doubleMetrics.inventoryCalls = 0
  doubleMetrics.fetchCalls = 0
  doubleMetrics.mappedMessages = 0
  doubleMetrics.downloadCalls = 0

  return {
    name: 'double',
    async linked() { return linked },
    async account() { return linked ? { ...ACCOUNT } : null },
    async linkQR({ onQR } = {}) {
      if (mode === 'qr-error') throw new Error('QR failed')
      if (onQR) await onQR('DOUBLE-QR-PAYLOAD')
      if (mode === 'qr-timeout') { const err = new Error('QR expired'); err.kind = 'no-net'; throw err }
      linked = true
      return { ...ACCOUNT }
    },
    async linkCode(phone, { onCode } = {}) {
      if (mode === 'code-error') throw new Error('pairing failed')
      if (onCode) onCode('1234-5678')
      linked = true
      return { ...ACCOUNT }
    },
    async fetchChats({ allow } = {}) {
      doubleMetrics.fetchCalls += 1
      if (mode === 'no-net' || mode === 'close-408') throw tagged('no-net', 'connection closed (408)')
      if (mode === 'close-500' || mode === 'bad-session' || mode === 'invalid-session') throw tagged('bad-session', 'connection closed (500)')
      if (mode === 'boom') throw new Error('unexpected internal failure')
      const allowed = allow instanceof Set ? new Set([...allow].map((jid) => String(jid).toLowerCase())) : new Set()
      const chats = chatsFixture().filter((chat) => allowed.has(chat.jid.toLowerCase()))
      for (const chat of chats) {
        for (const message of chat.mensajes) {
          doubleMetrics.mappedMessages += 1
          if (message.attachment?.kind === 'document') doubleMetrics.downloadCalls += 1
        }
      }
      return chats
    },
    async fetchChatInventory() {
      doubleMetrics.inventoryCalls += 1
      if (mode === 'no-net' || mode === 'close-408') throw tagged('no-net', 'connection closed (408)')
      if (mode === 'close-500' || mode === 'bad-session' || mode === 'invalid-session') throw tagged('bad-session', 'connection closed (500)')
      if (mode === 'boom') throw new Error('unexpected internal failure')
      return inventoryFixture()
    },
    async runForeground({ onSync } = {}) {
      if (onSync) onSync({ chatsWritten: 2, messages: 6 })
      return undefined
    },
    async stop() { return { stopRequested: true } },
    async logout() { linked = false },
  }
}
