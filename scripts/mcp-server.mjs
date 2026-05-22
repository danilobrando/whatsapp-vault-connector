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
const WA_INBOX = process.env.WA_INBOX_PATH || path.join(VAULT_ROOT, '⚙️ Meta', 'whatsapp-inbox')
const SOCKET_PATH = '/tmp/whatsapp-daemon.sock'

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
    const name = file.replace('.md', '').replace(/ \(\d+\)$/, '')
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

  // 3. Search by name across all conversations (individuals + groups)
  const results = searchContacts(raw)
  if (results.length === 0) return null
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
      description: 'List all WhatsApp groups the user is in (from vault conversation files). Use when the user wants to browse groups or you need to disambiguate before sending. Optional query narrows by name.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional substring to filter group names.' },
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
    const results = searchContacts(args.query || '', { kind: 'group' })
    if (results.length === 0) {
      return { content: [{ type: 'text', text: args.query ? `No groups found matching "${args.query}".` : 'No groups found in the vault.' }] }
    }
    // Sort by name for stable browsing
    results.sort((a, b) => a.name.localeCompare(b.name))
    const lines = results.map(r => `${r.name} — ${r.jid}`).join('\n')
    return { content: [{ type: 'text', text: `${results.length} group(s):\n${lines}` }] }
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
        return {
          content: [{
            type: 'text',
            text: [
              `Connected: ${resp.connected ? 'yes' : 'no'}`,
              `Uptime: ${upHrs}h ${upMin}m`,
              `Last message: ${resp.lastMessageAt || 'none'}`,
              `File index: ${resp.indexSize} conversations`,
              `Contacts: ${resp.contactCount}`,
            ].join('\n'),
          }],
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
