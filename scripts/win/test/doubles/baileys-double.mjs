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
      mensajes: [{ ts: 1710000400, fromMe: false, author: 'X', text: 'secreto' }],
    },
    {
      jid: '573009998877@s.whatsapp.net',
      nombre: 'Desconocido',
      es_grupo: false,
      mensajes: [{ ts: 1710000500, fromMe: false, author: 'Z', text: 'no permitido' }],
    },
  ]
}

function tagged(kind, message) {
  const err = new Error(message)
  err.kind = kind
  return err
}

export async function createAdapter({ env = process.env } = {}) {
  const mode = env.WA_DOUBLE_MODE || 'ok'
  let linked = mode !== 'unlinked'

  return {
    name: 'double',
    async linked() { return linked },
    async account() { return linked ? { ...ACCOUNT } : null },
    async linkQR({ onQR } = {}) {
      if (onQR) onQR('DOUBLE-QR-PAYLOAD')
      linked = true
      return { ...ACCOUNT }
    },
    async linkCode(phone, { onCode } = {}) {
      if (onCode) onCode('1234-5678')
      linked = true
      return { ...ACCOUNT }
    },
    async fetchChats() {
      if (mode === 'no-net') throw tagged('no-net', 'offline')
      if (mode === 'bad-session') throw tagged('bad-session', 'invalid session')
      if (mode === 'boom') throw new Error('unexpected internal failure')
      return chatsFixture()
    },
    async runForeground({ onSync } = {}) {
      if (onSync) onSync({ chatsWritten: 2, messages: 6 })
      return undefined
    },
    async stop() { return { stopRequested: true } },
    async logout() { linked = false },
  }
}
