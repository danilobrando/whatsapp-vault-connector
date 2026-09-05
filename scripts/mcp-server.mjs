#!/usr/bin/env node
/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * WhatsApp MCP Server for Claude Code
 *
 * Exposes WhatsApp messaging via MCP tools:
 *   - whatsapp_send: Send a message (via daemon IPC)
 *   - whatsapp_search_contacts: Find contacts by name
 *   - whatsapp_read_recent: Read recent messages from vault
 *   - whatsapp_daemon_status: Check daemon health
 *
 * Reads from vault files. Sends via Unix socket to the daemon.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import fs from 'fs'
import net from 'net'
import path from 'path'
import { fileURLToPath } from 'url'

const __dir = path.dirname(fileURLToPath(import.meta.url))
// Standard install path: <vault>/connectors/whatsapp/  (this file lives 2 dirs deep)
const VAULT_ROOT = process.env.VAULT_ROOT || path.resolve(__dir, '..', '..')
// Escape a string for safe use inside a RegExp (the inbox suffix is user-set).
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

const WA_INBOX = process.env.WA_INBOX_PATH || path.join(VAULT_ROOT, '⚙️ Meta', 'whatsapp-inbox')
// Resolve the daemon socket. It moved out of /tmp (mode 1777, reachable by
// every process on the machine) into a 0700 run directory beside the daemon.
// The legacy path stays as a fallback so a half-updated install still works.
const __sockDir = path.dirname(fileURLToPath(import.meta.url))
const SOCKET_PATH = process.env.WA_SOCKET_PATH
  || [path.join(__sockDir, '.run', 'daemon.sock'), '/tmp/whatsapp-daemon.sock']
     .find(p => { try { return fs.existsSync(p) } catch { return false } })
  || path.join(__sockDir, '.run', 'daemon.sock')

// ── Daemon IPC client ────────────────────────────────────────────────────────

function sendToDaemon(cmd) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCKET_PATH, () => {
      client.write(JSON.stringify(cmd) + '\n')
    })
    let buffer = ''
    client.on('data', (data) => {
      buffer += data.toString()
      if (buffer.includes('\n')) {
        client.destroy()
        try { resolve(JSON.parse(buffer.trim())) }
        catch { reject(new Error('Invalid response from daemon')) }
      }
    })
    client.on('error', (err) => {
      reject(new Error(`Daemon not running (${err.code}). Run 'wa-fix.py fix' to auto-repair, or start the launchd job manually.`))
    })
    client.setTimeout(10000, () => {
      client.destroy()
      reject(new Error('Daemon timeout'))
    })
  })
}

// ── Contact resolution (from vault files) ────────────────────────────────────
//
// Conversation files in the vault have one of two frontmatter shapes:
//   individual:  phone: "+<digits>"      → JID is <digits>@s.whatsapp.net
//   group:       jid:   "<groupId>"      → JID is <groupId>@g.us
// Older group files were also written with `phone:` (legacy). WhatsApp group
// IDs are 17–18 digits; real phone numbers max out around 15. We use length
// >= 17 as the heuristic to detect group IDs stored under the phone field.

const GROUP_ID_MIN_DIGITS = 17

function toJid(idOrPhone, kind) {
  if (kind === 'group' || idOrPhone.length >= GROUP_ID_MIN_DIGITS) {
    return idOrPhone + '@g.us'
  }
  return idOrPhone + '@s.whatsapp.net'
}

function kindFromDigits(digits) {
  return digits.length >= GROUP_ID_MIN_DIGITS ? 'group' : 'individual'
}

function searchContacts(query, { kind = 'any' } = {}) {
  const results = []
  const q = query.toLowerCase()
  if (!fs.existsSync(WA_INBOX)) return results

  for (const file of fs.readdirSync(WA_INBOX)) {
    if (!file.endsWith('.md')) continue
    const name = file.replace(/\.md$/, '')
      .replace(new RegExp(escapeRe(process.env.WA_INBOX_SUFFIX || '') + '$'), '')
      .replace(/ \(WhatsApp\)$/, '').replace(/ \(\d+\)$/, '')
    if (q && !name.toLowerCase().includes(q)) continue

    const content = fs.readFileSync(path.join(WA_INBOX, file), 'utf8')

    // Newer convention: explicit `jid:` for groups (e.g. jid: "12036...@g.us" or just digits)
    const jidMatch = content.match(/jid:\s*"?([^\s"]+)"?/)
    if (jidMatch) {
      const raw = jidMatch[1]
      const fullJid = raw.includes('@') ? raw : raw + '@g.us'
      const entryKind = fullJid.endsWith('@g.us') ? 'group' : 'individual'
      if (kind === 'any' || kind === entryKind) {
        results.push({ name, jid: fullJid, kind: entryKind, file })
      }
      continue
    }

    // Legacy: `phone:` holds either a real phone (individual) or a long group ID
    const phoneMatch = content.match(/phone:\s*"?\+?(\d+)"?/)
    if (phoneMatch) {
      const digits = phoneMatch[1]
      const entryKind = kindFromDigits(digits)
      const fullJid = toJid(digits, entryKind)
      if (kind === 'any' || kind === entryKind) {
        const entry = { name, jid: fullJid, kind: entryKind, file }
        if (entryKind === 'individual') entry.phone = digits
        results.push(entry)
      }
    }
  }

  return results
}

function resolveContact(nameOrPhone) {
  const raw = String(nameOrPhone || '').trim()
  if (!raw) return null

  // 1. Explicit JID passed through (e.g. "12036...@g.us" or "+57...@s.whatsapp.net")
  if (/@(s\.whatsapp\.net|g\.us|lid|broadcast)$/.test(raw)) {
    return {
      jid: raw,
      displayName: raw.split('@')[0],
      kind: raw.endsWith('@g.us') ? 'group' : 'individual',
    }
  }

  // 2. All-digits input: distinguish group ID (17+) from phone (<17)
  const clean = raw.replace(/[+\-\s]/g, '')
  if (/^\d{7,}$/.test(clean)) {
    const entryKind = kindFromDigits(clean)
    return {
      jid: toJid(clean, entryKind),
      displayName: entryKind === 'group' ? 'Group ' + clean : '+' + clean,
      kind: entryKind,
    }
  }

  // 3. Search by name across all conversations (individuals + groups).
  // Sending is irreversible, so an ambiguous name must never be resolved
  // silently to whatever sorted first. Exact match wins; otherwise the caller
  // is handed the candidates and has to choose.
  const results = searchContacts(raw)
  if (results.length === 0) return null
  const exact = results.filter(r => r.name.toLowerCase() === raw.toLowerCase())
  if (exact.length === 1) return { jid: exact[0].jid, displayName: exact[0].name, kind: exact[0].kind }
  if (results.length > 1) {
    return { ambiguous: results.slice(0, 8).map(r => ({ name: r.name, jid: r.jid, kind: r.kind })) }
  }
  return { jid: results[0].jid, displayName: results[0].name, kind: results[0].kind }
}

// ── Read recent messages from vault ──────────────────────────────────────────

function readRecent(contactQuery, count = 20) {
  const q = contactQuery.toLowerCase()
  let targetFile = null

  if (fs.existsSync(WA_INBOX)) {
    for (const file of fs.readdirSync(WA_INBOX)) {
      if (!file.endsWith('.md')) continue
      if (file.toLowerCase().includes(q)) {
        targetFile = path.join(WA_INBOX, file)
        break
      }
    }
  }

  if (!targetFile) return null

  const content = fs.readFileSync(targetFile, 'utf8')
  const lines = content.split('\n')
  const messageLines = lines.filter(l => l.startsWith('**'))
  return {
    file: path.basename(targetFile),
    total: messageLines.length,
    recent: messageLines.slice(-count).join('\n'),
  }
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'whatsapp', version: '2.3.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'whatsapp_send',
      description: 'Send a WhatsApp message to an individual contact OR a group. Resolution: pass a name (matches contacts and group names), a phone in E.164 (individual), a numeric group ID (17+ digits), or an explicit JID (e.g. "12036...@g.us"). When the user mentions "el grupo X" or "al grupo de Y", this is the tool — pair with whatsapp_list_groups first to confirm the exact group name if ambiguous.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Contact name, group name, phone number (E.164), group ID (17+ digits), or full JID.' },
          message: { type: 'string', description: 'Message text to send' },
        },
        required: ['to', 'message'],
      },
    },
    {
      name: 'whatsapp_search_contacts',
      description: 'Search WhatsApp conversations by name. Returns both individuals (with phone) and groups (with JID), each tagged kind: "individual" | "group".',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name or partial name to search for' },
          kind: { type: 'string', enum: ['any', 'individual', 'group'], description: 'Filter by conversation kind. Default "any".' },
        },
        required: ['query'],
      },
    },
    {
      name: 'whatsapp_list_groups',
      description: 'List all WhatsApp groups the user is in. By default reads from the vault (fast). If the vault has none matching the query, automatically falls back to a live query against Baileys, which includes brand-new groups that have not yet received messages in this session. Use this when the user wants to browse groups or you need to disambiguate before sending.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional substring to filter group names.' },
          source: { type: 'string', enum: ['vault', 'live', 'auto'], description: 'Where to read from. Default "auto" tries vault first then falls back to live.' },
        },
      },
    },
    {
      name: 'whatsapp_read_recent',
      description: 'Read recent messages from a WhatsApp conversation (individual or group). Messages are synced in real-time by the daemon.',
      inputSchema: {
        type: 'object',
        properties: {
          contact: { type: 'string', description: 'Contact or group name to read messages from' },
          count: { type: 'number', description: 'Number of recent messages to return (default: 20)' },
        },
        required: ['contact'],
      },
    },
    {
      name: 'whatsapp_daemon_status',
      description: 'Check WhatsApp daemon connection status and health.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name === 'whatsapp_search_contacts') {
    const results = searchContacts(args.query, { kind: args.kind || 'any' })
    if (results.length === 0) {
      return { content: [{ type: 'text', text: `No conversations found matching "${args.query}".` }] }
    }
    const lines = results.map(r => {
      const tag = r.kind === 'group' ? '[group]' : '[individual]'
      const id = r.phone ? `+${r.phone}` : r.jid
      return `${tag} ${r.name} — ${id} (jid: ${r.jid})`
    }).join('\n')
    const ind = results.filter(r => r.kind === 'individual').length
    const grp = results.filter(r => r.kind === 'group').length
    return { content: [{ type: 'text', text: `Found ${results.length} match(es): ${ind} individual, ${grp} group.\n${lines}` }] }
  }

  if (name === 'whatsapp_list_groups') {
    const source = args.source || 'auto'
    let results = []
    let usedSource = 'vault'

    if (source !== 'live') {
      results = searchContacts(args.query || '', { kind: 'group' })
    }

    if ((source === 'live') || (source === 'auto' && results.length === 0)) {
      // Ask the daemon for the canonical live list from Baileys
      try {
        const resp = await sendToDaemon({ cmd: 'list_groups_live', query: args.query || '' })
        if (resp.ok) {
          results = resp.groups || []
          usedSource = 'live'
        } else if (source === 'live') {
          return { content: [{ type: 'text', text: `Live group fetch failed: ${resp.error}` }], isError: true }
        }
      } catch (err) {
        if (source === 'live') {
          return { content: [{ type: 'text', text: err.message }], isError: true }
        }
      }
    }

    if (results.length === 0) {
      const q = args.query ? ` matching "${args.query}"` : ''
      return { content: [{ type: 'text', text: `No groups found${q}.` }] }
    }
    results.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    const lines = results.map(r => {
      const size = r.size ? ` (${r.size} members)` : ''
      return `${r.name || '(unnamed)'} ${size} — ${r.jid}`
    }).join('\n')
    return { content: [{ type: 'text', text: `${results.length} group(s) [source: ${usedSource}]:\n${lines}` }] }
  }

  if (name === 'whatsapp_read_recent') {
    const data = readRecent(args.contact, args.count || 20)
    if (!data) {
      return { content: [{ type: 'text', text: `No conversation found for "${args.contact}".` }] }
    }
    return {
      content: [{
        type: 'text',
        text: `${data.file} (${data.total} total messages)\n\nLast ${args.count || 20}:\n${data.recent}`,
      }],
    }
  }

  if (name === 'whatsapp_send') {
    const resolved = resolveContact(args.to)
    if (!resolved) {
      return {
        content: [{ type: 'text', text: `No contact or group found for "${args.to}". Use whatsapp_search_contacts or whatsapp_list_groups to find the right name.` }],
        isError: true,
      }
    }
    // Refuse to guess. Sending to the wrong person cannot be undone, and the
    // previous behaviour picked whichever candidate happened to sort first
    // without ever mentioning that there were others.
    if (resolved.ambiguous) {
      const list = resolved.ambiguous.map(c => `  ${c.name}  (${c.kind})  ${c.jid}`).join('\n')
      return {
        content: [{ type: 'text', text: `"${args.to}" matches ${resolved.ambiguous.length} contacts. Nothing was sent. Re-send with the exact name or the JID:\n${list}` }],
        isError: true,
      }
    }
    try {
      const resp = await sendToDaemon({ cmd: 'send', jid: resolved.jid, text: args.message })
      if (resp.ok) {
        const tag = resolved.kind === 'group' ? 'group' : 'contact'
        return { content: [{ type: 'text', text: `Message sent to ${tag} ${resolved.displayName} (${resolved.jid})` }] }
      }
      return { content: [{ type: 'text', text: `Send failed: ${resp.error}` }], isError: true }
    } catch (err) {
      return { content: [{ type: 'text', text: err.message }], isError: true }
    }
  }

  if (name === 'whatsapp_daemon_status') {
    try {
      const resp = await sendToDaemon({ cmd: 'status' })
      if (resp.ok) {
        const upHrs = Math.floor(resp.uptime / 3600)
        const upMin = Math.floor((resp.uptime % 3600) / 60)
        // Verdict first, computed here. This tool answers "is WhatsApp okay?"
        // and for 28 days it replied with five green lines — every one of them
        // true, none of them about reception — because it printed the field
        // that self-sent messages kept fresh and discarded the state the daemon
        // had already computed.
        const inAgeH = resp.lastInboundRealAt
          ? (Date.now() - new Date(resp.lastInboundRealAt).getTime()) / 3600000
          : null
        let verdict, degraded = false
        if (!resp.connected) { verdict = 'DISCONNECTED'; degraded = true }
        else if (resp.state === 'DRIFT_DETECTED') { verdict = 'DRIFT — sends are being refused'; degraded = true }
        else if (inAgeH === null) { verdict = 'UNKNOWN — no inbound signal yet'; degraded = true }
        else if (inAgeH >= 18) { verdict = `DEAF — no real inbound for ${inAgeH.toFixed(1)}h`; degraded = true }
        else if (inAgeH >= 9) { verdict = `QUIET — last real inbound ${inAgeH.toFixed(1)}h ago` }
        else { verdict = 'RECEIVING' }
        return {
          content: [{
            type: 'text',
            text: [
              `VERDICT: ${verdict}`,
              `State: ${resp.state}   Connected: ${resp.connected ? 'yes' : 'no'}   Uptime: ${upHrs}h ${upMin}m`,
              `Last real inbound: ${resp.lastInboundRealAt || 'none'}`,
              `Inbound 24h: ${resp.inboundReal24h ?? '?'} msgs from ${resp.inboundRealJids24h ?? '?'} contacts`,
              `Decrypt failures: ${resp.decryptFail1h ?? '?'}/h  (${resp.decryptFail24h ?? '?'} in 24h)`,
              `Last outbound: ${resp.lastOutboundAt || 'none'}   own echo: ${resp.lastOwnEchoAt || 'none'}`,
              `Reconnects in window: ${resp.reconnectsInWindow ?? '?'}   sends: ${resp.successfulSendsInWindow ?? '?'}`,
              `File index: ${resp.indexSize} conversations   Contacts: ${resp.contactCount}`,
              degraded ? `\nRun: python3 wa-fix.py doctor --json` : '',
            ].filter(Boolean).join('\n'),
          }],
          // An agent must not be able to read this as "fine" when it is not.
          isError: degraded,
        }
      }
      return { content: [{ type: 'text', text: `Daemon error: ${resp.error}` }], isError: true }
    } catch (err) {
      return { content: [{ type: 'text', text: err.message }], isError: true }
    }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(err => {
  process.stderr.write(`MCP server fatal: ${err.message}\n`)
  process.exit(1)
})
